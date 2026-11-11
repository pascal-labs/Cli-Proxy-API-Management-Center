/**
 * Threads: the title fallback chain, merging sessions of one T3 thread, nesting subagents under
 * their parent (by thread id, by native session id for `:agent:` keys, by parent title, or under a
 * placeholder), roll-ups, model splits and what-if prices, the reading profile, waste flags, top
 * threads, sorting, search and project grouping.
 */

import { describe, expect, test } from 'bun:test';
import type { UsageSession } from '@/services/api/hubInsights';
import { parseSessionKey, type SessionModelUsage } from '@/services/api/hubInsights';
import {
  agentDisplayName,
  buildThreadRows,
  countWastefulThreads,
  filterThreadRows,
  groupThreadRowsByProject,
  readingProfile,
  sessionDisplayTitle,
  sessionMetrics,
  sessionPromptTokens,
  sortThreadRows,
  threadFlags,
  topThreads,
  topThreadsByValue,
  type ThreadRow,
} from '@/features/insights/logic/threads';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 10, 12);

let seq = 0;
const session = (overrides: Partial<UsageSession> = {}): UsageSession => ({
  sessionKey: `sess_${++seq}`,
  nativeSessionId: null,
  agentId: null,
  provider: 'claude',
  client: 'claude-code',
  project: null,
  cwd: null,
  title: null,
  t3ThreadId: null,
  t3Title: null,
  t3ParentTitle: null,
  subagent: false,
  authIndexes: ['a'],
  firstSeen: null,
  firstSeenMs: NOW - 2 * HOUR,
  lastSeen: null,
  lastSeenMs: NOW - HOUR,
  requests: 10,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 800,
  cacheCreationTokens: 100,
  cacheHitRatio: 0.8,
  coldCacheWrites: 1,
  apiValueUsd: 1,
  models: [],
  whatIfUsd: null,
  ...overrides,
});

/** A session keyed like the hub does it, with native id and agent parsed from the key. */
const keyed = (key: string, overrides: Partial<UsageSession> = {}): UsageSession => {
  const { nativeId, agentId } = parseSessionKey(key);
  return session({ sessionKey: key, nativeSessionId: nativeId, agentId, ...overrides });
};

const PARENT = '7f3a91c2-0b1d-4e5f-8a9b-1c2d3e4f5a6b';

const usage = (model: string, overrides: Partial<SessionModelUsage> = {}): SessionModelUsage => ({
  model,
  requests: 10,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 800,
  cacheCreationTokens: 100,
  apiValueUsd: 1,
  ...overrides,
});

const byTitle = (rows: ThreadRow[], title: string) => {
  const row = rows.find((entry) => entry.title === title);
  if (!row) throw new Error(`no row ${title}`);
  return row;
};

describe('sessionDisplayTitle', () => {
  test('T3 title, then title, then project, then the short session key', () => {
    expect(sessionDisplayTitle(session({ t3Title: 'T3', title: 'T', project: 'p' }))).toEqual({
      title: 'T3',
      source: 't3_title',
    });
    expect(sessionDisplayTitle(session({ title: 'T', project: 'p' })).source).toBe('title');
    expect(sessionDisplayTitle(session({ project: 'p' }))).toEqual({
      title: 'p',
      source: 'project',
    });
    expect(sessionDisplayTitle(session({ sessionKey: 'sess_9f8e7d6c5b4a3210' }))).toEqual({
      title: 'sess_9f8…',
      source: 'session_key',
    });
    expect(sessionDisplayTitle(session({ sessionKey: 'short' })).title).toBe('short');
  });

  test("a subagent skips a title that only repeats its parent's", () => {
    const sub = session({ t3Title: 'Parent', title: 'Explore: files' });
    expect(sessionDisplayTitle(sub, 'Parent').title).toBe('Explore: files');
    expect(sessionDisplayTitle(session({ t3Title: 'Parent', project: 'p' }), 'Parent').title).toBe(
      'p'
    );
  });
});

describe('metrics', () => {
  test("prompt tokens reproduce each session's own hit ratio when summed", () => {
    // Codex-style input that already includes cached tokens: ratio 0.5 means a 1600-token prompt.
    const codex = session({
      inputTokens: 1600,
      cacheReadTokens: 800,
      cacheCreationTokens: 0,
      cacheHitRatio: 0.5,
    });
    expect(sessionPromptTokens(codex)).toBe(1600);
    const metrics = sessionMetrics([
      codex,
      session({
        cacheHitRatio: null,
        inputTokens: 200,
        cacheReadTokens: 0,
        cacheCreationTokens: 200,
      }),
    ]);
    expect(metrics.promptTokens).toBe(2000);
    expect(metrics.cacheHitRatio).toBeCloseTo(800 / 2000);
    expect(metrics.tokens).toBe(2000 + 100);
  });

  test('value is null only when no session was priced; unpriced traffic is noted', () => {
    expect(sessionMetrics([session({ apiValueUsd: null })]).apiValueUsd).toBeNull();
    const mixed = sessionMetrics([session({ apiValueUsd: 2 }), session({ apiValueUsd: null })]);
    expect(mixed.apiValueUsd).toBe(2);
    expect(mixed.hasUnpriced).toBe(true);
    expect(sessionMetrics([]).cacheHitRatio).toBeNull();
  });
});

describe('buildThreadRows', () => {
  test('sessions of one T3 thread merge (by id, then by title) and keep union metadata', () => {
    const rows = buildThreadRows([
      session({
        t3ThreadId: 't1',
        t3Title: 'Fix DST',
        provider: 'codex',
        client: 'codex',
        authIndexes: ['c'],
      }),
      session({ t3Title: 'Fix DST', authIndexes: ['a'], lastSeenMs: NOW }),
      session({ t3ThreadId: 't1', project: 'web', authIndexes: ['c', 'b'] }),
      session({ title: 'Loose' }),
    ]);
    expect(rows).toHaveLength(2);
    const thread = byTitle(rows, 'Fix DST');
    expect(thread.sessions).toHaveLength(3);
    expect(thread.project).toBe('web');
    expect(thread.metrics.clients).toEqual(['codex', 'claude-code']);
    expect(thread.metrics.authIndexes).toEqual(['c', 'b', 'a']);
    expect(thread.metrics.requests).toBe(30);
    expect(thread.metrics.lastSeenMs).toBe(NOW);
  });

  test('subagents nest under their parent by thread id or parent title, and roll up', () => {
    const rows = buildThreadRows([
      session({ t3ThreadId: 't1', t3Title: 'Runway', requests: 100, apiValueUsd: 10 }),
      session({
        subagent: true,
        t3ParentTitle: 'Runway',
        title: 'Explore',
        requests: 5,
        apiValueUsd: 1,
      }),
      session({ subagent: true, t3ThreadId: 't1', title: 'Test', requests: 3, apiValueUsd: 0.5 }),
    ]);
    expect(rows).toHaveLength(1);
    const [parent] = rows;
    expect(parent.children.map((child) => child.title).sort()).toEqual(['Explore', 'Test']);
    expect(parent.children.every((child) => child.subagent)).toBe(true);
    expect(parent.own.requests).toBe(100);
    expect(parent.metrics.requests).toBe(108);
    expect(parent.metrics.apiValueUsd).toBeCloseTo(11.5);
  });

  test('a parent outside the window becomes a placeholder; an unlinked subagent stays top level', () => {
    const rows = buildThreadRows([
      session({ subagent: true, t3ParentTitle: 'Roadmap', title: 'Research', apiValueUsd: 2 }),
      session({ subagent: true, t3ParentTitle: 'Roadmap', title: 'Draft', apiValueUsd: 1 }),
      session({ subagent: true, title: 'Orphan' }),
    ]);
    const placeholder = byTitle(rows, 'Roadmap');
    expect(placeholder.placeholder).toBe(true);
    expect(placeholder.titleSource).toBe('parent_title');
    expect(placeholder.children).toHaveLength(2);
    expect(placeholder.metrics.apiValueUsd).toBe(3);
    expect(placeholder.own.requests).toBe(0);
    const orphan = byTitle(rows, 'Orphan');
    expect(orphan.subagent).toBe(true);
    expect(orphan.children).toHaveLength(0);
  });
});

describe('Claude Code / Codex subagents (`:agent:` keys)', () => {
  test('the key yields the native id and agent; other keys have neither', () => {
    expect(parseSessionKey(`claude:${PARENT.toUpperCase()}:agent:a4f0aa401b88ca320`)).toEqual({
      nativeId: PARENT,
      agentId: 'a4f0aa401b88ca320',
    });
    expect(parseSessionKey(`codex:${PARENT}`)).toEqual({ nativeId: PARENT, agentId: null });
    expect(parseSessionKey('header:abc:agent:x')).toEqual({ nativeId: null, agentId: 'x' });
    expect(parseSessionKey('sess_1')).toEqual({ nativeId: null, agentId: null });
  });

  test('without a T3 mapping they nest under the parent with the same native session id', () => {
    const rows = buildThreadRows([
      keyed(`claude:${PARENT}`, { title: 'Engine freeze', requests: 100, apiValueUsd: 10 }),
      keyed(`claude:${PARENT}:agent:a4f0aa401b88ca320`, { title: 'Engine freeze', requests: 5 }),
      keyed(`claude:${PARENT}:agent:a93caed17f75b8b58`, { title: 'Engine freeze', requests: 7 }),
      keyed('claude:0b5e0001-1a2b-4c3d-8e4f-000000000001', { title: 'Other work' }),
    ]);
    expect(rows.map((row) => row.title).sort()).toEqual(['Engine freeze', 'Other work']);
    const parent = byTitle(rows, 'Engine freeze');
    expect(parent.children).toHaveLength(2);
    expect(parent.children.every((child) => child.subagent)).toBe(true);
    // They report the parent's transcript title, so each is named after its own agent.
    expect(parent.children.map((child) => child.title).sort()).toEqual([
      'agent a4f0aa40',
      'agent a93caed1',
    ]);
    expect(parent.children[0].titleSource).toBe('agent');
    expect(parent.own.requests).toBe(100);
    expect(parent.metrics.requests).toBe(112);
  });

  test('with a T3 mapping (subagent: false) they nest instead of merging into the parent', () => {
    const t3 = { t3ThreadId: 't3-x', t3Title: 'Tab D', subagent: false };
    const rows = buildThreadRows([
      keyed(`claude:${PARENT}`, t3),
      keyed(`claude:${PARENT}:agent:a1111111111111111`, t3),
      keyed(`claude:${PARENT}:agent:a2222222222222222`, t3),
      keyed(`codex:01a1c6f6-0664-7130-8a1b-2c3d4e5f6a7b:agent:review_patch`, {
        ...t3,
        provider: 'codex',
        client: 'codex',
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].sessions).toHaveLength(1);
    expect(rows[0].children.map((child) => child.title)).toContain('review patch');
    expect(rows[0].children).toHaveLength(3);
  });

  test('a parent outside the window becomes a stand-in named after what the agents report', () => {
    const rows = buildThreadRows([
      keyed(`claude:${PARENT}:agent:a1111111111111111`, { title: 'Audit cache TTLs' }),
      keyed(`claude:${PARENT}:agent:a2222222222222222`, { title: 'Audit cache TTLs' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Audit cache TTLs', placeholder: true });
    expect(rows[0].children).toHaveLength(2);
  });

  test('agent labels: Claude hex ids are shortened, Codex names read as words', () => {
    expect(agentDisplayName('a4f0aa401b88ca320')).toBe('agent a4f0aa40');
    expect(agentDisplayName('first_stop_seed_custody')).toBe('first stop seed custody');
  });

  test('top threads count a thread once, by value or by tokens', () => {
    const rows = buildThreadRows([
      keyed(`claude:${PARENT}`, { title: 'Big', apiValueUsd: 5, cacheReadTokens: 100 }),
      keyed(`claude:${PARENT}:agent:a1111111111111111`, { title: 'Big', apiValueUsd: 5 }),
      keyed(`claude:${PARENT}:agent:a2222222222222222`, { title: 'Big', apiValueUsd: 5 }),
      session({ title: 'Wide', apiValueUsd: 12, cacheReadTokens: 90_000 }),
      session({ title: 'Unpriced', apiValueUsd: null, cacheReadTokens: 5_000 }),
    ]);
    const byValue = topThreads(rows, 'value');
    expect(byValue.map((row) => row.title)).toEqual(['Big', 'Wide']);
    expect(byValue[0].metrics.apiValueUsd).toBe(15);
    expect(topThreads(rows, 'tokens').map((row) => row.title)).toEqual(['Wide', 'Unpriced', 'Big']);
  });
});

describe('model split and what-if', () => {
  test('models merge across a thread and its subagents, highest value first', () => {
    const rows = buildThreadRows([
      keyed(`claude:${PARENT}`, {
        title: 'Thread',
        models: [usage('claude-fable-5-2', { apiValueUsd: 8 })],
        whatIfUsd: { 'claude-opus-5-5': 4, 'claude-sonnet-5-5': 2 },
      }),
      keyed(`claude:${PARENT}:agent:a1111111111111111`, {
        title: 'Thread',
        models: [
          usage('claude-sonnet-5-5', { apiValueUsd: 0.5 }),
          usage('claude-fable-5-2', { apiValueUsd: 2 }),
        ],
        whatIfUsd: { 'claude-opus-5-5': 1.5, 'claude-sonnet-5-5': 0.8 },
      }),
      keyed('codex:0b5e0001-1a2b-4c3d-8e4f-000000000001', {
        title: 'Codex only',
        models: [
          usage('gpt-5.1-codex-mini', {
            apiValueUsd: null,
            inputTokens: 900,
            cacheReadTokens: 800,
          }),
        ],
      }),
    ]);
    const thread = byTitle(rows, 'Thread').metrics;
    expect(thread.models.map((model) => [model.model, model.apiValueUsd])).toEqual([
      ['claude-fable-5-2', 10],
      ['claude-sonnet-5-5', 0.5],
    ]);
    expect(thread.models[0].requests).toBe(20);
    expect(thread.whatIfUsd).toEqual({ 'claude-opus-5-5': 5.5, 'claude-sonnet-5-5': 2.8 });
    expect(thread.claudeValueUsd).toBeCloseTo(10.5);
    const codex = byTitle(rows, 'Codex only').metrics;
    expect(codex.whatIfUsd).toBeNull();
    expect(codex.claudeValueUsd).toBeNull();
    // Codex input (900) already includes the cached tokens: prompt counted once, plus output.
    expect(codex.models[0].tokens).toBe(900 + 50);
  });

  test('an older hub without the split leaves it empty', () => {
    const metrics = sessionMetrics([session()]);
    expect(metrics.models).toEqual([]);
    expect(metrics.whatIfUsd).toBeNull();
  });

  test('reading profile: cache reads far above output with short replies', () => {
    const reading = readingProfile(
      sessionMetrics([session({ requests: 20, outputTokens: 10_000, cacheReadTokens: 900_000 })])
    );
    expect(reading).toEqual({ readToOutput: 90, outputPerRequest: 500, mostlyReading: true });
    expect(
      readingProfile(
        sessionMetrics([session({ requests: 20, outputTokens: 200_000, cacheReadTokens: 9e6 })])
      ).mostlyReading
    ).toBe(false);
    expect(
      readingProfile(
        sessionMetrics([session({ requests: 2, outputTokens: 10, cacheReadTokens: 9e6 })])
      ).mostlyReading
    ).toBe(false);
    expect(readingProfile(sessionMetrics([session({ outputTokens: 0 })])).readToOutput).toBeNull();
  });
});

describe('waste flags', () => {
  const metrics = (overrides: Partial<UsageSession>) => sessionMetrics([session(overrides)]);

  test('low hit ratio once busy enough; cold writes on a large share of requests', () => {
    expect(
      threadFlags(metrics({ requests: 10, cacheHitRatio: 0.3, cacheReadTokens: 300 }))
    ).toEqual(['low_hit']);
    expect(threadFlags(metrics({ requests: 4, cacheHitRatio: 0.1, cacheReadTokens: 100 }))).toEqual(
      []
    );
    expect(threadFlags(metrics({ requests: 10, coldCacheWrites: 3 }))).toEqual(['cold_writes']);
    expect(threadFlags(metrics({ requests: 100, coldCacheWrites: 3 }))).toEqual([]);
    expect(threadFlags(metrics({ requests: 2, coldCacheWrites: 2 }))).toEqual([]);
  });

  test('a thread counts as wasteful when it or a subagent is flagged', () => {
    const rows = buildThreadRows([
      session({ t3ThreadId: 't1', t3Title: 'Healthy', requests: 500, coldCacheWrites: 1 }),
      session({ subagent: true, t3ThreadId: 't1', requests: 10, coldCacheWrites: 6 }),
      session({ t3Title: 'Fine' }),
    ]);
    expect(byTitle(rows, 'Healthy').flags).toEqual([]);
    expect(countWastefulThreads(rows)).toBe(1);
  });
});

describe('sorting, search, grouping', () => {
  const rows = buildThreadRows([
    session({ t3Title: 'Alpha', project: 'web', apiValueUsd: 5, lastSeenMs: NOW - 3 * HOUR }),
    session({ t3Title: 'beta', project: 'core', apiValueUsd: null, lastSeenMs: NOW - HOUR }),
    session({ t3Title: 'Gamma', project: null, apiValueUsd: 9, lastSeenMs: NOW - 2 * HOUR }),
    session({
      t3ThreadId: 't9',
      t3Title: 'Delta',
      project: 'web',
      apiValueUsd: 1,
      lastSeenMs: NOW,
    }),
    session({
      subagent: true,
      t3ThreadId: 't9',
      title: 'Explore: chart helpers',
      apiValueUsd: 0.5,
    }),
  ]);
  const titles = (list: Array<{ title: string }>) => list.map((row) => row.title);

  test('numbers sort largest first by default and missing values last either way', () => {
    expect(titles(sortThreadRows(rows, 'value', 'desc'))).toEqual([
      'Gamma',
      'Alpha',
      'Delta',
      'beta',
    ]);
    expect(titles(sortThreadRows(rows, 'value', 'asc'))).toEqual([
      'Delta',
      'Alpha',
      'Gamma',
      'beta',
    ]);
    expect(titles(sortThreadRows(rows, 'lastActive', 'desc'))).toEqual([
      'Delta',
      'beta',
      'Gamma',
      'Alpha',
    ]);
    expect(titles(sortThreadRows(rows, 'title', 'asc'))).toEqual([
      'Alpha',
      'beta',
      'Delta',
      'Gamma',
    ]);
    expect(titles(sortThreadRows(rows, 'project', 'asc'))).toEqual([
      'beta',
      'Delta',
      'Alpha',
      'Gamma',
    ]);
  });

  test('search keeps a matching parent whole, or a parent with only its matching subagents', () => {
    expect(titles(filterThreadRows(rows, 'GAMMA'))).toEqual(['Gamma']);
    const byChild = filterThreadRows(rows, 'chart helpers');
    expect(titles(byChild)).toEqual(['Delta']);
    expect(byChild[0].children).toHaveLength(1);
    expect(filterThreadRows(rows, 'delta')[0].children).toHaveLength(1);
    expect(filterThreadRows(rows, '   ')).toHaveLength(rows.length);
    expect(filterThreadRows(rows, 'no such thing')).toEqual([]);
  });

  test('project groups follow the sort on their combined figures; no project last', () => {
    const groups = groupThreadRowsByProject(rows, 'value', 'desc');
    expect(groups.map((group) => group.project)).toEqual(['web', 'core', null]);
    expect(groups[0].metrics.apiValueUsd).toBeCloseTo(6.5);
    expect(titles(groups[0].rows)).toEqual(['Alpha', 'Delta']);
    expect(groupThreadRowsByProject(rows, 'title', 'asc').map((group) => group.project)).toEqual([
      'core',
      'web',
      null,
    ]);
  });

  test('top threads by value include subagents and skip unpriced threads', () => {
    expect(titles(topThreadsByValue(rows, 2))).toEqual(['Gamma', 'Alpha']);
    expect(
      topThreadsByValue(rows, 5).find((row) => row.title === 'Delta')?.metrics.apiValueUsd
    ).toBe(1.5);
    expect(titles(topThreadsByValue(rows, 5))).not.toContain('beta');
  });
});
