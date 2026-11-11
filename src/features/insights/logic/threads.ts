/**
 * Threads: `/usage/sessions` reshaped into one row per T3 thread, with subagent sessions nested
 * under their parent, wasteful threads flagged, and sorting / search / project grouping.
 *
 * Grouping rules:
 * - Non-subagent sessions of the same thread merge into one row: same `t3_thread_id`, else the
 *   same T3 title, else the same `native_session_id`. A thread that hopped providers is still one
 *   line.
 * - A Claude Code / Codex subagent (`…:agent:<agent>` key, which shares its parent's native
 *   session id) attaches to the parent with the same `t3_thread_id`, else the same native session
 *   id, so it nests even without a T3 mapping. A T3 subagent thread (`subagent: true`) attaches by
 *   `t3_thread_id`, else to the parent whose T3 title equals its `t3_parent_title`.
 * - A parent outside the window becomes a placeholder row (named after `t3_parent_title`, or after
 *   what the subagents report for their parent); a subagent with no link stays a top-level row.
 * - A parent row shows its own sessions plus its subagents (that is what the thread cost); each
 *   subagent row shows only itself.
 */

import type { UsageSession } from '@/services/api/hubInsights';
import { HIT_RATIO_MEDIUM, LOW_HIT_MIN_REQUESTS } from '@/features/usage/logic';
import { isClaudeModelId, shortSessionKey } from './format';

/* ---------------------------------------------------------------------------------------------
 * Titles
 * ------------------------------------------------------------------------------------------- */

export type TitleSource =
  't3_title' | 'title' | 'project' | 'session_key' | 'parent_title' | 'agent';

/** A Claude Code / Codex subagent session, or a T3 thread exported as a subagent. */
export const isSubagentSession = (session: UsageSession): boolean =>
  session.subagent || session.agentId !== null;

/**
 * A subagent's agent id as a label: Claude's hex ids are shortened ("agent a4f0aa40"), Codex's
 * named agents read as words ("review patch").
 */
export function agentDisplayName(agentId: string): string {
  const id = agentId.trim();
  if (/^a?[0-9a-f]{10,}$/i.test(id)) return `agent ${id.slice(0, 8)}`;
  return id.replace(/[_-]+/g, ' ').trim() || id;
}

export interface ResolvedTitle {
  title: string;
  source: TitleSource;
}

/**
 * T3 title, then the client's own title, then the project, then the short session key. `exclude`
 * skips a title equal to the parent's, so a subagent row says what the subagent did instead of
 * repeating the thread name.
 */
export function sessionDisplayTitle(session: UsageSession, exclude?: string | null): ResolvedTitle {
  const skip = exclude?.trim() || null;
  if (session.t3Title && session.t3Title !== skip)
    return { title: session.t3Title, source: 't3_title' };
  if (session.title && session.title !== skip) return { title: session.title, source: 'title' };
  if (session.project) return { title: session.project, source: 'project' };
  if (session.sessionKey)
    return { title: shortSessionKey(session.sessionKey), source: 'session_key' };
  return {
    title: session.t3Title ?? session.title ?? '—',
    source: session.t3Title ? 't3_title' : 'title',
  };
}

/* ---------------------------------------------------------------------------------------------
 * Metrics
 * ------------------------------------------------------------------------------------------- */

export interface ThreadMetrics {
  sessions: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Prompt tokens on the backend's hit-ratio basis (cache read + cache write + uncached input). */
  promptTokens: number;
  tokens: number;
  cacheHitRatio: number | null;
  coldCacheWrites: number;
  /** Sum of priced sessions; null when none had a value. */
  apiValueUsd: number | null;
  hasUnpriced: boolean;
  firstSeenMs: number | null;
  lastSeenMs: number | null;
  authIndexes: string[];
  clients: string[];
  providers: string[];
  /** Usage per model across the sessions (empty from a hub without the split). */
  models: ThreadModelUsage[];
  /**
   * Claude tokens re-priced per model id (API-price estimates); null when no session carried a
   * what-if figure.
   */
  whatIfUsd: Record<string, number> | null;
  /** API value of the Claude models in the split: what the what-if figures compare with. */
  claudeValueUsd: number | null;
}

export interface ThreadModelUsage {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Prompt (input + cache read + cache write, counted once) plus output. */
  tokens: number;
  /** Null when the model has no price. */
  apiValueUsd: number | null;
}

/**
 * A model's prompt counted once: Claude reports input without cached tokens, while Codex /
 * OpenAI-style input already includes them.
 */
const modelTokens = (model: Omit<ThreadModelUsage, 'tokens'>): number => {
  const cached = model.cacheReadTokens + model.cacheCreationTokens;
  const prompt = isClaudeModelId(model.model)
    ? model.inputTokens + cached
    : Math.max(model.inputTokens, cached);
  return prompt + model.outputTokens;
};

/** Highest value first (unpriced last), then most tokens, then name. */
export const compareModelUsage = (a: ThreadModelUsage, b: ThreadModelUsage): number => {
  if ((a.apiValueUsd === null) !== (b.apiValueUsd === null)) return a.apiValueUsd === null ? 1 : -1;
  return (
    (b.apiValueUsd ?? 0) - (a.apiValueUsd ?? 0) ||
    b.tokens - a.tokens ||
    a.model.localeCompare(b.model)
  );
};

function mergeModels(sessions: readonly UsageSession[]): ThreadModelUsage[] {
  const byModel = new Map<string, ThreadModelUsage>();
  sessions.forEach((session) =>
    session.models.forEach((usage) => {
      const entry = byModel.get(usage.model) ?? {
        model: usage.model,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        tokens: 0,
        apiValueUsd: null,
      };
      entry.requests += usage.requests;
      entry.inputTokens += usage.inputTokens;
      entry.outputTokens += usage.outputTokens;
      entry.cacheReadTokens += usage.cacheReadTokens;
      entry.cacheCreationTokens += usage.cacheCreationTokens;
      if (usage.apiValueUsd !== null)
        entry.apiValueUsd = (entry.apiValueUsd ?? 0) + usage.apiValueUsd;
      byModel.set(usage.model, entry);
    })
  );
  return [...byModel.values()]
    .map((entry) => ({ ...entry, tokens: modelTokens(entry) }))
    .sort(compareModelUsage);
}

/**
 * A session's prompt size on the same basis as its hit ratio. `input_tokens` alone is not
 * comparable across providers (Codex includes cached tokens), but cache_read ÷ ratio is, so the
 * backend's own ratio is reproduced exactly when sessions are summed.
 */
export function sessionPromptTokens(session: UsageSession): number {
  if (session.cacheHitRatio !== null && session.cacheHitRatio > 0 && session.cacheReadTokens > 0) {
    return session.cacheReadTokens / session.cacheHitRatio;
  }
  return session.inputTokens + session.cacheReadTokens + session.cacheCreationTokens;
}

const pushUnique = (target: string[], values: readonly string[]) => {
  values.forEach((value) => {
    if (value && !target.includes(value)) target.push(value);
  });
};

export function sessionMetrics(sessions: readonly UsageSession[]): ThreadMetrics {
  const metrics: ThreadMetrics = {
    sessions: sessions.length,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    promptTokens: 0,
    tokens: 0,
    cacheHitRatio: null,
    coldCacheWrites: 0,
    apiValueUsd: null,
    hasUnpriced: false,
    firstSeenMs: null,
    lastSeenMs: null,
    authIndexes: [],
    clients: [],
    providers: [],
    models: mergeModels(sessions),
    whatIfUsd: null,
    claudeValueUsd: null,
  };
  sessions.forEach((session) => {
    if (session.whatIfUsd) {
      const whatIf = metrics.whatIfUsd ?? {};
      Object.entries(session.whatIfUsd).forEach(([model, usd]) => {
        whatIf[model] = (whatIf[model] ?? 0) + usd;
      });
      metrics.whatIfUsd = whatIf;
    }
    metrics.requests += session.requests;
    metrics.inputTokens += session.inputTokens;
    metrics.outputTokens += session.outputTokens;
    metrics.cacheReadTokens += session.cacheReadTokens;
    metrics.cacheCreationTokens += session.cacheCreationTokens;
    metrics.promptTokens += sessionPromptTokens(session);
    metrics.coldCacheWrites += session.coldCacheWrites;
    if (session.apiValueUsd !== null) {
      metrics.apiValueUsd = (metrics.apiValueUsd ?? 0) + session.apiValueUsd;
    } else if (session.requests > 0) {
      metrics.hasUnpriced = true;
    }
    if (session.firstSeenMs !== null) {
      metrics.firstSeenMs = Math.min(metrics.firstSeenMs ?? Infinity, session.firstSeenMs);
    }
    if (session.lastSeenMs !== null) {
      metrics.lastSeenMs = Math.max(metrics.lastSeenMs ?? -Infinity, session.lastSeenMs);
    }
    pushUnique(metrics.authIndexes, session.authIndexes);
    pushUnique(metrics.clients, [session.client]);
    pushUnique(metrics.providers, [session.provider]);
  });
  metrics.promptTokens = Math.round(metrics.promptTokens);
  metrics.tokens = metrics.promptTokens + metrics.outputTokens;
  metrics.cacheHitRatio =
    metrics.promptTokens > 0 ? Math.min(1, metrics.cacheReadTokens / metrics.promptTokens) : null;
  metrics.models.forEach((model) => {
    if (isClaudeModelId(model.model) && model.apiValueUsd !== null) {
      metrics.claudeValueUsd = (metrics.claudeValueUsd ?? 0) + model.apiValueUsd;
    }
  });
  return metrics;
}

/* ---------------------------------------------------------------------------------------------
 * Reading profile
 * ------------------------------------------------------------------------------------------- */

/** Cache reads at least this many times the output… */
export const READING_MIN_READ_RATIO = 50;
/** …with replies averaging at most this many output tokens per request… */
export const READING_MAX_OUTPUT_PER_REQUEST = 1_500;
/** …once there are enough requests to judge. */
export const READING_MIN_REQUESTS = 5;

export interface ReadingProfile {
  /** Cache-read tokens per output token; null without output. */
  readToOutput: number | null;
  /** Mean output tokens per request; null without requests. */
  outputPerRequest: number | null;
  /**
   * Mostly reading (cache reads far above output) with short replies. A neutral description of
   * the thread's shape, not a recommendation.
   */
  mostlyReading: boolean;
}

export function readingProfile(metrics: ThreadMetrics): ReadingProfile {
  const readToOutput =
    metrics.outputTokens > 0 ? metrics.cacheReadTokens / metrics.outputTokens : null;
  const outputPerRequest = metrics.requests > 0 ? metrics.outputTokens / metrics.requests : null;
  return {
    readToOutput,
    outputPerRequest,
    mostlyReading:
      metrics.requests >= READING_MIN_REQUESTS &&
      readToOutput !== null &&
      readToOutput >= READING_MIN_READ_RATIO &&
      outputPerRequest !== null &&
      outputPerRequest <= READING_MAX_OUTPUT_PER_REQUEST,
  };
}

/* ---------------------------------------------------------------------------------------------
 * Waste flags
 * ------------------------------------------------------------------------------------------- */

export type ThreadFlag = 'low_hit' | 'cold_writes';

/** At least this many cold writes, making up at least this share of requests. */
export const COLD_WRITES_MIN = 3;
export const COLD_WRITES_SHARE = 0.2;

/**
 * A thread wastes quota when its prompt keeps being rebuilt: a low cache hit ratio once it is
 * busy enough to judge (same bands as Cache & Usage), or cold cache writes on a large share of
 * its requests (usually the conversation hopping accounts or idling past the cache TTL).
 */
export function threadFlags(metrics: ThreadMetrics): ThreadFlag[] {
  const flags: ThreadFlag[] = [];
  if (
    metrics.requests >= LOW_HIT_MIN_REQUESTS &&
    metrics.cacheHitRatio !== null &&
    metrics.cacheHitRatio < HIT_RATIO_MEDIUM
  ) {
    flags.push('low_hit');
  }
  if (
    metrics.coldCacheWrites >= COLD_WRITES_MIN &&
    metrics.coldCacheWrites / Math.max(1, metrics.requests) >= COLD_WRITES_SHARE
  ) {
    flags.push('cold_writes');
  }
  return flags;
}

/* ---------------------------------------------------------------------------------------------
 * Rows
 * ------------------------------------------------------------------------------------------- */

export interface ThreadRow {
  id: string;
  title: string;
  titleSource: TitleSource;
  project: string | null;
  cwd: string | null;
  t3ThreadId: string | null;
  subagent: boolean;
  /** Parent thread not in the window: stands in to group its subagents. */
  placeholder: boolean;
  /** This row's own sessions (merged sessions of one thread, or one subagent session). */
  sessions: UsageSession[];
  own: ThreadMetrics;
  /** Displayed figures: own plus subagents for a parent row. */
  metrics: ThreadMetrics;
  children: ThreadRow[];
  flags: ThreadFlag[];
}

const byRecency = (a: UsageSession, b: UsageSession) =>
  (b.lastSeenMs ?? -Infinity) - (a.lastSeenMs ?? -Infinity);

/** Most recent non-empty value across a thread's sessions. */
function latest<T>(
  sessions: readonly UsageSession[],
  read: (s: UsageSession) => T | null
): T | null {
  for (const session of [...sessions].sort(byRecency)) {
    const value = read(session);
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function makeRow(
  id: string,
  sessions: UsageSession[],
  options: { subagent: boolean; parentTitle?: string | null; parentTitles?: readonly string[] }
): ThreadRow {
  const newest = [...sessions].sort(byRecency)[0];
  let resolved: ResolvedTitle;
  if (options.subagent && newest.agentId) {
    // A Claude Code / Codex subagent reports its parent's title and transcript; name it after its
    // own agent unless it carries a title of its own.
    const parentTitles = new Set(
      [options.parentTitle, ...(options.parentTitles ?? [])].filter(Boolean)
    );
    resolved =
      newest.title && !parentTitles.has(newest.title) && newest.title !== newest.t3Title
        ? { title: newest.title, source: 'title' }
        : { title: agentDisplayName(newest.agentId), source: 'agent' };
  } else if (options.subagent) {
    resolved = sessionDisplayTitle(newest, options.parentTitle);
  } else {
    resolved =
      latest(sessions, (s) =>
        s.t3Title ? ({ title: s.t3Title, source: 't3_title' } as const) : null
      ) ?? sessionDisplayTitle(newest);
  }
  const own = sessionMetrics(sessions);
  return {
    id,
    title: resolved.title,
    titleSource: resolved.source,
    project: latest(sessions, (s) => s.project),
    cwd: latest(sessions, (s) => s.cwd),
    t3ThreadId: latest(sessions, (s) => s.t3ThreadId),
    subagent: options.subagent,
    placeholder: false,
    sessions,
    own,
    metrics: own,
    children: [],
    flags: threadFlags(own),
  };
}

const sessionId = (session: UsageSession, index: number) =>
  session.sessionKey ? `session:${session.sessionKey}` : `session#${index}`;

interface Placeholder {
  title: string;
  titleSource: TitleSource;
  kids: ThreadRow[];
}

export function buildThreadRows(sessions: readonly UsageSession[]): ThreadRow[] {
  const groups = new Map<string, UsageSession[]>();
  const keyByTitle = new Map<string, string>();
  const keyByNative = new Map<string, string>();
  const subagents: Array<{ session: UsageSession; index: number }> = [];
  const add = (key: string, session: UsageSession) => {
    const list = groups.get(key);
    if (list) list.push(session);
    else groups.set(key, [session]);
    if (session.nativeSessionId && !keyByNative.has(session.nativeSessionId)) {
      keyByNative.set(session.nativeSessionId, key);
    }
  };

  // Pass 1: sessions that know their T3 thread id define the groups (and claim their title).
  sessions.forEach((session, index) => {
    if (isSubagentSession(session)) {
      subagents.push({ session, index });
      return;
    }
    if (!session.t3ThreadId) return;
    const key = `t3:${session.t3ThreadId}`;
    add(key, session);
    if (session.t3Title && !keyByTitle.has(session.t3Title)) keyByTitle.set(session.t3Title, key);
  });
  // Pass 2: the rest join a thread by T3 title, then by native session id, or stand alone.
  sessions.forEach((session, index) => {
    if (isSubagentSession(session) || session.t3ThreadId) return;
    if (session.t3Title) {
      const key = keyByTitle.get(session.t3Title) ?? `t3title:${session.t3Title}`;
      keyByTitle.set(session.t3Title, key);
      add(key, session);
      return;
    }
    if (session.nativeSessionId) {
      add(keyByNative.get(session.nativeSessionId) ?? `native:${session.nativeSessionId}`, session);
      return;
    }
    add(sessionId(session, index), session);
  });

  const parents = new Map<string, ThreadRow>();
  groups.forEach((list, key) => parents.set(key, makeRow(key, list, { subagent: false })));
  const parentByThreadId = new Map<string, ThreadRow>();
  const parentByNative = new Map<string, ThreadRow>();
  parents.forEach((row) => {
    row.sessions.forEach((session) => {
      if (session.t3ThreadId && !parentByThreadId.has(session.t3ThreadId)) {
        parentByThreadId.set(session.t3ThreadId, row);
      }
      if (session.nativeSessionId && !parentByNative.has(session.nativeSessionId)) {
        parentByNative.set(session.nativeSessionId, row);
      }
    });
  });

  const children = new Map<string, ThreadRow[]>();
  const placeholders = new Map<string, Placeholder>();
  const orphans: ThreadRow[] = [];
  subagents.forEach(({ session, index }) => {
    const parent =
      (session.t3ThreadId ? parentByThreadId.get(session.t3ThreadId) : undefined) ??
      (session.agentId && session.nativeSessionId
        ? parentByNative.get(session.nativeSessionId)
        : undefined) ??
      (session.t3ParentTitle
        ? parents.get(keyByTitle.get(session.t3ParentTitle) ?? '')
        : undefined);
    const parentTitle = parent?.title ?? session.t3ParentTitle;
    const parentTitles = parent?.sessions.flatMap((s) => [s.title ?? '', s.t3Title ?? '']);
    const row = makeRow(sessionId(session, index), [session], {
      subagent: true,
      parentTitle,
      parentTitles,
    });
    if (parent) {
      children.set(parent.id, [...(children.get(parent.id) ?? []), row]);
      return;
    }
    // Parent outside the window: group under a stand-in. Agent sessions carry their parent's
    // T3 thread / transcript, so they name it; T3 subagent threads name it by parent title.
    let key: string | null = null;
    let title: ResolvedTitle | null = null;
    if (session.agentId && (session.t3ThreadId || session.nativeSessionId)) {
      key = session.t3ThreadId ? `t3:${session.t3ThreadId}` : `native:${session.nativeSessionId}`;
      title = sessionDisplayTitle(session);
    } else if (session.t3ParentTitle) {
      key = `title:${session.t3ParentTitle}`;
      title = { title: session.t3ParentTitle, source: 'parent_title' };
    }
    if (!key || !title) {
      orphans.push(row);
      return;
    }
    const entry = placeholders.get(key) ?? {
      title: title.title,
      titleSource: title.source,
      kids: [],
    };
    entry.kids.push(row);
    placeholders.set(key, entry);
  });

  const rows: ThreadRow[] = [];
  parents.forEach((row) => {
    const kids = children.get(row.id) ?? [];
    if (kids.length === 0) {
      rows.push(row);
      return;
    }
    const metrics = sessionMetrics([...row.sessions, ...kids.flatMap((kid) => kid.sessions)]);
    rows.push({ ...row, children: kids, metrics, flags: threadFlags(metrics) });
  });
  placeholders.forEach(({ title, titleSource, kids }, key) => {
    const allSessions = kids.flatMap((kid) => kid.sessions);
    const metrics = sessionMetrics(allSessions);
    rows.push({
      id: `parent:${key}`,
      title,
      titleSource,
      project: latest(allSessions, (s) => s.project),
      cwd: latest(allSessions, (s) => s.cwd),
      t3ThreadId: latest(allSessions, (s) => s.t3ThreadId),
      subagent: false,
      placeholder: true,
      sessions: [],
      own: sessionMetrics([]),
      metrics,
      children: kids,
      flags: threadFlags(metrics),
    });
  });
  rows.push(...orphans);
  return rows;
}

/** Top-level threads where the thread or any subagent is flagged. */
export function countWastefulThreads(rows: readonly ThreadRow[]): number {
  return rows.filter(
    (row) => row.flags.length > 0 || row.children.some((child) => child.flags.length > 0)
  ).length;
}

export type TopThreadsMetric = 'value' | 'tokens';

/**
 * The largest threads (subagents included) by API value or by tokens, for the overview. Threads
 * with nothing on that measure (unpriced, for value) are left out.
 */
export function topThreads(
  rows: readonly ThreadRow[],
  metric: TopThreadsMetric,
  count = 5
): ThreadRow[] {
  const amount = (row: ThreadRow) =>
    metric === 'value' ? (row.metrics.apiValueUsd ?? 0) : row.metrics.tokens;
  return rows
    .filter((row) => amount(row) > 0)
    .sort(
      (a, b) => amount(b) - amount(a) || (b.metrics.lastSeenMs ?? 0) - (a.metrics.lastSeenMs ?? 0)
    )
    .slice(0, count);
}

/** Highest-value threads (subagents included), for the overview. */
export const topThreadsByValue = (rows: readonly ThreadRow[], count = 5): ThreadRow[] =>
  topThreads(rows, 'value', count);

/* ---------------------------------------------------------------------------------------------
 * Sorting, search, grouping
 * ------------------------------------------------------------------------------------------- */

export const THREAD_SORT_KEYS = [
  'title',
  'project',
  'client',
  'accounts',
  'lastActive',
  'requests',
  'tokens',
  'cacheHit',
  'coldWrites',
  'value',
] as const;
export type ThreadSortKey = (typeof THREAD_SORT_KEYS)[number];
export type SortDirection = 'asc' | 'desc';

/** Text columns start A→Z; figures start largest first. */
export const defaultSortDirection = (key: ThreadSortKey): SortDirection =>
  key === 'title' || key === 'project' || key === 'client' || key === 'accounts' ? 'asc' : 'desc';

interface Sortable {
  id: string;
  title: string;
  project: string | null;
  metrics: ThreadMetrics;
}

type AccountLabel = (authIndex: string) => string;

function sortValue(item: Sortable, key: ThreadSortKey, accountLabel?: AccountLabel) {
  const m = item.metrics;
  switch (key) {
    case 'title':
      return item.title.toLowerCase();
    case 'project':
      return item.project?.toLowerCase() ?? null;
    case 'client':
      return m.clients.length ? m.clients.join(', ').toLowerCase() : null;
    case 'accounts':
      return m.authIndexes.length
        ? m.authIndexes
            .map((index) => accountLabel?.(index) ?? index)
            .join(', ')
            .toLowerCase()
        : null;
    case 'lastActive':
      return m.lastSeenMs;
    case 'requests':
      return m.requests;
    case 'tokens':
      return m.tokens;
    case 'cacheHit':
      return m.cacheHitRatio;
    case 'coldWrites':
      return m.coldCacheWrites;
    case 'value':
      return m.apiValueUsd;
  }
}

/** Missing values sort last in both directions; ties fall back to recency, then id. */
export function compareThreads(
  a: Sortable,
  b: Sortable,
  key: ThreadSortKey,
  direction: SortDirection,
  accountLabel?: AccountLabel
): number {
  const left = sortValue(a, key, accountLabel);
  const right = sortValue(b, key, accountLabel);
  if (left === null && right !== null) return 1;
  if (right === null && left !== null) return -1;
  if (left !== null && right !== null && left !== right) {
    const order =
      typeof left === 'string' && typeof right === 'string'
        ? left.localeCompare(right)
        : (left as number) - (right as number);
    if (order !== 0) return direction === 'asc' ? order : -order;
  }
  return (
    (b.metrics.lastSeenMs ?? -Infinity) - (a.metrics.lastSeenMs ?? -Infinity) ||
    a.id.localeCompare(b.id)
  );
}

export function sortThreadRows(
  rows: readonly ThreadRow[],
  key: ThreadSortKey,
  direction: SortDirection,
  accountLabel?: AccountLabel
): ThreadRow[] {
  const compare = (a: ThreadRow, b: ThreadRow) =>
    compareThreads(a, b, key, direction, accountLabel);
  return [...rows]
    .map((row) =>
      row.children.length ? { ...row, children: [...row.children].sort(compare) } : row
    )
    .sort(compare);
}

function haystack(row: ThreadRow): string {
  const parts = [
    row.title,
    row.project ?? '',
    row.cwd ?? '',
    ...row.metrics.clients,
    ...row.metrics.providers,
  ];
  row.sessions.forEach((session) => {
    parts.push(
      session.t3Title ?? '',
      session.title ?? '',
      session.t3ParentTitle ?? '',
      session.sessionKey
    );
  });
  return parts.join('\n').toLowerCase();
}

/**
 * Case-insensitive search over titles, project, path, client and session keys. A parent that
 * matches keeps all its subagents; otherwise it stays only for the subagents that match.
 */
export function filterThreadRows(rows: readonly ThreadRow[], query: string): ThreadRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  const result: ThreadRow[] = [];
  rows.forEach((row) => {
    if (haystack(row).includes(needle)) {
      result.push(row);
      return;
    }
    const kids = row.children.filter((child) => haystack(child).includes(needle));
    if (kids.length) result.push({ ...row, children: kids });
  });
  return result;
}

export interface ProjectGroup {
  id: string;
  /** Null groups threads without a project. */
  project: string | null;
  title: string;
  rows: ThreadRow[];
  metrics: ThreadMetrics;
}

/**
 * Threads grouped by project, groups ordered by the active sort (on their combined figures, or
 * by name for the text columns); threads without a project come last.
 */
export function groupThreadRowsByProject(
  rows: readonly ThreadRow[],
  key: ThreadSortKey,
  direction: SortDirection,
  accountLabel?: AccountLabel
): ProjectGroup[] {
  const groups = new Map<string, ThreadRow[]>();
  rows.forEach((row) => {
    const id = row.project ?? '';
    groups.set(id, [...(groups.get(id) ?? []), row]);
  });
  const result: ProjectGroup[] = [...groups.entries()].map(([id, list]) => ({
    id: `project:${id}`,
    project: id || null,
    title: id,
    rows: sortThreadRows(list, key, direction, accountLabel),
    metrics: sessionMetrics(
      list.flatMap((row) => [...row.sessions, ...row.children.flatMap((child) => child.sessions)])
    ),
  }));
  const groupKey: ThreadSortKey = key === 'title' ? 'project' : key;
  return result.sort((a, b) => {
    if (a.project === null && b.project !== null) return 1;
    if (b.project === null && a.project !== null) return -1;
    return compareThreads(a, b, groupKey, direction, accountLabel);
  });
}
