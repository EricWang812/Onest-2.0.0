import React, { useEffect, useMemo, useState } from 'react';
import type { LoggedSession } from '@focus-lock/shared';
import { api } from '../api.js';

function startOfWeek(d: Date): Date {
  const copy = new Date(d);
  const day = copy.getDay();
  const diff = (day === 0 ? -6 : 1) - day; // Monday start
  copy.setDate(copy.getDate() + diff);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function Log(): React.JSX.Element {
  const [weekOffset, setWeekOffset] = useState(0);
  const [sessions, setSessions] = useState<LoggedSession[]>([]);

  const weekStart = useMemo(() => {
    const base = startOfWeek(new Date());
    base.setDate(base.getDate() + weekOffset * 7);
    return base;
  }, [weekOffset]);
  const weekEnd = useMemo(() => {
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 7);
    return end;
  }, [weekStart]);

  useEffect(() => {
    let cancelled = false;
    api.getLog(weekStart.getTime(), weekEnd.getTime()).then((res) => {
      if (!cancelled && res.ok && res.result) setSessions(res.result);
    });
    return () => {
      cancelled = true;
    };
  }, [weekStart, weekEnd]);

  const dayTotals = useMemo(() => {
    const totals = [0, 0, 0, 0, 0, 0, 0];
    for (const s of sessions) {
      const dayIdx = Math.floor((s.started_at - weekStart.getTime()) / 86_400_000);
      if (dayIdx >= 0 && dayIdx < 7) totals[dayIdx] += s.actual_duration_s ?? s.planned_duration_s;
    }
    return totals;
  }, [sessions, weekStart]);

  const weeklyTotalS = dayTotals.reduce((a, b) => a + b, 0);
  const daysWithData = dayTotals.filter((t) => t > 0).length || 1;
  const maxDay = Math.max(1, ...dayTotals);

  function exportCsv(): void {
    const header = 'date,start,duration_s,label,completed,origin_device\n';
    const rows = sessions
      .map((s) => {
        const d = new Date(s.started_at);
        return [d.toISOString().slice(0, 10), d.toTimeString().slice(0, 5), s.actual_duration_s ?? '', s.label ?? '', s.completed, s.origin_device].join(',');
      })
      .join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `focus-lock-log-${weekStart.toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div>
      <h1 className="page-title">Log</h1>
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="chip" onClick={() => setWeekOffset((o) => o - 1)}>&larr; Prev</button>
            <button className="chip" onClick={() => setWeekOffset(0)}>This week</button>
            <button className="chip" onClick={() => setWeekOffset((o) => o + 1)}>Next &rarr;</button>
          </div>
          <div className="text-dim" style={{ fontSize: 13 }}>
            {fmtDate(weekStart)} – {fmtDate(new Date(weekEnd.getTime() - 1))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 32, marginBottom: 12 }}>
          <div>
            <div className="text-dim" style={{ fontSize: 12 }}>Weekly total</div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{fmtDuration(weeklyTotalS)}</div>
          </div>
          <div>
            <div className="text-dim" style={{ fontSize: 12 }}>Daily average</div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{fmtDuration(Math.round(weeklyTotalS / daysWithData))}</div>
          </div>
        </div>
        {sessions.length === 0 ? (
          <div className="empty-state">No sessions logged this week.</div>
        ) : (
          <div className="bar-chart">
            {dayTotals.map((t, i) => (
              <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <div className="bar" style={{ height: `${(t / maxDay) * 100}px`, width: '100%' }} title={fmtDuration(t)} />
                <div className="text-dim" style={{ fontSize: 11 }}>{dayLabels[i]}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Sessions</div>
          <button className="chip" onClick={exportCsv} disabled={sessions.length === 0}>Export CSV</button>
        </div>
        {sessions.length === 0 ? (
          <div className="empty-state">Nothing to show yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Start</th><th>Duration</th><th>Label</th><th>Devices</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const d = new Date(s.started_at);
                return (
                  <tr key={s.id}>
                    <td>{d.toLocaleDateString()}</td>
                    <td>{d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                    <td>{fmtDuration(s.actual_duration_s ?? s.planned_duration_s)}</td>
                    <td>{s.label ?? <span className="text-dim">—</span>}</td>
                    <td className="text-dim">{s.origin_device}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
