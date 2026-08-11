import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { BlockCategoryId } from '@focus-lock/shared';
import { domainsForCategories, processNamesForCategories } from '@focus-lock/shared';
import type { AuditLog } from './audit.js';
import { NEVER_BLOCK_DOMAINS, type BlockedHit, type Enforcer } from './enforcement.js';

const run = promisify(execFile);

const MARKER_BEGIN = '# FOCUSLOCK-BEGIN (managed — do not edit by hand)';
const MARKER_END = '# FOCUSLOCK-END';
const PF_ANCHOR = 'focuslock';
const DOH_IP_TARGETS = ['1.1.1.1', '8.8.8.8'];
const DOH_DOMAIN_TARGETS = ['dns.google', 'cloudflare-dns.com'];

function hostsPath(): string {
  return process.env.FOCUSLOCK_HOSTS_PATH ?? '/etc/hosts';
}

// Same bug, independently duplicated from enforcement-windows.ts — see the
// comment there. MARKER_BEGIN's literal parentheses are regex metacharacters;
// left unescaped in `new RegExp(...)`, the strip-old-block replace below
// never matches the real file content, so removeBlock() would silently
// leave the block in place. Fixed here too even though this file is unbuilt
// and untested in this environment (no macOS available) — it's the
// identical, already-diagnosed root cause, not a hypothetical extension.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * macOS enforcer. **Weaker than Windows by design of the OS, not by choice
 * here** — see DECISIONS.md for the full gap analysis. In short: SIP
 * restricts what even root can rewrite/observe on modern macOS, and there is
 * no first-party equivalent of WFP for straightforward outbound IP/port
 * blocking from a plain daemon — this uses `pf` anchors, which work but are
 * coarser and more fragile across OS updates than Windows' WFP/netsh path.
 * TCC further limits process-visibility/kill without additional prompts
 * this daemon cannot itself grant. Never verified on real hardware in this
 * environment (no macOS available) — written, not run.
 */
export class MacEnforcer implements Enforcer {
  private currentCategories: BlockCategoryId[] = [];
  private hostsWatchTimer?: NodeJS.Timeout;
  private processPollTimer?: NodeJS.Timeout;

  constructor(private readonly audit: AuditLog) {}

  private expectedHostsBlock(): string {
    const domains = [...new Set([...domainsForCategories(this.currentCategories), ...DOH_DOMAIN_TARGETS])].filter(
      (d) => !NEVER_BLOCK_DOMAINS.includes(d),
    );
    const lines = domains.flatMap((d) => [`0.0.0.0 ${d}`, `0.0.0.0 www.${d}`]);
    return [MARKER_BEGIN, ...lines, MARKER_END].join('\n');
  }

  private writeHostsBlock(): void {
    const path = hostsPath();
    let existing = '';
    try {
      existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
    } catch {
      // best effort
    }
    const withoutOurBlock = existing.replace(new RegExp(`\\n?${escapeRegExp(MARKER_BEGIN)}[\\s\\S]*?${escapeRegExp(MARKER_END)}\\n?`, 'g'), '\n');
    const next = this.currentCategories.length > 0 ? `${withoutOurBlock.trimEnd()}\n${this.expectedHostsBlock()}\n` : `${withoutOurBlock.trimEnd()}\n`;
    try {
      writeFileSync(path, next, 'utf8');
    } catch (err) {
      this.audit.log('hosts_write_failed', { error: String(err), path });
    }
  }

  private async flushDns(): Promise<void> {
    try {
      await run('dscacheutil', ['-flushcache']);
      await run('killall', ['-HUP', 'mDNSResponder']);
    } catch (err) {
      this.audit.log('dns_flush_failed', { error: String(err) });
    }
  }

  private pfRulesText(): string {
    return DOH_IP_TARGETS.map((ip) => `block drop out proto tcp from any to ${ip} port 443`).join('\n');
  }

  private async applyPfAnchor(): Promise<void> {
    try {
      const rulesFile = '/tmp/focuslock.pf.conf';
      writeFileSync(rulesFile, `${this.pfRulesText()}\n`, 'utf8');
      await run('pfctl', ['-a', PF_ANCHOR, '-f', rulesFile]);
      await run('pfctl', ['-e']);
    } catch (err) {
      this.audit.log('pf_anchor_apply_failed', { error: String(err) });
    }
  }

  private async removePfAnchor(): Promise<void> {
    try {
      await run('pfctl', ['-a', PF_ANCHOR, '-F', 'all']);
    } catch (err) {
      this.audit.log('pf_anchor_remove_failed', { error: String(err) });
    }
  }

  async applyBlock(categories: BlockCategoryId[]): Promise<void> {
    this.currentCategories = categories;
    this.writeHostsBlock();
    await this.flushDns();
    await this.applyPfAnchor();
    this.audit.log('block_applied', { categories });
  }

  async removeBlock(): Promise<void> {
    this.currentCategories = [];
    this.writeHostsBlock();
    await this.flushDns();
    await this.removePfAnchor();
    this.audit.log('block_removed', {});
  }

  startWatching(onHit: (hits: BlockedHit[]) => void): void {
    this.stopWatching();
    this.hostsWatchTimer = setInterval(() => {
      if (this.currentCategories.length === 0) return;
      let current = '';
      try {
        current = readFileSync(hostsPath(), 'utf8');
      } catch {
        return;
      }
      if (!current.includes(MARKER_BEGIN) || !current.includes(this.expectedHostsBlock())) {
        this.writeHostsBlock();
        this.audit.log('hosts_file_reverted_external_edit', {});
      }
    }, 1000);

    this.processPollTimer = setInterval(() => {
      void this.pollProcesses(onHit);
    }, 1000);
  }

  private async pollProcesses(onHit: (hits: BlockedHit[]) => void): Promise<void> {
    if (this.currentCategories.length === 0) return;
    const targets = new Set(processNamesForCategories(this.currentCategories).map((n) => n.toLowerCase()));
    if (targets.size === 0) return;
    let stdout = '';
    try {
      ({ stdout } = await run('ps', ['-Ao', 'comm=']));
    } catch (err) {
      this.audit.log('process_poll_failed', { error: String(err) });
      return;
    }
    const hits: BlockedHit[] = [];
    const seen = new Set<string>();
    for (const line of stdout.split('\n')) {
      const name = line.trim().split('/').pop() ?? '';
      if (!name) continue;
      if (targets.has(name.toLowerCase()) && !seen.has(name)) {
        seen.add(name);
        hits.push({ kind: 'process', name });
        try {
          await run('pkill', ['-f', name]);
          this.audit.log('process_killed', { name });
        } catch (err) {
          this.audit.log('process_kill_failed', { name, error: String(err) });
        }
      }
    }
    if (hits.length > 0) onHit(hits);
  }

  stopWatching(): void {
    if (this.hostsWatchTimer) clearInterval(this.hostsWatchTimer);
    if (this.processPollTimer) clearInterval(this.processPollTimer);
    this.hostsWatchTimer = undefined;
    this.processPollTimer = undefined;
  }
}
