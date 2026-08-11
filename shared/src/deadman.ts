import type { ActiveSessionRow, SessionRecord } from './types.js';
import { MAX_SESSION_DURATION_S } from './types.js';

/**
 * Dead-man's-switch and safety-cap logic, shared by relay validation and
 * every client's crash-recovery path. Imported by relay/src/session.ts and
 * desktop/daemon session module (mirrored by hand on Android/iOS — see
 * DECISIONS.md).
 */

export interface DeadmanResult {
  valid: boolean;
  reason?: string;
  /** true if this record is already in the past and must trigger an immediate, full unblock */
  alreadyExpired: boolean;
}

/**
 * A client calls this on every start/reconnect. now() must be monotonic-anchored
 * where possible (see desktop/daemon/src/clock.ts) so a user rolling the wall
 * clock backward can't extend a session.
 */
export function evaluateSessionRecord(record: SessionRecord, nowMs: number): DeadmanResult {
  const durationS = (record.ends_at - record.started_at) / 1000;
  if (durationS <= 0) {
    return { valid: false, reason: 'ends_at not after started_at', alreadyExpired: true };
  }
  if (durationS > MAX_SESSION_DURATION_S) {
    return { valid: false, reason: `duration ${durationS}s exceeds ${MAX_SESSION_DURATION_S}s cap`, alreadyExpired: false };
  }
  if (record.categories.length === 0) {
    return { valid: false, reason: 'no categories', alreadyExpired: false };
  }
  const alreadyExpired = nowMs >= record.ends_at;
  return { valid: true, alreadyExpired };
}

/**
 * The dead-man's-switch proper: given whatever crash-recovery row a client
 * finds on disk at startup, decide whether to keep enforcing or unblock
 * immediately. A crashed daemon / dead relay must never leave a device
 * permanently blocked, so this defaults to "unblock" on any ambiguity.
 */
export function shouldEnforceOnStartup(row: ActiveSessionRow | null, nowMs: number): boolean {
  if (!row) return false;
  if (nowMs >= row.ends_at) return false;
  const durationS = (row.ends_at - row.started_at) / 1000;
  if (durationS > MAX_SESSION_DURATION_S) return false;
  return true;
}

export function remainingMs(record: Pick<SessionRecord, 'ends_at'>, nowMs: number): number {
  return Math.max(0, record.ends_at - nowMs);
}
