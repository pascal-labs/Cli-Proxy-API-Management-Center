/**
 * Cache & Usage: hit-ratio bands, the session-hopping callout, sparkline geometry, and the
 * `/usage/accounts` normalization.
 */

import { describe, expect, test } from 'bun:test';
import {
  buildSparkline,
  classifyHitRatio,
  densifyHourlySeries,
  findLowHitAccounts,
  formatRatio,
  sortUsageAccounts,
} from '@/features/usage/logic';
import {
  computeCacheHitRatio,
  isHubFeatureMissing,
  normalizeUsageAccounts,
  type UsageAccount,
} from '@/services/api/hub';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 10, 0);

const account = (label: string, requests: number, ratio: number | null): UsageAccount => ({
  authIndex: label,
  authId: label,
  provider: 'claude',
  label,
  requests,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cacheHitRatio: ratio,
  series: [],
});

describe('classifyHitRatio', () => {
  test('≥70% green, 40–70% amber, below 40% red', () => {
    expect(classifyHitRatio(0.92)).toBe('high');
    expect(classifyHitRatio(0.7)).toBe('high');
    expect(classifyHitRatio(0.6999)).toBe('medium');
    expect(classifyHitRatio(0.4)).toBe('medium');
    expect(classifyHitRatio(0.3999)).toBe('low');
    expect(classifyHitRatio(0)).toBe('low');
  });

  test('no measurement is its own band, not red', () => {
    expect(classifyHitRatio(null)).toBe('none');
    expect(classifyHitRatio(undefined)).toBe('none');
    expect(classifyHitRatio(Number.NaN)).toBe('none');
    expect(formatRatio(null)).toBe('—');
    expect(formatRatio(0.456)).toBe('46%');
  });
});

describe('low hit ratio callout', () => {
  test('flags busy accounts under 70%, busiest first', () => {
    const flagged = findLowHitAccounts([
      account('quiet-low', 4, 0.1),
      account('busy-low', 12, 0.5),
      account('busier-low', 30, 0.2),
      account('busy-healthy', 50, 0.85),
      account('busy-edge', 9, 0.7),
      account('busy-unknown', 40, null),
    ]);
    expect(flagged.map((item) => item.label)).toEqual(['busier-low', 'busy-low']);
  });

  test('exactly five requests is enough to count', () => {
    expect(findLowHitAccounts([account('five', 5, 0.69)])).toHaveLength(1);
  });
});

describe('table order', () => {
  test('busiest first, then cache reads, then name', () => {
    const rows = sortUsageAccounts([
      { ...account('b', 10, 0.5), cacheReadTokens: 5 },
      { ...account('a', 10, 0.5), cacheReadTokens: 5 },
      { ...account('c', 10, 0.5), cacheReadTokens: 50 },
      account('d', 99, 0.5),
    ]);
    expect(rows.map((item) => item.label)).toEqual(['d', 'c', 'a', 'b']);
  });
});

describe('sparkline', () => {
  const point = (hour: number, cacheRead: number, cacheCreation: number) => ({
    t: new Date(T0 + hour * HOUR).toISOString(),
    tMs: T0 + hour * HOUR,
    requests: 1,
    input: 0,
    cacheRead,
    cacheCreation,
  });

  test('fills missing hours with zeros and merges duplicates', () => {
    const dense = densifyHourlySeries([
      point(3, 30, 3),
      point(0, 10, 1),
      { ...point(0, 5, 0), tMs: T0 + 10 * 60_000 },
    ]);
    expect(dense.map((item) => [item.tMs, item.cacheRead, item.cacheCreation])).toEqual([
      [T0, 15, 1],
      [T0 + HOUR, 0, 0],
      [T0 + 2 * HOUR, 0, 0],
      [T0 + 3 * HOUR, 30, 3],
    ]);
    expect(densifyHourlySeries([{ ...point(0, 1, 1), tMs: null }])).toEqual([]);
  });

  test('both lines share one scale', () => {
    const geometry = buildSparkline([point(0, 100, 0), point(1, 0, 50)], 100, 22);
    expect(geometry.max).toBe(100);
    expect(geometry.read).toBe('M0 1L100 21');
    expect(geometry.write).toBe('M0 21L100 11');
  });

  test('a single bucket draws a flat line; no data draws nothing', () => {
    expect(buildSparkline([point(0, 5, 5)], 100, 22).read).toBe('M0 1L100 1');
    expect(buildSparkline([], 100, 22)).toEqual({ read: '', write: '', max: 0 });
  });

  test('an all-zero series sits on the baseline instead of dividing by zero', () => {
    expect(buildSparkline([point(0, 0, 0), point(1, 0, 0)], 100, 22).read).toBe('M0 21L100 21');
  });
});

describe('usage accounts normalization', () => {
  test('reads the contract, sorts series and falls back to the requested window', () => {
    const report = normalizeUsageAccounts(
      {
        window: 'bogus',
        generated_at: '2026-09-10T12:00:00Z',
        accounts: [
          {
            auth_index: 1,
            auth_id: 'claude-a',
            provider: 'Claude',
            label: 'claude-a.json',
            requests: 12,
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 800,
            cache_creation_tokens: 100,
            cache_hit_ratio: 0.8,
            series: [
              {
                t: '2026-09-10T11:00:00Z',
                requests: 2,
                input: 10,
                cache_read: 20,
                cache_creation: 1,
              },
              {
                t: '2026-09-10T10:00:00Z',
                requests: 1,
                input: 5,
                cache_read: 9,
                cache_creation: 0,
              },
            ],
          },
          null,
          { requests: 3 },
        ],
        totals: {
          requests: 12,
          input_tokens: 100,
          cache_read_tokens: 800,
          cache_creation_tokens: 100,
        },
      },
      '7d'
    );
    expect(report.window).toBe('7d');
    expect(report.accounts).toHaveLength(1);
    const [first] = report.accounts;
    expect(first).toMatchObject({
      authIndex: '1',
      provider: 'claude',
      requests: 12,
      cacheReadTokens: 800,
      cacheCreationTokens: 100,
      cacheHitRatio: 0.8,
    });
    expect(first.series.map((point) => point.t)).toEqual([
      '2026-09-10T10:00:00Z',
      '2026-09-10T11:00:00Z',
    ]);
    // Totals without an explicit ratio derive it the same way the backend does.
    expect(report.totals.cacheHitRatio).toBeCloseTo(800 / 1000);
  });

  test('zero traffic has no ratio rather than a 0% one', () => {
    expect(computeCacheHitRatio(0, 0, 0)).toBeNull();
    const report = normalizeUsageAccounts({ totals: { cache_hit_ratio: 0 } });
    expect(report.totals.cacheHitRatio).toBeNull();
    expect(report.accounts).toEqual([]);
  });

  test('a 404 is the "hub patch missing" signal; other errors are not', () => {
    expect(isHubFeatureMissing({ status: 404 })).toBe(true);
    expect(isHubFeatureMissing({ status: 500 })).toBe(false);
    expect(isHubFeatureMissing(null)).toBe(false);
  });
});
