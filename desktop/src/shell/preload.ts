import { contextBridge, ipcRenderer } from 'electron';

/**
 * The entire surface the renderer can reach. Every call here is a thin
 * `ipcRenderer.invoke` to a daemon command that itself has no session-ending
 * handler — see desktop/src/daemon/index.ts. There is deliberately no
 * `endSession`/`cancelSession`/`stopSession` exposed, because there is
 * nothing on the other end that would honor it.
 */
const api = {
  getState: () => ipcRenderer.invoke('get_state'),
  startSession: (durationS: number, categories: string[], label: string | null) =>
    ipcRenderer.invoke('start_session', { durationS, categories, label }),
  getLog: (sinceMs: number, untilMs: number) => ipcRenderer.invoke('get_log', { sinceMs, untilMs }),
  listDevices: () => ipcRenderer.invoke('list_devices'),
  getSetting: (key: string) => ipcRenderer.invoke('get_setting', { key }),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('set_setting', { key, value }),
  getIdentity: () => ipcRenderer.invoke('get_identity'),
  // Kicks off the SPAKE2 flow; the daemon (desktop/src/daemon/pairing-manager.ts)
  // owns the whole exchange from here — the renderer only gets status updates.
  pairingHostStart: () => ipcRenderer.invoke('pairing_host_start'),
  pairingJoinerStart: (code: string) => ipcRenderer.invoke('pairing_joiner_start', { code }),
  getLaunchAtLogin: () => ipcRenderer.invoke('get_launch_at_login'),
  setLaunchAtLogin: (enabled: boolean) => ipcRenderer.invoke('set_launch_at_login', enabled),
  getAppVersion: () => ipcRenderer.invoke('get_app_version'),

  onSessionState: (cb: (state: unknown) => void) => {
    ipcRenderer.on('daemon:session.state', (_e, payload) => cb(payload));
  },
  onSessionComplete: (cb: (payload: unknown) => void) => {
    ipcRenderer.on('daemon:session.complete', (_e, payload) => cb(payload));
  },
  onDaemonConnected: (cb: () => void) => ipcRenderer.on('daemon:connected', () => cb()),
  onDaemonDisconnected: (cb: () => void) => ipcRenderer.on('daemon:disconnected', () => cb()),
  onPairingStatus: (cb: (payload: unknown) => void) => {
    ipcRenderer.on('daemon:pairing.status', (_e, payload) => cb(payload));
  },

  // Blocked-app popup window only.
  onPopupData: (cb: (payload: unknown) => void) => {
    ipcRenderer.on('popup:data', (_e, payload) => cb(payload));
  },
  dismissPopup: () => ipcRenderer.send('popup:dismiss'),
};

export type FocusLockApi = typeof api;

contextBridge.exposeInMainWorld('focusLock', api);
