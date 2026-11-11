/**
 * `/usage/models` shaping: token totals, cache hit ratio and value, per account and per model.
 *
 * Tokens are counted as everything the model processed: uncached input + cache reads + cache
 * writes + output. `uncached_input_tokens` is the backend's provider-normalized input, so a Codex
 * row (whose `input_tokens` includes cached tokens) is not double-counted.
 */

import type { ModelUsageRow } from '@/services/api/hubInsights';
import { computeCacheHitRatio } from '@/services/api/hub';

export interface UsageAggregate {
  requests: number;
  /** Uncached input + cache read + cache write: the prompt the model actually saw. */
  promptTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  tokens: number;
  cacheHitRatio: number | null;
  /** Sum of priced rows; null when no row had a price. */
  apiValueUsd: number | null;
  /** Some traffic had no price, so `apiValueUsd` understates the true value. */
  hasUnpriced: boolean;
  /**
   * Cache reads priced as fresh input minus their cache price, over priced rows; null when no row
   * reported it (unpriced, or a hub that predates the field).
   */
  cacheSavingsUsd: number | null;
}

export const rowCacheWriteTokens = (row: ModelUsageRow): number =>
  row.cacheCreation5mTokens + row.cacheCreation1hTokens;

export const rowTokens = (row: ModelUsageRow): number =>
  row.uncachedInputTokens + row.cacheReadTokens + rowCacheWriteTokens(row) + row.outputTokens;

export function aggregateRows(
  rows: readonly ModelUsageRow[],
  unpricedModels: readonly string[] = []
): UsageAggregate {
  const unpriced = new Set(unpricedModels);
  let requests = 0;
  let uncached = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let value = 0;
  let priced = false;
  let hasUnpriced = false;
  let savings: number | null = null;
  rows.forEach((row) => {
    requests += row.requests;
    uncached += row.uncachedInputTokens;
    outputTokens += row.outputTokens;
    cacheReadTokens += row.cacheReadTokens;
    cacheWriteTokens += rowCacheWriteTokens(row);
    if (row.apiValueUsd !== null) {
      value += row.apiValueUsd;
      priced = true;
    }
    if (row.cacheSavingsUsd !== null) savings = (savings ?? 0) + row.cacheSavingsUsd;
    const used = row.requests > 0 || rowTokens(row) > 0;
    if (used && (row.apiValueUsd === null || unpriced.has(row.model))) hasUnpriced = true;
  });
  const promptTokens = uncached + cacheReadTokens + cacheWriteTokens;
  return {
    requests,
    promptTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    tokens: promptTokens + outputTokens,
    cacheHitRatio: computeCacheHitRatio(uncached, cacheReadTokens, cacheWriteTokens),
    apiValueUsd: priced ? value : null,
    hasUnpriced,
    cacheSavingsUsd: savings,
  };
}

export interface ModelAggregate extends UsageAggregate {
  model: string;
  providers: string[];
  authIndexes: string[];
}

export interface AccountAggregate extends UsageAggregate {
  authIndex: string;
  provider: string;
  models: string[];
}

function groupBy<K>(rows: readonly ModelUsageRow[], key: (row: ModelUsageRow) => K) {
  const groups = new Map<K, ModelUsageRow[]>();
  rows.forEach((row) => {
    const k = key(row);
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  });
  return groups;
}

const unique = (values: string[]) => [...new Set(values.filter(Boolean))].sort();

/** Per model across accounts; highest value first, then most tokens, then name. */
export function aggregateByModel(
  rows: readonly ModelUsageRow[],
  unpricedModels: readonly string[] = []
): ModelAggregate[] {
  return [...groupBy(rows, (row) => row.model || '—').entries()]
    .map(([model, list]) => ({
      ...aggregateRows(list, unpricedModels),
      model,
      providers: unique(list.map((row) => row.provider)),
      authIndexes: unique(list.map((row) => row.authIndex)),
    }))
    .sort(
      (a, b) =>
        (b.apiValueUsd ?? -1) - (a.apiValueUsd ?? -1) ||
        b.tokens - a.tokens ||
        a.model.localeCompare(b.model)
    );
}

/** Per account across models; most tokens first. */
export function aggregateByAccount(
  rows: readonly ModelUsageRow[],
  unpricedModels: readonly string[] = []
): AccountAggregate[] {
  return [...groupBy(rows, (row) => row.authIndex).entries()]
    .map(([authIndex, list]) => ({
      ...aggregateRows(list, unpricedModels),
      authIndex,
      provider: list.find((row) => row.provider)?.provider ?? '',
      models: unique(list.map((row) => row.model)),
    }))
    .sort((a, b) => b.tokens - a.tokens || a.authIndex.localeCompare(b.authIndex));
}

/** Unpriced models: the backend's list plus any model that carried traffic without a value. */
export function collectUnpricedModels(
  rows: readonly ModelUsageRow[],
  reported: readonly string[] = []
): string[] {
  const models = new Set(reported.filter(Boolean));
  rows.forEach((row) => {
    if (row.apiValueUsd === null && row.model && (row.requests > 0 || rowTokens(row) > 0)) {
      models.add(row.model);
    }
  });
  return [...models].sort();
}

export interface AccountModelMix {
  authIndex: string;
  provider: string;
  /** This account's models, most tokens first. */
  models: ModelAggregate[];
  tokens: number;
  apiValueUsd: number | null;
}

/** Per account, its usage split by model (for the model-mix bars); most tokens first. */
export function modelMixByAccount(
  rows: readonly ModelUsageRow[],
  unpricedModels: readonly string[] = []
): AccountModelMix[] {
  return aggregateByAccount(rows, unpricedModels).map((account) => ({
    authIndex: account.authIndex,
    provider: account.provider,
    models: aggregateByModel(
      rows.filter((row) => row.authIndex === account.authIndex),
      unpricedModels
    ).sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model)),
    tokens: account.tokens,
    apiValueUsd: account.apiValueUsd,
  }));
}
