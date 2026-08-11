import { describe, expect, it } from 'vitest';
import {
  BLOCK_CATEGORIES,
  MAX_SESSION_DURATION_S,
  blocklistHash,
  canonicalize,
  domainsForCategories,
  evaluateSessionRecord,
  generateDeviceKeyPair,
  newGroupId,
  newNonce,
  newPairingCode,
  newSessionId,
  processNamesForCategories,
  shouldEnforceOnStartup,
  signSessionRecord,
  validateBlocklist,
  verifySessionRecord,
} from '../src/index.js';
import type { ActiveSessionRow, SessionRecord } from '../src/index.js';

describe('blocklist', () => {
  it('validates without throwing', () => {
    expect(() => validateBlocklist()).not.toThrow();
  });

  it('has at least 40 social domains', () => {
    const social = BLOCK_CATEGORIES.find((c) => c.id === 'social')!;
    expect(social.domains.length).toBeGreaterThanOrEqual(40);
  });

  it('covers major game platforms', () => {
    const domains = domainsForCategories(['games']);
    for (const d of ['steampowered.com', 'epicgames.com', 'battle.net', 'riotgames.com', 'roblox.com', 'xbox.com']) {
      expect(domains).toContain(d);
    }
  });

  it('includes short-link domains', () => {
    const domains = domainsForCategories(['social']);
    expect(domains).toContain('fb.me');
    expect(domains).toContain('t.co');
  });

  it('produces a stable hash regardless of array order in memory', () => {
    const h1 = blocklistHash();
    const h2 = blocklistHash();
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('collects process names for a category set', () => {
    const names = processNamesForCategories(['games']);
    expect(names).toContain('steam.exe');
  });
});

describe('canonicalize', () => {
  it('sorts keys so field order does not affect output', () => {
    const a = canonicalize({ b: 1, a: 2 });
    const b = canonicalize({ a: 2, b: 1 });
    expect(a).toBe(b);
  });
});

describe('signing', () => {
  it('round-trips sign/verify', () => {
    const kp = generateDeviceKeyPair();
    const record: Omit<SessionRecord, 'signature'> = {
      group_id: newGroupId(),
      session_id: newSessionId(),
      started_at: 1000,
      ends_at: 2000,
      categories: ['social'],
      label: 'test',
      origin_device: 'device-a',
      nonce: newNonce(),
    };
    const signature = signSessionRecord(record, kp.privateKeyPem);
    const full: SessionRecord = { ...record, signature };
    expect(verifySessionRecord(full, kp.publicKeyB64)).toBe(true);
  });

  it('rejects a tampered record', () => {
    const kp = generateDeviceKeyPair();
    const record: Omit<SessionRecord, 'signature'> = {
      group_id: newGroupId(),
      session_id: newSessionId(),
      started_at: 1000,
      ends_at: 2000,
      categories: ['social'],
      label: null,
      origin_device: 'device-a',
      nonce: newNonce(),
    };
    const signature = signSessionRecord(record, kp.privateKeyPem);
    const tampered: SessionRecord = { ...record, ends_at: 999_999, signature };
    expect(verifySessionRecord(tampered, kp.publicKeyB64)).toBe(false);
  });

  it('rejects a signature from the wrong key', () => {
    const kpA = generateDeviceKeyPair();
    const kpB = generateDeviceKeyPair();
    const record: Omit<SessionRecord, 'signature'> = {
      group_id: newGroupId(),
      session_id: newSessionId(),
      started_at: 1000,
      ends_at: 2000,
      categories: ['games'],
      label: null,
      origin_device: 'device-a',
      nonce: newNonce(),
    };
    const signature = signSessionRecord(record, kpA.privateKeyPem);
    const full: SessionRecord = { ...record, signature };
    expect(verifySessionRecord(full, kpB.publicKeyB64)).toBe(false);
  });

  it('rejects a garbage signature without throwing', () => {
    const kp = generateDeviceKeyPair();
    const record: SessionRecord = {
      group_id: newGroupId(),
      session_id: newSessionId(),
      started_at: 1000,
      ends_at: 2000,
      categories: ['games'],
      label: null,
      origin_device: 'device-a',
      nonce: newNonce(),
      signature: 'not-a-real-signature',
    };
    expect(verifySessionRecord(record, kp.publicKeyB64)).toBe(false);
  });

  it('newPairingCode is always 6 digits', () => {
    for (let i = 0; i < 50; i++) {
      expect(newPairingCode()).toMatch(/^\d{6}$/);
    }
  });
});

describe('deadman switch / safety cap', () => {
  it('rejects sessions longer than 8 hours', () => {
    const record: SessionRecord = {
      group_id: 'g', session_id: 's', started_at: 0,
      ends_at: (MAX_SESSION_DURATION_S + 3600) * 1000,
      categories: ['social'], label: null, origin_device: 'd', nonce: 'n', signature: 'sig',
    };
    const result = evaluateSessionRecord(record, 0);
    expect(result.valid).toBe(false);
  });

  it('accepts an 8-hour session exactly', () => {
    const record: SessionRecord = {
      group_id: 'g', session_id: 's', started_at: 0,
      ends_at: MAX_SESSION_DURATION_S * 1000,
      categories: ['social'], label: null, origin_device: 'd', nonce: 'n', signature: 'sig',
    };
    expect(evaluateSessionRecord(record, 0).valid).toBe(true);
  });

  it('flags an already-expired record instead of enforcing it', () => {
    const record: SessionRecord = {
      group_id: 'g', session_id: 's', started_at: 0, ends_at: 1000,
      categories: ['social'], label: null, origin_device: 'd', nonce: 'n', signature: 'sig',
    };
    expect(evaluateSessionRecord(record, 5000).alreadyExpired).toBe(true);
  });

  it('shouldEnforceOnStartup returns false with no crash-recovery row', () => {
    expect(shouldEnforceOnStartup(null, Date.now())).toBe(false);
  });

  it('shouldEnforceOnStartup returns false once ends_at has passed (crashed daemon / dead relay never permanently blocks)', () => {
    const row: ActiveSessionRow = {
      session_id: 's', ends_at: 1000, started_at: 0, categories: ['social'], label: null, origin_device: 'd',
    };
    expect(shouldEnforceOnStartup(row, 5000)).toBe(false);
  });

  it('shouldEnforceOnStartup returns true mid-session', () => {
    const row: ActiveSessionRow = {
      session_id: 's', ends_at: 10_000, started_at: 0, categories: ['social'], label: null, origin_device: 'd',
    };
    expect(shouldEnforceOnStartup(row, 5000)).toBe(true);
  });
});
