/**
 * Threads: the title fallback chain, merging sessions of one T3 thread, nesting subagents under
 * their parent (by thread id, by parent title, or under a placeholder), roll-ups, waste flags,
 * sorting, search and project grouping.
 */

import { describe, expect, test } from 'bun:test';
import type { UsageSession } from '@/services/api/hubInsights';
import {
  buildThreadRows,
  countWastefulThreads,
  filterThreadRows,
  groupThreadRowsByProject,
  sessionDisplayTitle,
  sessionMetrics,
  sessionPromptTokens,
  sortThreadRows,
  threadFlags,
  topThreadsByValue,
  type ThreadRow,
} from '@/features/insights/logic/threads';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 10, 12);

let seq = 0;
const session = (overrides: Partial<UsageSession> = {}): UsageSession => ({
  sessionKey: `sess_${++seq}`,
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
