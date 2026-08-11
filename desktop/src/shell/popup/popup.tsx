import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

interface PopupPayload {
  items: Array<{ kind: 'domain' | 'process'; name: string }>;
  remainingMs: number;
  reason: string;
}

declare global {
  interface Window {
    focusLock: {
      onPopupData: (cb: (payload: PopupPayload) => void) => void;
      dismissPopup: () => void;
    };
  }
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * The blocked-app popup. Mellow by design — no red, no alarm iconography,
 * no sound. Dismiss only closes this window; there is no "let me through".
 */
function Popup(): React.JSX.Element {
  const [payload, setPayload] = useState<PopupPayload | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);

  useEffect(() => {
    window.focusLock.onPopupData((p) => {
      setPayload(p);
      setRemainingMs(p.remainingMs);
    });
  }, []);

  useEffect(() => {
    const t = setInterval(() => setRemainingMs((ms) => Math.max(0, ms - 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  if (!payload) return <div />;

  const names = payload.items.map((i) => i.name);
  const title = names.length === 1 ? names[0] : `${names.length} apps blocked`;

  return (
    <div className="popup-card">
      <div className="popup-title">{title}</div>
      <div className="popup-body">{payload.reason}</div>
      {names.length > 1 && <div className="popup-body" style={{ fontSize: 11 }}>{names.join(', ')}</div>}
      <div className="popup-footer">
        <span className="popup-timer">{formatRemaining(remainingMs)} remaining</span>
        <button className="dismiss-btn" onClick={() => window.focusLock.dismissPopup()}>Dismiss</button>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Popup />);
