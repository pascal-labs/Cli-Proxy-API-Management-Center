/**
 * Cache & Usage page logic: hit-ratio bands, the session-hopping callout, sparkline geometry.
 * React-free and clock-free so every rule is directly testable.
 */

import type { UsageAccount, UsageSeriesPoint } from '@/services/api/hub';
import { HOUR_MS } from '@/utils/time/durations';

/** ≥70% green, 40–70% amber, below 40% red; `none` when nothing was measured. */
export type HitRatioBand = 'high' | 'medium' | 'low' | 'none';

export const HIT_RATIO_HIGH = 0.7;
export const HIT_RATIO_MEDIUM = 0.4;

export function classifyHitRatio(ratio: number | null | undefined): HitRatioBand {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return 'none';
  if (ratio >= HIT_RATIO_HIGH) return 'high';
  if (ratio >= HIT_RATIO_MEDIUM) return 'medium';
  return 'low';
}

/** Below this many requests in the last hour a ratio is noise, not a signal. */
export const LOW_HIT_MIN_REQUESTS = 5;

/**
 * Accounts whose last-hour cache hit ratio suggests sessions are hopping between accounts:
 * busy enough to matter (≥5 requests) yet under the healthy band. Busiest first.
 */
export function findLowHitAccounts(
  accounts: readonly UsageAccount[],
  minRequests = LOW_HIT_MIN_REQUESTS,
  threshold = HIT_RATIO_HIGH
): UsageAccount[] {
  return accounts
    .filter(
      (account) =>
        account.requests >= minRequests &&
        account.cacheHitRatio !== null &&
        account.cacheHitRatio < threshold
    )
    .sort((a, b) => b.requests - a.requests);
}

/** Busiest accounts first; name breaks ties so the table does not shuffle between refreshes. */
export function sortUsageAccounts(accounts: readonly UsageAccount[]): UsageAccount[] {
  return [...accounts].sort(
    (a, b) =>
      b.requests - a.requests ||
      b.cacheReadTokens - a.cacheReadTokens ||
      a.label.localeCompare(b.label)
  );
}

/**
 * Hourly buckets with the gaps filled by zeros, so a quiet hour reads as a dip instead of the
 * line silently jumping across it. Points without a usable timestamp are dropped.
 */
export function densifyHourlySeries(series: readonly UsageSeriesPoint[]): UsageSeriesPoint[] {
  const timed = series
    .filter((point): point is UsageSeriesPoint & { tMs: number } => point.tMs !== null)
    .sort((a, b) => a.tMs - b.tMs);
  if (timed.length === 0) return [];
  const byHour = new Map<number, UsageSeriesPoint>();
  timed.forEach((point) => {
    const hour = Math.floor(point.tMs / HOUR_MS) * HOUR_MS;
    const existing = byHour.get(hour);
    byHour.set(
      hour,
      existing
        ? {
            ...existing,
            requests: existing.requests + point.requests,
            input: existing.input + point.input,
            cacheRead: existing.cacheRead + point.cacheRead,
            cacheCreation: existing.cacheCreation + point.cacheCreation,
          }
        : { ...point, tMs: hour }
    );
  });
  const first = Math.floor(timed[0].tMs / HOUR_MS) * HOUR_MS;
  const last = Math.floor(timed[timed.length - 1].tMs / HOUR_MS) * HOUR_MS;
  const result: UsageSeriesPoint[] = [];
  // Bounded: a week of hourly buckets is 168 points; refuse to expand pathological spans.
  const maxPoints = 24 * 31;
  for (let hour = first, count = 0; hour <= last && count < maxPoints; hour += HOUR_MS, count++) {
    result.push(
      byHour.get(hour) ?? {
        t: new Date(hour).toISOString(),
        tMs: hour,
        requests: 0,
        input: 0,
        cacheRead: 0,
        cacheCreation: 0,
      }
    );
  }
  return result;
}

export interface SparklineGeometry {
  read: string;
  write: string;
  /** Shared y-scale ceiling; 0 means an all-zero series (both lines sit on the baseline). */
  max: number;
}

const round = (value: number) => Math.round(value * 10) / 10;

function linePath(values: readonly number[], width: number, height: number, max: number): string {
  if (values.length === 0) return '';
  const pad = 1;
  const usable = height - pad * 2;
  const y = (value: number) => round(pad + usable - (max > 0 ? (value / max) * usable : 0));
  if (values.length === 1) {
    return `M0 ${y(values[0])}L${width} ${y(values[0])}`;
  }
  const step = width / (values.length - 1);
  return values
    .map((value, index) => `${index === 0 ? 'M' : 'L'}${round(index * step)} ${y(value)}`)
    .join('');
}

/** Cache read vs cache creation on one shared scale, so the two lines compare honestly. */
export function buildSparkline(
  series: readonly UsageSeriesPoint[],
  width: number,
  height: number
): SparklineGeometry {
  const reads = series.map((point) => point.cacheRead);
  const writes = series.map((point) => point.cacheCreation);
  const max = Math.max(0, ...reads, ...writes);
  return {
    read: linePath(reads, width, height, max),
    write: linePath(writes, width, height, max),
    max,
  };
}

const compactFormatters = new Map<string, Intl.NumberFormat>();

/** 1234567 → "1.2M" in the active locale. */
export function formatCompact(value: number, locale?: string): string {
  const key = locale ?? '';
  let formatter = compactFormatters.get(key);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
    } catch {
      formatter = new Intl.NumberFormat(undefined, {
        notation: 'compact',
        maximumFractionDigits: 1,
      });
    }
    compactFormatters.set(key, formatter);
  }
  return formatter.format(value);
}

export const formatRatio = (ratio: number | null): string =>
  ratio === null || !Number.isFinite(ratio) ? '—' : `${Math.round(ratio * 100)}%`;
