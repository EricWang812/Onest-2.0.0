import { afterEach, describe, expect, it } from 'vitest';
import { SessionClock } from '../src/daemon/clock.js';

const originalHrtimeBigint = process.hrtime.bigint;

afterEach(() => {
  process.hrtime.bigint = originalHrtimeBigint;
});

describe('SessionClock', () => {
  it('reports remaining time close to the planned duration right after start', () => {
    const now = Date.now();
    const clock = new SessionClock(now, now + 60_000);
    expect(clock.remainingMs()).toBeGreaterThan(59_000);
    expect(clock.remainingMs()).toBeLessThanOrEqual(60_000);
    expect(clock.isExpired()).toBe(false);
  });

  it('is expired once the duration has elapsed (fake monotonic clock)', () => {
    let fakeNs = 0n;
    process.hrtime.bigint = () => fakeNs;
    const clock = new SessionClock(0, 1000); // 1000ms duration
    expect(clock.isExpired()).toBe(false);
    fakeNs = 1_500_000_000n; // 1500ms elapsed
    expect(clock.isExpired()).toBe(true);
    expect(clock.remainingMs()).toBe(0);
  });

  it('does not end early when the wall clock jumps forward mid-session', () => {
    const now = Date.now();
    const clock = new SessionClock(now, now + 5000);
    const originalDateNow = Date.now;
    try {
      Date.now = () => now + 60 * 60 * 1000; // user sets the clock forward by an hour
      expect(clock.isExpired()).toBe(false);
      expect(clock.remainingMs()).toBeGreaterThan(4000);
    } finally {
      Date.now = originalDateNow;
    }
  });
});
