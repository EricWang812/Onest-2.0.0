import type { BlockCategoryId, DeviceRecord, LoggedSession, Platform } from '@focus-lock/shared';

export interface SessionState {
  running: boolean;
  remainingMs: number;
  label: string | null;
  categories: BlockCategoryId[];
  sessionId: string | null;
}

export interface Identity {
  deviceId: string;
  groupId: string;
  platform: Platform;
}

export interface FocusLockWindowApi {
  getState(): Promise<{ ok: boolean; result?: SessionState }>;
  startSession(durationS: number, categories: BlockCategoryId[], label: string | null): Promise<{ ok: boolean; error?: string }>;
  getLog(sinceMs: number, untilMs: number): Promise<{ ok: boolean; result?: LoggedSession[] }>;
  listDevices(): Promise<{ ok: boolean; result?: DeviceRecord[] }>;
  getSetting(key: string): Promise<{ ok: boolean; result?: string | null }>;
  setSetting(key: string, value: string): Promise<{ ok: boolean; error?: string }>;
  getIdentity(): Promise<{ ok: boolean; result?: Identity }>;
  pairingHostStart(): Promise<{ ok: boolean; result?: { code: string; expiresAt: number } }>;
  pairingJoinerStart(code: string): Promise<{ ok: boolean }>;
  getLaunchAtLogin(): Promise<boolean>;
  setLaunchAtLogin(enabled: boolean): Promise<{ ok: boolean }>;
  getAppVersion(): Promise<string>;
  onSessionState(cb: (state: SessionState) => void): void;
  onSessionComplete(cb: (payload: { durationLabel: string; label: string | null }) => void): void;
  onDaemonConnected(cb: () => void): void;
  onDaemonDisconnected(cb: () => void): void;
  onPairingStatus(cb: (payload: { state: string; reason?: string; challengeId?: string }) => void): void;
}

declare global {
  interface Window {
    focusLock: FocusLockWindowApi;
  }
}

export const api: FocusLockWindowApi = window.focusLock;
