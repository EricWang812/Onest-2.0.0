import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';
import type { SessionRecord } from './types.js';

export interface Ed25519KeyPair {
  publicKeyB64: string;
  privateKeyPem: string;
}

/** Generates a device signing keypair. Called once per device, on first run. */
export function generateDeviceKeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** Deterministic JSON: sorted keys, no whitespace. Required so sign/verify agree byte-for-byte. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function recordSigningPayload(record: Omit<SessionRecord, 'signature'>): Buffer {
  return Buffer.from(canonicalize(record), 'utf8');
}

/** Signs everything in `record` except `signature` with the device's ed25519 private key (PKCS8 PEM). */
export function signSessionRecord(
  record: Omit<SessionRecord, 'signature'>,
  privateKeyPem: string,
): string {
  const payload = recordSigningPayload(record);
  const sig = edSign(null, payload, privateKeyPem);
  return sig.toString('base64');
}

/** Verifies `record.signature` against the device's ed25519 public key (SPKI DER, base64). Never throws. */
export function verifySessionRecord(record: SessionRecord, publicKeyDerB64: string): boolean {
  const { signature, ...rest } = record;
  try {
    const payload = recordSigningPayload(rest);
    const spki = Buffer.from(publicKeyDerB64, 'base64');
    const pubKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return edVerify(null, payload, pubKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export function newSessionId(): string {
  return randomBytes(16).toString('hex');
}

export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

export function newGroupId(): string {
  return randomBytes(16).toString('hex');
}

/** 6-digit pairing code, zero-padded, uniform over 000000-999999. */
export function newPairingCode(): string {
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, '0');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
