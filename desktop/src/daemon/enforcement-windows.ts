import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { BlockCategoryId } from '@focus-lock/shared';
import { domainsForCategories, processNamesForCategories, titleKeywordsForCategories } from '@focus-lock/shared';
import type { AuditLog } from './audit.js';
import { NEVER_BLOCK_DOMAINS, type BlockedHit, type Enforcer } from './enforcement.js';

const run = promisify(execFile);

const MARKER_BEGIN = '# FOCUSLOCK-BEGIN (managed — do not edit by hand)';
const MARKER_END = '# FOCUSLOCK-END';
const FW_RULE_PREFIX = 'FocusLock-';
// Known DNS-over-HTTPS resolvers a browser could fall back to, bypassing the hosts file.
const DOH_IP_TARGETS = ['1.1.1.1', '8.8.8.8'];
const DOH_DOMAIN_TARGETS = ['dns.google', 'cloudflare-dns.com'];

function hostsPath(): string {
  return process.env.FOCUSLOCK_HOSTS_PATH ?? 'C:\\Windows\\System32\\drivers\\etc\\hosts';
}

// MARKER_BEGIN contains literal parentheses ("(managed — do not edit by
// hand)"), which are regex metacharacters. Splicing it unescaped into
// `new RegExp(...)` (as writeHostsBlock() below used to) makes `(` open an
// unintended capture group instead of matching a literal `(` — the built
// pattern then expects "BEGIN managed" with no paren at all, which never
// appears in the real file, so the "strip the old block" replace silently
// matches nothing and removeBlock() leaves the block in place untouched.
// This is not hypothetical: found via a real spawned-daemon test asserting
// the hosts file after natural session completion — audit.log correctly
// showed `block_removed` logged, but the file itself still had the entire
// domain list, because the regex that was supposed to delete it never
// matched. Every "session complete -> unblock" transition against a real
// hosts file was silently broken until this fix, on every category, since
// the same marker constant and the same broken pattern applied regardless
// of which domains were in the block.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class WindowsEnforcer implements Enforcer {
  private currentCategories: BlockCategoryId[] = [];
  private hostsWatchTimer?: NodeJS.Timeout;
  private processPollTimer?: NodeJS.Timeout;

  constructor(private readonly audit: AuditLog) {}

  private expectedHostsBlock(): string {
    const domains = [...new Set([...domainsForCategories(this.currentCategories), ...DOH_DOMAIN_TARGETS])].filter(
      (d) => !NEVER_BLOCK_DOMAINS.includes(d),
    );
    const lines = domains.flatMap((d) => [`0.0.0.0 ${d}`, `0.0.0.0 www.${d}`]);
    return [MARKER_BEGIN, ...lines, MARKER_END].join('\r\n');
  }

  private writeHostsBlock(): void {
    const path = hostsPath();
    let existing = '';
    try {
      existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
    } catch {
      // Unreadable hosts file (permissions) — best effort, logged below.
    }
    const withoutOurBlock = existing.replace(
      new RegExp(`\\r?\\n?${escapeRegExp(MARKER_BEGIN)}[\\s\\S]*?${escapeRegExp(MARKER_END)}\\r?\\n?`, 'g'),
      '\n',
    );
    const next = this.currentCategories.length > 0 ? `${withoutOurBlock.trimEnd()}\n${this.expectedHostsBlock()}\n` : `${withoutOurBlock.trimEnd()}\n`;
    try {
      writeFileSync(path, next, 'utf8');
    } catch (err) {
      this.audit.log('hosts_write_failed', { error: String(err), path });
    }
  }

  private async flushDns(): Promise<void> {
    try {
      await run('ipconfig', ['/flushdns']);
    } catch (err) {
      this.audit.log('dns_flush_failed', { error: String(err) });
    }
  }

  private async addFirewallRules(): Promise<void> {
    for (const ip of DOH_IP_TARGETS) {
      const name = `${FW_RULE_PREFIX}DoH-${ip}`;
      try {
        await run('netsh', [
          'advfirewall', 'firewall', 'add', 'rule',
          `name=${name}`, 'dir=out', 'action=block', `remoteip=${ip}`, 'protocol=TCP', 'remoteport=443',
        ]);
      } catch (err) {
        this.audit.log('firewall_rule_add_failed', { ip, error: String(err) });
      }
    }
  }

  private async removeFirewallRules(): Promise<void> {
    for (const ip of DOH_IP_TARGETS) {
      const name = `${FW_RULE_PREFIX}DoH-${ip}`;
      try {
        await run('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`]);
      } catch {
        // Rule may not exist yet — fine.
      }
    }
  }

  async applyBlock(categories: BlockCategoryId[]): Promise<void> {
    this.currentCategories = categories;
    this.writeHostsBlock();
    await this.flushDns();
    await this.addFirewallRules();
    this.audit.log('block_applied', { categories });
  }

  async removeBlock(): Promise<void> {
    this.currentCategories = [];
    this.writeHostsBlock();
    await this.flushDns();
    await this.removeFirewallRules();
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

    // Was 1000ms. A blocked app with its own updater/launcher (Discord's
    // Update.exe is the concrete case in this category list) respawns the
    // killed process on its own within roughly a second, so a 1s poll meant
    // the app was back up for nearly the entire gap between polls — visible
    // to the user as "the popup showed up but the app just kept working."
    // 300ms shrinks that window without meaningfully increasing load (tasklist
    // is cheap) — see the /T fix in pollProcesses for the other half of this.
    this.processPollTimer = setInterval(() => {
      void this.pollProcesses(onHit);
    }, 300);
  }

  private async pollProcesses(onHit: (hits: BlockedHit[]) => void): Promise<void> {
    if (this.currentCategories.length === 0) return;
    const targets = new Set(processNamesForCategories(this.currentCategories).map((n) => n.toLowerCase()));
    const titleKeywords = titleKeywordsForCategories(this.currentCategories);
    if (targets.size === 0 && titleKeywords.length === 0) return;

    // `/v` (verbose) adds a Window Title column, needed for the browser-tab
    // check below — see the doc comment on BlockCategory.titleKeywords for
    // why exact process-name matching alone can't catch a blocked website.
    let stdout = '';
    try {
      ({ stdout } = await run('tasklist', ['/v', '/fo', 'csv', '/nh']));
    } catch (err) {
      this.audit.log('process_poll_failed', { error: String(err) });
      return;
    }

    const hits: BlockedHit[] = [];
    const killedPids = new Set<string>();
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('"') || !line.endsWith('"')) continue;
      // tasklist's CSV quotes every field but doesn't escape commas inside
      // a field (window titles routinely contain them), so a plain
      // comma-split breaks on rows like `"...","Focus, Reset - YouTube"`.
      // Splitting on the `","` delimiter sequence instead only breaks at
      // real field boundaries, since a title containing that exact
      // three-character sequence is not realistic.
      const fields = line.slice(1, -1).split('","');
      if (fields.length < 2) continue;
      const imageName = fields[0];
      const pid = fields[1];
      const windowTitle = fields.length >= 9 ? fields[8] : '';
      // never target our own UI, under either name (renamed FocusLock -> Onest mid-project)
      if (imageName.toLowerCase() === 'onest.exe' || imageName.toLowerCase() === 'focuslock.exe') continue;

      const nameMatch = targets.has(imageName.toLowerCase());
      const titleMatch =
        windowTitle !== '' &&
        windowTitle !== 'N/A' &&
        titleKeywords.some((kw) => windowTitle.toLowerCase().includes(kw));
      if (!nameMatch && !titleMatch) continue;

      hits.push({ kind: 'process', name: titleMatch && !nameMatch ? windowTitle : imageName });
      if (killedPids.has(pid)) continue; // same process already killed this pass (e.g. both name+title matched)
      killedPids.add(pid);
      try {
        // /T kills the whole process tree, not just the matched image/PID.
        // Plain `/IM <name> /F` only killed the named process — for an app
        // whose updater/launcher (a separate exe) respawns it on exit, the
        // app was back within ~1s of every kill, so the user saw the popup
        // fire but the window never actually stayed closed. Killing the
        // tree takes the spawning updater down with it. Title-matched hits
        // kill by PID (the specific offending window), not by image name,
        // so an unrelated window from the same browser type isn't required
        // to also match — though in practice a single-profile browser's
        // windows all share one process tree, so this still closes the
        // whole browser instance, matching the existing process-kill
        // behavior for native apps.
        await run('taskkill', ['/PID', pid, '/F', '/T']);
        this.audit.log('process_killed', { name: imageName, pid, via: titleMatch && !nameMatch ? 'window_title' : 'image_name', windowTitle });
      } catch (err) {
        this.audit.log('process_kill_failed', { name: imageName, pid, error: String(err) });
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
