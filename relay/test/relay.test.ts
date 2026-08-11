import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
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
  newSessionId,
  signSessionRecord,
  type ClientToServerMessage,
  type ServerToClientMessage,
  type SessionRecord,
} from '@focus-lock/shared';
import { RelayDb } from '../src/db.js';
import { buildServer } from '../src/server.js';

let tmpDir: string;
let db: RelayDb;
let app: ReturnType<typeof buildServer>;
let baseUrl: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'focuslock-relay-'));
  db = new RelayDb(join(tmpDir, 'relay.sqlite'));
  app = buildServer(db);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `ws://127.0.0.1:${port}/ws`;
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// A persistent listener + queue, not one-shot `ws.once('message', ...)` per
// await: two server sends with no I/O gap between them (as pairing.group_key
// + pairing.complete are) can arrive in the same socket read and fire as two
// synchronous 'message' events before an await-then-register-next-listener
// pattern gets a chance to register the second listener, silently dropping
// it. Real clients (desktop daemon, mobile) must use this queueing pattern
// too — see desktop/daemon/src/relay-client.ts.
const queues = new WeakMap<WebSocket, ServerToClientMessage[]>();
const waiters = new WeakMap<WebSocket, ((msg: ServerToClientMessage) => void)[]>();

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl);
    queues.set(ws, []);
    waiters.set(ws, []);
    ws.on('message', (raw) => {
      const parsed = JSON.parse(raw.toString()) as ServerToClientMessage;
      const pending = waiters.get(ws)!;
      const resolve = pending.shift();
      if (resolve) resolve(parsed);
      else queues.get(ws)!.push(parsed);
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<ServerToClientMessage> {
  const queue = queues.get(ws)!;
  if (queue.length > 0) return Promise.resolve(queue.shift()!);
  return new Promise((resolve) => waiters.get(ws)!.push(resolve));
}

function sendMsg(ws: WebSocket, msg: ClientToServerMessage): void {
  ws.send(JSON.stringify(msg));
}

describe('relay: pairing handshake end-to-end', () => {
  it('routes SPAKE2 + group key so both devices derive the same key material and reject a wrong code', async () => {
    const hostWs = await connect();
    const joinerWs = await connect();

    const seed = createPairingChallengeSeed();
    sendMsg(hostWs, { type: 'pairing.host_start', code: seed.code, salt_hex: seed.saltHex, group_id: seed.challengeId });
    const hostParams = (await nextMessage(hostWs)) as Extract<ServerToClientMessage, { type: 'pairing.params' }>;
    expect(hostParams.type).toBe('pairing.params');

    sendMsg(joinerWs, { type: 'pairing.joiner_start', code: seed.code });
    const joinerParams = (await nextMessage(joinerWs)) as Extract<ServerToClientMessage, { type: 'pairing.params' }>;
    expect(joinerParams.challenge_id).toBe(hostParams.challenge_id);
    expect(joinerParams.salt_hex).toBe(seed.saltHex);

    const hostSession = await hostBeginPairing(seed.code, seed.saltHex);
    const joinerSession = await joinerBeginPairing(seed.code, seed.saltHex);

    sendMsg(hostWs, { type: 'pairing.spake2_msg', challenge_id: hostParams.challenge_id, payload: hostSession.messageB64 });
    const joinerGotHostMsg = (await nextMessage(joinerWs)) as Extract<ServerToClientMessage, { type: 'pairing.spake2_msg' }>;

    sendMsg(joinerWs, { type: 'pairing.spake2_msg', challenge_id: hostParams.challenge_id, payload: joinerSession.messageB64 });
    const hostGotJoinerMsg = (await nextMessage(hostWs)) as Extract<ServerToClientMessage, { type: 'pairing.spake2_msg' }>;

    const hostKeyMaterial = hostFinishPairing(hostSession.state, hostGotJoinerMsg.payload);
    const joinerKeyMaterial = joinerFinishPairing(joinerSession.state, joinerGotHostMsg.payload);
    expect(hostKeyMaterial.encryptionKey.equals(joinerKeyMaterial.encryptionKey)).toBe(true);

    const kp = generateDeviceKeyPair();
    const groupId = newGroupId();
    const blob = encryptGroupKey(hostKeyMaterial.encryptionKey, {
      groupId,
      privateKeyPem: kp.privateKeyPem,
      publicKeyB64: kp.publicKeyB64,
    });
    sendMsg(hostWs, { type: 'pairing.group_key', challenge_id: hostParams.challenge_id, blob });

    const joinerGotKey = (await nextMessage(joinerWs)) as Extract<ServerToClientMessage, { type: 'pairing.group_key' }>;
    const decrypted = decryptGroupKey(joinerKeyMaterial.encryptionKey, joinerGotKey.blob);
    expect(decrypted.groupId).toBe(groupId);

    const hostComplete = await nextMessage(hostWs);
    expect(hostComplete.type).toBe('pairing.complete');
    const joinerComplete = await nextMessage(joinerWs);
    expect(joinerComplete.type).toBe('pairing.complete');

    hostWs.close();
    joinerWs.close();
  });

  it('rejects a joiner using an unknown code', async () => {
    const joinerWs = await connect();
    sendMsg(joinerWs, { type: 'pairing.joiner_start', code: '000000' });
    const msg = await nextMessage(joinerWs);
    expect(msg.type).toBe('pairing.error');
    joinerWs.close();
  });
});

describe('relay: signed session records', () => {
  it('broadcasts a validly signed session to all group members and reconciles on connect', async () => {
    const groupId = newGroupId();
    const kp = generateDeviceKeyPair();

    const wsA = await connect();
    sendMsg(wsA, {
      type: 'hello',
      group_id: groupId,
      device_id: 'device-a',
      device_name: 'Desktop',
      platform: 'windows',
      pubkey: kp.publicKeyB64,
    });
    const helloReplyA = await nextMessage(wsA);
    expect(helloReplyA).toEqual({ type: 'session.update', record: null });

    const wsB = await connect();
    sendMsg(wsB, { type: 'hello', group_id: groupId, device_id: 'device-b', device_name: 'Phone', platform: 'android' });
    await nextMessage(wsB); // initial null reconciliation

    const record: Omit<SessionRecord, 'signature'> = {
      group_id: groupId,
      session_id: newSessionId(),
      started_at: Date.now(),
      ends_at: Date.now() + 60_000,
      categories: ['social'],
      label: 'deep work',
      origin_device: 'device-a',
      nonce: 'n1',
    };
    const signature = signSessionRecord(record, kp.privateKeyPem);
    const full: SessionRecord = { ...record, signature };

    sendMsg(wsA, { type: 'session.publish', record: full });
    const broadcastToA = (await nextMessage(wsA)) as Extract<ServerToClientMessage, { type: 'session.update' }>;
    const broadcastToB = (await nextMessage(wsB)) as Extract<ServerToClientMessage, { type: 'session.update' }>;
    expect(broadcastToA.record?.session_id).toBe(record.session_id);
    expect(broadcastToB.record?.session_id).toBe(record.session_id);

    // A third device reconnecting later reconciles against the relay's current record.
    const wsC = await connect();
    sendMsg(wsC, { type: 'hello', group_id: groupId, device_id: 'device-c', device_name: 'Laptop', platform: 'macos' });
    const helloReplyC = (await nextMessage(wsC)) as Extract<ServerToClientMessage, { type: 'session.update' }>;
    expect(helloReplyC.record?.session_id).toBe(record.session_id);

    wsA.close();
    wsB.close();
    wsC.close();
  });

  it('rejects a session record with an invalid signature', async () => {
    const groupId = newGroupId();
    const kp = generateDeviceKeyPair();
    const attacker = generateDeviceKeyPair();

    const ws = await connect();
    sendMsg(ws, { type: 'hello', group_id: groupId, device_id: 'device-a', device_name: 'Desktop', platform: 'windows', pubkey: kp.publicKeyB64 });
    await nextMessage(ws);

    const record: Omit<SessionRecord, 'signature'> = {
      group_id: groupId,
      session_id: newSessionId(),
      started_at: Date.now(),
      ends_at: Date.now() + 60_000,
      categories: ['games'],
      label: null,
      origin_device: 'device-a',
      nonce: 'n2',
    };
    // Signed by the WRONG key.
    const signature = signSessionRecord(record, attacker.privateKeyPem);
    const forged: SessionRecord = { ...record, signature };

    sendMsg(ws, { type: 'session.publish', record: forged });
    const reply = await nextMessage(ws);
    expect(reply.type).toBe('error');
    if (reply.type === 'error') expect(reply.reason).toMatch(/signature/);

    expect(db.getCurrentSession(groupId)).toBeNull();
    ws.close();
  });

  it('rejects a session record with no group key registered yet', async () => {
    const groupId = newGroupId();
    const kp = generateDeviceKeyPair();
    const ws = await connect();
    // No `hello` with pubkey sent — group has no registered key.
    const record: Omit<SessionRecord, 'signature'> = {
      group_id: groupId,
      session_id: newSessionId(),
      started_at: Date.now(),
      ends_at: Date.now() + 60_000,
      categories: ['games'],
      label: null,
      origin_device: 'device-a',
      nonce: 'n3',
    };
    const signature = signSessionRecord(record, kp.privateKeyPem);
    sendMsg(ws, { type: 'session.publish', record: { ...record, signature } });
    const reply = await nextMessage(ws);
    expect(reply.type).toBe('error');
    ws.close();
  });

  it('rejects a session record longer than the 8-hour cap', async () => {
    const groupId = newGroupId();
    const kp = generateDeviceKeyPair();
    const ws = await connect();
    sendMsg(ws, { type: 'hello', group_id: groupId, device_id: 'device-a', device_name: 'Desktop', platform: 'windows', pubkey: kp.publicKeyB64 });
    await nextMessage(ws);

    const record: Omit<SessionRecord, 'signature'> = {
      group_id: groupId,
      session_id: newSessionId(),
      started_at: Date.now(),
      ends_at: Date.now() + 9 * 60 * 60 * 1000,
      categories: ['games'],
      label: null,
      origin_device: 'device-a',
      nonce: 'n4',
    };
    const signature = signSessionRecord(record, kp.privateKeyPem);
    sendMsg(ws, { type: 'session.publish', record: { ...record, signature } });
    const reply = await nextMessage(ws);
    expect(reply.type).toBe('error');
    ws.close();
  });
});
