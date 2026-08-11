import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isStale, writeHeartbeat } from '../daemon/heartbeat.js';

/**
 * A second elevated process with no session-ending authority at all — it
 * cannot end a session because it has no IPC connection to the daemon and
 * no code path that would do so; its only job is watching a heartbeat file
 * and respawning the daemon if it goes stale. The daemon does the same for
 * this process (see desktop/src/daemon/index.ts's own respawn loop).
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
// See the matching comment in desktop/src/daemon/index.ts.
const DAEMON_ENTRY = process.env.FOCUSLOCK_DAEMON_ENTRY ?? join(__dirname, '..', 'daemon', 'index.js');

function spawnDaemon(): void {
  // Forward argv (e.g. a --data-dir test marker) so it survives every respawn hop.
  const child = spawn(process.execPath, [DAEMON_ENTRY, ...process.argv.slice(2)], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  // Optimistic placeholder — see the matching comment in desktop/src/daemon/index.ts.
  writeHeartbeat('daemon');
}

function tick(): void {
  writeHeartbeat('watchdog');
  if (isStale('daemon')) {
    // eslint-disable-next-line no-console
    console.log('watchdog: daemon heartbeat stale, respawning');
    spawnDaemon();
  }
}

setInterval(tick, 1000);
tick();
// eslint-disable-next-line no-console
console.log('focus-lock watchdog running');
