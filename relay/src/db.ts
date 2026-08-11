import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { BlockCategoryId, SessionRecord } from '@focus-lock/shared';

// Loaded via createRequire (not a static `import`) because Vite/vitest's
// built-in-module list predates `node:sqlite` (Node 22.5+) and otherwise
// tries to resolve it as an npm package named "sqlite". A type-only import
// (erased at compile time) is used above for typechecking. See DECISIONS.md.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * The relay's entire persistent state. Per spec: "It stores only group_id,
 * device push tokens, and the current session record... It stores no
 * personal data, no logs of activity, and no plaintext of what was blocked."
 * There is deliberately no audit/activity log table here — that lives only
 * on clients.
 */
export class RelayDb {
  private db: DatabaseSyncType;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        group_id TEXT PRIMARY KEY,
        pubkey TEXT
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        last_seen INTEGER NOT NULL,
        push_token TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        group_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ends_at INTEGER NOT NULL,
        categories TEXT NOT NULL,
        label TEXT,
        origin_device TEXT NOT NULL,
        nonce TEXT NOT NULL,
        signature TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairing_challenges (
        challenge_id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        group_id TEXT NOT NULL,
        salt_hex TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  getGroupPubkey(groupId: string): string | null {
    const row = this.db.prepare('SELECT pubkey FROM groups WHERE group_id = ?').get(groupId) as
      | { pubkey: string | null }
      | undefined;
    return row?.pubkey ?? null;
  }

  /** Idempotent: first pubkey seen for a group wins (see DECISIONS.md on the group-key trust model). */
  setGroupPubkeyIfAbsent(groupId: string, pubkey: string): void {
    const existing = this.getGroupPubkey(groupId);
    if (existing) return;
    this.db
      .prepare('INSERT INTO groups (group_id, pubkey) VALUES (?, ?) ON CONFLICT(group_id) DO UPDATE SET pubkey = excluded.pubkey')
      .run(groupId, pubkey);
  }

  upsertDevice(params: {
    id: string;
    groupId: string;
    name: string;
    platform: string;
    lastSeen: number;
    pushToken?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO devices (id, group_id, name, platform, last_seen, push_token)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           group_id = excluded.group_id,
           name = excluded.name,
           platform = excluded.platform,
           last_seen = excluded.last_seen,
           push_token = COALESCE(excluded.push_token, devices.push_token)`,
      )
      .run(params.id, params.groupId, params.name, params.platform, params.lastSeen, params.pushToken ?? null);
  }

  getCurrentSession(groupId: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE group_id = ?').get(groupId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      group_id: row.group_id as string,
      session_id: row.session_id as string,
      started_at: row.started_at as number,
      ends_at: row.ends_at as number,
      categories: JSON.parse(row.categories as string) as BlockCategoryId[],
      label: (row.label as string | null) ?? null,
      origin_device: row.origin_device as string,
      nonce: row.nonce as string,
      signature: row.signature as string,
    };
  }

  setCurrentSession(record: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions (group_id, session_id, started_at, ends_at, categories, label, origin_device, nonce, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET
           session_id = excluded.session_id,
           started_at = excluded.started_at,
           ends_at = excluded.ends_at,
           categories = excluded.categories,
           label = excluded.label,
           origin_device = excluded.origin_device,
           nonce = excluded.nonce,
           signature = excluded.signature`,
      )
      .run(
        record.group_id,
        record.session_id,
        record.started_at,
        record.ends_at,
        JSON.stringify(record.categories),
        record.label,
        record.origin_device,
        record.nonce,
        record.signature,
      );
  }

  createPairingChallenge(params: {
    challengeId: string;
    code: string;
    groupId: string;
    saltHex: string;
    expiresAt: number;
  }): void {
    this.db
      .prepare(
        'INSERT INTO pairing_challenges (challenge_id, code, group_id, salt_hex, expires_at, consumed) VALUES (?, ?, ?, ?, ?, 0)',
      )
      .run(params.challengeId, params.code, params.groupId, params.saltHex, params.expiresAt);
  }

  /** Returns the most recent non-expired, non-consumed challenge for a code, if any. */
  findActiveChallengeByCode(
    code: string,
    nowMs: number,
  ): { challengeId: string; groupId: string; saltHex: string; expiresAt: number } | null {
    const row = this.db
      .prepare(
        'SELECT challenge_id, group_id, salt_hex, expires_at FROM pairing_challenges WHERE code = ? AND consumed = 0 AND expires_at > ? ORDER BY expires_at DESC LIMIT 1',
      )
      .get(code, nowMs) as
      | { challenge_id: string; group_id: string; salt_hex: string; expires_at: number }
      | undefined;
    if (!row) return null;
    return { challengeId: row.challenge_id, groupId: row.group_id, saltHex: row.salt_hex, expiresAt: row.expires_at };
  }

  consumeChallenge(challengeId: string): void {
    this.db.prepare('UPDATE pairing_challenges SET consumed = 1 WHERE challenge_id = ?').run(challengeId);
  }
}
