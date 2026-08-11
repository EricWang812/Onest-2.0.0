import {
  createPairingChallengeSeed,
  decryptGroupKey,
  encryptGroupKey,
  hostBeginPairing,
  hostFinishPairing,
  joinerBeginPairing,
  joinerFinishPairing,
  type ClientSPAKE2State,
  type ServerSPAKE2State,
} from '@focus-lock/shared';
import type { AuditLog } from './audit.js';
import type { DesktopDb } from './db.js';
import type { DeviceIdentity } from './session-manager.js';
import type { RelayClient } from './relay-client.js';
import type { IpcServer } from './ipc-server.js';

interface HostFlow {
  role: 'host';
  challengeId: string;
  saltHex: string;
  state: ServerSPAKE2State;
  pendingMessageB64?: string;
}
interface JoinerFlow {
  role: 'joiner';
  challengeId: string;
  saltHex: string;
  code: string;
  state: ClientSPAKE2State;
  encryptionKey?: Buffer;
}

/**
 * Owns the SPAKE2 state machine for pairing. The daemon holds this (not the
 * Electron shell) because it's the daemon that owns the device's signing
 * keypair and the relay connection — see DECISIONS.md. The relay itself
 * only ever sees opaque routed bytes (shared/src/pairing.ts + relay/src/server.ts).
 */
export class PairingManager {
  private hostFlow: HostFlow | null = null;
  private joinerFlow: JoinerFlow | null = null;
  private pendingJoinerCode: string | null = null;

  constructor(
    private readonly db: DesktopDb,
    private readonly relay: RelayClient,
    private readonly ipc: IpcServer,
    private readonly audit: AuditLog,
    private readonly identity: DeviceIdentity,
  ) {
    relay.on('pairing.spake2_msg', (msg: { challenge_id: string; payload: string }) => {
      void this.onSpake2Msg(msg.challenge_id, msg.payload);
    });
    relay.on('pairing.params', (msg: { challenge_id: string; salt_hex: string; group_id: string }) => {
      void this.onParams(msg);
    });
    relay.on('pairing.group_key', (msg: { challenge_id: string; blob: string }) => {
      void this.onGroupKey(msg.challenge_id, msg.blob);
    });
    relay.on('pairing.error', (msg: { reason: string }) => {
      // "peer not connected" is the expected, normal state of the world
      // between the host proactively sending its first SPAKE2 message (as
      // soon as the relay assigns a challenge_id) and a joiner actually
      // entering the code — it is not a failure, the code is still valid
      // and still waiting. Treating it as fatal here made a perfectly
      // healthy "waiting for joiner" code flash "Pairing failed" to the
      // user within about a second of every single pairing attempt — found
      // via a real live-daemon UI test, not a code read. Only genuine
      // failures (an actually invalid/expired code) should reach the UI.
      if (msg.reason === 'peer not connected') {
        this.audit.log('pairing_peer_not_yet_connected', {});
        return;
      }
      this.ipc.broadcast('pairing.status', { state: 'error', reason: msg.reason });
    });
  }

  /** Host role: the device already in the group generates a code and displays it. */
  async hostStart(): Promise<{ code: string; expiresAt: number }> {
    const seed = createPairingChallengeSeed();
    const { state, messageB64 } = await hostBeginPairing(seed.code, seed.saltHex);
    this.hostFlow = { role: 'host', challengeId: seed.challengeId, saltHex: seed.saltHex, state, pendingMessageB64: messageB64 };
    this.relay.hostStartPairing(seed.code, seed.saltHex, this.identity.groupId);
    this.audit.log('pairing_host_started', {});
    return { code: seed.code, expiresAt: seed.expiresAt };
  }

  /** Joiner role: a new device that was just handed a 6-digit code. */
  joinerStart(code: string): void {
    this.joinerFlow = null; // reset any prior attempt
    this.relay.joinerStartPairing(code);
    this.pendingJoinerCode = code;
    this.audit.log('pairing_joiner_started', {});
  }

  /** Relay assigned a challenge_id in response to our host_start OR the joiner's joiner_start. */
  private async onParams(msg: { challenge_id: string; salt_hex: string; group_id: string }): Promise<void> {
    if (this.hostFlow) {
      this.hostFlow.challengeId = msg.challenge_id;
      if (this.hostFlow.pendingMessageB64) this.relay.sendSpake2Msg(msg.challenge_id, this.hostFlow.pendingMessageB64);
      this.ipc.broadcast('pairing.status', { state: 'waiting_for_joiner', challengeId: msg.challenge_id });
      return;
    }
    if (!this.pendingJoinerCode) return;
    const { state, messageB64 } = await joinerBeginPairing(this.pendingJoinerCode, msg.salt_hex);
    this.joinerFlow = { role: 'joiner', challengeId: msg.challenge_id, saltHex: msg.salt_hex, code: this.pendingJoinerCode, state };
    this.pendingJoinerCode = null;
    this.relay.sendSpake2Msg(msg.challenge_id, messageB64);
    this.ipc.broadcast('pairing.status', { state: 'exchanging', challengeId: msg.challenge_id });
  }

  private async onSpake2Msg(challengeId: string, payload: string): Promise<void> {
    if (this.hostFlow && this.hostFlow.challengeId === challengeId) {
      const keyMaterial = hostFinishPairing(this.hostFlow.state, payload);
      const blob = encryptGroupKey(keyMaterial.encryptionKey, {
        groupId: this.identity.groupId,
        privateKeyPem: this.identity.privateKeyPem,
        publicKeyB64: this.identity.publicKeyB64,
      });
      this.relay.sendGroupKey(challengeId, blob);
      this.audit.log('pairing_group_key_sent', {});
      return;
    }
    if (this.joinerFlow && this.joinerFlow.challengeId === challengeId) {
      // This is the host's SPAKE2 message relayed back to us; finish our side.
      const keyMaterial = joinerFinishPairing(this.joinerFlow.state, payload);
      this.joinerFlow.encryptionKey = keyMaterial.encryptionKey;
    }
  }

  private async onGroupKey(challengeId: string, blob: string): Promise<void> {
    if (!this.joinerFlow || this.joinerFlow.challengeId !== challengeId) return;
    const encryptionKey = this.joinerFlow.encryptionKey;
    if (!encryptionKey) {
      this.ipc.broadcast('pairing.status', { state: 'error', reason: 'group key arrived before key exchange finished' });
      return;
    }
    try {
      const payload = decryptGroupKey(encryptionKey, blob);
      this.db.setSetting('group_id', payload.groupId);
      this.db.setSetting('device_pubkey', payload.publicKeyB64);
      this.db.setSetting('device_privkey', payload.privateKeyPem);
      this.audit.log('pairing_completed_identity_adopted', { groupId: payload.groupId });
      this.ipc.broadcast('pairing.status', { state: 'complete' });
      // The daemon was constructed with the OLD (self-generated) identity;
      // rather than hot-swap RelayClient/SessionManager state at runtime,
      // exit and let the watchdog respawn us within ~2s — a clean restart
      // picks the new shared identity up from disk. No session can be
      // active on a device that was mid-pairing, so this is safe. See
      // DECISIONS.md.
      setTimeout(() => process.exit(0), 250);
    } catch (err) {
      this.audit.log('pairing_group_key_decrypt_failed', { error: String(err) });
      this.ipc.broadcast('pairing.status', { state: 'error', reason: 'failed to decrypt group key' });
    }
  }
}
