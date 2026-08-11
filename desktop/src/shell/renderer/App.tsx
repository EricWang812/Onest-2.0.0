import React, { useEffect, useState } from 'react';
import type { DeviceRecord } from '@focus-lock/shared';
import { api, type SessionState } from './api.js';
import { Home } from './pages/Home.js';
import { Log } from './pages/Log.js';
import { Devices } from './pages/Devices.js';
import { Settings } from './pages/Settings.js';

type View = 'home' | 'log' | 'devices' | 'settings';

const NAV: { id: View; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'log', label: 'Log' },
  { id: 'devices', label: 'Devices' },
  { id: 'settings', label: 'Settings' },
];

export function App(): React.JSX.Element {
  const [view, setView] = useState<View>('home');
  const [state, setState] = useState<SessionState | null>(null);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [connected, setConnected] = useState(false);
  const [completeToast, setCompleteToast] = useState<{ durationLabel: string; label: string | null } | null>(null);

  async function refreshDevices(): Promise<void> {
    const res = await api.listDevices();
    if (res.ok && res.result) setDevices(res.result);
  }

  useEffect(() => {
    api.getState().then((res) => {
      if (res.ok && res.result) setState(res.result);
      // The main process's IPC client connects to the daemon as soon as the
      // window is created — often before this renderer has finished
      // mounting and registering onDaemonConnected below, so the one-shot
      // 'daemon:connected' event can fire into nobody and "Daemon
      // disconnected" gets stuck forever even though every call actually
      // works (found via a real live-daemon UI test: Start ran a genuine
      // session while the sidebar still said disconnected). A successful
      // IPC round-trip is itself proof of connection, so trust that too.
      if (res.ok) setConnected(true);
    });
    refreshDevices();
    const devicePoll = setInterval(refreshDevices, 10_000);

    api.onSessionState((s) => setState(s));
    api.onSessionComplete((payload) => {
      setCompleteToast(payload);
      setTimeout(() => setCompleteToast(null), 6000);
      refreshDevices();
    });
    api.onDaemonConnected(() => setConnected(true));
    api.onDaemonDisconnected(() => setConnected(false));

    return () => clearInterval(devicePoll);
  }, []);

  return (
    <div className="app-shell">
      <div className="sidebar">
        <div className="sidebar-brand">Onest</div>
        {NAV.map((n) => (
          <div key={n.id} className={`nav-item ${view === n.id ? 'active' : ''}`} onClick={() => setView(n.id)}>
            {n.label}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <div className="text-dim" style={{ fontSize: 11, padding: '0 12px' }}>
          {connected ? 'Daemon connected' : 'Daemon disconnected'}
        </div>
      </div>
      <div className="content">
        {completeToast && (
          <div className="card" style={{ marginBottom: 16, padding: 16 }}>
            Focus session complete — {completeToast.durationLabel}
            {completeToast.label ? ` — ${completeToast.label}` : ''}
          </div>
        )}
        {view === 'home' && <Home state={state} devices={devices} />}
        {view === 'log' && <Log />}
        {view === 'devices' && <Devices devices={devices} state={state} onRefresh={refreshDevices} />}
        {view === 'settings' && <Settings state={state} connected={connected} />}
      </div>
    </div>
  );
}
