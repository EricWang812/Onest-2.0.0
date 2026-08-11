import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** OS app-data path, per spec ("Local SQLite... at the OS app-data path"). */
export function appDataDir(): string {
  if (process.env.FOCUSLOCK_DATA_DIR) return process.env.FOCUSLOCK_DATA_DIR;
  const plat = platform();
  if (plat === 'win32') {
    return join(process.env.PROGRAMDATA ?? 'C:/ProgramData', 'Onest');
  }
  if (plat === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Onest');
  }
  return join(homedir(), '.onest');
}

export function dbPath(): string {
  return join(appDataDir(), 'onest.sqlite');
}

export function auditLogPath(): string {
  return join(appDataDir(), 'audit.log');
}

export function deviceKeyPath(): string {
  return join(appDataDir(), 'device-key.json');
}

export function ipcEndpoint(): string {
  return platform() === 'win32' ? '\\\\.\\pipe\\onest' : '/var/run/onest.sock';
}

/** Dev-mode fallback so this runs without admin/root while iterating locally. */
export function ipcEndpointDev(): string {
  if (process.env.FOCUSLOCK_IPC_PATH) return process.env.FOCUSLOCK_IPC_PATH;
  return platform() === 'win32' ? '\\\\.\\pipe\\onest-dev' : join(appDataDir(), 'onest-dev.sock');
}
