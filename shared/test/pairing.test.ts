import { describe, expect, it } from 'vitest';
import {
  createPairingChallengeSeed,
  decryptGroupKey,
  encryptGroupKey,
  generateDeviceKeyPair,
  hostBeginPairing,
  hostFinishPairing,
  joinerBeginPairing,
  joinerFinishPairing,
  newGroupId,
} from '../src/index.js';

describe('pairing (SPAKE2)', () => {
  it('derives the same shared secret on both sides and transports the group key', async () => {
    const seed = createPairingChallengeSeed();

    const host = await hostBeginPairing(seed.code, seed.saltHex);
    const joiner = await joinerBeginPairing(seed.code, seed.saltHex);

    const hostKeyMaterial = hostFinishPairing(host.state, joiner.messageB64);
    const joinerKeyMaterial = joinerFinishPairing(joiner.state, host.messageB64);

    expect(hostKeyMaterial.encryptionKey.equals(joinerKeyMaterial.encryptionKey)).toBe(true);
    expect(joinerKeyMaterial.verifyConfirmation(hostKeyMaterial.confirmationB64)).toBe(true);
    expect(hostKeyMaterial.verifyConfirmation(joinerKeyMaterial.confirmationB64)).toBe(true);

    const kp = generateDeviceKeyPair();
    const groupId = newGroupId();
    const blob = encryptGroupKey(hostKeyMaterial.encryptionKey, {
      groupId,
      privateKeyPem: kp.privateKeyPem,
      publicKeyB64: kp.publicKeyB64,
    });

    const decrypted = decryptGroupKey(joinerKeyMaterial.encryptionKey, blob);
    expect(decrypted.groupId).toBe(groupId);
    expect(decrypted.privateKeyPem).toBe(kp.privateKeyPem);
    expect(decrypted.publicKeyB64).toBe(kp.publicKeyB64);
  });

  it('fails when the joiner uses the wrong code (confirmation mismatch)', async () => {
    const seed = createPairingChallengeSeed();

    const host = await hostBeginPairing(seed.code, seed.saltHex);
    const joiner = await joinerBeginPairing('000000' === seed.code ? '111111' : '000000', seed.saltHex);

    const hostKeyMaterial = hostFinishPairing(host.state, joiner.messageB64);
    const joinerKeyMaterial = joinerFinishPairing(joiner.state, host.messageB64);

    expect(joinerKeyMaterial.verifyConfirmation(hostKeyMaterial.confirmationB64)).toBe(false);
  });

  it('rejects decryption with the wrong key', async () => {
    const seed = createPairingChallengeSeed();
    const host = await hostBeginPairing(seed.code, seed.saltHex);
    const joiner = await joinerBeginPairing(seed.code, seed.saltHex);
    const hostKeyMaterial = hostFinishPairing(host.state, joiner.messageB64);

    const kp = generateDeviceKeyPair();
    const blob = encryptGroupKey(hostKeyMaterial.encryptionKey, {
      groupId: 'g', privateKeyPem: kp.privateKeyPem, publicKeyB64: kp.publicKeyB64,
    });

    const wrongKey = Buffer.alloc(16, 7);
    expect(() => decryptGroupKey(wrongKey, blob)).toThrow();
  });
});
