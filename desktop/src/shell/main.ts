import { app, BrowserWindow, Menu, nativeImage, screen, Tray, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { platform } from 'node:os';
import { ipcEndpoint, ipcEndpointDev } from '../daemon/paths.js';
import { IpcClient } from './ipc-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEV_MODE = process.env.FOCUSLOCK_DEV === '1';

// Placeholder 16x16 tray icon (a simple filled circle) so Tray() never
// throws on a machine with no real asset installed yet. Ship a real
// multi-resolution .ico/.png via the installer before release — see
// desktop/build/README and DECISIONS.md.
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAdklEQVR4Ae3XsQ2AMAxE0TsmYAym' +
  'YQIYg2mYgAlIQZEqRUqf4i9dqrOe/lLuI4QIgiAI3iPYOyLiKSKm7v40s9OtE0mSJEmSJEmSJEmS' +
  'JEmSJEmSJEmS9G9BEARBEARBEAT/CXbnnHNmZmZmZmZmiIiI+ADYWzRB4bTvBQAAAABJRU5ErkJggg==';

// Without this, an uncaught exception in any timer/async callback (the
// popup double-close bug below is the concrete case that surfaced this)
// takes down the *entire* Electron main process silently — tray, main
// window, and the IPC bridge to the daemon all die with it, so nothing
// after the crash can ever show a popup again (enforcement itself keeps
// running fine, since that lives in the separate daemon service).
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[main uncaughtException]', err);
});

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let popupWindow: BrowserWindow | null = null;
let popupWindowReady = false;
let popupAutoDismiss: NodeJS.Timeout | null = null;

const ipc = new IpcClient(DEV_MODE ? ipcEndpointDev() : ipcEndpoint());

function createMainWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    title: 'Onest',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(join(__dirname, '..', 'shell', 'renderer', 'index.html'));
  // Forwarded to the main process's own stdout/log so a blank-page report
  // can actually be diagnosed (a packaged app has no visible devtools by
  // default) — see DECISIONS.md for the bug this caught.
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // eslint-disable-next-line no-console
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    // eslint-disable-next-line no-console
    console.error(`[renderer did-fail-load] ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    // eslint-disable-next-line no-console
    console.error(`[renderer process gone] ${JSON.stringify(details)}`);
  });
  mainWindow.on('close', (e) => {
    // Closing the window hides it; it does not quit the app. The tray
    // process (and therefore popups + relay-of-daemon-events) keeps running.
    if (!(app as unknown as { isQuitting?: boolean }).isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  tray = new Tray(icon);
  tray.setToolTip('Onest');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Onest', click: () => createMainWindow() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          (app as unknown as { isQuitting: boolean }).isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => createMainWindow());
}

/**
 * Blocked-app popup: frameless, always-on-top, centered on the active
 * display, ~380x180, fades in, auto-dismisses after 6s, no unblock
 * affordance of any kind — Dismiss only closes the window. Coalescing and
 * rate-limiting already happened daemon-side (desktop/src/daemon/session-manager.ts);
 * this just renders whatever single batch it was told about.
 */
let popupPendingPayload: { items: Array<{ kind: string; name: string }>; remainingMs: number; reason: string } | null = null;

function clearPopupAutoDismiss(): void {
  if (popupAutoDismiss) clearTimeout(popupAutoDismiss);
  popupAutoDismiss = null;
}

function closePopupWindow(): void {
  // `popupWindow?.close()` alone isn't enough: optional chaining only
  // guards against `popupWindow` being null, not against it being a
  // *destroyed-but-still-non-null* reference — Electron throws
  // "Object has been destroyed" from calling most BrowserWindow methods
  // (close() included) after destroy. That's exactly what happened here:
  // clicking Dismiss closed the window immediately but left the 6s
  // auto-dismiss timer scheduled; when it later fired, this same line
  // ran again on the now-destroyed window and threw from inside a
  // Timeout callback — an uncaught exception with no handler in this
  // file, which took down the entire Electron main process (tray, main
  // window, and the daemon IPC bridge all die with it — the only thing
  // that survives is enforcement itself, which lives in the daemon
  // service, not here). Once the shell is dead, no *future* popup can
  // ever render either, regardless of what triggered it — which is why
  // this one crash also explained "popups only show for the first app
  // blocked, never afterward, website or not."
  if (popupWindow && !popupWindow.isDestroyed()) popupWindow.close();
}

function showBlockedPopup(payload: { items: Array<{ kind: string; name: string }>; remainingMs: number; reason: string }): void {
  clearPopupAutoDismiss();
  popupAutoDismiss = setTimeout(closePopupWindow, 6000);

  if (!popupWindow || popupWindow.isDestroyed()) {
    popupWindowReady = false;
    popupPendingPayload = payload;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const width = 380;
    const height = 180;
    popupWindow = new BrowserWindow({
      width,
      height,
      x: Math.round(display.bounds.x + (display.bounds.width - width) / 2),
      y: Math.round(display.bounds.y + (display.bounds.height - height) / 2),
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      show: false,
      opacity: 0,
      webPreferences: {
        preload: join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // Reset all popup-window-scoped state on close, whichever of the three
    // paths (manual Dismiss, the 6s auto-dismiss, or an unexpected close)
    // triggered it — otherwise `popupWindow` is left as a stale non-null
    // reference to a destroyed object, which is the root cause above.
    popupWindow.on('closed', () => {
      popupWindow = null;
      popupWindowReady = false;
      clearPopupAutoDismiss();
    });
    popupWindow.loadFile(join(__dirname, '..', 'shell', 'popup', 'popup.html'));
    popupWindow.once('ready-to-show', () => {
      popupWindow?.show();
      fadeIn(popupWindow!);
    });
    // `webContents.send` right after `loadFile` used to race the renderer's
    // own preload/mount: loadFile is async, so the very first popup on a
    // freshly-created window was sent before popup.tsx had registered its
    // `onPopupData` listener and was silently lost — the window appeared
    // (frame/fade-in are main-process-driven) but rendered empty, since
    // `payload` in popup.tsx never left `null`. Because the window closes
    // itself after every auto-dismiss, *every* popup was a fresh window, so
    // this was a 100%-repro "no text ever" bug, not an occasional one.
    // did-finish-load guarantees the page (and therefore preload's
    // `contextBridge` listener) is ready before the first send. Reading
    // `popupPendingPayload` (not the closed-over `payload`) at fire time
    // covers a second hit arriving before the first load finishes too.
    popupWindow.webContents.once('did-finish-load', () => {
      popupWindowReady = true;
      if (popupPendingPayload) popupWindow?.webContents.send('popup:data', popupPendingPayload);
    });
    return;
  }

  if (popupWindowReady) {
    popupWindow.webContents.send('popup:data', payload);
  } else {
    popupPendingPayload = payload;
  }
}

function fadeIn(win: BrowserWindow): void {
  let opacity = 0;
  const step = () => {
    if (win.isDestroyed()) return;
    opacity = Math.min(1, opacity + 0.15);
    win.setOpacity(opacity);
    if (opacity < 1) setTimeout(step, 150 / 6);
  };
  step();
}

function wireDaemonEvents(): void {
  ipc.on('blocked.popup', (payload) => showBlockedPopup(payload as never));
  ipc.on('session.state', (payload) => mainWindow?.webContents.send('daemon:session.state', payload));
  ipc.on('session.complete', (payload) => {
    mainWindow?.webContents.send('daemon:session.complete', payload);
  });
  ipc.on('pairing.status', (payload) => mainWindow?.webContents.send('daemon:pairing.status', payload));
  ipc.on('daemon.connected', () => mainWindow?.webContents.send('daemon:connected', {}));
  ipc.on('daemon.disconnected', () => mainWindow?.webContents.send('daemon:disconnected', {}));
}

function wireIpcMainBridge(): void {
  const passthrough = [
    'get_state', 'start_session', 'get_log', 'list_devices', 'get_setting', 'set_setting',
    'get_identity', 'pairing_host_start', 'pairing_joiner_start',
  ];
  for (const cmd of passthrough) {
    ipcMain.handle(cmd, async (_evt, args) => ipc.request(cmd, args));
  }
  ipcMain.on('popup:dismiss', () => closePopupWindow());

  // Launch-at-login is an OS/Electron-level setting (app.setLoginItemSettings),
  // not daemon state, so it's handled here rather than round-tripped to the daemon.
  // Since Onest.exe now ships with requestedExecutionLevel: requireAdministrator
  // (electron-builder.yml — needed for the shell to reach the daemon's
  // SYSTEM-owned named pipe at all), Windows will show a UAC prompt on this
  // auto-start launch too, same as any other launch. That's an accepted,
  // known trade-off, not an oversight: a silent-elevate auto-start would
  // need a Task-Scheduler-based launch mechanism instead of the standard
  // Run-key/Startup-folder one Electron uses here, which is out of scope
  // for what was actually broken (the daemon connection).
  ipcMain.handle('get_launch_at_login', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('set_launch_at_login', (_evt, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return { ok: true };
  });
  ipcMain.handle('get_app_version', () => app.getVersion());
}

app.whenReady().then(() => {
  if (platform() === 'win32') app.setAppUserModelId('com.onest.app');
  createTray();
  createMainWindow();
  wireIpcMainBridge();
  wireDaemonEvents();
  ipc.connect();
});

app.on('window-all-closed', () => {
  // Deliberately does nothing — see the tray Quit handler above. This is
  // what makes "closing the app does nothing" true for the popup/UI layer;
  // enforcement itself never depended on this process at all.
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
