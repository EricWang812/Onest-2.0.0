/**
 * Protocol types shared by relay, desktop daemon, and (eventually) the
 * Android/iOS clients. This file has no runtime dependencies so it can be
 * ported/mirrored by hand into Kotlin/Swift where a shared TS package isn't
 * possible.
 */

export type Platform = 'windows' | 'macos' | 'android' | 'ios';

export type BlockCategoryId = 'social' | 'games' | 'video' | 'news';

/** Hard safety cap. A session record with a longer span must be rejected by every client. */
export const MAX_SESSION_DURATION_S = 8 * 60 * 60;

/** How long a pairing code stays valid after generation. */
export const PAIRING_CODE_TTL_S = 5 * 60;

/**
 * The single record the relay stores and every client enforces from.
 * Everything except `signature` is signed; clients recompute the signature
 * over the canonical (sorted-key, no-whitespace) JSON of every field below
 * except `signature` itself, using the originating device's public key.
 */
export interface SessionRecord {
  group_id: string;
  session_id: string;
  /** ms epoch, set by the originating device's monotonic-anchored clock */
  started_at: number;
  /** ms epoch */
  ends_at: number;
  categories: BlockCategoryId[];
  label: string | null;
  origin_device: string;
  /** random per-session value; prevents replay of a stale signed record */
  nonce: string;
  /** base64 ed25519 signature over canonicalize(record without `signature`) */
  signature: string;
}

export interface DeviceRecord {
  id: string;
  name: string;
  platform: Platform;
  /** ms epoch of last contact with the relay (or LAN peer) */
  last_seen: number;
  /** base64 ed25519 public key, used to verify this device's session records */
  pubkey: string;
}

export interface DeviceGroup {
  group_id: string;
  /** base64 ed25519 public key of the group's signing keypair (may be per-device; see DECISIONS.md) */
  devices: DeviceRecord[];
}

/** Server-side pairing session state (relay + LAN-direct mode share this shape). */
export interface PairingChallenge {
  group_id: string;
  code: string;
  created_at: number;
  expires_at: number;
  consumed: boolean;
}

/**
 * Pairing over WS is a blind-relay design: the relay never runs SPAKE2 math,
 * it only looks up a challenge by its human code and forwards opaque
 * messages between the two sockets that share a challenge_id. See
 * shared/src/pairing.ts for the actual cryptography.
 */
export type ServerToClientMessage =
  | { type: 'session.update'; record: SessionRecord | null }
  | { type: 'pairing.params'; challenge_id: string; salt_hex: string; group_id: string }
  | { type: 'pairing.spake2_msg'; challenge_id: string; payload: string }
  | { type: 'pairing.group_key'; challenge_id: string; blob: string }
  | { type: 'pairing.complete'; challenge_id: string }
  | { type: 'pairing.error'; reason: string }
  | { type: 'error'; reason: string };

export type ClientToServerMessage =
  | { type: 'hello'; group_id: string; device_id: string; device_name: string; platform: Platform; pubkey?: string; push_token?: string }
  | { type: 'session.publish'; record: SessionRecord }
  | { type: 'pairing.host_start'; code: string; salt_hex: string; group_id: string }
  | { type: 'pairing.joiner_start'; code: string }
  | { type: 'pairing.spake2_msg'; challenge_id: string; payload: string }
  | { type: 'pairing.group_key'; challenge_id: string; blob: string };

/** Local, per-client crash-recovery record — the dead-man's-switch input. */
export interface ActiveSessionRow {
  session_id: string;
  ends_at: number;
  categories: BlockCategoryId[];
  label: string | null;
  started_at: number;
  origin_device: string;
}

export interface LoggedSession {
  id: string;
  started_at: number;
  ended_at: number | null;
  planned_duration_s: number;
  actual_duration_s: number | null;
  label: string | null;
  completed: boolean;
  origin_device: string;
}
