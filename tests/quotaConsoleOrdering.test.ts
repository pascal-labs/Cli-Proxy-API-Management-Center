/**
 * Console sort modes ("Ledger", "Soonest reset", "Most remaining") and the "Next up" badge.
 */

import { describe, expect, test } from 'bun:test';
import { sortQuotaEntries, type QuotaFileEntry } from '@/features/quota/logic';
import { isNextUpFile, pickNextUpEntry, selectNextUpKeys } from '@/features/quota/nextUp';
import { normalizeRoutingOrder, type RoutingOrderEntry } from '@/services/api/hub';
import type { AuthFileItem } from '@/types';

const entry = (name: string): QuotaFileEntry => ({
  file: { name } as AuthFileItem,
  type: 'claude',
});
const names = (entries: QuotaFileEntry[]) => entries.map((item) => item.file.name);
const ENTRIES = ['a', 'b', 'c', 'd'].map(entry);

describe('sort modes', () => {
  const remaining: Record<string, number | null> = { a: 40, b: null, c: 90, d: 40 };
  const recovery: Record<string, number | null> = { a: 300, b: 100, c: null, d: 200 };
  const byRemaining = (item: QuotaFileEntry) => remaining[item.file.name];
  const byRecovery = (item: QuotaFileEntry) => recovery[item.file.name];

  test('ledger keeps file order and ignores both keys', () => {
    expect(names(sortQuotaEntries(ENTRIES, 'default', byRecovery, byRemaining))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  test('soonest reset orders by recovery instant, unknowns last', () => {
    expect(names(sortQuotaEntries(ENTRIES, 'soonest', byRecovery, byRemaining))).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);
  });

  test('most remaining orders descending, ties stable, unknowns last', () => {
    expect(names(sortQuotaEntries(ENTRIES, 'remaining', byRecovery, byRemaining))).toEqual([
      'c',
      'a',
      'd',
      'b',
    ]);
  });

  test('most remaining without a resolver keeps ledger order', () => {
    expect(names(sortQuotaEntries(ENTRIES, 'remaining', byRecovery))).toEqual(['a', 'b', 'c', 'd']);
  });

  test('does not mutate its input', () => {
    const input = [...ENTRIES];
    sortQuotaEntries(input, 'remaining', byRecovery, byRemaining);
    expect(names(input)).toEqual(['a', 'b', 'c', 'd']);
  });
});

const orderEntry = (overrides: Partial<RoutingOrderEntry>): RoutingOrderEntry => ({
  authIndex: '',
  authId: '',
  label: '',
  rank: 1,
  eligible: true,
  skipReason: '',
  weeklyKey: '',
  weeklyUsedPercent: null,
  weeklyResetsAt: null,
  fiveHourUsedPercent: null,
  fiveHourResetsAt: null,
  disabled: false,
  ...overrides,
});

describe('next up', () => {
  test('rank 1 among eligible, enabled candidates wins', () => {
    const next = pickNextUpEntry([
      orderEntry({ authIndex: '3', rank: 3 }),
      orderEntry({ authIndex: '1', rank: 1, eligible: false, skipReason: 'cooldown' }),
      orderEntry({ authIndex: '2', rank: 2 }),
      orderEntry({ authIndex: '0', rank: 0, disabled: true }),
    ]);
    expect(next?.authIndex).toBe('2');
    expect(pickNextUpEntry([orderEntry({ eligible: false })])).toBeNull();
  });

  test('one badge per provider, matched by index, id or file name', () => {
    const order = normalizeRoutingOrder({
      strategy: 'soonest-reset',
      generated_at: '2026-09-10T12:00:00Z',
      providers: {
        claude: [
          {
            auth_index: 'c2',
            auth_id: 'claude-b',
            label: 'claude-b.json',
            rank: 2,
            eligible: true,
          },
          {
            auth_index: 'c1',
            auth_id: 'claude-a',
            label: 'claude-a.json',
            rank: 1,
            eligible: true,
          },
        ],
        codex: [{ auth_id: 'codex-x', label: 'codex-x.json', rank: 1, eligible: true }],
        xai: [],
      },
    });
    const keys = selectNextUpKeys(order);
    const file = (fields: Partial<AuthFileItem>) =>
      ({ name: 'other.json', ...fields }) as AuthFileItem;

    expect(isNextUpFile(file({ name: 'claude-a.json', authIndex: 'c1' }), keys)).toBe(true);
    expect(isNextUpFile(file({ name: 'claude-b.json', authIndex: 'c2' }), keys)).toBe(false);
    expect(isNextUpFile(file({ name: 'codex-x.json' }), keys)).toBe(true);
    expect(isNextUpFile(file({ id: 'codex-x' }), keys)).toBe(true);
    expect(isNextUpFile(file({ name: 'CODEX-X.JSON' }), keys)).toBe(true);
  });

  test('no order (404 or failure) means no badge anywhere', () => {
    expect(selectNextUpKeys(null).size).toBe(0);
    expect(isNextUpFile({ name: 'claude-a.json' } as AuthFileItem, new Set())).toBe(false);
  });
});

describe('routing order normalization', () => {
  test('reads the contract and tolerates junk', () => {
    const order = normalizeRoutingOrder({
      strategy: 'soonest-reset',
      generated_at: 'not a date',
      providers: {
        Claude: [
          {
            auth_index: 7,
            auth_id: 'a',
            label: 'a.json',
            rank: 1,
            eligible: true,
            skip_reason: '',
            weekly_key: 'seven_day_fable',
            weekly_used_percent: 42,
            weekly_resets_at: '2026-09-12T23:00:00Z',
            five_hour_used_percent: 10,
            five_hour_resets_at: null,
            disabled: false,
          },
          'junk',
          {},
        ],
        codex: 'nope',
      },
    });
    expect(order.strategy).toBe('soonest-reset');
    expect(order.generatedAt).toBeNull();
    expect(Object.keys(order.providers)).toEqual(['claude']);
    expect(order.providers.claude).toEqual([
      {
        authIndex: '7',
        authId: 'a',
        label: 'a.json',
        rank: 1,
        eligible: true,
        skipReason: '',
        weeklyKey: 'seven_day_fable',
        weeklyUsedPercent: 42,
        weeklyResetsAt: '2026-09-12T23:00:00Z',
        fiveHourUsedPercent: 10,
        fiveHourResetsAt: null,
        disabled: false,
      },
    ]);
    expect(normalizeRoutingOrder(null).providers).toEqual({});
  });
});
