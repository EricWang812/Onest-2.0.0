import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Plain-text audit log of every enforcement action, per spec. Append-only,
 * one line per event, human-readable — deliberately not SQLite (so it's
 * readable/recoverable even if the DB is corrupt, and trivially greppable
 * during incident response).
 */
export class AuditLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  log(event: string, details: Record<string, unknown> = {}): void {
    const line = `${new Date().toISOString()} ${event} ${JSON.stringify(details)}\n`;
    try {
      appendFileSync(this.path, line, 'utf8');
    } catch {
      // Audit logging must never crash enforcement. Best-effort only.
    }
  }
}
