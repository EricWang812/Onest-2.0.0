import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appDataDir } from './paths.js';

const STALE_MS = 2000;

function fileFor(name: 'daemon' | 'watchdog'): string {
  return join(appDataDir(), `${name}.heartbeat`);
}

export function writeHeartbeat(name: 'daemon' | 'watchdog'): void {
  try {
    writeFileSync(fileFor(name), String(Date.now()), 'utf8');
  } catch {
    // best effort
  }
}

/** true if the other process's heartbeat is missing or older than 2s. */
export function isStale(name: 'daemon' | 'watchdog'): boolean {
  try {
    const raw = readFileSync(fileFor(name), 'utf8');
    const ts = Number(raw);
    return !Number.isFinite(ts) || Date.now() - ts > STALE_MS;
  } catch {
    return true;
  }
}
