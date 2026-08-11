import type { BlockCategoryId } from '@focus-lock/shared';

/** Domains/processes that must never be blocked, regardless of category selection. See DECISIONS.md. */
export const NEVER_BLOCK_DOMAINS = [
  'localhost',
  'windowsupdate.com',
  'update.microsoft.com',
  'apple.com',
  'swscan.apple.com',
  'mesu.apple.com',
];

export interface BlockedHit {
  kind: 'domain' | 'process';
  name: string;
}

export interface Enforcer {
  /** Apply blocking for the given categories. Idempotent — safe to call repeatedly while a session is active. */
  applyBlock(categories: BlockCategoryId[]): Promise<void>;
  /** Fully remove all blocking. Must succeed even if applyBlock was never called (fresh boot recovery). */
  removeBlock(): Promise<void>;
  /** Start the 1s hosts-file watchdog + 1s process-poll loop. Calls onHit for each newly-blocked interception. */
  startWatching(onHit: (hits: BlockedHit[]) => void): void;
  stopWatching(): void;
}
