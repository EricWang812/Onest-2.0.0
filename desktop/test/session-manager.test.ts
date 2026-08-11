import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDeviceKeyPair, MAX_SESSION_DURATION_S, newGroupId, newSessionId, signSessionRecord, type SessionRecord } from '@focus-lock/shared';
import { AuditLog } from '../src/daemon/audit.js';
import { DesktopDb } from '../src/daemon/db.js';
import type { BlockedHit, Enforcer } from '../src/daemon/enforcement.js';
import { IpcServer } from '../src/daemon/ipc-server.js';
import { RelayClient } from '../src/daemon/relay-client.js';
import { bootstrapIdentity, SessionManager } from '../src/daemon/session-manager.js';

vi.mock('../src/daemon/notify.js', () => ({ notifySessionComplete: vi.fn() }));
import { notifySessionComplete } from '../src/daemon/notify.js';

class FakeEnforcer implements Enforcer {
  applyBlockCalls: string[][] = [];
  removeBlockCalls = 0;
  watching = false;
  onHitCb: ((hits: BlockedHit[]) => void) | null = null;

  async applyBlock(categories: string[]): Promise<void> {
    this.applyBlockCalls.push(categories);
  }
  async removeBlock(): Promise<void> {
    this.removeBlockCalls++;
  }
  startWatching(onHit: (hits: BlockedHit[]) => void): void {
    this.watching = true;
    this.onHitCb = onHit;
  }
  stopWatching(): void {
    this.watching = false;
  }
}

let dir: string;
let db: DesktopDb;
let enforcer: FakeEnforcer;
let ipc: IpcServer;
let broadcasts: Array<{ event: string; payload: unknown }>;
let relay: RelayClient;
let audit: AuditLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'focuslock-sm-'));
  db = new DesktopDb(join(dir, 'db.sqlite'));
  enforcer = new FakeEnforcer();
  broadcasts = [];
  ipc = { broadcast: (event: string, payload: unknown) => broadcasts.push({ event, payload }) } as unknown as IpcServer;
  relay = new RelayClient('ws://127.0.0.1:1/ws', 'group-1', 'device-1', 'Test', 'windows', 'pk');
  audit = new AuditLog(join(dir, 'audit.log'));
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeManager(): SessionManager {
  const identity = bootstrapIdentity(db, 'Test Desktop', 'windows', 'group-1');
  return new SessionManager(db, enforcer, relay, ipc, audit, identity);
}

describe('SessionManager: starting a session', () => {
  it('rejects a duration beyond the 8h cap', async () => {
    const mgr = makeManager();
    await expect(mgr.startSession(MAX_SESSION_DURATION_S + 1, ['social'], null)).rejects.toThrow(/duration/);
    expect(enforcer.applyBlockCalls).toHaveLength(0);
  });

  it('rejects starting a second session while one is active', async () => {
    const mgr = makeManager();
    await mgr.startSession(10, ['social'], 'first');
    await expect(mgr.startSession(10, ['games'], 'second')).rejects.toThrow(/already active/);
  });

  it('applies enforcement, persists the dead-man row, and publishes to the relay', async () => {
    const mgr = makeManager();
    const publishSpy = vi.spyOn(relay, 'publishSession');
    await mgr.startSession(30, ['social', 'games'], 'deep work');

    expect(enforcer.applyBlockCalls).toEqual([['social', 'games']]);
    expect(enforcer.watching).toBe(true);
    expect(db.getActiveSession()).not.toBeNull();
    expect(publishSpy).toHaveBeenCalledOnce();
    expect(mgr.getState().running).toBe(true);
  });
});

describe('SessionManager: completion sequencing', () => {
  it('unblocks, persists the log row, and only then notifies — in that order', async () => {
    const mgr = makeManager();
    await mgr.startSession(1, ['social'], 'quick'); // 1 second

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (enforcer.removeBlockCalls > 0) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    expect(enforcer.removeBlockCalls).toBe(1);
    expect(mgr.getState().running).toBe(false);
    expect(db.getActiveSession()).toBeNull();
    const logged = db.listSessions(0, Date.now() + 10_000);
    expect(logged.find((s) => s.completed)).toBeTruthy();
    expect(notifySessionComplete).toHaveBeenCalledTimes(1);
    expect(broadcasts.some((b) => b.event === 'session.complete')).toBe(true);
  });
});

describe('SessionManager: relay outage does not affect local enforcement', () => {
  it('keeps enforcing when the relay disconnects mid-session', async () => {
    const mgr = makeManager();
    await mgr.startSession(30, ['social'], null);
    relay.emit('disconnected');
    expect(mgr.getState().running).toBe(true);
    expect(enforcer.removeBlockCalls).toBe(0);
  });
});

describe('SessionManager: remote session start (cross-device sync)', () => {
  it('applies enforcement for a validly signed record from another device in the same group', async () => {
    const mgr = makeManager();
    const identity = bootstrapIdentity(db, 'x', 'windows'); // reuses persisted keys
    const unsigned = {
      group_id: 'group-1',
      session_id: newSessionId(),
      started_at: Date.now(),
      ends_at: Date.now() + 60_000,
      categories: ['games'] as const,
      label: 'from phone',
      origin_device: 'phone-1',
      nonce: 'n',
    };
    const signature = signSessionRecord(unsigned, identity.privateKeyPem);
    const record: SessionRecord = { ...unsigned, signature, categories: ['games'] };

    relay.emit('session.update', { record });
    await new Promise((r) => setTimeout(r, 50));

    expect(enforcer.applyBlockCalls).toEqual([['games']]);
    expect(mgr.getState().running).toBe(true);
  });

  it('rejects a record with a bad signature', async () => {
    makeManager();
    const attacker = generateDeviceKeyPair();
    const unsigned = {
      group_id: 'group-1',
      session_id: newSessionId(),
      started_at: Date.now(),
      ends_at: Date.now() + 60_000,
      categories: ['games'] as const,
      label: null,
      origin_device: 'phone-1',
      nonce: 'n',
    };
    const signature = signSessionRecord(unsigned, attacker.privateKeyPem);
    relay.emit('session.update', { record: { ...unsigned, signature } });
    await new Promise((r) => setTimeout(r, 50));

    expect(enforcer.applyBlockCalls).toHaveLength(0);
  });
});

describe('SessionManager: dead-man switch on startup', () => {
  it('unblocks immediately when the persisted active_session row is already past ends_at', async () => {
    db.setActiveSession({
      session_id: 's1', started_at: Date.now() - 10_000, ends_at: Date.now() - 1000,
      categories: ['social'], label: null, origin_device: 'd1',
    });
    const mgr = makeManager();
    await mgr.recoverOnStartup();
    expect(enforcer.removeBlockCalls).toBe(1);
    expect(enforcer.applyBlockCalls).toHaveLength(0);
    expect(db.getActiveSession()).toBeNull();
  });

  it('resumes enforcement when the persisted row is still within its window', async () => {
    db.setActiveSession({
      session_id: 's1', started_at: Date.now() - 1000, ends_at: Date.now() + 60_000,
      categories: ['social'], label: null, origin_device: 'd1',
    });
    const mgr = makeManager();
    await mgr.recoverOnStartup();
    expect(enforcer.applyBlockCalls).toEqual([['social']]);
    expect(mgr.getState().running).toBe(true);
  });

  it('unblocks on startup when there is no active_session row at all', async () => {
    const mgr = makeManager();
    await mgr.recoverOnStartup();
    expect(enforcer.removeBlockCalls).toBe(1);
  });
});
