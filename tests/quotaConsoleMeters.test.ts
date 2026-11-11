/**
 * Console projection of quota state: normalized meters, the primary bucket, pooled sums,
 * and the gateway snapshot fallback.
 */

import { describe, expect, test } from 'bun:test';
import {
  XAI_MONTHLY_ROW_ID,
  buildMeterPool,
  buildProviderSummary,
  extractQuotaMeters,
  extractSnapshotMeters,
  meterTone,
  orderRowMeters,
  pickPrimaryMeterId,
  primaryRemaining,
  type QuotaMeterSample,
} from '@/features/quota/meters';
import { XAI_WEEKLY_ROW_ID } from '@/features/quota/resetSchedule';
import type { AuthFileItem } from '@/types';

const NOW = Date.UTC(2026, 8, 10, 12);
const HOUR = 3_600_000;

const claudeQuota = (fable: number | null, sevenDay: number, fiveHour: number, resetH = 24) => ({
  status: 'success',
  windows: [
    {
      id: 'five-hour',
      label: '5-hour limit',
      labelKey: 'claude_quota.five_hour',
      usedPercent: fiveHour,
      resetLabel: '-',
      resetAtMs: null,
      periodHours: 5,
    },
    {
      id: 'seven-day',
      label: '7-day limit',
      labelKey: 'claude_quota.seven_day',
      usedPercent: sevenDay,
      resetLabel: '-',
      resetAtMs: NOW + resetH * HOUR,
      periodHours: 168,
    },
    ...(fable === null
      ? []
      : [
          {
            id: 'seven-day-fable',
            label: '7-day Fable 5',
            labelKey: 'claude_quota.seven_day_fable',
            usedPercent: fable,
            resetLabel: '-',
            resetAtMs: NOW + resetH * HOUR,
            periodHours: 168,
          },
        ]),
  ],
});

const meter = (id: string, remaining: number | null, extra: Partial<QuotaMeterSample> = {}) => ({
  id,
  label: { text: id },
  remainingPercent: remaining,
  resetAtMs: null,
  periodHours: null,
  ...extra,
});

describe('extractQuotaMeters', () => {
  test('turns used % into remaining % and keeps labels translatable', () => {
    const meters = extractQuotaMeters('claude', claudeQuota(42, 21, 0));
    expect(meters.map((item) => [item.id, item.remainingPercent])).toEqual([
      ['five-hour', 100],
      ['seven-day', 79],
      ['seven-day-fable', 58],
    ]);
    expect(meters[2].label.key).toBe('claude_quota.seven_day_fable');
  });

  test('clamps out-of-range usage and keeps unknown as null', () => {
    const meters = extractQuotaMeters('codex', {
      status: 'success',
      windows: [
        { id: 'weekly', label: 'Weekly', usedPercent: 140, resetLabel: '-' },
        { id: 'five-hour', label: '5h', usedPercent: null, resetLabel: '-' },
      ],
    });
    expect(meters.map((item) => item.remainingPercent)).toEqual([0, null]);
  });

  test('reads nothing from idle, loading or failed states', () => {
    expect(extractQuotaMeters('codex', undefined)).toEqual([]);
    expect(extractQuotaMeters('codex', { status: 'idle', windows: [] })).toEqual([]);
    expect(extractQuotaMeters('codex', { status: 'error', windows: [] })).toEqual([]);
  });

  test('Claude keeps its retained observation while refreshing', () => {
    const retained = { ...claudeQuota(10, 10, 10), status: 'loading' };
    expect(extractQuotaMeters('claude', retained)).toHaveLength(3);
  });

  test('normalizes Kimi rows, Antigravity buckets and Meta windows', () => {
    expect(
      extractQuotaMeters('kimi', {
        status: 'success',
        rows: [{ id: 'weekly', label: 'Weekly', used: 25, limit: 100, periodHours: 168 }],
      })[0].remainingPercent
    ).toBe(75);

    const antigravity = extractQuotaMeters('antigravity', {
      status: 'success',
      groups: [
        {
          id: 'g1',
          label: 'Gemini',
          buckets: [{ id: 'b1', label: 'Weekly', remainingFraction: 0.4 }],
        },
        {
          id: 'g2',
          label: 'Claude',
          buckets: [{ id: 'b2', label: 'Weekly', remainingFraction: 1 }],
        },
      ],
    });
    expect(antigravity.map((item) => [item.id, item.remainingPercent])).toEqual([
      ['b1', 40],
      ['b2', 100],
    ]);
    expect(antigravity[0].label.group?.text).toBe('Gemini');

    const meta = extractQuotaMeters('meta', {
      status: 'success',
      data: { windows: [{ id: 'weekly', usedPercent: 30, resetAt: NOW / 1000 + 60 }] },
    });
    expect(meta[0]).toMatchObject({ id: 'weekly', remainingPercent: 70, periodHours: 168 });
    expect(meta[0].resetAtMs).toBe(NOW + 60_000);
  });

  test('xAI weekly plans expose a weekly meter; monthly plans a monthly one', () => {
    const weekly = extractQuotaMeters('xai', {
      status: 'success',
      billing: {
        mode: 'billing',
        periodType: 'weekly',
        usagePercent: 25,
        usedPercent: null,
        monthlyLimitCents: null,
        resetAtMs: NOW + HOUR,
        productUsage: [],
      },
    });
    expect(weekly.map((item) => [item.id, item.remainingPercent])).toEqual([
      [XAI_WEEKLY_ROW_ID, 75],
    ]);

    const monthly = extractQuotaMeters('xai', {
      status: 'success',
      billing: { mode: 'billing', periodType: 'monthly', usagePercent: null, usedPercent: 60 },
    });
    expect(monthly.map((item) => [item.id, item.remainingPercent])).toEqual([
      [XAI_MONTHLY_ROW_ID, 40],
    ]);

    expect(
      extractQuotaMeters('xai', { status: 'success', billing: { mode: 'paid-health' } })
    ).toEqual([]);
  });
});

describe('primary bucket', () => {
  test('Claude prefers the plain 7-day bucket, then the model-scoped one', () => {
    const withFable = [extractQuotaMeters('claude', claudeQuota(10, 10, 10))];
    const withoutFable = [extractQuotaMeters('claude', claudeQuota(null, 10, 10))];
    expect(pickPrimaryMeterId('claude', withFable)).toBe('seven-day');
    expect(pickPrimaryMeterId('claude', withoutFable)).toBe('seven-day');
  });

  test('picks the bucket even if only one account reports it', () => {
    const lists = [
      extractQuotaMeters('claude', claudeQuota(null, 10, 10)),
      extractQuotaMeters('claude', claudeQuota(30, 10, 10)),
    ];
    expect(pickPrimaryMeterId('claude', lists)).toBe('seven-day');
  });

  test('without a preference, the longest window wins', () => {
    const lists = [
      [meter('a', 50, { periodHours: 5 }), meter('b', 50, { periodHours: 168 })],
      [meter('a', 50, { periodHours: 5 })],
    ];
    expect(pickPrimaryMeterId('antigravity', lists)).toBe('b');
    expect(pickPrimaryMeterId('antigravity', [])).toBeNull();
  });

  test('row order leads with the primary bucket and keeps the rest in provider order', () => {
    const meters = extractQuotaMeters('claude', claudeQuota(42, 21, 0));
    expect(orderRowMeters(meters, 'seven-day-fable').map((item) => item.id)).toEqual([
      'seven-day-fable',
      'five-hour',
      'seven-day',
    ]);
    expect(primaryRemaining(meters, 'seven-day-fable')).toBe(58);
    expect(primaryRemaining(meters, null)).toBeNull();
  });
});

describe('pooling', () => {
  test('sums remaining across accounts against accounts × 100', () => {
    const accounts = [
      extractQuotaMeters('claude', claudeQuota(42, 21, 0, 30)),
      extractQuotaMeters('claude', claudeQuota(0, 0, 0, 90)),
      extractQuotaMeters('claude', claudeQuota(0, 0, 0, 10)),
      extractQuotaMeters('claude', claudeQuota(49, 25, 1, 50)),
      extractQuotaMeters('claude', claudeQuota(0, 0, 0, 70)),
    ];
    const pool = buildMeterPool('seven-day-fable', accounts, NOW);
    expect(pool.sumRemaining).toBe(409);
    expect(pool.maxRemaining).toBe(500);
    expect(pool.segments).toEqual([58, 100, 100, 51, 100]);
    expect(pool.soonestResetMs).toBe(NOW + 10 * HOUR);
  });

  test('unknown readings show as empty segments and do not count as zero', () => {
    const pool = buildMeterPool(
      'weekly',
      [[meter('weekly', 17)], [], [meter('weekly', null)]],
      NOW
    );
    expect(pool.sumRemaining).toBe(17);
    expect(pool.maxRemaining).toBe(300);
    expect(pool.segments).toEqual([17, null, null]);
  });

  test('no reading at all is "--", not 0%', () => {
    const pool = buildMeterPool('weekly', [[]], NOW);
    expect(pool.sumRemaining).toBeNull();
    expect(pool.soonestResetMs).toBeNull();
  });

  test('past resets are not "next" resets', () => {
    const pool = buildMeterPool(
      'weekly',
      [
        [meter('weekly', 50, { resetAtMs: NOW - HOUR })],
        [meter('weekly', 50, { resetAtMs: NOW + HOUR })],
      ],
      NOW
    );
    expect(pool.soonestResetMs).toBe(NOW + HOUR);
  });

  test('provider summary puts weekly secondaries first', () => {
    const summary = buildProviderSummary(
      'claude',
      [
        extractQuotaMeters('claude', claudeQuota(42, 21, 0)),
        extractQuotaMeters('claude', claudeQuota(0, 25, 0)),
      ],
      NOW
    );
    expect(summary.credentials).toBe(2);
    expect(summary.primary?.meterId).toBe('seven-day');
    expect(summary.primary?.sumRemaining).toBe(154);
    expect(summary.secondary.map((pool) => pool.meterId)).toEqual(['seven-day-fable', 'five-hour']);
    expect(summary.secondary[0].sumRemaining).toBe(158);
  });

  test('a pinned primary overrides the subset choice', () => {
    const summary = buildProviderSummary(
      'claude',
      [extractQuotaMeters('claude', claudeQuota(null, 21, 0))],
      NOW,
      'seven-day-fable'
    );
    expect(summary.primary?.meterId).toBe('seven-day-fable');
    expect(summary.primary?.sumRemaining).toBeNull();
  });
});

describe('meter tone', () => {
  test('matches the bar thresholds', () => {
    expect(meterTone(70)).toBe('high');
    expect(meterTone(69.9)).toBe('medium');
    expect(meterTone(30)).toBe('medium');
    expect(meterTone(29)).toBe('low');
    expect(meterTone(null)).toBe('unknown');
  });
});

describe('gateway snapshot fallback', () => {
  const file = (quota: unknown): AuthFileItem => ({ name: 'claude-a.json', quota }) as AuthFileItem;

  test('maps snapshot keys onto the live ids so both pool together', () => {
    const meters = extractSnapshotMeters(
      'claude',
      file({
        windows: [
          {
            key: 'seven_day_fable',
            kind: '7d',
            used_percent: 42,
            resets_at: new Date(NOW + HOUR).toISOString(),
          },
          { key: 'five_hour', kind: '5h', used_percent: 10, resets_at: null },
        ],
      })
    );
    expect(meters.map((item) => [item.id, item.remainingPercent, item.periodHours])).toEqual([
      ['seven-day-fable', 58, 168],
      ['five-hour', 90, 5],
    ]);
    expect(meters[0].label.key).toBe('claude_quota.seven_day_fable');
    expect(meters[0].resetAtMs).toBe(NOW + HOUR);
  });

  test('codex snapshot windows map by kind', () => {
    const meters = extractSnapshotMeters(
      'codex',
      file({ windows: [{ key: 'secondary', kind: '7d', used_percent: 83 }] })
    );
    expect(meters[0]).toMatchObject({ id: 'weekly', remainingPercent: 17 });
  });

  test('ignores absent or malformed snapshots', () => {
    expect(extractSnapshotMeters('claude', file(undefined))).toEqual([]);
    expect(extractSnapshotMeters('claude', file({ windows: 'nope' }))).toEqual([]);
    expect(extractSnapshotMeters('claude', file({ windows: [null, {}] }))).toEqual([]);
  });
});
