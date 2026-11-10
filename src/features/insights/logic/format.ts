/**
 * Number, money and instant formatting shared by the insight pages. Pure and clock-free: `nowMs`,
 * `locale` and (for tests) `timeZone` are always passed in.
 */

import { maskAccountName } from '@/utils/accountMask';
import { relativeTimeParts } from '@/utils/quota/relativeTime';
import { DAY_MS } from '@/utils/time/durations';

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

function numberFormat(locale: string | undefined, options: Intl.NumberFormatOptions) {
  const key = `n|${locale ?? ''}|${JSON.stringify(options)}`;
  let formatter = cache.get(key) as Intl.NumberFormat | undefined;
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat(locale, options);
    } catch {
      formatter = new Intl.NumberFormat(undefined, options);
    }
    cache.set(key, formatter);
  }
  return formatter;
}

function dateFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions) {
  const key = `d|${locale ?? ''}|${JSON.stringify(options)}`;
  let formatter = cache.get(key) as Intl.DateTimeFormat | undefined;
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat(locale, options);
    } catch {
      formatter = new Intl.DateTimeFormat(undefined, options);
    }
    cache.set(key, formatter);
  }
  return formatter;
}

export const EMPTY_VALUE = '—';

const isNumber = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** "$0.42", "$41.20", "$1,234", "$12.3K"; "<$0.01" for dust; "—" when unknown. */
export function formatUsd(value: number | null | undefined, locale?: string): string {
  if (!isNumber(value)) return EMPTY_VALUE;
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.01)
    return `<${numberFormat(locale, { style: 'currency', currency: 'USD' }).format(0.01)}`;
  if (abs >= 100_000) {
    return numberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  }
  return numberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: abs >= 1000 ? 0 : 2,
    maximumFractionDigits: abs >= 1000 ? 0 : 2,
  }).format(value);
}

/** 1234567 → "1.2M". */
export function formatCompactNumber(value: number | null | undefined, locale?: string): string {
  if (!isNumber(value)) return EMPTY_VALUE;
  return numberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** Value ratio as a multiple: 4.25 → "4.3×", 12.6 → "13×", 0.04 → "0.04×". */
export function formatMultiple(ratio: number | null | undefined, locale?: string): string {
  if (!isNumber(ratio)) return EMPTY_VALUE;
  const digits = ratio >= 10 ? 0 : ratio >= 0.1 ? 1 : 2;
  return `${numberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(ratio)}×`;
}

/** 0–1 ratio as a whole percentage; "<1%" for a non-zero sliver. */
export function formatShare(ratio: number | null | undefined): string {
  if (!isNumber(ratio)) return EMPTY_VALUE;
  if (ratio > 0 && ratio < 0.005) return '<1%';
  return `${Math.round(ratio * 100)}%`;
}

/** Already-a-percentage value (0–100). */
export function formatPercentValue(value: number | null | undefined): string {
  if (!isNumber(value)) return EMPTY_VALUE;
  return `${Math.round(value)}%`;
}

/** Burn rate in percentage points per hour: "+2.4%/h", "+14%/h". */
export function formatBurnRate(rate: number | null | undefined, locale?: string): string {
  if (!isNumber(rate)) return EMPTY_VALUE;
  const digits = Math.abs(rate) >= 10 ? 0 : 1;
  const text = numberFormat(locale, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(Math.abs(rate));
  return `${rate < 0 ? '−' : '+'}${text}%/h`;
}

/**
 * Planning-friendly instant: "Thu 14:00" within six days either side of `nowMs`, "Nov 20 08:00"
 * beyond that so a weekday never becomes ambiguous.
 */
export function formatWeekdayInstant(
  ms: number | null | undefined,
  nowMs: number,
  locale?: string,
  timeZone?: string
): string {
  if (!isNumber(ms)) return EMPTY_VALUE;
  const zone = timeZone ? { timeZone } : {};
  const time = dateFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...zone,
  }).format(ms);
  const near = Math.abs(ms - nowMs) < 6 * DAY_MS;
  const day = near
    ? dateFormat(locale, { weekday: 'short', ...zone }).format(ms)
    : dateFormat(locale, { month: 'short', day: 'numeric', ...zone }).format(ms);
  return `${day} ${time}`;
}

const agoFormatters = new Map<string, Intl.RelativeTimeFormat>();

/** Compact relative time for table cells: "11 min. ago", "2 days ago". */
export function formatAgo(ms: number | null | undefined, nowMs: number, locale?: string): string {
  if (!isNumber(ms)) return EMPTY_VALUE;
  const key = locale ?? '';
  let formatter = agoFormatters.get(key);
  if (!formatter) {
    try {
      formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'short' });
    } catch {
      formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'always', style: 'short' });
    }
    agoFormatters.set(key, formatter);
  }
  const { value, unit } = relativeTimeParts(ms, nowMs);
  return formatter.format(value, unit);
}

/** "14:05" for timeline rows. */
export function formatClock(ms: number, locale?: string, timeZone?: string): string {
  return dateFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}),
  }).format(ms);
}

/** "Mon, Nov 10" for timeline day headers. */
export function formatDay(ms: number, locale?: string, timeZone?: string): string {
  return dateFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  }).format(ms);
}

/** Calendar-day key in the given (or local) zone, for grouping. */
export function dayKey(ms: number, timeZone?: string): string {
  return dateFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(ms);
}

/** First 8 characters of a session key, with an ellipsis when it was longer. */
export function shortSessionKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.length > 12 ? `${trimmed.slice(0, 8)}…` : trimmed;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Free-text backend messages can name an account ("refresh failed for alex@…"). With emails
 * hidden, each address is masked the same way as account labels.
 */
export function maskEmailsInText(text: string, reveal: boolean): string {
  if (reveal || !text) return text;
  return text.replace(EMAIL_RE, (match) => maskAccountName(match));
}
