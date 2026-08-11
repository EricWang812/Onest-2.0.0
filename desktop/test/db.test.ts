import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DesktopDb } from '../src/daemon/db.js';

let dir: string;
let db: DesktopDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'focuslock-desktop-db-'));
  db = new DesktopDb(join(dir, 'test.sqlite'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('DesktopDb: active_session (dead-man switch row)', () => {
  it('round-trips and clears', () => {
    expect(db.getActiveSession()).toBeNull();
    db.setActiveSession({
      session_id: 's1', ends_at: 2000, started_at: 1000, categories: ['social'], label: 'work', origin_device: 'd1',
    });
    expect(db.getActiveSession()).toEqual({
      session_id: 's1', ends_at: 2000, started_at: 1000, categories: ['social'], label: 'work', origin_device: 'd1',
    });
    db.clearActiveSession();
    expect(db.getActiveSession()).toBeNull();
  });
});

describe('DesktopDb: sessions / log aggregation', () => {
  it('lists sessions within a date range, ordered by start time', () => {
    db.insertSessionStart({ id: 'a', startedAt: 1000, plannedDurationS: 60, label: 'A', originDevice: 'd1' });
    db.insertSessionStart({ id: 'b', startedAt: 2000, plannedDurationS: 120, label: 'B', originDevice: 'd1' });
    db.insertSessionStart({ id: 'c', startedAt: 9_999_999, plannedDurationS: 60, label: 'out of range', originDevice: 'd1' });
    db.completeSession('a', 1060, 60);

    const rows = db.listSessions(0, 5000);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows[0].completed).toBe(true);
    expect(rows[0].actual_duration_s).toBe(60);
    expect(rows[1].completed).toBe(false);
  });

  it('returns an empty array for a range with no sessions', () => {
    expect(db.listSessions(0, 100)).toEqual([]);
  });
});

describe('DesktopDb: settings', () => {
  it('get/set round-trips and overwrites', () => {
    expect(db.getSetting('theme')).toBeNull();
    db.setSetting('theme', 'dark');
    expect(db.getSetting('theme')).toBe('dark');
    db.setSetting('theme', 'light');
    expect(db.getSetting('theme')).toBe('light');
  });
});

describe('DesktopDb: devices', () => {
  it('upserts and lists devices', () => {
    db.upsertDevice({ id: 'd1', name: 'Desktop', platform: 'windows', last_seen: 100, pubkey: 'pk' });
    db.upsertDevice({ id: 'd1', name: 'Desktop', platform: 'windows', last_seen: 200, pubkey: 'pk' });
    db.upsertDevice({ id: 'd2', name: 'Phone', platform: 'android', last_seen: 150, pubkey: 'pk2' });
    const devices = db.listDevices();
    expect(devices).toHaveLength(2);
    expect(devices[0].id).toBe('d1'); // most recently seen first
  });
});
