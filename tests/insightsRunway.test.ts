/**
 * Runway: status, "runs out Thu 14:00 · resets Sat 08:00" formatting, unused-at-reset, ordering
 * and the history chart geometry. All clocks are fixed and formatting runs in UTC.
 */

import { describe, expect, test } from 'bun:test';
import type { RunwayAccount, RunwayCycle, RunwayWindow } from '@/services/api/hubInsights';
import { formatBurnRate, formatWeekdayInstant } from '@/features/insights/logic/format';
import {
  buildRunwayChart,
  classifyRunway,
  collectRunwayAlerts,
  describeRunway,
  latestCycles,
  nearestPointIndex,
  projectedExhaustMs,
  projectedUsedAtReset,
  sortRunwayAccounts,
  sortRunwayWindows,
  summarizeUnused,
  unusedAtReset,
} from '@/features/insights/logic/runway';

const HOUR = 3_600_000;
// Tuesday 10 Nov 2026, 12:00 UTC.
const NOW = Date.UTC(2026, 10, 10, 12);

const window = (overrides: Partial<RunwayWindow> = {}): RunwayWindow => ({
  key: 'seven_day',
  kind: 'weekly',
  usedPercent: 50,
  resetsAt: null,
  resetsAtMs: NOW + 92 * HOUR, // Sat 08:00
  burnRatePctPerHour: 1,
  projectedExhaustAt: null,
  projectedExhaustAtMs: null,
  exhaustsBeforeReset: false,
  history: [],
  ...overrides,
});

const account = (
  authIndex: string,
  windows: RunwayWindow[],
  lastCycles: RunwayCycle[] = []
): RunwayAccount => ({
  authIndex,
  provider: 'claude',
  label: `claude-${authIndex}.json`,
  windows,
  lastCycles,
});

const cycle = (windowKey: string, hoursAgo: number, final: number | null): RunwayCycle => ({
  windowKey,
  resetAt: null,
  resetAtMs: NOW - hoursAgo * HOUR,
  finalUsedPercent: final,
});

describe('formatting', () => {
  test('weekday + 24h time near now, month + day further out', () => {
    expect(formatWeekdayInstant(Date.UTC(2026, 10, 12, 14), NOW, 'en-US', 'UTC')).toBe('Thu 14:00');
    expect(formatWeekdayInstant(Date.UTC(2026, 10, 14, 8), NOW, 'en-US', 'UTC')).toBe('Sat 08:00');
    expect(formatWeekdayInstant(Date.UTC(2026, 10, 20, 8), NOW, 'en-US', 'UTC')).toBe(
      'Nov 20 08:00'
    );
    expect(formatWeekdayInstant(null, NOW)).toBe('—');
  });

  test('burn rate in points per hour', () => {
    expect(formatBurnRate(2.44, 'en-US')).toBe('+2.4%/h');
    expect(formatBurnRate(14.2, 'en-US')).toBe('+14%/h');
    expect(formatBurnRate(null)).toBe('—');
  });
});

describe('classifyRunway', () => {
  test('exhausted, at risk, ok, idle, unknown', () => {
    expect(classifyRunway(window({ usedPercent: 100 }))).toBe('exhausted');
    expect(classifyRunway(window({ exhaustsBeforeReset: true }))).toBe('at_risk');
    expect(classifyRunway(window())).toBe('ok');
    expect(classifyRunway(window({ burnRatePctPerHour: null }))).toBe('idle');
    expect(classifyRunway(window({ burnRatePctPerHour: 0 }))).toBe('idle');
    expect(classifyRunway(window({ usedPercent: null }))).toBe('unknown');
  });
});

describe('describeRunway', () => {
  test('runs out Thu 14:00 · resets Sat 08:00', () => {
    const description = describeRunway(
      window({
        usedPercent: 74,
        burnRatePctPerHour: 0.52,
        exhaustsBeforeReset: true,
        projectedExhaustAtMs: Date.UTC(2026, 10, 12, 14),
      }),
      NOW,
      'en-US',
      'UTC'
    );
    expect(description).toEqual({
      status: 'at_risk',
      exhaustLabel: 'Thu 14:00',
      resetLabel: 'Sat 08:00',
      leftAtResetPercent: null,
    });
  });

  test('a window that lasts reports what will be left at the reset', () => {
    const description = describeRunway(
      window({ usedPercent: 40, burnRatePctPerHour: 0.5 }),
      NOW,
      'en-US',
      'UTC'
    );
    expect(description.status).toBe('ok');
    expect(description.exhaustLabel).toBeNull();
    // 40% + 0.5 × 92h = 86% at the reset → 14% left.
    expect(description.leftAtResetPercent).toBeCloseTo(14);
  });

  test('no pending reset and a reset in the past both read as no reset', () => {
    expect(describeRunway(window({ resetsAtMs: null }), NOW).resetLabel).toBeNull();
    expect(describeRunway(window({ resetsAtMs: NOW - HOUR }), NOW).resetLabel).toBeNull();
  });

  test('exhaust time is derived from the burn rate when the backend sent none', () => {
    expect(projectedExhaustMs(window({ usedPercent: 90, burnRatePctPerHour: 5 }), NOW)).toBe(
      NOW + 2 * HOUR
    );
    expect(projectedExhaustMs(window({ burnRatePctPerHour: null }), NOW)).toBeNull();
  });

  test('projected use at reset is clamped to 100% and needs a pace', () => {
    expect(projectedUsedAtReset(window({ usedPercent: 90, burnRatePctPerHour: 5 }), NOW)).toBe(100);
    expect(projectedUsedAtReset(window({ burnRatePctPerHour: null }), NOW)).toBeNull();
    expect(projectedUsedAtReset(window({ burnRatePctPerHour: 0 }), NOW)).toBe(50);
  });
});

describe('left unused at last reset', () => {
  test('latest cycle per key and the unused share', () => {
    const latest = latestCycles([cycle('w', 300, 20), cycle('w', 100, 70), cycle('f', 3, null)]);
    expect(latest.get('w')?.finalUsedPercent).toBe(70);
    expect(unusedAtReset(latest.get('w'))).toBe(30);
    expect(unusedAtReset(latest.get('f'))).toBeNull();
    expect(unusedAtReset(undefined)).toBeNull();
    expect(unusedAtReset(cycle('x', 1, 120))).toBe(0);
  });

  test('summary prefers weekly windows and falls back to all kinds', () => {
    const fiveHour = window({ key: 'five_hour', kind: 'five_hour' });
    const accounts = [
      account('a', [window(), fiveHour], [cycle('seven_day', 10, 60), cycle('five_hour', 1, 0)]),
      account('b', [window()], [cycle('seven_day', 20, 80)]),
    ];
    expect(summarizeUnused(accounts)).toEqual({
      averagePercent: 30,
      totalPercent: 60,
      windows: 2,
      scope: 'weekly',
    });
    const onlyFiveHour = summarizeUnused([account('c', [fiveHour], [cycle('five_hour', 1, 75)])]);
    expect(onlyFiveHour.scope).toBe('all');
    expect(onlyFiveHour.averagePercent).toBe(25);
    expect(summarizeUnused([]).averagePercent).toBeNull();
  });
});

describe('ordering', () => {
  test('alerts: exhausted first, then soonest exhaustion', () => {
    const later = window({ exhaustsBeforeReset: true, projectedExhaustAtMs: NOW + 30 * HOUR });
    const sooner = window({ exhaustsBeforeReset: true, projectedExhaustAtMs: NOW + 3 * HOUR });
    const done = window({ usedPercent: 100 });
    const alerts = collectRunwayAlerts(
      [account('a', [later, window()]), account('b', [sooner]), account('c', [done])],
      NOW
    );
    expect(alerts.map((alert) => alert.account.authIndex)).toEqual(['c', 'b', 'a']);
  });

  test('accounts in trouble first; windows five-hour before weekly', () => {
    const sorted = sortRunwayAccounts(
      [account('ok', [window()]), account('risk', [window({ exhaustsBeforeReset: true })])],
      NOW
    );
    expect(sorted.map((entry) => entry.authIndex)).toEqual(['risk', 'ok']);
    expect(
      sortRunwayWindows([window(), window({ key: 'five_hour', kind: 'five_hour' })]).map(
        (w) => w.kind
      )
    ).toEqual(['five_hour', 'weekly']);
  });
});

describe('buildRunwayChart', () => {
  const resetsAtMs = NOW + 2 * HOUR;
  const fiveHour = window({
    key: 'five_hour',
    kind: 'five_hour',
    usedPercent: 60,
    burnRatePctPerHour: 30,
    resetsAtMs,
    history: [
      { t: '', tMs: NOW - 3 * HOUR, usedPercent: 0 },
      { t: '', tMs: NOW, usedPercent: 60 },
    ],
  });

  test('spans the cycle up to the reset, 100% at the top', () => {
    const chart = buildRunwayChart(fiveHour, NOW, 300, 64);
    expect(chart.startMs).toBe(NOW - 3 * HOUR);
    expect(chart.endMs).toBe(resetsAtMs);
    expect(chart.points[0]).toMatchObject({ x: 0, y: chart.baseY });
    expect(chart.points[1].x).toBe(180);
    expect(chart.nowX).toBe(180);
    expect(chart.resetX).toBe(300);
    expect(chart.limitY).toBe(3);
    expect(chart.line.startsWith('M0 ')).toBe(true);
  });

  test('the pace line stops at 100% when it runs out before the reset', () => {
    const chart = buildRunwayChart(fiveHour, NOW, 300, 64);
    // 40 points left at 30/h → exhausted 80 minutes from now, before the 2h reset.
    expect(chart.projectionEnd?.reachesLimit).toBe(true);
    expect(chart.projectionEnd?.x).toBeCloseTo(180 + (80 / 300) * 300, 0);
    expect(chart.projectionEnd?.y).toBe(chart.limitY);
  });

  test('a window that lasts projects to the reset edge, idle draws no projection', () => {
    const slow = buildRunwayChart({ ...fiveHour, burnRatePctPerHour: 5 }, NOW, 300, 64);
    expect(slow.projectionEnd).toMatchObject({ x: 300, reachesLimit: false });
    expect(
      buildRunwayChart({ ...fiveHour, burnRatePctPerHour: null }, NOW, 300, 64).projection
    ).toBeNull();
  });

  test('no history and no usage draws nothing; usage alone draws a single point', () => {
    expect(buildRunwayChart(window({ usedPercent: null }), NOW, 300, 64).line).toBe('');
    expect(buildRunwayChart(window({ history: [] }), NOW, 300, 64).points).toHaveLength(1);
  });

  test('hover picks the nearest sample', () => {
    const chart = buildRunwayChart(fiveHour, NOW, 300, 64);
    expect(nearestPointIndex(chart.points, 20)).toBe(0);
    expect(nearestPointIndex(chart.points, 170)).toBe(1);
    expect(nearestPointIndex([], 10)).toBe(-1);
  });
});
