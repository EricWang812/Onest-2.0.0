import {
  MAX_SESSION_DURATION_S,
  evaluateSessionRecord,
  generateDeviceKeyPair,
  newNonce,
  newSessionId,
  shouldEnforceOnStartup,
  signSessionRecord,
  verifySessionRecord,
  type BlockCategoryId,
  type Platform,
  type SessionRecord,
} from '@focus-lock/shared';
import { AuditLog } from './audit.js';
import { SessionClock } from './clock.js';
import { DesktopDb } from './db.js';
import type { BlockedHit, Enforcer } from './enforcement.js';
import type { IpcServer } from './ipc-server.js';
import { notifySessionComplete } from './notify.js';
import { RelayClient } from './relay-client.js';

const TICK_MS = 500;
const POPUP_GLOBAL_MIN_GAP_MS = 10_000;
const POPUP_PER_APP_SUPPRESS_MS = 60_000;
const POPUP_COALESCE_WINDOW_MS = 250;

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
  platform: Platform;
  publicKeyB64: string;
  privateKeyPem: string;
  groupId: string;
}

/**
 * The daemon's single source of truth for "is a session running". Owns the
 * clock, the DB, enforcement, and the relay connection. Deliberately has no
 * method that ends a session early — `tick()` is the only path to
 * completion, and it only fires once `SessionClock.isExpired()`.
 */
export class SessionManager {
  private clock: SessionClock | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private currentSessionId: string | null = null;
  private currentCategories: BlockCategoryId[] = [];
  private currentLabel: string | null = null;
  private currentStartedAt = 0;

  private popupQueue: BlockedHit[] = [];
  private popupFlushTimer: NodeJS.Timeout | null = null;
  private lastGlobalPopupAt = 0;
  private lastPerAppPopupAt = new Map<string, number>();

  constructor(
    private readonly db: DesktopDb,
    private readonly enforcer: Enforcer,
    private readonly relay: RelayClient,
    private readonly ipc: IpcServer,
    private readonly audit: AuditLog,
    private readonly identity: DeviceIdentity,
  ) {
    this.relay.on('session.update', (msg: { record: SessionRecord | null }) => {
      void this.onRemoteSessionUpdate(msg.record);
    });
  }

  /** Crash-recovery / dead-man's-switch: called once at daemon startup. */
  async recoverOnStartup(): Promise<void> {
    const row = this.db.getActiveSession();
    if (shouldEnforceOnStartup(row, Date.now())) {
      this.currentSessionId = row!.session_id;
      this.currentCategories = row!.categories;
      this.currentLabel = row!.label;
      this.currentStartedAt = row!.started_at;
      this.clock = new SessionClock(row!.started_at, row!.ends_at);
      await this.enforcer.applyBlock(row!.categories);
      this.enforcer.startWatching((hits) => this.onEnforcementHit(hits));
      this.startTicking();
      this.audit.log('startup_recovered_active_session', { session_id: row!.session_id });
    } else {
      // No active session, or it's already past ends_at, or malformed: never leave the device blocked.
      await this.enforcer.removeBlock();
      this.db.clearActiveSession();
      this.audit.log('startup_no_active_session_unblocked', {});
    }
  }

  isRunning(): boolean {
    return this.clock !== null;
  }

  getState(): {
    running: boolean;
    remainingMs: number;
    label: string | null;
    categories: BlockCategoryId[];
    sessionId: string | null;
  } {
    return {
      running: this.isRunning(),
      remainingMs: this.clock?.remainingMs() ?? 0,
      label: this.currentLabel,
      categories: this.currentCategories,
      sessionId: this.currentSessionId,
    };
  }

  /** The only entry point that starts enforcement. There is no corresponding `stop`. */
  async startSession(durationS: number, categories: BlockCategoryId[], label: string | null): Promise<void> {
    if (this.isRunning()) throw new Error('a session is already active');
    if (durationS <= 0 || durationS > MAX_SESSION_DURATION_S) {
      throw new Error(`duration must be between 1s and ${MAX_SESSION_DURATION_S}s`);
    }
    if (categories.length === 0) throw new Error('at least one category is required');

    const startedAt = Date.now();
    const endsAt = startedAt + durationS * 1000;
    const sessionId = newSessionId();

    const unsigned = {
      group_id: this.identity.groupId,
      session_id: sessionId,
      started_at: startedAt,
      ends_at: endsAt,
      categories,
      label,
      origin_device: this.identity.deviceId,
      nonce: newNonce(),
    };
    const signature = signSessionRecord(unsigned, this.identity.privateKeyPem);
    const record: SessionRecord = { ...unsigned, signature };

    this.db.setActiveSession({
      session_id: sessionId, ends_at: endsAt, started_at: startedAt, categories, label,
      origin_device: this.identity.deviceId,
    });
    this.db.insertSessionStart({
      id: sessionId, startedAt, plannedDurationS: durationS, label, originDevice: this.identity.deviceId,
    });

    this.currentSessionId = sessionId;
    this.currentCategories = categories;
    this.currentLabel = label;
    this.currentStartedAt = startedAt;
    this.clock = new SessionClock(startedAt, endsAt);

    await this.enforcer.applyBlock(categories);
    this.enforcer.startWatching((hits) => this.onEnforcementHit(hits));
    this.relay.publishSession(record);
    this.startTicking();
    this.audit.log('session_started', { session_id: sessionId, durationS, categories, label });
    this.ipc.broadcast('session.state', this.getState());
  }

  /** A signed record arrived from another paired device (or ourselves, echoed back). */
  private async onRemoteSessionUpdate(record: SessionRecord | null): Promise<void> {
    if (!record) return;
    if (record.group_id !== this.identity.groupId) return;
    if (record.session_id === this.currentSessionId) return; // already enforcing this one
    if (this.isRunning()) return; // a local session takes precedence; do not override a running enforcement
    if (!verifySessionRecord(record, this.identity.publicKeyB64)) {
      this.audit.log('remote_session_rejected_bad_signature', { session_id: record.session_id });
      return;
    }
    const evalResult = evaluateSessionRecord(record, Date.now());
    if (!evalResult.valid || evalResult.alreadyExpired) return;

    this.db.setActiveSession({
      session_id: record.session_id, ends_at: record.ends_at, started_at: record.started_at,
      categories: record.categories, label: record.label, origin_device: record.origin_device,
    });
    this.db.insertSessionStart({
      id: record.session_id, startedAt: record.started_at,
      plannedDurationS: Math.round((record.ends_at - record.started_at) / 1000),
      label: record.label, originDevice: record.origin_device,
    });
    this.currentSessionId = record.session_id;
    this.currentCategories = record.categories;
    this.currentLabel = record.label;
    this.currentStartedAt = record.started_at;
    this.clock = new SessionClock(record.started_at, record.ends_at);
    await this.enforcer.applyBlock(record.categories);
    this.enforcer.startWatching((hits) => this.onEnforcementHit(hits));
    this.startTicking();
    this.audit.log('session_started_from_remote_device', { session_id: record.session_id, origin: record.origin_device });
    this.ipc.broadcast('session.state', this.getState());
  }

  private startTicking(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      if (this.clock?.isExpired()) void this.completeSession();
      else this.ipc.broadcast('session.state', this.getState());
    }, TICK_MS);
  }

  /** The only path to "no longer enforcing" — reached solely by the clock expiring. */
  private async completeSession(): Promise<void> {
    if (!this.currentSessionId) return;
    const sessionId = this.currentSessionId;
    const startedAt = this.currentStartedAt;
    const label = this.currentLabel;

    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.enforcer.stopWatching();

    // Sequence matters: unblock, confirm, THEN notify.
    await this.enforcer.removeBlock();
    this.db.clearActiveSession();
    const endedAt = Date.now();
    const actualDurationS = Math.round((endedAt - startedAt) / 1000);
    this.db.completeSession(sessionId, endedAt, actualDurationS);

    this.clock = null;
    this.currentSessionId = null;
    this.currentCategories = [];
    this.currentLabel = null;

    const durationLabel = formatDuration(actualDurationS);
    notifySessionComplete(durationLabel, label);
    this.audit.log('session_completed', { session_id: sessionId, actualDurationS });
    this.ipc.broadcast('session.complete', { sessionId, durationLabel, label });
    this.ipc.broadcast('session.state', this.getState());
  }

  private onEnforcementHit(hits: BlockedHit[]): void {
    const now = Date.now();
    const fresh = hits.filter((h) => (this.lastPerAppPopupAt.get(h.name) ?? 0) + POPUP_PER_APP_SUPPRESS_MS < now);
    if (fresh.length === 0) return;
    for (const h of fresh) this.lastPerAppPopupAt.set(h.name, now);
    this.popupQueue.push(...fresh);
    for (const h of fresh) this.audit.log('enforcement_hit', { kind: h.kind, name: h.name });
    if (!this.popupFlushTimer) {
      this.popupFlushTimer = setTimeout(() => this.flushPopupQueue(), POPUP_COALESCE_WINDOW_MS);
    }
  }

  private flushPopupQueue(): void {
    this.popupFlushTimer = null;
    const now = Date.now();
    if (now - this.lastGlobalPopupAt < POPUP_GLOBAL_MIN_GAP_MS) {
      this.popupQueue = [];
      return;
    }
    if (this.popupQueue.length === 0) return;
    this.lastGlobalPopupAt = now;
    const items = this.popupQueue;
    this.popupQueue = [];
    this.ipc.broadcast('blocked.popup', {
      items,
      remainingMs: this.clock?.remainingMs() ?? 0,
      reason: 'Focus session in progress',
    });
  }
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function bootstrapIdentity(
  db: DesktopDb,
  deviceName: string,
  platform: Platform,
  existingGroupId?: string,
): DeviceIdentity {
  let groupId = db.getSetting('group_id');
  let deviceId = db.getSetting('device_id');
  let pubkey = db.getSetting('device_pubkey');
  let privkey = db.getSetting('device_privkey');

  if (!groupId) {
    groupId = existingGroupId ?? newSessionId();
    db.setSetting('group_id', groupId);
  }
  if (!deviceId || !pubkey || !privkey) {
    const kp = generateDeviceKeyPair();
    deviceId = newSessionId();
    pubkey = kp.publicKeyB64;
    privkey = kp.privateKeyPem;
    db.setSetting('device_id', deviceId);
    db.setSetting('device_pubkey', pubkey);
    db.setSetting('device_privkey', privkey);
  }

  return {
    deviceId, deviceName, platform, publicKeyB64: pubkey, privateKeyPem: privkey, groupId,
  };
}
