/**
 * Monotonic-anchored session clock. `SessionRecord.ends_at` is wall-clock
 * (ms epoch) because it has to be — it's shared and compared across devices
 * via the relay. But a live daemon process must not let the *user* rolling
 * the system clock forward shorten a running session: verification step
 * "set the system clock forward mid-session, confirm the timer does not end
 * early" is exactly this. So while the daemon process is continuously
 * running, remaining time is computed from `process.hrtime.bigint()`
 * elapsed-since-start, not from repeatedly re-reading `Date.now()`.
 *
 * This protection only holds *within one process lifetime* — hrtime has no
 * meaning across a restart. On restart, there is no monotonic reference
 * left, so startup falls back to the plain wall-clock dead-man's-switch
 * comparison (shared/src/deadman.ts). A clock rolled forward across a
 * daemon restart is an accepted, documented gap (see DECISIONS.md) — the
 * alternative (persisting a monotonic counter across reboots) needs OS
 * support this project doesn't have time to add.
 */
export class SessionClock {
  private readonly durationMs: number;
  private readonly monoStartNs: bigint;

  constructor(startedAtMs: number, endsAtMs: number) {
    this.durationMs = endsAtMs - startedAtMs;
    this.monoStartNs = process.hrtime.bigint();
  }

  private elapsedMs(): number {
    return Number(process.hrtime.bigint() - this.monoStartNs) / 1e6;
  }

  remainingMs(): number {
    return Math.max(0, this.durationMs - this.elapsedMs());
  }

  isExpired(): boolean {
    return this.remainingMs() <= 0;
  }
}
