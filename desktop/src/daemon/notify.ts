import notifier from 'node-notifier';

/**
 * Fired directly by the daemon (never the renderer) so it works with the
 * main window closed or never opened at all. Per spec, sequence matters:
 * callers must unblock first, confirm it, and only then call this.
 */
export function notifySessionComplete(durationLabel: string, sessionLabel: string | null): void {
  const body = sessionLabel ? `${durationLabel} — ${sessionLabel}` : durationLabel;
  notifier.notify({
    title: 'Focus session complete',
    message: body,
    sound: true,
    appID: 'com.onest.app',
  });
}
