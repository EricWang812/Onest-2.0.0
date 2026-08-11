import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { ClientToServerMessage, Platform, ServerToClientMessage, SessionRecord } from '@focus-lock/shared';

/**
 * Persistent-listener event emitter, not one-shot listeners per pending
 * call — see DECISIONS.md / relay/test/relay.test.ts for the race this
 * avoids (two server sends with no I/O gap can arrive as two synchronous
 * 'message' events before an await-then-relisten pattern registers the
 * second listener).
 */
export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private shouldReconnect = true;
  private reconnectDelayMs = 1000;

  constructor(
    private readonly url: string,
    private readonly groupId: string,
    private readonly deviceId: string,
    private readonly deviceName: string,
    private readonly platform: Platform,
    private readonly pubkeyB64: string,
  ) {
    super();
  }

  connect(): void {
    this.shouldReconnect = true;
    this.openSocket();
  }

  private openSocket(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectDelayMs = 1000;
      this.send({
        type: 'hello',
        group_id: this.groupId,
        device_id: this.deviceId,
        device_name: this.deviceName,
        platform: this.platform,
        pubkey: this.pubkeyB64,
      });
      this.emit('connected');
    });

    ws.on('message', (raw: Buffer) => {
      let msg: ServerToClientMessage;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      this.emit(msg.type, msg);
    });

    ws.on('close', () => {
      this.emit('disconnected');
      if (this.shouldReconnect) this.scheduleReconnect();
    });
    ws.on('error', () => {
      // 'close' follows; reconnect is scheduled there.
    });
  }

  private scheduleReconnect(): void {
    setTimeout(() => {
      if (this.shouldReconnect) this.openSocket();
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.ws?.close();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private send(msg: ClientToServerMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  publishSession(record: SessionRecord): void {
    this.send({ type: 'session.publish', record });
  }

  hostStartPairing(code: string, saltHex: string, groupId: string): void {
    this.send({ type: 'pairing.host_start', code, salt_hex: saltHex, group_id: groupId });
  }

  joinerStartPairing(code: string): void {
    this.send({ type: 'pairing.joiner_start', code });
  }

  sendSpake2Msg(challengeId: string, payload: string): void {
    this.send({ type: 'pairing.spake2_msg', challenge_id: challengeId, payload });
  }

  sendGroupKey(challengeId: string, blob: string): void {
    this.send({ type: 'pairing.group_key', challenge_id: challengeId, blob });
  }
}
