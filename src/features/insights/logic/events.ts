/**
 * Health: `/usage/events` shaping — totals by kind, filters, the kind × hour matrix, failover
 * history and logins that died without recovering.
 */

import {
  USAGE_EVENT_KINDS,
  type EventsReport,
  type UsageEvent,
  type UsageEventCount,
} from '@/services/api/hubInsights';
import { HOUR_MS } from '@/utils/time/durations';

/** Kinds that count as "errors" on the overview: the request did not succeed where it landed. */
export const ERROR_EVENT_KINDS: readonly string[] = [
  'rate_limited',
  'transient_error',
  'network_error',
  'dead_login',
];

/** Traffic moved between accounts. */
export const MOVE_EVENT_KINDS: readonly string[] = ['failover', 'rebind'];

/**
 * Totals per kind. The hourly `counts` cover the whole window, while `events` may be truncated by
 * `limit`, so counts win whenever the backend sent any.
 */
export function countEventsByKind(
  report: Pick<EventsReport, 'events' | 'counts'> | null | undefined
): Map<string, number> {
  const totals = new Map<string, number>();
  if (!report) return totals;
  if (report.counts.length > 0) {
    report.counts.forEach((entry) =>
      totals.set(entry.kind, (totals.get(entry.kind) ?? 0) + entry.count)
    );
  } else {
    report.events.forEach((event) => totals.set(event.kind, (totals.get(event.kind) ?? 0) + 1));
  }
  return totals;
}

export interface HealthSummary {
  failovers: number;
  rebinds: number;
  errors: number;
  rateLimited: number;
  deadLogins: number;
}

export function summarizeHealth(
  report: Pick<EventsReport, 'events' | 'counts'> | null | undefined
): HealthSummary {
  const totals = countEventsByKind(report);
  const get = (kind: string) => totals.get(kind) ?? 0;
  return {
    failovers: get('failover'),
    rebinds: get('rebind'),
    errors: ERROR_EVENT_KINDS.reduce((sum, kind) => sum + get(kind), 0),
    rateLimited: get('rate_limited'),
    deadLogins: get('dead_login'),
  };
}

/** Known kinds in contract order, then any newer kinds the backend sent, alphabetically. */
export function orderedEventKinds(present: Iterable<string>): string[] {
  const known = USAGE_EVENT_KINDS as readonly string[];
  const extra = [...new Set(present)].filter((kind) => !known.includes(kind)).sort();
  return [...known, ...extra];
}

export interface EventFilter {
  /** Null or empty = every kind. */
  kinds?: ReadonlySet<string> | null;
  /** Null or empty = every account. */
  authIndex?: string | null;
}

export function filterEvents(events: readonly UsageEvent[], filter: EventFilter): UsageEvent[] {
  const kinds = filter.kinds && filter.kinds.size > 0 ? filter.kinds : null;
  const account = filter.authIndex || null;
  return events.filter(
    (event) => (!kinds || kinds.has(event.kind)) && (!account || event.authIndex === account)
  );
}

/** Accounts that appear in the events, most active first. */
export function eventAccounts(events: readonly UsageEvent[]): string[] {
  const counts = new Map<string, number>();
  events.forEach((event) => {
    if (event.authIndex) counts.set(event.authIndex, (counts.get(event.authIndex) ?? 0) + 1);
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k);
}

/* ---------------------------------------------------------------------------------------------
 * Kind × hour matrix
 * ------------------------------------------------------------------------------------------- */

export interface HourlyRow {
  kind: string;
  cells: number[];
  total: number;
}

export interface HourlyMatrix {
  /** Hour starts, oldest first; the last one is the current hour. */
  hours: number[];
  rows: HourlyRow[];
  max: number;
}

/**
 * One row per kind and one cell per hour of the window, ending with the current hour. Kinds with
 * no events in the window are dropped unless they were explicitly asked for.
 */
export function buildHourlyMatrix(input: {
  counts?: readonly UsageEventCount[];
  /** Used instead of counts when given (e.g. when filtering by account). */
  events?: readonly UsageEvent[];
  windowMs: number;
  nowMs: number;
  kinds: readonly string[];
  keepEmpty?: boolean;
}): HourlyMatrix {
  const size = Math.max(1, Math.round(input.windowMs / HOUR_MS));
  const last = Math.floor(input.nowMs / HOUR_MS) * HOUR_MS;
  const first = last - (size - 1) * HOUR_MS;
  const hours = Array.from({ length: size }, (_, index) => first + index * HOUR_MS);
  const cells = new Map<string, number[]>(
    input.kinds.map((kind) => [kind, new Array(size).fill(0)])
  );
  const add = (kind: string, ms: number, count: number) => {
    const row = cells.get(kind);
    if (!row) return;
    const index = Math.floor((ms - first) / HOUR_MS);
    if (index < 0 || index >= size) return;
    row[index] += count;
  };
  if (input.events) {
    input.events.forEach((event) => add(event.kind, event.tMs, 1));
  } else {
    input.counts?.forEach((entry) => add(entry.kind, entry.hourMs, entry.count));
  }
  let max = 0;
  const rows: HourlyRow[] = [];
  input.kinds.forEach((kind) => {
    const row = cells.get(kind) ?? [];
    const total = row.reduce((sum, value) => sum + value, 0);
    max = Math.max(max, ...row);
    if (total > 0 || input.keepEmpty) rows.push({ kind, cells: row, total });
  });
  return { hours, rows, max };
}

/** Quantized intensity for a cell: 0 empty, then 1 · 2–3 · 4–9 · 10+. */
export function heatLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 9) return 3;
  return 4;
}

/* ---------------------------------------------------------------------------------------------
 * Failover history and dead logins
 * ------------------------------------------------------------------------------------------- */

/** Failovers and rebinds, newest first. */
export function moveHistory(events: readonly UsageEvent[]): UsageEvent[] {
  return events
    .filter((event) => MOVE_EVENT_KINDS.includes(event.kind))
    .sort((a, b) => b.tMs - a.tMs);
}

/**
 * The latest dead login per account that has no `recovered` event after it: logins that still
 * need re-authenticating. Newest first.
 */
export function activeDeadLogins(events: readonly UsageEvent[]): UsageEvent[] {
  const latestDead = new Map<string, UsageEvent>();
  const latestRecovered = new Map<string, number>();
  events.forEach((event) => {
    if (!event.authIndex) return;
    if (event.kind === 'dead_login') {
      const existing = latestDead.get(event.authIndex);
      if (!existing || event.tMs > existing.tMs) latestDead.set(event.authIndex, event);
    } else if (event.kind === 'recovered') {
      latestRecovered.set(
        event.authIndex,
        Math.max(latestRecovered.get(event.authIndex) ?? -Infinity, event.tMs)
      );
    }
  });
  return [...latestDead.values()]
    .filter((event) => (latestRecovered.get(event.authIndex) ?? -Infinity) < event.tMs)
    .sort((a, b) => b.tMs - a.tMs);
}

export interface EventDay {
  key: string;
  events: UsageEvent[];
}

/** Consecutive events grouped by calendar day (key from `dayOf`), preserving order. */
export function groupEventsByDay(
  events: readonly UsageEvent[],
  dayOf: (ms: number) => string
): EventDay[] {
  const days: EventDay[] = [];
  events.forEach((event) => {
    const key = dayOf(event.tMs);
    const current = days[days.length - 1];
    if (current && current.key === key) current.events.push(event);
    else days.push({ key, events: [event] });
  });
  return days;
}
