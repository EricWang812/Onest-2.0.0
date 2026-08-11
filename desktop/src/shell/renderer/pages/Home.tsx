import React, { useMemo, useState } from 'react';
import type { BlockCategoryId, DeviceRecord } from '@focus-lock/shared';
import { api, type SessionState } from '../api.js';

// Duplicated from shared/src/types.ts's MAX_SESSION_DURATION_S rather than
// imported as a value: @focus-lock/shared's barrel (index.ts) re-exports
// crypto.ts/pairing.ts alongside types.ts, both of which import
// 'node:crypto' — fine for the daemon (bundled with platform: 'node'), but
// this file is bundled for the browser platform (build-renderer.mjs), where
// esbuild can't resolve node:crypto at all. A `import type` for
// BlockCategoryId/DeviceRecord below is erased at compile time and never
// triggers this; pulling in a real runtime binding like this constant does.
const MAX_SESSION_DURATION_S = 8 * 60 * 60;

// Was 3 presets (25/50/90m) plus a native <input type="time">, which is a
// clock-of-day widget — semantically wrong for "how long", and its spinner
// UI reads the same whether you're entering 12:05am or a 5-minute session.
// Six presets cover short/medium/long blocks without turning into a wall of
// chips; the custom control below is now explicit hour/minute steppers.
const PRESETS = [
  { label: '15m', seconds: 15 * 60 },
  { label: '25m', seconds: 25 * 60 },
  { label: '45m', seconds: 45 * 60 },
  { label: '1h', seconds: 60 * 60 },
  { label: '1h 30m', seconds: 90 * 60 },
  { label: '2h', seconds: 120 * 60 },
];

const MAX_HOURS = Math.floor(MAX_SESSION_DURATION_S / 3600);
const MINUTE_STEP = 5;

function formatDurationLabel(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

/** Rolls minutes into hours and clamps to [1min, MAX_SESSION_DURATION_S] so the steppers can never produce an invalid session length. */
function clampCustom(hours: number, minutes: number): { hours: number; minutes: number } {
  const totalMinutes = Math.max(1, Math.min(hours * 60 + minutes, MAX_SESSION_DURATION_S / 60));
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

function Stepper({
  label, value, unit, onDecrement, onIncrement, decrementDisabled, incrementDisabled,
}: {
  label: string; value: number; unit: string; onDecrement: () => void; onIncrement: () => void;
  decrementDisabled: boolean; incrementDisabled: boolean;
}): React.JSX.Element {
  return (
    <div className="stepper">
      <button type="button" className="stepper-btn" onClick={onDecrement} disabled={decrementDisabled} aria-label={`Decrease ${label}`}>
        −
      </button>
      <div style={{ textAlign: 'center', minWidth: 44 }}>
        <div className="stepper-value">{value}</div>
        <div className="stepper-unit">{unit}</div>
      </div>
      <button type="button" className="stepper-btn" onClick={onIncrement} disabled={incrementDisabled} aria-label={`Increase ${label}`}>
        +
      </button>
    </div>
  );
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function CountdownRing({ remainingMs, totalMs }: { remainingMs: number; totalMs: number }): React.JSX.Element {
  const size = 220;
  const stroke = 12;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = totalMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 0;
  const offset = circumference * (1 - fraction);
  return (
    <svg width={size} height={size}>
      <circle cx={size / 2} cy={size / 2} r={radius} stroke="var(--border)" strokeWidth={stroke} fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke="var(--accent)"
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.4s ease' }}
      />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" fontSize="30" fontWeight={600} fill="var(--text)">
        {formatRemaining(remainingMs)}
      </text>
    </svg>
  );
}

export function Home({ state, devices }: { state: SessionState | null; devices: DeviceRecord[] }): React.JSX.Element {
  const [presetSeconds, setPresetSeconds] = useState<number | null>(25 * 60);
  const [customHours, setCustomHours] = useState(0);
  const [customMinutes, setCustomMinutes] = useState(30);
  const [label, setLabel] = useState('');
  const [categories, setCategories] = useState<BlockCategoryId[]>(['social', 'games']);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalMsAtStart, setTotalMsAtStart] = useState(0);

  const durationS = useMemo(() => {
    if (presetSeconds !== null) return presetSeconds;
    return customHours * 3600 + customMinutes * 60;
  }, [presetSeconds, customHours, customMinutes]);

  // The steppers always reflect *this*, not the raw customHours/customMinutes
  // state — otherwise selecting a preset (e.g. "2h") would leave the stepper
  // boxes showing a stale, disconnected value from whatever custom length was
  // last set, contradicting the big readout right above them.
  const effectiveHours = Math.floor(durationS / 3600);
  const effectiveMinutes = Math.round((durationS % 3600) / 60);

  function adjustCustom(deltaHours: number, deltaMinutes: number): void {
    const next = clampCustom(effectiveHours + deltaHours, effectiveMinutes + deltaMinutes);
    setCustomHours(next.hours);
    setCustomMinutes(next.minutes);
    setPresetSeconds(null);
  }

  async function start(): Promise<void> {
    setError(null);
    setStarting(true);
    const res = await api.startSession(durationS, categories, label.trim() || null);
    setStarting(false);
    if (!res.ok) setError(res.error ?? 'failed to start');
    else setTotalMsAtStart(durationS * 1000);
  }

  function toggleCategory(id: BlockCategoryId): void {
    setCategories((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  if (state?.running) {
    const total = totalMsAtStart || state.remainingMs;
    return (
      <div className="ring-wrap">
        <CountdownRing remainingMs={state.remainingMs} totalMs={total} />
        {state.label && <div style={{ fontSize: 16, fontWeight: 500 }}>{state.label}</div>}
        <div className="chip-row">
          {state.categories.map((c) => (
            <span key={c} className="chip selected">{c}</span>
          ))}
        </div>
        <div className="device-dots">
          {devices.map((d) => {
            const ageMs = Date.now() - d.last_seen;
            const cls = ageMs < 30_000 ? 'green' : 'amber';
            return <span key={d.id} className={`dot ${cls}`} title={`${d.name} — ${d.platform}`} />;
          })}
        </div>
        <div className="text-dim" style={{ fontSize: 12 }}>
          Focus session in progress — no pause or cancel is available while a session is active.
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="page-title">Home</h1>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 480 }}>
        <div>
          <div className="text-dim" style={{ fontSize: 13, marginBottom: 8 }}>Duration</div>
          <div className="duration-readout" style={{ marginBottom: 12 }}>{formatDurationLabel(durationS)}</div>
          <div className="chip-row" style={{ marginBottom: 12 }}>
            {PRESETS.map((p) => (
              <span
                key={p.label}
                className={`chip ${presetSeconds === p.seconds ? 'selected' : ''}`}
                onClick={() => setPresetSeconds(p.seconds)}
              >
                {p.label}
              </span>
            ))}
          </div>
          <div className="text-dim" style={{ fontSize: 12, marginBottom: 8 }}>Or nudge the length directly</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Stepper
              label="hours"
              value={effectiveHours}
              unit="hr"
              onDecrement={() => adjustCustom(-1, 0)}
              onIncrement={() => adjustCustom(1, 0)}
              decrementDisabled={effectiveHours <= 0 && effectiveMinutes <= 1}
              incrementDisabled={effectiveHours >= MAX_HOURS}
            />
            <Stepper
              label="minutes"
              value={effectiveMinutes}
              unit="min"
              onDecrement={() => adjustCustom(0, -MINUTE_STEP)}
              onIncrement={() => adjustCustom(0, MINUTE_STEP)}
              decrementDisabled={effectiveHours <= 0 && effectiveMinutes <= 1}
              incrementDisabled={effectiveHours >= MAX_HOURS && effectiveMinutes + MINUTE_STEP > 59}
            />
          </div>
        </div>
        <div>
          <div className="text-dim" style={{ fontSize: 13, marginBottom: 8 }}>Categories</div>
          <div className="chip-row">
            {(['social', 'games', 'video', 'news'] as BlockCategoryId[]).map((c) => (
              <span key={c} className={`chip ${categories.includes(c) ? 'selected' : ''}`} onClick={() => toggleCategory(c)}>
                {c}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div className="text-dim" style={{ fontSize: 13, marginBottom: 8 }}>What are you working on? (optional)</div>
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} style={{ width: '100%' }} placeholder="thesis draft" />
        </div>
        {error && <div style={{ color: '#c76b6b', fontSize: 13 }}>{error}</div>}
        <button className="btn-primary" disabled={starting || durationS <= 0 || categories.length === 0} onClick={start}>
          {starting ? 'Starting…' : 'Start'}
        </button>
      </div>
    </div>
  );
}
