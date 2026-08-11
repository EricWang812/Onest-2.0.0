import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';

interface PendingRequest {
  resolve: (value: { ok: boolean; result?: unknown; error?: string }) => void;
}

/**
 * Talks to the daemon over the local IPC pipe/socket. Dispatches every
 * incoming line by `id` (RPC responses) or `{type:'event'}` (unsolicited
 * broadcasts — session.state, blocked.popup, session.complete, pairing.*),
 * never by "the next line must be my response" — see DECISIONS.md for the
 * bug that pattern causes (a broadcast can legitimately arrive between a
 * request and its own response on the same connection).
 *
 * This client has no method that could end a session. It literally cannot
 * ask the daemon to do that — the daemon has no handler for it.
 */
export class IpcClient extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = '';
  private pending = new Map<string, PendingRequest>();
  private reconnectDelayMs = 500;
  private shouldReconnect = true;

  constructor(private readonly endpoint: string) {
    super();
  }

  connect(): void {
    this.shouldReconnect = true;
    this.openSocket();
  }

  private openSocket(): void {
    const socket = connect(this.endpoint);
    this.socket = socket;

    socket.on('connect', () => {
      this.reconnectDelayMs = 500;
      this.emit('daemon.connected');
    });

    socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      let idx: number;
      // eslint-disable-next-line no-cond-assign
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        this.handleLine(line);
      }
    });

    socket.on('close', () => {
      this.emit('daemon.disconnected');
      if (this.shouldReconnect) {
        setTimeout(() => this.openSocket(), this.reconnectDelayMs);
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 10_000);
      }
    });

    socket.on('error', () => {
      // 'close' follows; reconnect handled there.
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: { id?: string; type?: string; event?: string; payload?: unknown; ok?: boolean; result?: unknown; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'event' && msg.event) {
      this.emit(msg.event, msg.payload);
      return;
    }
    if (msg.id) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        pending.resolve({ ok: Boolean(msg.ok), result: msg.result, error: msg.error });
      }
    }
  }

  request<T = unknown>(cmd: string, args?: unknown): Promise<{ ok: boolean; result?: T; error?: string }> {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      this.pending.set(id, { resolve: resolve as PendingRequest['resolve'] });
      const line = `${JSON.stringify({ id, cmd, args })}\n`;
      if (this.socket && !this.socket.destroyed) {
        this.socket.write(line);
      } else {
        this.pending.delete(id);
        resolve({ ok: false, error: 'not connected to daemon' });
      }
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.socket?.destroy();
  }
}
