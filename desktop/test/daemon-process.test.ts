import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Real end-to-end process tests: spawn the actual compiled daemon (which
 * itself spawns the actual compiled watchdog, exactly as in production)
 * against a real, temp-dir-redirected hosts file, and drive it over its
 * real IPC pipe — no mocked Enforcer anywhere in this file. Two independent
 * scenarios, each with its own daemon instance so they can't interfere with
 * each other's timing:
 *   1. kill resilience — the block survives a SIGKILL and the watchdog
 *      respawns the daemon.
 *   2. natural completion — a short session's block is actually removed
 *      when its clock expires on its own, not just killed. This was a real
 *      gap: the existing session-manager.test.ts completion test only
 *      proves the *sequencing* logic calls a mocked removeBlock(), never
 *      that a real hosts-file block actually clears end to end.
 *
 * Windows-only (this project's primary dev target); skipped elsewhere.
 * Requires `npm run build:daemon` to have produced desktop/dist/{daemon,watchdog}.
 */
const IS_WINDOWS = platform() === 'win32';
const desktopRoot = join(__dirname, '..');
const daemonEntry = join(desktopRoot, 'dist', 'daemon', 'index.js');
const watchdogEntry = join(desktopRoot, 'dist', 'watchdog', 'index.js');

function killAllTestProcesses(dataDir: string): void {
  if (!IS_WINDOWS) return;
  // `-like` is a wildcard match, not regex — it needs no backslash escaping.
  // Match on just the temp dir's unique basename to sidestep path-separator
  // issues entirely.
  const marker = dataDir.split(/[\\/]/).pop();
  try {
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
  } catch {
    // best effort — nothing more we can do from a test
  }
}

function readHosts(hostsFile: string): string {
  return existsSync(hostsFile) ? readFileSync(hostsFile, 'utf8') : '';
}

// Dispatches by `id`, not "first line wins" — the daemon can (and for
// start_session, always does) write an unsolicited `{type:'event',...}`
// broadcast down the same socket before the RPC response line, since
// SessionManager broadcasts session.state from inside startSession() before
// its handler returns. A naive first-line reader misreads the broadcast as
// the response. Real IPC clients (desktop/src/shell/ipc-client.ts) must use
// this same id-dispatch pattern, not a one-shot "next line" read.
function sendIpc(pipePath: string, cmd: string, args: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipePath);
    const id = Math.random().toString(36).slice(2);
    let buf = '';
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, cmd, args })}\n`));
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx: number;
      // eslint-disable-next-line no-cond-assign
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const parsed = JSON.parse(line);
        if (parsed.type === 'event') continue; // unsolicited broadcast — not our response
        if (parsed.id === id) {
          socket.end();
          resolve(parsed);
          return;
        }
      }
    });
    socket.on('error', reject);
  });
}

async function waitFor(conditionFn: () => Promise<boolean> | boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await conditionFn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return conditionFn();
}

function canConnect(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function spawnDaemon(dataDir: string, hostsFile: string, pipePath: string): Promise<ChildProcess> {
  const env = {
    ...process.env,
    FOCUSLOCK_DEV: '1',
    FOCUSLOCK_DATA_DIR: dataDir,
    FOCUSLOCK_HOSTS_PATH: hostsFile,
    FOCUSLOCK_IPC_PATH: pipePath,
    FOCUSLOCK_RELAY_URL: 'ws://127.0.0.1:1/ws', // unreachable on purpose; daemon must start anyway
  };
  const proc = spawn(process.execPath, [daemonEntry, `--data-dir=${dataDir}`], { env, stdio: 'ignore' });
  const ready = await waitFor(() => canConnect(pipePath), 8000, 150);
  if (!ready) throw new Error('daemon did not open its IPC pipe in time');
  return proc;
}

describe.skipIf(!IS_WINDOWS || !existsSync(daemonEntry) || !existsSync(watchdogEntry))(
  'daemon process resilience (real spawned processes)',
  () => {
    let dataDir: string;
    let hostsFile: string;
    let pipePath: string;
    let daemonProc: ChildProcess | null = null;

    beforeAll(async () => {
      dataDir = mkdtempSync(join(tmpdir(), 'focuslock-proc-'));
      hostsFile = join(dataDir, 'hosts.txt');
      pipePath = `\\\\.\\pipe\\focuslock-test-${Date.now()}`;
      daemonProc = await spawnDaemon(dataDir, hostsFile, pipePath);
    }, 20000);

    afterAll(async () => {
      killAllTestProcesses(dataDir);
      // Windows can hold file handles open briefly after a process is
      // terminated; retry the cleanup rather than fail the whole suite on it.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(dataDir, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    });

    it('starts a session and writes a real hosts-file block', async () => {
      const res = await sendIpc(pipePath, 'start_session', {
        durationS: 120,
        categories: ['social'],
        label: 'integration test',
      });
      expect(res.ok).toBe(true);
      const hosts = readHosts(hostsFile);
      expect(hosts).toContain('FOCUSLOCK-BEGIN');
      expect(hosts).toMatch(/0\.0\.0\.0 facebook\.com/);
    });

    it('keeps the block intact and respawns the daemon within a few seconds of being killed', async () => {
      const hostsBeforeKill = readHosts(hostsFile);
      expect(hostsBeforeKill).toContain('FOCUSLOCK-BEGIN');

      const killedAt = Date.now();
      daemonProc?.kill('SIGKILL'); // the Task-Manager-equivalent: no graceful shutdown path runs

      // Blocking is OS-level state (a file on disk); it must not depend on the process being alive.
      const hostsRightAfterKill = readHosts(hostsFile);
      expect(hostsRightAfterKill).toContain('FOCUSLOCK-BEGIN');

      const heartbeatPath = join(dataDir, 'daemon.heartbeat');
      const heartbeatAtKill = existsSync(heartbeatPath) ? readFileSync(heartbeatPath, 'utf8') : '';

      const recovered = await waitFor(() => {
        if (!existsSync(heartbeatPath)) return false;
        const value = readFileSync(heartbeatPath, 'utf8');
        return value !== heartbeatAtKill && Number(value) > killedAt;
      }, 8000, 100);

      expect(recovered).toBe(true);
      // Confirm the block survived across the entire gap, not just at the two sampled instants.
      expect(readHosts(hostsFile)).toContain('FOCUSLOCK-BEGIN');
    }, 15000);
  },
);

describe.skipIf(!IS_WINDOWS || !existsSync(daemonEntry) || !existsSync(watchdogEntry))(
  'daemon process resilience (real spawned processes) — natural completion',
  () => {
    // Own daemon instance, deliberately separate from the kill-resilience
    // suite above: that suite starts a 120s session it depends on staying
    // active across two tests, so this scenario (which needs a session that
    // actually finishes) can't share it without either waiting ~120s or
    // racing the other suite's assumptions. A fresh daemon with nothing
    // else going on is simpler and faster than threading shared state
    // between the two.
    let dataDir: string;
    let hostsFile: string;
    let pipePath: string;
    let daemonProc: ChildProcess | null = null;

    beforeAll(async () => {
      dataDir = mkdtempSync(join(tmpdir(), 'focuslock-proc-complete-'));
      hostsFile = join(dataDir, 'hosts.txt');
      pipePath = `\\\\.\\pipe\\focuslock-test-complete-${Date.now()}`;
      daemonProc = await spawnDaemon(dataDir, hostsFile, pipePath);
    }, 20000);

    afterAll(async () => {
      daemonProc?.kill('SIGKILL');
      killAllTestProcesses(dataDir);
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(dataDir, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    });

    it('removes the real hosts-file block once the session clock expires on its own', async () => {
      const res = await sendIpc(pipePath, 'start_session', {
        durationS: 3,
        categories: ['social'],
        label: 'natural completion test',
      });
      expect(res.ok).toBe(true);
      expect(readHosts(hostsFile)).toContain('FOCUSLOCK-BEGIN');

      // SessionManager's tick loop runs every 500ms (session-manager.ts's
      // TICK_MS) and only calls completeSession() once SessionClock.isExpired()
      // — poll get_state rather than a fixed sleep, so this isn't fragile to
      // exact timing, but bound it well past the 3s duration.
      const completed = await waitFor(async () => {
        const state = await sendIpc(pipePath, 'get_state', {});
        return state.ok && (state.result as { running: boolean }).running === false;
      }, 8000, 200);

      expect(completed).toBe(true);
      // The real assertion this test exists for: not "the code called
      // removeBlock()" (session-manager.test.ts already proves that against
      // a mock) but that the actual hosts file, on disk, no longer contains
      // any part of the managed block — enforcement-windows.ts's
      // removeBlock() strips the entire FOCUSLOCK-BEGIN..END region when
      // categories is empty, not just the domain lines inside it.
      const hostsAfterCompletion = readHosts(hostsFile);
      expect(hostsAfterCompletion).not.toContain('FOCUSLOCK-BEGIN');
      expect(hostsAfterCompletion).not.toContain('FOCUSLOCK-END');
      expect(hostsAfterCompletion).not.toMatch(/0\.0\.0\.0 facebook\.com/);
    }, 15000);
  },
);
