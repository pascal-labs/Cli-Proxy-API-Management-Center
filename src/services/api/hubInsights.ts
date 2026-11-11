/**
 * Hub backend insight endpoints: per-model usage, per-session (T3 thread) usage, quota runway,
 * API-equivalent value, the routing/health event log and the host's health (`/box/health`).
 *
 * All six live under the regular v8 Management API prefix and only exist on a hub build that
 * records them. Callers treat a 404 as "update the hub" rather than an error (see
 * `isHubFeatureMissing`). Every field is read defensively: counts default to 0, everything the
 * contract marks nullable stays `null`, and junk entries are dropped, so components never touch
 * snake_case payloads or guard against `undefined`.
 */

import { normalizeAuthIndex } from '@/utils/authIndex';
import { isRecord } from '@/utils/helpers';
import { apiClient } from './client';
import { computeCacheHitRatio } from './hub';

/* ---------------------------------------------------------------------------------------------
 * Windows
 * ------------------------------------------------------------------------------------------- */

/** `/usage/models` windows. */
export const MODEL_USAGE_WINDOWS = ['1h', '24h', '7d', '30d'] as const;
export type ModelUsageWindow = (typeof MODEL_USAGE_WINDOWS)[number];

/** `/usage/sessions` and `/usage/value` windows. */
export const INSIGHT_WINDOWS = ['24h', '7d', '30d'] as const;
export type InsightWindow = (typeof INSIGHT_WINDOWS)[number];

/** `/usage/events` windows. */
export const EVENT_WINDOWS = ['24h', '7d'] as const;
export type EventWindow = (typeof EVENT_WINDOWS)[number];

/* ---------------------------------------------------------------------------------------------
 * GET /usage/models?window=
 * ------------------------------------------------------------------------------------------- */

export interface ModelUsageRow {
  authIndex: string;
  provider: string;
  model: string;
  requests: number;
  /** Provider-reported input (Claude excludes cached tokens, Codex includes them). */
  inputTokens: number;
  /** Input not served from or written to cache, normalized across providers. */
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  /** 0–1; null when nothing was measured. */
  cacheHitRatio: number | null;
  /** Null when the model has no price configured. */
  apiValueUsd: number | null;
  /**
   * Cache reads priced as fresh input minus their cache price. Null when unpriced, or from a hub
   * that predates the field.
   */
  cacheSavingsUsd: number | null;
}

export interface ModelUsageReport {
  window: ModelUsageWindow;
  generatedAt: string | null;
  rows: ModelUsageRow[];
  unpricedModels: string[];
}

/* ---------------------------------------------------------------------------------------------
 * GET /usage/sessions?window=&limit=
 * ------------------------------------------------------------------------------------------- */

/** One model's share of a session's usage (`/usage/sessions` `models[]`). */
export interface SessionModelUsage {
  model: string;
  requests: number;
  /** Provider-reported input (Claude excludes cached tokens, Codex includes them). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Null when the model has no price configured. */
  apiValueUsd: number | null;
}

export interface UsageSession {
  sessionKey: string;
  /**
   * The client's own session id. Subagent keys (`claude:<id>:agent:<agent>`) share their parent's,
   * so this is what ties a subagent to its parent when there is no T3 mapping.
   */
  nativeSessionId: string | null;
  /** The `<agent>` of a `…:agent:<agent>` key: a Claude Code or Codex subagent; null otherwise. */
  agentId: string | null;
  provider: string;
  client: string;
  project: string | null;
  cwd: string | null;
  title: string | null;
  t3ThreadId: string | null;
  t3Title: string | null;
  t3ParentTitle: string | null;
  subagent: boolean;
  authIndexes: string[];
  firstSeen: string | null;
  firstSeenMs: number | null;
  lastSeen: string | null;
  lastSeenMs: number | null;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheHitRatio: number | null;
  coldCacheWrites: number;
  apiValueUsd: number | null;
  /** Usage split by model; empty from a hub that predates it. */
  models: SessionModelUsage[];
  /**
   * The session's Claude tokens re-priced per model id (API-price estimates). Null without Claude
   * usage, or from a hub that predates it.
   */
  whatIfUsd: Record<string, number> | null;
}

export interface SessionsReport {
  window: InsightWindow;
  generatedAt: string | null;
  sessions: UsageSession[];
}

/* ---------------------------------------------------------------------------------------------
 * GET /usage/runway
 * ------------------------------------------------------------------------------------------- */

/** Known window kinds; anything else the backend adds renders under its key. */
export type RunwayWindowKind = 'five_hour' | 'weekly' | 'other';

export interface RunwayHistoryPoint {
  t: string;
  tMs: number;
  usedPercent: number;
}

/**
 * Whether the burn rate is projected: `learning` until the current cycle has enough samples (the
 * rate and projection are null meanwhile), `idle` with enough history but no upward pace. Null
 * from a hub that predates the field.
 */
export type RunwayProjectionStatus = 'ok' | 'learning' | 'idle';

export interface RunwayWindow {
  key: string;
  kind: RunwayWindowKind;
  /** Model family of a model-specific window (e.g. "fable" on `seven_day_fable`). */
  model: string | null;
  usedPercent: number | null;
  resetsAt: string | null;
  resetsAtMs: number | null;
  burnRatePctPerHour: number | null;
  projectedExhaustAt: string | null;
  projectedExhaustAtMs: number | null;
  exhaustsBeforeReset: boolean;
  projectionStatus: RunwayProjectionStatus | null;
  /** When a learning window is expected to have enough history to project. */
  learningUntil: string | null;
  learningUntilMs: number | null;
  /** Oldest first. */
  history: RunwayHistoryPoint[];
}

export interface RunwayCycle {
  windowKey: string;
  resetAt: string | null;
  resetAtMs: number | null;
  finalUsedPercent: number | null;
}

export interface RunwayAccount {
  authIndex: string;
  provider: string;
  label: string;
  windows: RunwayWindow[];
  lastCycles: RunwayCycle[];
}

export interface RunwayReport {
  generatedAt: string | null;
  accounts: RunwayAccount[];
}

/* ---------------------------------------------------------------------------------------------
 * GET /usage/value?window=
 * ------------------------------------------------------------------------------------------- */

export interface ValueAccount {
  authIndex: string;
  provider: string;
  label: string;
  requests: number;
  /** Null when all of the account's usage is unpriced (see `hasUnpricedUsage`). */
  apiValueUsd: number | null;
  /** Some of the account's usage has no price, so `apiValueUsd` leaves it out. */
  hasUnpricedUsage: boolean;
  /** Priced usage only; null when unpriced or from a hub that predates the field. */
  cacheSavingsUsd: number | null;
  /** The same priced traffic with every prompt token at the input rate. */
  noCacheValueUsd: number | null;
  subscriptionUsdPerMonth: number | null;
  subscriptionUsdForWindow: number | null;
  /** API value ÷ subscription cost for the window; null without a plan cost. */
  valueRatio: number | null;
}

export interface ValueTotals {
  apiValueUsd: number | null;
  subscriptionUsdForWindow: number | null;
  valueRatio: number | null;
  /** Null from a hub that predates the field. */
  cacheSavingsUsd?: number | null;
  noCacheValueUsd?: number | null;
  /** Some usage in the window has no price and is left out of the figures. */
  hasUnpricedUsage?: boolean;
}

export interface ValueReport {
  window: InsightWindow;
  generatedAt: string | null;
  accounts: ValueAccount[];
  totals: ValueTotals;
  unpricedModels: string[];
}

/* ---------------------------------------------------------------------------------------------
 * GET /usage/events?window=&limit=
 * ------------------------------------------------------------------------------------------- */

export const USAGE_EVENT_KINDS = [
  'rate_limited',
  'transient_error',
  'network_error',
  'failover',
  'rebind',
  'cooldown',
  'dead_login',
  'recovered',
  'hub_start',
] as const;
export type UsageEventKind = (typeof USAGE_EVENT_KINDS)[number];

export const isUsageEventKind = (value: unknown): value is UsageEventKind =>
  typeof value === 'string' && (USAGE_EVENT_KINDS as readonly string[]).includes(value);

export interface UsageEvent {
  /** Stable React key: timestamp, kind and position. */
  id: string;
  t: string;
  tMs: number;
  /** One of `USAGE_EVENT_KINDS`, or a newer kind passed through verbatim. */
  kind: string;
  authIndex: string;
  provider: string;
  model: string;
  sessionKey: string;
  statusCode: number | null;
  detail: string;
}

export interface UsageEventCount {
  hour: string;
  hourMs: number;
  kind: string;
  count: number;
}

export interface EventsReport {
  window: EventWindow;
  generatedAt: string | null;
  /** Newest first. */
  events: UsageEvent[];
  counts: UsageEventCount[];
}

/* ---------------------------------------------------------------------------------------------
 * Readers
 * ------------------------------------------------------------------------------------------- */

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const readNullableText = (value: unknown): string | null => readText(value) || null;

const readNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const readCount = (value: unknown): number => Math.max(0, readNumber(value) ?? 0);

const readMoney = (value: unknown): number | null => {
  const parsed = readNumber(value);
  return parsed === null ? null : Math.max(0, parsed);
};

const readPercent = (value: unknown): number | null => {
  const parsed = readNumber(value);
  return parsed === null ? null : Math.max(0, parsed);
};

const readInstant = (value: unknown): { text: string | null; ms: number | null } => {
  const text = readText(value);
  if (!text) return { text: null, ms: null };
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? { text, ms } : { text: null, ms: null };
};

const readStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  value.forEach((entry) => {
    const text = typeof entry === 'number' ? String(entry) : readText(entry);
    if (text) seen.add(text);
  });
  return [...seen];
};

const readList = <T>(value: unknown, normalize: (raw: unknown, index: number) => T | null): T[] =>
  Array.isArray(value) ? value.map(normalize).filter((entry): entry is T => entry !== null) : [];

const pick = (raw: Record<string, unknown>, snake: string, camel: string): unknown =>
  raw[snake] ?? raw[camel];

const readWindow = <W extends string>(value: unknown, allowed: readonly W[], fallback: W): W =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as W)
    : fallback;

/** A zero ratio with zero traffic is "no data", not "0% hit" — same rule as `/usage/accounts`. */
const readRatio = (value: unknown, traffic: number, fallback: () => number | null) => {
  const explicit = readNumber(value);
  if (explicit !== null && traffic > 0) return Math.min(1, Math.max(0, explicit));
  return fallback();
};

/**
 * API value ÷ subscription cost. Null when either side is unknown or the plan cost is zero, so
 * an unconfigured plan never reads as an infinite (or zero) return.
 */
export function computeValueRatio(
  apiValueUsd: number | null | undefined,
  subscriptionUsd: number | null | undefined
): number | null {
  if (apiValueUsd === null || apiValueUsd === undefined || !Number.isFinite(apiValueUsd)) {
    return null;
  }
  if (
    subscriptionUsd === null ||
    subscriptionUsd === undefined ||
    !Number.isFinite(subscriptionUsd) ||
    subscriptionUsd <= 0
  ) {
    return null;
  }
  return apiValueUsd / subscriptionUsd;
}

const readValueRatio = (
  value: unknown,
  apiValueUsd: number | null,
  subscription: number | null
) => {
  const explicit = readNumber(value);
  if (explicit !== null && explicit >= 0) return explicit;
  return computeValueRatio(apiValueUsd, subscription);
};

/* ---------------------------------------------------------------------------------------------
 * Normalization
 * ------------------------------------------------------------------------------------------- */

function normalizeModelUsageRow(raw: unknown): ModelUsageRow | null {
  if (!isRecord(raw)) return null;
  const model = readText(raw.model);
  const authIndex = normalizeAuthIndex(pick(raw, 'auth_index', 'authIndex')) ?? '';
  if (!model && !authIndex) return null;
  const inputTokens = readCount(pick(raw, 'input_tokens', 'inputTokens'));
  const uncachedRaw = readNumber(pick(raw, 'uncached_input_tokens', 'uncachedInputTokens'));
  const uncachedInputTokens = uncachedRaw === null ? inputTokens : Math.max(0, uncachedRaw);
  const cacheReadTokens = readCount(pick(raw, 'cache_read_tokens', 'cacheReadTokens'));
  const cacheCreation5mTokens = readCount(
    pick(raw, 'cache_creation_5m_tokens', 'cacheCreation5mTokens')
  );
  const cacheCreation1hTokens = readCount(
    pick(raw, 'cache_creation_1h_tokens', 'cacheCreation1hTokens')
  );
  const creation = cacheCreation5mTokens + cacheCreation1hTokens;
  return {
    authIndex,
    provider: readText(raw.provider).toLowerCase(),
    model,
    requests: readCount(raw.requests),
    inputTokens,
    uncachedInputTokens,
    outputTokens: readCount(pick(raw, 'output_tokens', 'outputTokens')),
    cacheReadTokens,
    cacheCreation5mTokens,
    cacheCreation1hTokens,
    cacheHitRatio: readRatio(
      pick(raw, 'cache_hit_ratio', 'cacheHitRatio'),
      uncachedInputTokens + cacheReadTokens + creation,
      () => computeCacheHitRatio(uncachedInputTokens, cacheReadTokens, creation)
    ),
    apiValueUsd: readMoney(pick(raw, 'api_value_usd', 'apiValueUsd')),
    cacheSavingsUsd: readMoney(pick(raw, 'cache_savings_usd', 'cacheSavingsUsd')),
  };
}

export function normalizeModelUsage(
  raw: unknown,
  requestedWindow: ModelUsageWindow = '24h'
): ModelUsageReport {
  const root = isRecord(raw) ? raw : {};
  return {
    window: readWindow(root.window, MODEL_USAGE_WINDOWS, requestedWindow),
    generatedAt: readInstant(pick(root, 'generated_at', 'generatedAt')).text,
    rows: readList(root.rows, normalizeModelUsageRow),
    unpricedModels: readStringList(pick(root, 'unpriced_models', 'unpricedModels')),
  };
}

const NATIVE_ID_RE = /^[0-9a-f][0-9a-f-]{7,63}$/;

/**
 * Splits a hub session key the way the backend does: `claude:<id>[:agent:<agent>]` and
 * `codex:<id>[:agent:<agent>]` carry the client's native session id (UUID-like, lowercased) and,
 * for a subagent, its agent id. Other keys have neither native id nor agent.
 */
export function parseSessionKey(key: string): { nativeId: string | null; agentId: string | null } {
  const trimmed = key.trim();
  const agentAt = trimmed.indexOf(':agent:');
  const agentId = agentAt >= 0 ? trimmed.slice(agentAt + ':agent:'.length).trim() || null : null;
  const colon = trimmed.indexOf(':');
  const prefix = colon > 0 ? trimmed.slice(0, colon).toLowerCase() : '';
  if (prefix !== 'claude' && prefix !== 'codex') return { nativeId: null, agentId };
  const id = trimmed
    .slice(colon + 1)
    .split(':')[0]
    .trim()
    .toLowerCase();
  return { nativeId: NATIVE_ID_RE.test(id) ? id : null, agentId };
}

function normalizeSessionModel(raw: unknown): SessionModelUsage | null {
  if (!isRecord(raw)) return null;
  const model = readText(raw.model);
  if (!model) return null;
  return {
    model,
    requests: readCount(raw.requests),
    inputTokens: readCount(pick(raw, 'input_tokens', 'inputTokens')),
    outputTokens: readCount(pick(raw, 'output_tokens', 'outputTokens')),
    cacheReadTokens: readCount(pick(raw, 'cache_read_tokens', 'cacheReadTokens')),
    cacheCreationTokens: readCount(pick(raw, 'cache_creation_tokens', 'cacheCreationTokens')),
    apiValueUsd: readMoney(pick(raw, 'api_value_usd', 'apiValueUsd')),
  };
}

const readMoneyRecord = (value: unknown): Record<string, number> | null => {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  Object.entries(value).forEach(([key, amount]) => {
    const parsed = readMoney(amount);
    if (key.trim() && parsed !== null) out[key.trim()] = parsed;
  });
  return Object.keys(out).length > 0 ? out : null;
};

function normalizeSession(raw: unknown): UsageSession | null {
  if (!isRecord(raw)) return null;
  const sessionKey = readText(pick(raw, 'session_key', 'sessionKey'));
  const t3Title = readNullableText(pick(raw, 't3_title', 't3Title'));
  const title = readNullableText(raw.title);
  if (!sessionKey && !t3Title && !title) return null;
  const inputTokens = readCount(pick(raw, 'input_tokens', 'inputTokens'));
  const cacheReadTokens = readCount(pick(raw, 'cache_read_tokens', 'cacheReadTokens'));
  const cacheCreationTokens = readCount(pick(raw, 'cache_creation_tokens', 'cacheCreationTokens'));
  const firstSeen = readInstant(pick(raw, 'first_seen', 'firstSeen'));
  const lastSeen = readInstant(pick(raw, 'last_seen', 'lastSeen'));
  const authIndexes = readStringList(pick(raw, 'auth_indexes', 'authIndexes'));
  const parsedKey = parseSessionKey(sessionKey);
  return {
    sessionKey,
    nativeSessionId:
      readNullableText(pick(raw, 'native_session_id', 'nativeSessionId'))?.toLowerCase() ??
      parsedKey.nativeId,
    agentId: parsedKey.agentId,
    provider: readText(raw.provider).toLowerCase(),
    client: readText(raw.client),
    project: readNullableText(raw.project),
    cwd: readNullableText(raw.cwd),
    title,
    t3ThreadId: readNullableText(pick(raw, 't3_thread_id', 't3ThreadId')),
    t3Title,
    t3ParentTitle: readNullableText(pick(raw, 't3_parent_title', 't3ParentTitle')),
    subagent: raw.subagent === true,
    authIndexes,
    firstSeen: firstSeen.text,
    firstSeenMs: firstSeen.ms,
    lastSeen: lastSeen.text,
    lastSeenMs: lastSeen.ms,
    requests: readCount(raw.requests),
    inputTokens,
    outputTokens: readCount(pick(raw, 'output_tokens', 'outputTokens')),
    cacheReadTokens,
    cacheCreationTokens,
    cacheHitRatio: readRatio(
      pick(raw, 'cache_hit_ratio', 'cacheHitRatio'),
      inputTokens + cacheReadTokens + cacheCreationTokens,
      () => computeCacheHitRatio(inputTokens, cacheReadTokens, cacheCreationTokens)
    ),
    coldCacheWrites: readCount(pick(raw, 'cold_cache_writes', 'coldCacheWrites')),
    apiValueUsd: readMoney(pick(raw, 'api_value_usd', 'apiValueUsd')),
    models: readList(raw.models, normalizeSessionModel),
    whatIfUsd: readMoneyRecord(pick(raw, 'what_if_usd', 'whatIfUsd')),
  };
}

export function normalizeSessions(
  raw: unknown,
  requestedWindow: InsightWindow = '24h'
): SessionsReport {
  const root = isRecord(raw) ? raw : {};
  return {
    window: readWindow(root.window, INSIGHT_WINDOWS, requestedWindow),
    generatedAt: readInstant(pick(root, 'generated_at', 'generatedAt')).text,
    sessions: readList(root.sessions, normalizeSession),
  };
}

const readWindowKind = (value: unknown, key: string): RunwayWindowKind => {
  const text = readText(value).toLowerCase();
  if (text === 'five_hour' || text === 'weekly') return text;
  // A payload without `kind` still names its windows ("five_hour", "seven_day", "weekly", …).
  const probe = `${text} ${key.toLowerCase()}`;
  if (/five|5h|5_h|session/.test(probe)) return 'five_hour';
  if (/week|seven|7d|7_d/.test(probe)) return 'weekly';
  return 'other';
};

function normalizeRunwayHistoryPoint(raw: unknown): RunwayHistoryPoint | null {
  if (!isRecord(raw)) return null;
  const instant = readInstant(raw.t);
  const usedPercent = readPercent(pick(raw, 'used_percent', 'usedPercent'));
  if (instant.ms === null || instant.text === null || usedPercent === null) return null;
  return { t: instant.text, tMs: instant.ms, usedPercent };
}

function normalizeRunwayWindow(raw: unknown): RunwayWindow | null {
  if (!isRecord(raw)) return null;
  const key = readText(raw.key);
  if (!key) return null;
  const resetsAt = readInstant(pick(raw, 'resets_at', 'resetsAt'));
  const exhaust = readInstant(pick(raw, 'projected_exhaust_at', 'projectedExhaustAt'));
  const flag = pick(raw, 'exhausts_before_reset', 'exhaustsBeforeReset');
  const derivedFlag =
    exhaust.ms !== null && resetsAt.ms !== null ? exhaust.ms < resetsAt.ms : false;
  const statusText = readText(pick(raw, 'projection_status', 'projectionStatus')).toLowerCase();
  const projectionStatus =
    statusText === 'ok' || statusText === 'learning' || statusText === 'idle' ? statusText : null;
  const learningUntil = readInstant(pick(raw, 'learning_until', 'learningUntil'));
  return {
    key,
    kind: readWindowKind(raw.kind, key),
    model: readNullableText(raw.model),
    usedPercent: readPercent(pick(raw, 'used_percent', 'usedPercent')),
    resetsAt: resetsAt.text,
    resetsAtMs: resetsAt.ms,
    burnRatePctPerHour: readNumber(pick(raw, 'burn_rate_pct_per_hour', 'burnRatePctPerHour')),
    projectedExhaustAt: exhaust.text,
    projectedExhaustAtMs: exhaust.ms,
    // The backend's verdict wins; it is only derived when the field is missing altogether.
    exhaustsBeforeReset: typeof flag === 'boolean' ? flag : derivedFlag,
    projectionStatus,
    learningUntil: projectionStatus === 'learning' ? learningUntil.text : null,
    learningUntilMs: projectionStatus === 'learning' ? learningUntil.ms : null,
    history: readList(raw.history, normalizeRunwayHistoryPoint).sort((a, b) => a.tMs - b.tMs),
  };
}

function normalizeRunwayCycle(raw: unknown): RunwayCycle | null {
  if (!isRecord(raw)) return null;
  const windowKey = readText(pick(raw, 'window_key', 'windowKey'));
  if (!windowKey) return null;
  const resetAt = readInstant(pick(raw, 'reset_at', 'resetAt'));
  return {
    windowKey,
    resetAt: resetAt.text,
    resetAtMs: resetAt.ms,
    finalUsedPercent: readPercent(pick(raw, 'final_used_percent', 'finalUsedPercent')),
  };
}

function normalizeRunwayAccount(raw: unknown): RunwayAccount | null {
  if (!isRecord(raw)) return null;
  const authIndex = normalizeAuthIndex(pick(raw, 'auth_index', 'authIndex')) ?? '';
  const label = readText(raw.label);
  if (!authIndex && !label) return null;
  return {
    authIndex,
    provider: readText(raw.provider).toLowerCase(),
    label,
    windows: readList(raw.windows, normalizeRunwayWindow),
    lastCycles: readList(pick(raw, 'last_cycles', 'lastCycles'), normalizeRunwayCycle),
  };
}

export function normalizeRunway(raw: unknown): RunwayReport {
  const root = isRecord(raw) ? raw : {};
  return {
    generatedAt: readInstant(pick(root, 'generated_at', 'generatedAt')).text,
    accounts: readList(root.accounts, normalizeRunwayAccount),
  };
}

function normalizeValueAccount(raw: unknown): ValueAccount | null {
  if (!isRecord(raw)) return null;
  const authIndex = normalizeAuthIndex(pick(raw, 'auth_index', 'authIndex')) ?? '';
  const label = readText(raw.label);
  if (!authIndex && !label) return null;
  const apiValueUsd = readMoney(pick(raw, 'api_value_usd', 'apiValueUsd'));
  const subscriptionUsdForWindow = readMoney(
    pick(raw, 'subscription_usd_for_window', 'subscriptionUsdForWindow')
  );
  return {
    authIndex,
    provider: readText(raw.provider).toLowerCase(),
    label,
    requests: readCount(raw.requests),
    apiValueUsd,
    hasUnpricedUsage: pick(raw, 'has_unpriced_usage', 'hasUnpricedUsage') === true,
    cacheSavingsUsd: readMoney(pick(raw, 'cache_savings_usd', 'cacheSavingsUsd')),
    noCacheValueUsd: readMoney(pick(raw, 'no_cache_value_usd', 'noCacheValueUsd')),
    subscriptionUsdPerMonth: readMoney(
      pick(raw, 'subscription_usd_per_month', 'subscriptionUsdPerMonth')
    ),
    subscriptionUsdForWindow,
    valueRatio: readValueRatio(
      pick(raw, 'value_ratio', 'valueRatio'),
      apiValueUsd,
      subscriptionUsdForWindow
    ),
  };
}

export function normalizeValue(raw: unknown, requestedWindow: InsightWindow = '24h'): ValueReport {
  const root = isRecord(raw) ? raw : {};
  const totalsRaw = isRecord(root.totals) ? root.totals : {};
  const apiValueUsd = readMoney(pick(totalsRaw, 'api_value_usd', 'apiValueUsd'));
  const subscriptionUsdForWindow = readMoney(
    pick(totalsRaw, 'subscription_usd_for_window', 'subscriptionUsdForWindow')
  );
  return {
    window: readWindow(root.window, INSIGHT_WINDOWS, requestedWindow),
    generatedAt: readInstant(pick(root, 'generated_at', 'generatedAt')).text,
    accounts: readList(root.accounts, normalizeValueAccount),
    totals: {
      apiValueUsd,
      subscriptionUsdForWindow,
      valueRatio: readValueRatio(
        pick(totalsRaw, 'value_ratio', 'valueRatio'),
        apiValueUsd,
        subscriptionUsdForWindow
      ),
      cacheSavingsUsd: readMoney(pick(totalsRaw, 'cache_savings_usd', 'cacheSavingsUsd')),
      noCacheValueUsd: readMoney(pick(totalsRaw, 'no_cache_value_usd', 'noCacheValueUsd')),
      hasUnpricedUsage: pick(totalsRaw, 'has_unpriced_usage', 'hasUnpricedUsage') === true,
    },
    unpricedModels: readStringList(pick(root, 'unpriced_models', 'unpricedModels')),
  };
}

function normalizeEvent(raw: unknown, index: number): UsageEvent | null {
  if (!isRecord(raw)) return null;
  const instant = readInstant(raw.t);
  const kind = readText(raw.kind).toLowerCase();
  if (instant.ms === null || instant.text === null || !kind) return null;
  const statusCode = readNumber(pick(raw, 'status_code', 'statusCode'));
  return {
    id: `${instant.ms}:${kind}:${index}`,
    t: instant.text,
    tMs: instant.ms,
    kind,
    authIndex: normalizeAuthIndex(pick(raw, 'auth_index', 'authIndex')) ?? '',
    provider: readText(raw.provider).toLowerCase(),
    model: readText(raw.model),
    sessionKey: readText(pick(raw, 'session_key', 'sessionKey')),
    statusCode: statusCode !== null && statusCode > 0 ? Math.round(statusCode) : null,
    detail: readText(raw.detail),
  };
}

function normalizeEventCount(raw: unknown): UsageEventCount | null {
  if (!isRecord(raw)) return null;
  const hour = readInstant(raw.hour);
  const kind = readText(raw.kind).toLowerCase();
  if (hour.ms === null || hour.text === null || !kind) return null;
  return { hour: hour.text, hourMs: hour.ms, kind, count: readCount(raw.count) };
}

export function normalizeEvents(raw: unknown, requestedWindow: EventWindow = '24h'): EventsReport {
  const root = isRecord(raw) ? raw : {};
  return {
    window: readWindow(root.window, EVENT_WINDOWS, requestedWindow),
    generatedAt: readInstant(pick(root, 'generated_at', 'generatedAt')).text,
    events: readList(root.events, normalizeEvent).sort((a, b) => b.tMs - a.tMs),
    counts: readList(root.counts, normalizeEventCount).sort((a, b) => a.hourMs - b.hourMs),
  };
}

/* ---------------------------------------------------------------------------------------------
 * GET /box/health — the host the hub runs on, from an external exporter's sidecar file
 * ------------------------------------------------------------------------------------------- */

/** Normalised unit state from the exporter; anything unknown reads as `inactive`. */
export const BOX_UNIT_STATES = [
  'failed',
  'stopped',
  'starting',
  'running',
  'waiting',
  'idle',
  'inactive',
] as const;
export type BoxUnitState = (typeof BOX_UNIT_STATES)[number];

export interface BoxUnit {
  name: string;
  /** Name prefix before the first dash, e.g. `pmt`. */
  group: string;
  /** `service` or `timer`. */
  kind: string;
  description: string;
  state: BoxUnitState;
  active: string;
  sub: string;
  result: string | null;
  enabled: string | null;
  sinceMs: number | null;
  lastRunMs: number | null;
  nextRunMs: number | null;
}

export interface BoxTemp {
  sensor: string;
  label: string;
  celsius: number;
  high: number | null;
  crit: number | null;
}

export interface BoxDisk {
  mount: string;
  totalBytes: number;
  freeBytes: number;
  usedPct: number | null;
}

export interface BoxHistoryPoint {
  tMs: number;
  cpu: number | null;
  mem: number | null;
  load1: number | null;
}

export interface BoxHealth {
  generatedAtMs: number | null;
  host: string;
  os: string;
  kernel: string;
  uptimeSeconds: number | null;
  cpu: {
    model: string;
    cores: number;
    utilPct: number | null;
    iowaitPct: number | null;
    intervalSeconds: number | null;
  };
  load: { m1: number | null; m5: number | null; m15: number | null };
  memory: {
    totalBytes: number;
    availableBytes: number;
    usedPct: number | null;
    swapTotalBytes: number;
    swapUsedBytes: number;
  };
  disks: BoxDisk[];
  temps: BoxTemp[];
  units: BoxUnit[];
  history: BoxHistoryPoint[];
}

export interface BoxHealthReport {
  /** False when the hub has no usable export (exporter not installed or not run yet). */
  available: boolean;
  reason: string;
  generatedAt: string | null;
  ageSeconds: number | null;
  /** The export is older than the hub's freshness limit (exporter stopped). */
  stale: boolean;
  box: BoxHealth | null;
}

const readBoxUnitState = (value: unknown): BoxUnitState => {
  const text = readText(value).toLowerCase();
  return (BOX_UNIT_STATES as readonly string[]).includes(text)
    ? (text as BoxUnitState)
    : 'inactive';
};

function normalizeBoxUnit(raw: unknown): BoxUnit | null {
  if (!isRecord(raw)) return null;
  const name = readText(raw.name);
  if (!name) return null;
  const dot = name.lastIndexOf('.');
  return {
    name,
    group: readText(raw.group) || name.split(/[-.]/)[0],
    kind: readText(raw.kind) || (dot > 0 ? name.slice(dot + 1) : ''),
    description: readText(raw.description),
    state: readBoxUnitState(raw.state),
    active: readText(raw.active),
    sub: readText(raw.sub),
    result: readNullableText(raw.result),
    enabled: readNullableText(raw.enabled),
    sinceMs: readInstant(raw.since).ms,
    lastRunMs: readInstant(pick(raw, 'last_run', 'lastRun')).ms,
    nextRunMs: readInstant(pick(raw, 'next_run', 'nextRun')).ms,
  };
}

function normalizeBoxTemp(raw: unknown): BoxTemp | null {
  if (!isRecord(raw)) return null;
  const celsius = readNumber(raw.celsius);
  if (celsius === null) return null;
  return {
    sensor: readText(raw.sensor),
    label: readText(raw.label),
    celsius,
    high: readNumber(raw.high),
    crit: readNumber(raw.crit),
  };
}

function normalizeBoxDisk(raw: unknown): BoxDisk | null {
  if (!isRecord(raw)) return null;
  const mount = readText(raw.mount);
  if (!mount) return null;
  return {
    mount,
    totalBytes: readCount(pick(raw, 'total_bytes', 'totalBytes')),
    freeBytes: readCount(pick(raw, 'free_bytes', 'freeBytes')),
    usedPct: readPercent(pick(raw, 'used_pct', 'usedPct')),
  };
}

function normalizeBoxHistoryPoint(raw: unknown): BoxHistoryPoint | null {
  if (!isRecord(raw)) return null;
  const tMs = readInstant(raw.t).ms;
  if (tMs === null) return null;
  return {
    tMs,
    cpu: readPercent(raw.cpu),
    mem: readPercent(raw.mem),
    load1: readPercent(raw.load1),
  };
}

function normalizeBox(raw: unknown): BoxHealth | null {
  if (!isRecord(raw)) return null;
  const cpu = isRecord(raw.cpu) ? raw.cpu : {};
  const load = isRecord(raw.load) ? raw.load : {};
  const memory = isRecord(raw.memory) ? raw.memory : {};
  return {
    generatedAtMs: readInstant(pick(raw, 'generated_at', 'generatedAt')).ms,
    host: readText(raw.host),
    os: readText(raw.os),
    kernel: readText(raw.kernel),
    uptimeSeconds: readNumber(pick(raw, 'uptime_seconds', 'uptimeSeconds')),
    cpu: {
      model: readText(cpu.model),
      cores: readCount(cpu.cores),
      utilPct: readPercent(pick(cpu, 'util_pct', 'utilPct')),
      iowaitPct: readPercent(pick(cpu, 'iowait_pct', 'iowaitPct')),
      intervalSeconds: readNumber(pick(cpu, 'interval_seconds', 'intervalSeconds')),
    },
    load: { m1: readPercent(load.m1), m5: readPercent(load.m5), m15: readPercent(load.m15) },
    memory: {
      totalBytes: readCount(pick(memory, 'total_bytes', 'totalBytes')),
      availableBytes: readCount(pick(memory, 'available_bytes', 'availableBytes')),
      usedPct: readPercent(pick(memory, 'used_pct', 'usedPct')),
      swapTotalBytes: readCount(pick(memory, 'swap_total_bytes', 'swapTotalBytes')),
      swapUsedBytes: readCount(pick(memory, 'swap_used_bytes', 'swapUsedBytes')),
    },
    disks: readList(raw.disks, normalizeBoxDisk),
    temps: readList(raw.temps, normalizeBoxTemp),
    units: readList(raw.units, normalizeBoxUnit),
    history: readList(raw.history, normalizeBoxHistoryPoint).sort((a, b) => a.tMs - b.tMs),
  };
}

export function normalizeBoxHealth(raw: unknown): BoxHealthReport {
  const root = isRecord(raw) ? raw : {};
  const box = root.available === true ? normalizeBox(root.box) : null;
  return {
    available: box !== null,
    reason: readText(root.reason),
    generatedAt: readInstant(pick(root, 'generated_at', 'generatedAt')).text,
    ageSeconds: readNumber(pick(root, 'age_seconds', 'ageSeconds')),
    stale: root.stale === true,
    box,
  };
}

/* ---------------------------------------------------------------------------------------------
 * Client
 * ------------------------------------------------------------------------------------------- */

type QueryParams = Record<string, string | number>;

/**
 * GET through the shared client. In a dev build the fixture toggle (see
 * `hubInsightsFixtureMode.ts`) can answer instead; `import.meta.env.DEV` is statically false in
 * production, so that branch and its dynamic import are dropped from the bundle.
 */
async function getInsight(path: string, params?: QueryParams): Promise<unknown> {
  if (import.meta.env.DEV) {
    const { readHubFixtureMode } = await import('./hubInsightsFixtureMode');
    const mode = readHubFixtureMode();
    if (mode) {
      const { resolveHubFixture } = await import('./hubInsightsFixtures');
      return resolveHubFixture(mode, path, params ?? {});
    }
  }
  return apiClient.get<unknown>(path, params ? { params } : undefined);
}

const withLimit = (params: QueryParams, limit?: number): QueryParams =>
  limit !== undefined && Number.isFinite(limit) && limit > 0
    ? { ...params, limit: Math.floor(limit) }
    : params;

export const hubInsightsApi = {
  getModelUsage: async (window: ModelUsageWindow): Promise<ModelUsageReport> =>
    normalizeModelUsage(await getInsight('/usage/models', { window }), window),

  getSessions: async (window: InsightWindow, limit?: number): Promise<SessionsReport> =>
    normalizeSessions(await getInsight('/usage/sessions', withLimit({ window }, limit)), window),

  getRunway: async (): Promise<RunwayReport> => normalizeRunway(await getInsight('/usage/runway')),

  getValue: async (window: InsightWindow): Promise<ValueReport> =>
    normalizeValue(await getInsight('/usage/value', { window }), window),

  getEvents: async (window: EventWindow, limit?: number): Promise<EventsReport> =>
    normalizeEvents(await getInsight('/usage/events', withLimit({ window }, limit)), window),

  getBoxHealth: async (): Promise<BoxHealthReport> =>
    normalizeBoxHealth(await getInsight('/box/health')),
};
