import { createServer, type Server, type Socket } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import { platform } from 'node:os';

/**
 * Newline-delimited JSON IPC over a named pipe (Windows) / unix socket
 * (macOS). This is the entire surface the UI can reach — deliberately no
 * "end session" / "cancel" / "stop" command exists here at all. It cannot
 * be added by a compromised or buggy renderer because the daemon simply
 * has no handler that would do it; there's nothing to bypass.
 */
export interface IpcRequest {
  id: string;
  cmd: string;
  args?: unknown;
}
export interface IpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type IpcHandler = (args: unknown) => Promise<unknown> | unknown;

export class IpcServer {
  private server: Server;
  private handlers = new Map<string, IpcHandler>();
  private sockets = new Set<Socket>();

  constructor(private readonly endpoint: string) {
    if (platform() !== 'win32' && existsSync(endpoint)) {
      try {
        unlinkSync(endpoint);
      } catch {
        // stale socket file from a previous run — best effort cleanup
      }
    }
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      // A socket with no 'error' listener crashes the entire Node process on
      // any transport-level error (Node's default behavior for an unhandled
      // 'error' event) — not a hypothetical, found live: broadcast()'s write
      // to a client that had already disconnected (every real client closes
      // its socket after each request/response, same as any reconnect or
      // app-quit) threw EPIPE with no listener, killing the whole daemon.
      // Since every session.state tick (every 500ms while running) and every
      // popup/pairing broadcast goes through this same write path, this
      // could fire on essentially any client disconnect timing, not just at
      // session completion — found via a real spawned-daemon test, not
      // reasoned about. A broken client connection is not the daemon's
      // problem; just stop tracking it.
      socket.on('error', () => this.sockets.delete(socket));
      this.handleConnection(socket);
    });
  }

  /** Unsolicited push to every connected UI (popup triggers, live countdown, session.update). */
  broadcast(event: string, payload: unknown): void {
    const line = `${JSON.stringify({ type: 'event', event, payload })}\n`;
    for (const socket of this.sockets) socket.write(line);
  }

  on(cmd: string, handler: IpcHandler): void {
    this.handlers.set(cmd, handler);
  }

  private handleConnection(socket: Socket): void {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newlineIdx: number;
      // eslint-disable-next-line no-cond-assign
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line.trim()) void this.handleLine(socket, line);
      }
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let req: IpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    const handler = this.handlers.get(req.cmd);
    const res: IpcResponse = handler
      ? await Promise.resolve(handler(req.args))
          .then((result) => ({ id: req.id, ok: true, result }))
          .catch((err: unknown) => ({ id: req.id, ok: false, error: String(err) }))
      : { id: req.id, ok: false, error: `unknown command: ${req.cmd}` };
    socket.write(`${JSON.stringify(res)}\n`);
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.endpoint, () => resolve());
    });
  }

  close(): void {
    this.server.close();
  }
}
