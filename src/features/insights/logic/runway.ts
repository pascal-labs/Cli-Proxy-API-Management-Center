/**
 * Runway: will each quota window last until it resets, and how much was left on the table last
 * time? Pure and clock-free; `nowMs` is always passed in.
 */

import type { RunwayAccount, RunwayCycle, RunwayWindow } from '@/services/api/hubInsights';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import { formatWeekdayInstant } from './format';

export type RunwayStatus = 'exhausted' | 'at_risk' | 'ok' | 'idle' | 'unknown';

/** At risk / exhausted first: the order the page sorts and the summary counts by. */
export const RUNWAY_STATUS_RANK: Record<RunwayStatus, number> = {
  exhausted: 0,
  at_risk: 1,
  ok: 2,
  idle: 3,
  unknown: 4,
};

export function classifyRunway(window: RunwayWindow): RunwayStatus {
  if (window.usedPercent === null) return 'unknown';
  if (window.usedPercent >= 100) return 'exhausted';
  if (window.exhaustsBeforeReset) return 'at_risk';
  if (window.burnRatePctPerHour === null || window.burnRatePctPerHour <= 0) return 'idle';
  return 'ok';
}

const isFuture = (ms: number | null, nowMs: number): ms is number => ms !== null && ms > nowMs;

/** When the window hits 100% at the current pace: the backend's projection, else derived. */
export function projectedExhaustMs(window: RunwayWindow, nowMs: number): number | null {
  if (window.projectedExhaustAtMs !== null) return window.projectedExhaustAtMs;
  const burn = window.burnRatePctPerHour;
  if (window.usedPercent === null || burn === null || burn <= 0) return null;
  const remaining = 100 - window.usedPercent;
  return remaining <= 0 ? nowMs : nowMs + (remaining / burn) * HOUR_MS;
}

/** Used % expected at the reset if the current burn holds; null without a pace or a reset. */
export function projectedUsedAtReset(window: RunwayWindow, nowMs: number): number | null {
  if (window.usedPercent === null || !isFuture(window.resetsAtMs, nowMs)) return null;
  const burn = window.burnRatePctPerHour;
  if (burn === null) return null;
  const hours = (window.resetsAtMs - nowMs) / HOUR_MS;
  return Math.min(
    100,
    Math.max(window.usedPercent, window.usedPercent + Math.max(0, burn) * hours)
  );
}

export interface RunwayDescription {
  status: RunwayStatus;
  /** "Thu 14:00" when the window runs out before its reset. */
  exhaustLabel: string | null;
  /** "Sat 08:00"; null when no reset is pending. */
  resetLabel: string | null;
  /** Quota expected to be left over at the reset (0–100), when it lasts. */
  leftAtResetPercent: number | null;
}

/** Text parts for "runs out Thu 14:00 · resets Sat 08:00". */
export function describeRunway(
  window: RunwayWindow,
  nowMs: number,
  locale?: string,
  timeZone?: string
): RunwayDescription {
  const status = classifyRunway(window);
  const resetLabel = isFuture(window.resetsAtMs, nowMs)
    ? formatWeekdayInstant(window.resetsAtMs, nowMs, locale, timeZone)
    : null;
  const exhaustMs = status === 'at_risk' ? projectedExhaustMs(window, nowMs) : null;
  const atReset = status === 'ok' || status === 'idle' ? projectedUsedAtReset(window, nowMs) : null;
  return {
    status,
    exhaustLabel:
      exhaustMs === null
        ? null
        : formatWeekdayInstant(Math.max(exhaustMs, nowMs), nowMs, locale, timeZone),
    resetLabel,
    leftAtResetPercent: atReset === null ? null : Math.max(0, 100 - atReset),
  };
}

/** Most recent completed cycle per window key. */
export function latestCycles(cycles: readonly RunwayCycle[]): Map<string, RunwayCycle> {
  const latest = new Map<string, RunwayCycle>();
  cycles.forEach((cycle) => {
    const existing = latest.get(cycle.windowKey);
    if (!existing || (cycle.resetAtMs ?? -Infinity) > (existing.resetAtMs ?? -Infinity)) {
      latest.set(cycle.windowKey, cycle);
    }
  });
  return latest;
}

/** Quota left unused when the cycle reset (0–100); null when the final figure is unknown. */
export function unusedAtReset(cycle: RunwayCycle | null | undefined): number | null {
  if (!cycle || cycle.finalUsedPercent === null) return null;
  return Math.min(100, Math.max(0, 100 - cycle.finalUsedPercent));
}

export interface UnusedSummary {
  /** Mean unused % across the counted windows. */
  averagePercent: number | null;
  /** Sum of unused % — "1.4 accounts' worth" when divided by 100. */
  totalPercent: number;
  windows: number;
  /** Weekly windows when any reported a cycle, otherwise every window kind. */
  scope: 'weekly' | 'all';
}

/** "Quota left unused at the last reset", preferring weekly windows (the ones that are paid for). */
export function summarizeUnused(accounts: readonly RunwayAccount[]): UnusedSummary {
  const weekly: number[] = [];
  const all: number[] = [];
  accounts.forEach((account) => {
    const kinds = new Map(account.windows.map((window) => [window.key, window.kind]));
    latestCycles(account.lastCycles).forEach((cycle, key) => {
      const unused = unusedAtReset(cycle);
      if (unused === null) return;
      all.push(unused);
      if (kinds.get(key) === 'weekly') weekly.push(unused);
    });
  });
  const values = weekly.length > 0 ? weekly : all;
  const totalPercent = values.reduce((sum, value) => sum + value, 0);
  return {
    averagePercent: values.length ? totalPercent / values.length : null,
    totalPercent,
    windows: values.length,
    scope: weekly.length > 0 ? 'weekly' : 'all',
  };
}

export interface RunwayAlert {
  account: RunwayAccount;
  window: RunwayWindow;
  status: RunwayStatus;
  exhaustMs: number | null;
}

/** Windows that run out before reset or already have, soonest first. */
export function collectRunwayAlerts(
  accounts: readonly RunwayAccount[],
  nowMs: number
): RunwayAlert[] {
  const alerts: RunwayAlert[] = [];
  accounts.forEach((account) =>
    account.windows.forEach((window) => {
      const status = classifyRunway(window);
      if (status !== 'at_risk' && status !== 'exhausted') return;
      alerts.push({
        account,
        window,
        status,
        exhaustMs: status === 'exhausted' ? nowMs : projectedExhaustMs(window, nowMs),
      });
    })
  );
  return alerts.sort(
    (a, b) =>
      RUNWAY_STATUS_RANK[a.status] - RUNWAY_STATUS_RANK[b.status] ||
      (a.exhaustMs ?? Infinity) - (b.exhaustMs ?? Infinity)
  );
}

const worstStatus = (account: RunwayAccount): RunwayStatus =>
  account.windows
    .map(classifyRunway)
    .reduce<RunwayStatus>(
      (worst, status) => (RUNWAY_STATUS_RANK[status] < RUNWAY_STATUS_RANK[worst] ? status : worst),
      'unknown'
    );

/** Accounts in trouble first, then the one that runs out soonest, then by label. */
export function sortRunwayAccounts(
  accounts: readonly RunwayAccount[],
  nowMs: number
): RunwayAccount[] {
  const soonest = (account: RunwayAccount) =>
    Math.min(
      Infinity,
      ...account.windows
        .filter((window) => classifyRunway(window) === 'at_risk')
        .map((window) => projectedExhaustMs(window, nowMs) ?? Infinity)
    );
  return [...accounts].sort(
    (a, b) =>
      RUNWAY_STATUS_RANK[worstStatus(a)] - RUNWAY_STATUS_RANK[worstStatus(b)] ||
      soonest(a) - soonest(b) ||
      a.label.localeCompare(b.label) ||
      a.authIndex.localeCompare(b.authIndex)
  );
}

/** Five-hour windows first, then weekly, then anything else by key. */
export function sortRunwayWindows(windows: readonly RunwayWindow[]): RunwayWindow[] {
  const rank = { five_hour: 0, weekly: 1, other: 2 } as const;
  return [...windows].sort((a, b) => rank[a.kind] - rank[b.kind] || a.key.localeCompare(b.key));
}

/* ---------------------------------------------------------------------------------------------
 * History chart geometry
 * ------------------------------------------------------------------------------------------- */

export const RUNWAY_SPAN_MS: Record<RunwayWindow['kind'], number> = {
  five_hour: 5 * HOUR_MS,
  weekly: 7 * DAY_MS,
  other: 7 * DAY_MS,
};

export interface RunwayChartPoint {
  x: number;
  y: number;
  tMs: number;
  usedPercent: number;
}

export interface RunwayChartGeometry {
  startMs: number;
  endMs: number;
  /** Used-% history; empty when there is nothing to draw. */
  line: string;
  area: string;
  points: RunwayChartPoint[];
  /** Dashed pace line from now toward 100% (or the reset, whichever comes first). */
  projection: string | null;
  projectionEnd: { x: number; y: number; reachesLimit: boolean } | null;
  nowX: number | null;
  resetX: number | null;
  /** y of the 100% line. */
  limitY: number;
  baseY: number;
}

const r1 = (value: number) => Math.round(value * 10) / 10;

/**
 * x spans the window's own cycle (reset − span → reset) so the line climbs toward the right edge
 * where the quota refills; y is used % with 100% at the top.
 */
export function buildRunwayChart(
  window: RunwayWindow,
  nowMs: number,
  width: number,
  height: number
): RunwayChartGeometry {
  const span = RUNWAY_SPAN_MS[window.kind];
  const firstPoint = window.history[0]?.tMs ?? null;
  const resetMs = window.resetsAtMs;
  let startMs = resetMs !== null ? resetMs - span : nowMs - span;
  if (firstPoint !== null) startMs = Math.min(startMs, firstPoint);
  const lastPoint = window.history[window.history.length - 1]?.tMs ?? nowMs;
  let endMs = Math.max(resetMs ?? nowMs, nowMs, lastPoint);
  if (endMs <= startMs) endMs = startMs + HOUR_MS;

  const top = 3;
  const bottom = 2;
  const usable = height - top - bottom;
  const x = (ms: number) => r1(((ms - startMs) / (endMs - startMs)) * width);
  const y = (percent: number) => r1(top + (1 - Math.min(100, Math.max(0, percent)) / 100) * usable);
  const baseY = r1(top + usable);

  const source =
    window.history.length > 0
      ? window.history
      : window.usedPercent !== null
        ? [{ t: '', tMs: nowMs, usedPercent: window.usedPercent }]
        : [];
  const points = source.map((point) => ({
    x: x(point.tMs),
    y: y(point.usedPercent),
    tMs: point.tMs,
    usedPercent: point.usedPercent,
  }));
  const line = points.length
    ? points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join('') +
      (points.length === 1 ? `L${points[0].x} ${points[0].y}` : '')
    : '';
  const area = points.length
    ? `${line}L${points[points.length - 1].x} ${baseY}L${points[0].x} ${baseY}Z`
    : '';

  let projection: string | null = null;
  let projectionEnd: RunwayChartGeometry['projectionEnd'] = null;
  const burn = window.burnRatePctPerHour;
  const used = window.usedPercent;
  if (used !== null && used < 100 && burn !== null && burn > 0 && endMs > nowMs) {
    const exhaustMs = projectedExhaustMs(window, nowMs) ?? Infinity;
    const stopMs = Math.min(endMs, exhaustMs);
    const stopUsed = Math.min(100, used + (burn * (stopMs - nowMs)) / HOUR_MS);
    const fromX = x(nowMs);
    const toX = x(stopMs);
    projection = `M${fromX} ${y(used)}L${toX} ${y(stopUsed)}`;
    projectionEnd = { x: toX, y: y(stopUsed), reachesLimit: stopUsed >= 100 - 1e-9 };
  }

  return {
    startMs,
    endMs,
    line,
    area,
    points,
    projection,
    projectionEnd,
    nowX: nowMs >= startMs && nowMs <= endMs ? x(nowMs) : null,
    resetX: resetMs !== null && resetMs >= startMs ? x(resetMs) : null,
    limitY: y(100),
    baseY,
  };
}

/** Index of the history point nearest to an x position (for the hover crosshair). */
export function nearestPointIndex(points: readonly RunwayChartPoint[], xPos: number): number {
  if (points.length === 0) return -1;
  let best = 0;
  let bestDistance = Infinity;
  points.forEach((point, index) => {
    const distance = Math.abs(point.x - xPos);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}
