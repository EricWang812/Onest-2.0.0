import React, { useEffect, useState } from 'react';
import type { BlockCategoryId } from '@focus-lock/shared';
import { api, type Identity, type SessionState } from '../api.js';

const ALL_CATEGORIES: { id: BlockCategoryId; label: string }[] = [
  { id: 'social', label: 'Social' },
  { id: 'games', label: 'Games' },
  { id: 'video', label: 'Video' },
  { id: 'news', label: 'News / Forums' },
];

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }): React.JSX.Element {
  return (
    <div
      className={`toggle ${on ? 'on' : ''}`}
      onClick={disabled ? undefined : onClick}
      style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
    >
      <div className="toggle-knob" />
    </div>
  );
}

export function Settings({ state, connected }: { state: SessionState | null; connected: boolean }): React.JSX.Element {
  const [categories, setCategories] = useState<Set<BlockCategoryId>>(new Set(['social', 'games']));
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system');
  const [launchAtLogin, setLaunchAtLoginState] = useState(false);
  const [relayUrl, setRelayUrl] = useState('');
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [version, setVersion] = useState('0.1.0');
  // Every save below previously ignored whether the IPC call actually
  // succeeded, optimistically updating local state regardless — so a save
  // with no daemon connected looked identical to a real one. Found via the
  // no-daemon UI test pass alongside the Devices pairing bug (same root
  // cause: not checking `res.ok`).
  const [saveError, setSaveError] = useState<string | null>(null);

  async function trySave(promise: Promise<{ ok: boolean; error?: string }>): Promise<void> {
    const res = await promise;
    setSaveError(res.ok ? null : res.error ?? 'save failed — is the daemon running?');
  }

  useEffect(() => {
    (async () => {
      const savedCats = await api.getSetting('categories');
      if (savedCats.ok && savedCats.result) setCategories(new Set(JSON.parse(savedCats.result) as BlockCategoryId[]));
      const savedTheme = await api.getSetting('theme');
      if (savedTheme.ok && savedTheme.result) setTheme(savedTheme.result as 'system' | 'light' | 'dark');
      const savedRelay = await api.getSetting('relayUrl');
      if (savedRelay.ok && savedRelay.result) setRelayUrl(savedRelay.result);
      setLaunchAtLoginState(await api.getLaunchAtLogin());
      const idRes = await api.getIdentity();
      if (idRes.ok && idRes.result) setIdentity(idRes.result);
      setVersion(await api.getAppVersion());
    })();
  }, []);

  async function toggleCategory(id: BlockCategoryId): Promise<void> {
    if (state?.running) return;
    const next = new Set(categories);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCategories(next);
    await trySave(api.setSetting('categories', JSON.stringify([...next])));
  }

  async function saveTheme(next: 'system' | 'light' | 'dark'): Promise<void> {
    setTheme(next);
    await trySave(api.setSetting('theme', next));
  }

  async function saveRelayUrl(): Promise<void> {
    await trySave(api.setSetting('relayUrl', relayUrl));
  }

  return (
    <div>
      <h1 className="page-title">Settings</h1>
      {saveError && (
        <div className="card" style={{ marginBottom: 16, padding: 12, color: '#c76b6b', fontSize: 13 }}>
          {saveError}
        </div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Categories</div>
        {state?.running && (
          <div className="text-dim" style={{ fontSize: 12, marginBottom: 8 }}>
            Locked while a session is active.
          </div>
        )}
        {ALL_CATEGORIES.map((c) => (
          <div className="settings-row" key={c.id}>
            <span>{c.label}</span>
            <Toggle on={categories.has(c.id)} onClick={() => toggleCategory(c.id)} disabled={state?.running} />
          </div>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="settings-row">
          <span>Theme</span>
          <div className="chip-row">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <span key={t} className={`chip ${theme === t ? 'selected' : ''}`} onClick={() => saveTheme(t)}>{t}</span>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span>Launch at login</span>
          <Toggle
            on={launchAtLogin}
            onClick={async () => {
              const next = !launchAtLogin;
              setLaunchAtLoginState(next);
              await api.setLaunchAtLogin(next);
            }}
          />
        </div>
        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
          <span>Relay URL</span>
          <div style={{ display: 'flex', gap: 8, width: '100%' }}>
            <input type="text" value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} style={{ flex: 1 }} placeholder="ws://127.0.0.1:8787/ws" />
            <button className="chip" onClick={saveRelayUrl}>Save</button>
          </div>
          <div className="text-dim" style={{ fontSize: 11 }}>Takes effect after restarting the daemon.</div>
        </div>
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>About</div>
        <div className="settings-row"><span className="text-dim">Version</span><span>{version}</span></div>
        <div className="settings-row"><span className="text-dim">Daemon</span><span>{connected ? 'connected' : 'disconnected'}</span></div>
        {identity && (
          <>
            <div className="settings-row"><span className="text-dim">Device ID</span><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{identity.deviceId.slice(0, 12)}…</span></div>
            <div className="settings-row"><span className="text-dim">Group ID</span><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{identity.groupId.slice(0, 12)}…</span></div>
          </>
        )}
      </div>
    </div>
  );
}
