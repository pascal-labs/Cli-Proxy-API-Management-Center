/**
 * Hub backend extensions: routing order preview and per-account cache usage.
 *
 * Both endpoints live under the regular v8 Management API prefix and only exist on a backend
 * carrying the hub patch. Callers treat a 404 as "feature not available" rather than an error
 * (see `isHubFeatureMissing`). Raw backend field names are normalized here so components never
 * touch snake_case payloads.
 */

import type { ApiError } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { isRecord } from '@/utils/helpers';
import { apiClient } from './client';

/* ---------------------------------------------------------------------------------------------
 * Routing order — GET /routing/order[?model=]
 * ------------------------------------------------------------------------------------------- */

export interface RoutingOrderEntry {
  authIndex: string;
  authId: string;
  label: string;
  rank: number;
  eligible: boolean;
  skipReason: string;
  weeklyKey: string;
  weeklyUsedPercent: number | null;
  weeklyResetsAt: string | null;
  fiveHourUsedPercent: number | null;
  fiveHourResetsAt: string | null;
  disabled: boolean;
}

export interface RoutingOrder {
  strategy: string;
  generatedAt: string | null;
  /** Provider key (as the backend names it) → candidates, in backend order. */
  providers: Record<string, RoutingOrderEntry[]>;
}

/* ---------------------------------------------------------------------------------------------
 * Usage accounts — GET /usage/accounts?window=1h|24h|7d
 * ------------------------------------------------------------------------------------------- */

export const USAGE_WINDOWS = ['1h', '24h', '7d'] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

export interface UsageSeriesPoint {
  /** Hour start as sent by the backend (RFC3339). */
  t: string;
  /** Parsed hour start; null when the timestamp was unusable. */
  tMs: number | null;
  requests: number;
  input: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** 0–1; null when there was nothing to measure. */
  cacheHitRatio: number | null;
}

export interface UsageAccount extends UsageTotals {
  authIndex: string;
  authId: string;
  provider: string;
  /** Auth file name. */
  label: string;
  series: UsageSeriesPoint[];
}

export interface UsageAccountsReport {
  window: UsageWindow;
  generatedAt: string | null;
  accounts: UsageAccount[];
  totals: UsageTotals;
}

/* ---------------------------------------------------------------------------------------------
 * Normalization
 * ------------------------------------------------------------------------------------------- */

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const readNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const readCount = (value: unknown): number => Math.max(0, readNumber(value) ?? 0);

const readTimestamp = (value: unknown): string | null => {
  const text = readText(value);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
};

const isUsageWindow = (value: unknown): value is UsageWindow =>
  typeof value === 'string' && (USAGE_WINDOWS as readonly string[]).includes(value);

/**
 * Cache hit ratio as the share of prompt tokens served from cache. The backend's own figure wins;
 * the fallback mirrors its definition so a payload without the field still renders sensibly.
 */
export function computeCacheHitRatio(
  inputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number
): number | null {
  const denominator = inputTokens + cacheReadTokens + cacheCreationTokens;
  if (denominator <= 0) return null;
  return cacheReadTokens / denominator;
}

const readRatio = (
  value: unknown,
  input: number,
  cacheRead: number,
  cacheCreation: number
): number | null => {
  const explicit = readNumber(value);
  // A zero ratio with zero traffic is "no data", not "0% hit".
  if (explicit !== null && input + cacheRead + cacheCreation > 0) {
    return Math.min(1, Math.max(0, explicit));
  }
  return computeCacheHitRatio(input, cacheRead, cacheCreation);
};

function normalizeRoutingOrderEntry(raw: unknown, index: number): RoutingOrderEntry | null {
  if (!isRecord(raw)) return null;
  const authIndex = normalizeAuthIndex(raw.auth_index ?? raw.authIndex) ?? '';
  const authId = readText(raw.auth_id ?? raw.authId);
  const label = readText(raw.label);
  if (!authIndex && !authId && !label) return null;
  const rank = readNumber(raw.rank);
  return {
    authIndex,
    authId,
    label,
    rank: rank !== null && rank > 0 ? Math.floor(rank) : index + 1,
    eligible: raw.eligible !== false,
    skipReason: readText(raw.skip_reason ?? raw.skipReason),
    weeklyKey: readText(raw.weekly_key ?? raw.weeklyKey),
    weeklyUsedPercent: readNumber(raw.weekly_used_percent ?? raw.weeklyUsedPercent),
    weeklyResetsAt: readTimestamp(raw.weekly_resets_at ?? raw.weeklyResetsAt),
    fiveHourUsedPercent: readNumber(raw.five_hour_used_percent ?? raw.fiveHourUsedPercent),
    fiveHourResetsAt: readTimestamp(raw.five_hour_resets_at ?? raw.fiveHourResetsAt),
    disabled: raw.disabled === true,
  };
}

export function normalizeRoutingOrder(raw: unknown): RoutingOrder {
  const root = isRecord(raw) ? raw : {};
  const providers: Record<string, RoutingOrderEntry[]> = {};
  if (isRecord(root.providers)) {
    for (const [provider, list] of Object.entries(root.providers)) {
      const key = provider.trim().toLowerCase();
      if (!key || !Array.isArray(list)) continue;
      providers[key] = list
        .map((entry, index) => normalizeRoutingOrderEntry(entry, index))
        .filter((entry): entry is RoutingOrderEntry => entry !== null);
    }
  }
  return {
    strategy: readText(root.strategy),
    generatedAt: readTimestamp(root.generated_at ?? root.generatedAt),
    providers,
  };
}

function normalizeSeriesPoint(raw: unknown): UsageSeriesPoint | null {
  if (!isRecord(raw)) return null;
  const t = readText(raw.t);
  const parsed = Date.parse(t);
  return {
    t,
    tMs: Number.isFinite(parsed) ? parsed : null,
    requests: readCount(raw.requests),
    input: readCount(raw.input ?? raw.input_tokens),
    cacheRead: readCount(raw.cache_read ?? raw.cacheRead ?? raw.cache_read_tokens),
    cacheCreation: readCount(raw.cache_creation ?? raw.cacheCreation ?? raw.cache_creation_tokens),
  };
}

function normalizeTotals(raw: unknown): UsageTotals {
  const source = isRecord(raw) ? raw : {};
  const inputTokens = readCount(source.input_tokens ?? source.inputTokens);
  const cacheReadTokens = readCount(source.cache_read_tokens ?? source.cacheReadTokens);
  const cacheCreationTokens = readCount(source.cache_creation_tokens ?? source.cacheCreationTokens);
  return {
    requests: readCount(source.requests),
    inputTokens,
    outputTokens: readCount(source.output_tokens ?? source.outputTokens),
    cacheReadTokens,
    cacheCreationTokens,
    cacheHitRatio: readRatio(
      source.cache_hit_ratio ?? source.cacheHitRatio,
      inputTokens,
      cacheReadTokens,
      cacheCreationTokens
    ),
  };
}

function normalizeUsageAccount(raw: unknown): UsageAccount | null {
  if (!isRecord(raw)) return null;
  const authIndex = normalizeAuthIndex(raw.auth_index ?? raw.authIndex) ?? '';
  const authId = readText(raw.auth_id ?? raw.authId);
  const label = readText(raw.label);
  if (!authIndex && !authId && !label) return null;
  const series = Array.isArray(raw.series)
    ? raw.series
        .map(normalizeSeriesPoint)
        .filter((point): point is UsageSeriesPoint => point !== null)
        .sort((a, b) => (a.tMs ?? 0) - (b.tMs ?? 0))
    : [];
  return {
    ...normalizeTotals(raw),
    authIndex,
    authId,
    provider: readText(raw.provider).toLowerCase(),
    label,
    series,
  };
}

export function normalizeUsageAccounts(
  raw: unknown,
  requestedWindow: UsageWindow = '24h'
): UsageAccountsReport {
  const root = isRecord(raw) ? raw : {};
  const accounts = Array.isArray(root.accounts)
    ? root.accounts
        .map(normalizeUsageAccount)
        .filter((account): account is UsageAccount => account !== null)
    : [];
  return {
    window: isUsageWindow(root.window) ? root.window : requestedWindow,
    generatedAt: readTimestamp(root.generated_at ?? root.generatedAt),
    accounts,
    totals: normalizeTotals(root.totals),
  };
}

/** An unpatched backend answers these routes with 404; that hides the feature, not an error. */
export const isHubFeatureMissing = (error: unknown): boolean =>
  (error as ApiError | null)?.status === 404;

export const hubApi = {
  getRoutingOrder: async (model?: string): Promise<RoutingOrder> =>
    normalizeRoutingOrder(
      await apiClient.get<unknown>('/routing/order', model ? { params: { model } } : undefined)
    ),

  getUsageAccounts: async (window: UsageWindow): Promise<UsageAccountsReport> =>
    normalizeUsageAccounts(
      await apiClient.get<unknown>('/usage/accounts', { params: { window } }),
      window
    ),
};
