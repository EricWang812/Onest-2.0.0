import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { DeviceRecord } from '@focus-lock/shared';
import { api, type SessionState } from '../api.js';

function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function Devices({ devices, state, onRefresh }: { devices: DeviceRecord[]; state: SessionState | null; onRefresh: () => void }): React.JSX.Element {
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number; qrDataUrl: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    api.onPairingStatus((payload) => {
      setStatus(payload.state);
      if (payload.state === 'complete') {
        setTimeout(() => {
          setPairing(null);
          setStatus(null);
          onRefresh();
        }, 1500);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startPairing(): Promise<void> {
    setStatus('generating');
    const res = await api.pairingHostStart();
    if (res.ok && res.result) {
      const qrDataUrl = await QRCode.toDataURL(res.result.code, { margin: 1, width: 180 });
      setPairing({ code: res.result.code, expiresAt: res.result.expiresAt, qrDataUrl });
      setStatus('waiting_for_joiner');
    } else {
      setStatus('error');
    }
  }

  const remainingS = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0;
  const expired = pairing !== null && remainingS <= 0;

  return (
    <div>
      <h1 className="page-title">Devices</h1>

      <div className="card" style={{ marginBottom: 20 }}>
        {devices.length === 0 ? (
          <div className="empty-state">No paired devices yet.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Device</th><th>Platform</th><th>Last seen</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {devices.map((d) => {
                const fresh = Date.now() - d.last_seen < 30_000;
                return (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td className="text-dim">{d.platform}</td>
                    <td className="text-dim">{timeAgo(d.last_seen)}</td>
                    <td>
                      <span className={`dot ${fresh ? 'green' : 'amber'}`} style={{ marginRight: 6 }} />
                      {fresh ? 'enforcing' : 'last seen ' + timeAgo(d.last_seen)}
                    </td>
                    <td>
                      <button
                        className="chip"
                        disabled={state?.running}
                        title={state?.running ? 'Unpairing is blocked during an active session' : 'Device removal is not implemented in this build'}
                      >
                        Unpair
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ maxWidth: 420 }}>
        {/* Gated on `status`, not `pairing`: an IPC-level failure (e.g. no
            daemon connected) never sets `pairing`, so gating on that left
            a click on "Pair new device" produce zero visible feedback —
            found via a real no-daemon UI test, not a code read. */}
        {!status ? (
          <button className="btn-primary" onClick={startPairing}>Pair new device</button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            {status === 'generating' ? (
              <div className="text-dim">Generating code…</div>
            ) : status === 'error' || expired ? (
              <>
                <div className="text-dim">{expired ? 'Code expired.' : 'Pairing failed. Is the daemon running?'}</div>
                <button className="btn-primary" onClick={startPairing}>Generate a new code</button>
              </>
            ) : status === 'complete' ? (
              <div style={{ fontWeight: 600 }}>Device paired ✓</div>
            ) : pairing ? (
              <>
                <img src={pairing.qrDataUrl} width={180} height={180} alt="pairing QR code" />
                <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: 4 }}>{pairing.code}</div>
                <div className="text-dim" style={{ fontSize: 13 }}>
                  Expires in {Math.floor(remainingS / 60)}:{String(remainingS % 60).padStart(2, '0')}
                  {status === 'exchanging' && ' — connecting…'}
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
