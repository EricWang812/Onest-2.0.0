import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { ActiveSessionRow, BlockCategoryId, DeviceRecord, LoggedSession } from '@focus-lock/shared';

// See relay/src/db.ts / DECISIONS.md: loaded via createRequire so bundlers
// / test runners that don't yet recognize `node:sqlite` as a builtin don't
// misresolve it as an npm package named "sqlite".
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * Schema per spec: sessions, settings, devices, active_session (the
 * crash-recovery / dead-man's-switch row). The daemon is the only writer;
 * the UI reads through IPC (desktop/src/daemon/ipc-server.ts).
 */
export class DesktopDb {
  private db: DatabaseSyncType;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        planned_duration_s INTEGER NOT NULL,
        actual_duration_s INTEGER,
        label TEXT,
        completed INTEGER NOT NULL DEFAULT 0,
        origin_device TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        last_seen INTEGER NOT NULL,
        pubkey TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS active_session (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        session_id TEXT NOT NULL,
        ends_at INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        categories TEXT NOT NULL,
        label TEXT,
        origin_device TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // --- active_session (dead-man's-switch row) ---

  getActiveSession(): ActiveSessionRow | null {
    const row = this.db.prepare('SELECT * FROM active_session WHERE id = 1').get() as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      session_id: row.session_id as string,
      ends_at: row.ends_at as number,
      started_at: row.started_at as number,
      categories: JSON.parse(row.categories as string) as BlockCategoryId[],
      label: (row.label as string | null) ?? null,
      origin_device: row.origin_device as string,
    };
  }

  setActiveSession(row: ActiveSessionRow): void {
    this.db
      .prepare(
        `INSERT INTO active_session (id, session_id, ends_at, started_at, categories, label, origin_device)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id, ends_at = excluded.ends_at, started_at = excluded.started_at,
           categories = excluded.categories, label = excluded.label, origin_device = excluded.origin_device`,
      )
      .run(row.session_id, row.ends_at, row.started_at, JSON.stringify(row.categories), row.label, row.origin_device);
  }

  clearActiveSession(): void {
    this.db.prepare('DELETE FROM active_session WHERE id = 1').run();
  }

  // --- sessions (the log) ---

  insertSessionStart(params: {
    id: string;
    startedAt: number;
    plannedDurationS: number;
    label: string | null;
    originDevice: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, started_at, planned_duration_s, label, completed, origin_device)
         VALUES (?, ?, ?, ?, 0, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(params.id, params.startedAt, params.plannedDurationS, params.label, params.originDevice);
  }

  completeSession(id: string, endedAt: number, actualDurationS: number): void {
    this.db
      .prepare('UPDATE sessions SET ended_at = ?, actual_duration_s = ?, completed = 1 WHERE id = ?')
      .run(endedAt, actualDurationS, id);
  }

  listSessions(sinceMs: number, untilMs: number): LoggedSession[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE started_at >= ? AND started_at < ? ORDER BY started_at ASC')
      .all(sinceMs, untilMs) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      started_at: row.started_at as number,
      ended_at: (row.ended_at as number | null) ?? null,
      planned_duration_s: row.planned_duration_s as number,
      actual_duration_s: (row.actual_duration_s as number | null) ?? null,
      label: (row.label as string | null) ?? null,
      completed: Boolean(row.completed),
      origin_device: row.origin_device as string,
    }));
  }

  // --- settings ---

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  // --- devices ---

  upsertDevice(device: DeviceRecord): void {
    this.db
      .prepare(
        `INSERT INTO devices (id, name, platform, last_seen, pubkey) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, platform = excluded.platform, last_seen = excluded.last_seen, pubkey = excluded.pubkey`,
      )
      .run(device.id, device.name, device.platform, device.last_seen, device.pubkey);
  }

  listDevices(): DeviceRecord[] {
    const rows = this.db.prepare('SELECT * FROM devices ORDER BY last_seen DESC').all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      platform: row.platform as DeviceRecord['platform'],
      last_seen: row.last_seen as number,
      pubkey: row.pubkey as string,
    }));
  }
}
