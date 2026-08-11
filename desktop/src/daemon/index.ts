import { spawn } from 'node:child_process';
import { platform as osPlatform, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { BlockCategoryId } from '@focus-lock/shared';
import { AuditLog } from './audit.js';
import { DesktopDb } from './db.js';
import { MacEnforcer } from './enforcement-macos.js';
import { WindowsEnforcer } from './enforcement-windows.js';
import type { Enforcer } from './enforcement.js';
import { isStale, writeHeartbeat } from './heartbeat.js';
import { IpcServer } from './ipc-server.js';
import { auditLogPath, dbPath, ipcEndpoint, ipcEndpointDev } from './paths.js';
import { PairingManager } from './pairing-manager.js';
import { RelayClient } from './relay-client.js';
import { bootstrapIdentity, SessionManager } from './session-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Overridable because the packaged installer ships daemon.bundle.js /
// watchdog.bundle.js as flat siblings in one resources dir, not the
// dist/{daemon,watchdog}/index.js subfolder layout this default assumes.
const WATCHDOG_ENTRY = process.env.FOCUSLOCK_WATCHDOG_ENTRY ?? join(__dirname, '..', 'watchdog', 'index.js');

function spawnWatchdog(): void {
  const child = spawn(process.execPath, [WATCHDOG_ENTRY, ...process.argv.slice(2)], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  // Optimistic placeholder so the next staleness check (up to 1s away) doesn't
  // see "no heartbeat yet" and spawn a second one before this one can write
  // its own — a real startup race this project hit during testing.
  writeHeartbeat('watchdog');
}

const DEV_MODE = process.env.FOCUSLOCK_DEV === '1';
const RELAY_URL = process.env.FOCUSLOCK_RELAY_URL ?? 'ws://127.0.0.1:8787/ws';

async function main(): Promise<void> {
  const audit = new AuditLog(auditLogPath());
  const db = new DesktopDb(dbPath()); // creates the app-data dir as a side effect

  const plat = osPlatform() === 'darwin' ? 'macos' : 'windows';
  const enforcer: Enforcer = plat === 'macos' ? new MacEnforcer(audit) : new WindowsEnforcer(audit);

  const identity = bootstrapIdentity(db, hostname(), plat);

  const ipc = new IpcServer(DEV_MODE ? ipcEndpointDev() : ipcEndpoint());

  const relay = new RelayClient(RELAY_URL, identity.groupId, identity.deviceId, identity.deviceName, identity.platform, identity.publicKeyB64);

  const manager = new SessionManager(db, enforcer, relay, ipc, audit, identity);

  // IPC surface: read state + start a session. No end/cancel/stop command exists.
  ipc.on('get_state', () => manager.getState());
  ipc.on('start_session', async (args) => {
    const { durationS, categories, label } = args as { durationS: number; categories: BlockCategoryId[]; label: string | null };
    await manager.startSession(durationS, categories, label);
    return manager.getState();
  });
  ipc.on('get_log', (args) => {
    const { sinceMs, untilMs } = args as { sinceMs: number; untilMs: number };
    return db.listSessions(sinceMs, untilMs);
  });
  ipc.on('list_devices', () => db.listDevices());
  ipc.on('get_setting', (args) => db.getSetting((args as { key: string }).key));
  ipc.on('set_setting', (args) => {
    const { key, value } = args as { key: string; value: string };
    if (manager.isRunning() && key === 'categories') {
      throw new Error('categories are locked while a session is active');
    }
    db.setSetting(key, value);
    return { ok: true };
  });
  ipc.on('get_identity', () => ({
    deviceId: identity.deviceId, groupId: identity.groupId, platform: identity.platform,
  }));
  const pairing = new PairingManager(db, relay, ipc, audit, identity);
  ipc.on('pairing_host_start', () => pairing.hostStart());
  ipc.on('pairing_joiner_start', (args) => {
    const { code } = args as { code: string };
    pairing.joinerStart(code);
    return { ok: true };
  });

  relay.on('connected', () => ipc.broadcast('relay.connected', {}));
  relay.on('disconnected', () => ipc.broadcast('relay.disconnected', {}));

  await manager.recoverOnStartup();
  await ipc.listen();
  relay.connect();

  // Mutual heartbeat with the watchdog (desktop/src/watchdog/index.ts does the same in reverse).
  // Write our own heartbeat BEFORE spawning it, so its first tick (which can
  // run before our next 1s interval fires) never sees a missing daemon
  // heartbeat and spawns a redundant second daemon.
  writeHeartbeat('daemon');
  // Only spawn a watchdog if one isn't already heartbeating — this branch is
  // also hit on a watchdog-triggered respawn, where a live watchdog already
  // exists. Spawning unconditionally here previously caused every kill+respawn
  // cycle to accumulate a second, redundant watchdog process (found via the
  // real process-kill integration test — see DECISIONS.md).
  if (isStale('watchdog')) spawnWatchdog();
  setInterval(() => {
    writeHeartbeat('daemon');
    if (isStale('watchdog')) {
      audit.log('watchdog_heartbeat_stale_respawning', {});
      spawnWatchdog();
    }
  }, 1000);

  audit.log('daemon_started', { platform: plat, devMode: DEV_MODE });
  // eslint-disable-next-line no-console
  console.log(`focus-lock daemon running (${plat}${DEV_MODE ? ', dev mode' : ''})`);

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      // No enforcement teardown here: killing/stopping the daemon must not
      // unblock anything. The watchdog restarts it; state on disk persists.
      audit.log('daemon_process_exiting', { signal: sig });
      ipc.close();
      db.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('daemon fatal error', err);
  process.exit(1);
});
