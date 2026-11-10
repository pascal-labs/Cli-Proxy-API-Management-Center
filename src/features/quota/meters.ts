/**
 * Console meters: one normalized "remaining %" reading per quota window, for every provider.
 *
 * The provider bodies each read their own state shape to render a card. The console view needs
 * the opposite: the same few numbers lined up across accounts (row meters) and summed across a
 * provider (pooled summary). This module is that projection. It is React-free and clock-free —
 * `nowMs` is injected — so pooling and ordering rules are directly testable.
 *
 * Remaining is always 0–100 (higher = more capacity left). Unknown stays null and is never
 * treated as 0 or 100.
 */

import { parseIsoToMs } from '@/utils/quota';
import type { AuthFileItem } from '@/types';
import { isRecord } from '@/utils/helpers';
import {
  resolveAntigravityBucketLabelKey,
  resolveAntigravityGroupLabelKey,
} from './providers/antigravity/labels';
import type { QuotaProviderType } from './providers/types';
import { XAI_WEEKLY_ROW_ID } from './resetSchedule';

export interface QuotaMeterLabelPart {
  key?: string;
  params?: Record<string, string | number>;
  text?: string;
}

/** Translation-ready label; `group` (when set) is prefixed with a middle dot. */
export interface QuotaMeterLabel extends QuotaMeterLabelPart {
  group?: QuotaMeterLabelPart;
}

export interface QuotaMeterSample {
  /** Stable across accounts of one provider, so readings can be pooled by id. */
  id: string;
  label: QuotaMeterLabel;
  remainingPercent: number | null;
  resetAtMs: number | null;
  periodHours: number | null;
}

export const XAI_MONTHLY_ROW_ID = 'xai:monthly';
const WEEK_HOURS = 168;

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const remainingFromUsed = (used: unknown): number | null => {
  const value = finiteOrNull(used);
  return value === null ? null : clampPercent(100 - clampPercent(value));
};

interface WindowLike {
  id: string;
  label?: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  usedPercent?: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

const fromUsedWindows = (windows: readonly WindowLike[] | undefined): QuotaMeterSample[] =>
  (windows ?? []).map((window) => ({
    id: window.id,
    label: { key: window.labelKey, params: window.labelParams, text: window.label },
    remainingPercent: remainingFromUsed(window.usedPercent),
    resetAtMs: finiteOrNull(window.resetAtMs),
    periodHours: finiteOrNull(window.periodHours),
  }));

interface BucketLike {
  id: string;
  label: string;
  window?: string;
  remainingFraction: number;
  resetTime?: string;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

interface GroupLike {
  id: string;
  label: string;
  buckets?: BucketLike[];
}

const fromBucketGroups = (
  groups: readonly GroupLike[] | undefined,
  translateKeys: boolean
): QuotaMeterSample[] =>
  (groups ?? []).flatMap((group) => {
    const groupKey = translateKeys ? resolveAntigravityGroupLabelKey(group.label) : null;
    const buckets = group.buckets ?? [];
    return buckets.map((bucket) => {
      const bucketKey = translateKeys
        ? resolveAntigravityBucketLabelKey(bucket.label, bucket.window)
        : null;
      const fraction = finiteOrNull(bucket.remainingFraction);
      return {
        id: bucket.id,
        label: {
          key: bucketKey ? `antigravity_quota.${bucketKey}` : undefined,
          text: bucket.label,
          // A lone group adds nothing but noise in front of every bucket.
          group:
            (groups ?? []).length > 1
              ? { key: groupKey ? `antigravity_quota.${groupKey}` : undefined, text: group.label }
              : undefined,
        },
        remainingPercent: fraction === null ? null : clampPercent(fraction * 100),
        resetAtMs: finiteOrNull(bucket.resetAtMs) ?? parseIsoToMs(bucket.resetTime),
        periodHours: finiteOrNull(bucket.periodHours),
      };
    });
  });

/** Claude keeps showing its last observation while a refresh is in flight. */
const hasUsableState = (type: QuotaProviderType, quota: unknown): boolean => {
  if (!isRecord(quota)) return false;
  if (quota.status === 'success') return true;
  return type === 'claude' && Array.isArray(quota.windows) && quota.windows.length > 0;
};

/** Every quota window of one credential as a normalized meter, in the provider's own order. */
export function extractQuotaMeters(type: QuotaProviderType, quota: unknown): QuotaMeterSample[] {
  if (!hasUsableState(type, quota)) return [];
  const state = quota as Record<string, unknown>;

  switch (type) {
    case 'claude':
    case 'codex':
      return fromUsedWindows(state.windows as WindowLike[] | undefined);

    case 'devin':
      return ((state.windows as Array<Record<string, unknown>> | undefined) ?? []).map((window) => {
        const id = String(window.id);
        const remaining = finiteOrNull(window.remainingPercent);
        return {
          id,
          label: { key: `devin_quota.${id}` },
          remainingPercent: remaining === null ? null : clampPercent(remaining),
          resetAtMs: finiteOrNull(window.resetAtMs),
          periodHours: finiteOrNull(window.periodHours),
        };
      });

    case 'kimi':
      return ((state.rows as Array<Record<string, unknown>> | undefined) ?? []).map((row) => {
        const limit = finiteOrNull(row.limit) ?? 0;
        const used = finiteOrNull(row.used) ?? 0;
        const remaining =
          limit > 0 ? clampPercent(((limit - used) / limit) * 100) : used > 0 ? 0 : null;
        return {
          id: String(row.id),
          label: {
            key: typeof row.labelKey === 'string' ? row.labelKey : undefined,
            params: row.labelParams as Record<string, string | number> | undefined,
            text: typeof row.label === 'string' ? row.label : undefined,
          },
          remainingPercent: remaining,
          resetAtMs: finiteOrNull(row.resetAtMs),
          periodHours: finiteOrNull(row.periodHours),
        };
      });

    case 'meta': {
      const data = isRecord(state.data) ? state.data : null;
      const windows = (data?.windows as Array<Record<string, unknown>> | undefined) ?? [];
      return windows.map((window) => {
        const id = window.id === 'weekly' ? 'weekly' : 'window';
        const minutes = finiteOrNull(window.durationMinutes);
        const label: QuotaMeterLabel =
          id === 'window' && minutes
            ? minutes % 60 === 0
              ? { key: 'meta_quota.window_duration_hours', params: { hours: minutes / 60 } }
              : { key: 'meta_quota.window_duration', params: { minutes } }
            : { key: `meta_quota.${id}` };
        const resetAt = finiteOrNull(window.resetAt);
        return {
          id,
          label,
          remainingPercent: remainingFromUsed(window.usedPercent),
          resetAtMs: resetAt === null ? null : resetAt * 1000,
          periodHours: id === 'weekly' ? WEEK_HOURS : minutes ? minutes / 60 : null,
        };
      });
    }

    case 'xai': {
      const billing = isRecord(state.billing) ? state.billing : null;
      if (!billing || billing.mode === 'paid-health') return [];
      const meters: QuotaMeterSample[] = [];
      if (billing.periodType === 'weekly') {
        meters.push({
          id: XAI_WEEKLY_ROW_ID,
          label: { key: 'quota_management.weekly_limit' },
          remainingPercent: remainingFromUsed(billing.usagePercent),
          resetAtMs: finiteOrNull(billing.resetAtMs),
          periodHours: finiteOrNull(billing.periodHours) ?? WEEK_HOURS,
        });
      }
      // The monthly figure is a billing cycle, not a rate window; it still says how much of the
      // plan is left, so it rides along — as the only meter on monthly plans.
      const monthlyRemaining = remainingFromUsed(billing.usedPercent);
      const monthlyLimit = finiteOrNull(billing.monthlyLimitCents) ?? 0;
      if (billing.periodType !== 'weekly' || (monthlyRemaining !== null && monthlyLimit > 0)) {
        meters.push({
          id: XAI_MONTHLY_ROW_ID,
          label: { key: 'quota_management.monthly_limit' },
          remainingPercent: monthlyRemaining,
          resetAtMs: parseIsoToMs(
            typeof billing.billingPeriodEnd === 'string' ? billing.billingPeriodEnd : undefined
          ),
          periodHours: null,
        });
      }
      return meters;
    }

    case 'antigravity':
      return fromBucketGroups(state.groups as GroupLike[] | undefined, true);

    case 'plugin':
      return fromBucketGroups(state.groups as GroupLike[] | undefined, false);

    default:
      return [];
  }
}

/* ---------------------------------------------------------------------------------------------
 * Hub snapshot fallback — `quota.windows` on credential list entries (patched backends only)
 * ------------------------------------------------------------------------------------------- */

const SNAPSHOT_LABEL_KEYS: Record<string, string> = {
  'five-hour': 'claude_quota.five_hour',
  'seven-day': 'claude_quota.seven_day',
  'seven-day-oauth-apps': 'claude_quota.seven_day_oauth_apps',
  'seven-day-opus': 'claude_quota.seven_day_opus',
  'seven-day-sonnet': 'claude_quota.seven_day_sonnet',
  'seven-day-cowork': 'claude_quota.seven_day_cowork',
  'seven-day-fable': 'claude_quota.seven_day_fable',
};

/**
 * Meters from the backend's own last observation, used only while the live quota for that
 * credential has not been loaded. Ids are mapped onto the live ids so both sources pool together.
 */
export function extractSnapshotMeters(
  type: QuotaProviderType,
  file: AuthFileItem
): QuotaMeterSample[] {
  const quota = file.quota;
  if (!isRecord(quota) || !Array.isArray(quota.windows)) return [];
  const meters: QuotaMeterSample[] = [];
  const seen = new Set<string>();
  for (const raw of quota.windows) {
    if (!isRecord(raw)) continue;
    const kind = raw.kind === '5h' ? '5h' : raw.kind === '7d' ? '7d' : null;
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    if (!kind && !key) continue;
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';

    let id: string;
    let label: QuotaMeterLabel;
    if (type === 'claude' && key) {
      id = key.toLowerCase().replace(/_/g, '-');
      label = SNAPSHOT_LABEL_KEYS[id] ? { key: SNAPSHOT_LABEL_KEYS[id] } : { text: key };
    } else if (type === 'codex' && kind) {
      id = kind === '5h' ? 'five-hour' : 'weekly';
      label = {
        key: kind === '5h' ? 'codex_quota.primary_window' : 'codex_quota.secondary_window',
      };
    } else {
      id = key || (kind === '5h' ? 'five-hour' : 'weekly');
      label = {
        key: kind === '5h' ? 'quota_management.five_hour_limit' : 'quota_management.weekly_limit',
      };
    }
    if (model && type !== 'claude') label = { ...label, group: { text: model } };
    if (seen.has(id)) continue;
    seen.add(id);

    const resetsAt = typeof raw.resets_at === 'string' ? raw.resets_at : undefined;
    meters.push({
      id,
      label,
      remainingPercent: remainingFromUsed(raw.used_percent),
      resetAtMs: parseIsoToMs(resetsAt),
      periodHours: kind === '5h' ? 5 : kind === '7d' ? WEEK_HOURS : null,
    });
  }
  return meters;
}

/* ---------------------------------------------------------------------------------------------
 * Primary bucket, row order, pooling
 * ------------------------------------------------------------------------------------------- */

/** The bucket each provider is judged by — its model-scoped or plain weekly window. */
const PRIMARY_PREFERENCE: Partial<Record<QuotaProviderType, readonly string[]>> = {
  claude: ['seven-day-fable', 'seven-day'],
  codex: ['weekly', 'monthly'],
  devin: ['weekly', 'daily'],
  meta: ['weekly', 'window'],
  xai: [XAI_WEEKLY_ROW_ID, XAI_MONTHLY_ROW_ID],
  // Kimi's account-wide weekly summary row (see buildKimiQuotaRows).
  kimi: ['summary'],
};

/**
 * One meter id per provider, shared by every account so they can be compared and summed.
 * Provider preference first; otherwise the longest window seen (ties: most accounts reporting
 * it, then first seen).
 */
export function pickPrimaryMeterId(
  type: QuotaProviderType,
  meterLists: readonly (readonly QuotaMeterSample[])[]
): string | null {
  const seen = new Map<string, { period: number; count: number; order: number }>();
  for (const meters of meterLists) {
    for (const meter of meters) {
      const current = seen.get(meter.id);
      if (current) {
        current.count += 1;
        current.period = Math.max(current.period, meter.periodHours ?? 0);
      } else {
        seen.set(meter.id, { period: meter.periodHours ?? 0, count: 1, order: seen.size });
      }
    }
  }
  if (seen.size === 0) return null;
  for (const preferred of PRIMARY_PREFERENCE[type] ?? []) {
    if (seen.has(preferred)) return preferred;
  }
  let best: [string, { period: number; count: number; order: number }] | null = null;
  for (const entry of seen) {
    if (
      best === null ||
      entry[1].period > best[1].period ||
      (entry[1].period === best[1].period && entry[1].count > best[1].count) ||
      (entry[1].period === best[1].period &&
        entry[1].count === best[1].count &&
        entry[1].order < best[1].order)
    ) {
      best = entry;
    }
  }
  return best?.[0] ?? null;
}

/** Row order: the primary bucket leads, the rest keep the provider's order. */
export function orderRowMeters(
  meters: readonly QuotaMeterSample[],
  primaryId: string | null
): QuotaMeterSample[] {
  if (!primaryId) return [...meters];
  const primary = meters.filter((meter) => meter.id === primaryId);
  return [...primary, ...meters.filter((meter) => meter.id !== primaryId)];
}

export interface MeterPool {
  meterId: string;
  label: QuotaMeterLabel;
  periodHours: number | null;
  /** Credentials in the provider, reporting or not — the denominator of "of N%". */
  accounts: number;
  /** Sum of remaining % over reporting accounts; null when none reported this meter. */
  sumRemaining: number | null;
  maxRemaining: number;
  /** One entry per account in ledger order; null = this account has no reading. */
  segments: (number | null)[];
  /** Soonest reset still in the future across accounts. */
  soonestResetMs: number | null;
}

export function buildMeterPool(
  meterId: string,
  perAccount: readonly (readonly QuotaMeterSample[])[],
  nowMs: number
): MeterPool {
  let label: QuotaMeterLabel = { text: meterId };
  let labelFound = false;
  let periodHours: number | null = null;
  let sum: number | null = null;
  let soonest: number | null = null;
  const segments = perAccount.map((meters) => {
    const meter = meters.find((item) => item.id === meterId);
    if (!meter) return null;
    if (!labelFound) {
      label = meter.label;
      periodHours = meter.periodHours;
      labelFound = true;
    }
    if (meter.resetAtMs !== null && meter.resetAtMs > nowMs) {
      soonest = soonest === null ? meter.resetAtMs : Math.min(soonest, meter.resetAtMs);
    }
    if (meter.remainingPercent === null) return null;
    sum = (sum ?? 0) + meter.remainingPercent;
    return meter.remainingPercent;
  });
  return {
    meterId,
    label,
    periodHours,
    accounts: perAccount.length,
    sumRemaining: sum === null ? null : Math.round(sum),
    maxRemaining: perAccount.length * 100,
    segments,
    soonestResetMs: soonest,
  };
}

export interface ProviderPoolSummary {
  type: QuotaProviderType;
  credentials: number;
  primary: MeterPool | null;
  /** Every other bucket, weekly-length ones first; [0] is the headline secondary row. */
  secondary: MeterPool[];
}

export function buildProviderSummary(
  type: QuotaProviderType,
  perAccount: readonly (readonly QuotaMeterSample[])[],
  nowMs: number,
  /** Pin the primary bucket (the rows' choice over the whole ledger) instead of re-deriving it. */
  primaryIdOverride?: string | null
): ProviderPoolSummary {
  const primaryId =
    primaryIdOverride !== undefined ? primaryIdOverride : pickPrimaryMeterId(type, perAccount);
  const otherIds: string[] = [];
  const periods = new Map<string, number>();
  for (const meters of perAccount) {
    for (const meter of meters) {
      if (meter.id === primaryId || periods.has(meter.id)) continue;
      periods.set(meter.id, meter.periodHours ?? 0);
      otherIds.push(meter.id);
    }
  }
  const weekly = otherIds.filter((id) => (periods.get(id) ?? 0) >= WEEK_HOURS);
  const rest = otherIds.filter((id) => (periods.get(id) ?? 0) < WEEK_HOURS);
  return {
    type,
    credentials: perAccount.length,
    primary: primaryId ? buildMeterPool(primaryId, perAccount, nowMs) : null,
    secondary: [...weekly, ...rest].map((id) => buildMeterPool(id, perAccount, nowMs)),
  };
}

/** Remaining % of the provider's primary bucket for one account — the "most remaining" key. */
export function primaryRemaining(
  meters: readonly QuotaMeterSample[],
  primaryId: string | null
): number | null {
  if (!primaryId) return null;
  return meters.find((meter) => meter.id === primaryId)?.remainingPercent ?? null;
}

/** Meter colour band by remaining %, matching the bar thresholds (≥70 / ≥30 / below). */
export type MeterTone = 'high' | 'medium' | 'low' | 'unknown';

export function meterTone(remainingPercent: number | null): MeterTone {
  if (remainingPercent === null || !Number.isFinite(remainingPercent)) return 'unknown';
  if (remainingPercent >= 70) return 'high';
  if (remainingPercent >= 30) return 'medium';
  return 'low';
}
