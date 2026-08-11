import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import {
  MAX_SESSION_DURATION_S,
  evaluateSessionRecord,
  newNonce,
  verifySessionRecord,
  type ClientToServerMessage,
  type ServerToClientMessage,
} from '@focus-lock/shared';
import { RelayDb } from './db.js';

interface SocketMeta {
  groupId?: string;
  deviceId?: string;
  challengeId?: string;
  role?: 'host' | 'joiner';
}

/**
 * Blind-relay pairing + signed-session broadcast. No accounts: a socket is
 * scoped to a group only after `hello` names a group_id, and pairing routes
 * opaque SPAKE2 bytes between exactly two sockets sharing a challenge_id —
 * this file never touches pairing cryptography (see shared/src/pairing.ts).
 */
export function buildServer(db: RelayDb): FastifyInstance {
  const app = Fastify({ logger: false });

  const groupSockets = new Map<string, Set<WebSocket>>();
  const challengeSockets = new Map<string, { host?: WebSocket; joiner?: WebSocket }>();
  const meta = new WeakMap<WebSocket, SocketMeta>();

  function send(ws: WebSocket, msg: ServerToClientMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function broadcastToGroup(groupId: string, msg: ServerToClientMessage): void {
    for (const ws of groupSockets.get(groupId) ?? []) send(ws, msg);
  }

  function otherPeer(challengeId: string, sender: WebSocket): WebSocket | undefined {
    const pair = challengeSockets.get(challengeId);
    if (!pair) return undefined;
    if (pair.host === sender) return pair.joiner;
    if (pair.joiner === sender) return pair.host;
    return undefined;
  }

  function removeSocket(ws: WebSocket): void {
    const m = meta.get(ws);
    if (!m) return;
    if (m.groupId) groupSockets.get(m.groupId)?.delete(ws);
    if (m.challengeId) {
      const pair = challengeSockets.get(m.challengeId);
      if (pair) {
        if (pair.host === ws) pair.host = undefined;
        if (pair.joiner === ws) pair.joiner = undefined;
        if (!pair.host && !pair.joiner) challengeSockets.delete(m.challengeId);
      }
    }
  }

  app.register(fastifyWebsocket);

  app.register(async (instance) => {
    instance.get('/ws', { websocket: true }, (socket) => {
      const ws = socket as unknown as WebSocket;
      meta.set(ws, {});

      ws.on('message', (raw: Buffer) => {
        let parsed: ClientToServerMessage;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          send(ws, { type: 'error', reason: 'malformed message' });
          return;
        }
        handleMessage(ws, parsed);
      });

      ws.on('close', () => removeSocket(ws));
    });
  });

  function handleMessage(ws: WebSocket, msg: ClientToServerMessage): void {
    const now = Date.now();
    switch (msg.type) {
      case 'hello': {
        const m = meta.get(ws) ?? {};
        m.groupId = msg.group_id;
        m.deviceId = msg.device_id;
        meta.set(ws, m);
        if (!groupSockets.has(msg.group_id)) groupSockets.set(msg.group_id, new Set());
        groupSockets.get(msg.group_id)!.add(ws);
        db.upsertDevice({
          id: msg.device_id,
          groupId: msg.group_id,
          name: msg.device_name,
          platform: msg.platform,
          lastSeen: now,
          pushToken: msg.push_token,
        });
        if (msg.pubkey) db.setGroupPubkeyIfAbsent(msg.group_id, msg.pubkey);
        // Reconciliation: every client gets the relay's current record on connect.
        send(ws, { type: 'session.update', record: db.getCurrentSession(msg.group_id) });
        return;
      }

      case 'session.publish': {
        const record = msg.record;
        const pubkey = db.getGroupPubkey(record.group_id);
        if (!pubkey) {
          send(ws, { type: 'error', reason: 'group has no registered signing key yet' });
          return;
        }
        const evalResult = evaluateSessionRecord(record, now);
        if (!evalResult.valid) {
          send(ws, { type: 'error', reason: `rejected: ${evalResult.reason}` });
          return;
        }
        if ((record.ends_at - record.started_at) / 1000 > MAX_SESSION_DURATION_S) {
          send(ws, { type: 'error', reason: 'session exceeds 8h cap' });
          return;
        }
        if (!verifySessionRecord(record, pubkey)) {
          send(ws, { type: 'error', reason: 'invalid signature' });
          return;
        }
        db.setCurrentSession(record);
        broadcastToGroup(record.group_id, { type: 'session.update', record });
        return;
      }

      case 'pairing.host_start': {
        const challengeId = newNonce();
        db.createPairingChallenge({
          challengeId,
          code: msg.code,
          groupId: msg.group_id,
          saltHex: msg.salt_hex,
          expiresAt: now + 5 * 60_000,
        });
        challengeSockets.set(challengeId, { host: ws });
        const m = meta.get(ws) ?? {};
        m.challengeId = challengeId;
        m.role = 'host';
        meta.set(ws, m);
        send(ws, { type: 'pairing.params', challenge_id: challengeId, salt_hex: msg.salt_hex, group_id: msg.group_id });
        return;
      }

      case 'pairing.joiner_start': {
        const found = db.findActiveChallengeByCode(msg.code, now);
        if (!found) {
          send(ws, { type: 'pairing.error', reason: 'invalid or expired code' });
          return;
        }
        const pair = challengeSockets.get(found.challengeId) ?? {};
        pair.joiner = ws;
        challengeSockets.set(found.challengeId, pair);
        const m = meta.get(ws) ?? {};
        m.challengeId = found.challengeId;
        m.role = 'joiner';
        meta.set(ws, m);
        send(ws, {
          type: 'pairing.params',
          challenge_id: found.challengeId,
          salt_hex: found.saltHex,
          group_id: found.groupId,
        });
        return;
      }

      case 'pairing.spake2_msg': {
        const peer = otherPeer(msg.challenge_id, ws);
        if (!peer) {
          send(ws, { type: 'pairing.error', reason: 'peer not connected' });
          return;
        }
        send(peer, { type: 'pairing.spake2_msg', challenge_id: msg.challenge_id, payload: msg.payload });
        return;
      }

      case 'pairing.group_key': {
        const peer = otherPeer(msg.challenge_id, ws);
        if (!peer) {
          send(ws, { type: 'pairing.error', reason: 'peer not connected' });
          return;
        }
        send(peer, { type: 'pairing.group_key', challenge_id: msg.challenge_id, blob: msg.blob });
        db.consumeChallenge(msg.challenge_id);
        send(ws, { type: 'pairing.complete', challenge_id: msg.challenge_id });
        send(peer, { type: 'pairing.complete', challenge_id: msg.challenge_id });
        challengeSockets.delete(msg.challenge_id);
        return;
      }
    }
  }

  return app;
}
