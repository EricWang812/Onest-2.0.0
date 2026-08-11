import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  spake2 as makeSpake2,
  type ClientSPAKE2State,
  type ClientSharedSecret,
  type ServerSPAKE2State,
  type ServerSharedSecret,
} from 'spake2';
import { PAIRING_CODE_TTL_S } from './types.js';
import { newPairingCode } from './crypto.js';

// Re-exported so downstream packages (e.g. the desktop daemon's
// pairing-manager.ts) can hold onto in-flight SPAKE2 state without
// depending on the `spake2` package directly.
export type { ClientSPAKE2State, ServerSPAKE2State };

/**
 * Pairing: a relay (or LAN peer) never sees the 6-digit code or derives the
 * session key from it. It only routes the SPAKE2 protocol messages produced
 * here between the host and joiner sockets. See DECISIONS.md for why the
 * `spake2` npm package was chosen and its "unaudited" caveat.
 */

const HOST_IDENTITY = 'focuslock-host';
const JOINER_IDENTITY = 'focuslock-joiner';
// Interactive-strength scrypt cost. The code only has ~20 bits of entropy,
// but SPAKE2 already forces an *online* guess per attempt (rate-limited by
// the relay's one-use/5-minute challenge), so this is defense in depth, not
// the primary protection.
const MHF_PARAMS = { n: 16384, r: 8, p: 1 };

function suite() {
  return makeSpake2({
    suite: 'ED25519-SHA256-HKDF-HMAC-SCRYPT',
    mhf: MHF_PARAMS,
    kdf: { AAD: '' },
  });
}

export interface PairingChallengeSeed {
  code: string;
  saltHex: string;
  challengeId: string;
  expiresAt: number;
}

export function createPairingChallengeSeed(now = Date.now()): PairingChallengeSeed {
  return {
    code: newPairingCode(),
    saltHex: randomBytes(16).toString('hex'),
    challengeId: randomBytes(8).toString('hex'),
    expiresAt: now + PAIRING_CODE_TTL_S * 1000,
  };
}

export interface HostPairingSession {
  state: ServerSPAKE2State;
  messageB64: string;
}

/** Host (the device displaying the code) side of the exchange — plays the SPAKE2 "server" role. */
export async function hostBeginPairing(code: string, saltHex: string): Promise<HostPairingSession> {
  const s = suite();
  const verifier = await s.computeVerifier(code, Buffer.from(saltHex, 'hex'));
  const state = await s.startServer(JOINER_IDENTITY, HOST_IDENTITY, verifier);
  return { state, messageB64: state.getMessage().toString('base64') };
}

export interface JoinerPairingSession {
  state: ClientSPAKE2State;
  messageB64: string;
}

/** Joining device (the one that typed the code) — plays the SPAKE2 "client" role. */
export async function joinerBeginPairing(code: string, saltHex: string): Promise<JoinerPairingSession> {
  const s = suite();
  const state = await s.startClient(JOINER_IDENTITY, HOST_IDENTITY, code, Buffer.from(saltHex, 'hex'));
  return { state, messageB64: state.getMessage().toString('base64') };
}

export interface PairingKeyMaterial {
  /** 16-byte AES-128-GCM key derived from the SPAKE2 transcript hash. */
  encryptionKey: Buffer;
  confirmationB64: string;
  verifyConfirmation(incomingB64: string): boolean;
}

function wrapSharedSecret(secret: ServerSharedSecret | ClientSharedSecret): PairingKeyMaterial {
  return {
    encryptionKey: secret.toBuffer(),
    confirmationB64: secret.getConfirmation().toString('base64'),
    verifyConfirmation(incomingB64: string): boolean {
      try {
        secret.verify(Buffer.from(incomingB64, 'base64'));
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function hostFinishPairing(state: ServerSPAKE2State, joinerMessageB64: string): PairingKeyMaterial {
  return wrapSharedSecret(state.finish(Buffer.from(joinerMessageB64, 'base64')));
}

export function joinerFinishPairing(state: ClientSPAKE2State, hostMessageB64: string): PairingKeyMaterial {
  return wrapSharedSecret(state.finish(Buffer.from(hostMessageB64, 'base64')));
}

export interface GroupKeyPayload {
  groupId: string;
  privateKeyPem: string;
  publicKeyB64: string;
}

/** AES-128-GCM-encrypts the group signing keypair for transport once SPAKE2 confirmation succeeds. */
export function encryptGroupKey(encryptionKey: Buffer, payload: GroupKeyPayload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-128-gcm', encryptionKey, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptGroupKey(encryptionKey: Buffer, blobB64: string): GroupKeyPayload {
  const raw = Buffer.from(blobB64, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv('aes-128-gcm', encryptionKey, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as GroupKeyPayload;
}
