/**
 * Value bands and totals, per-model aggregation, the allocation split (stable colours, folding),
 * the health event shaping, and the shared formatters.
 */

import { describe, expect, test } from 'bun:test';
import type { ModelUsageRow, UsageEvent, ValueAccount } from '@/services/api/hubInsights';
import { accountName, buildAccountDirectory } from '@/features/insights/logic/accounts';
import {
  assignAllocationSlots,
  buildAllocation,
  OTHER_KEY,
  type AllocationItem,
} from '@/features/insights/logic/allocation';
import {
  activeDeadLogins,
  buildHourlyMatrix,
  countEventsByKind,
  eventAccounts,
  filterEvents,
  groupEventsByDay,
  heatLevel,
  moveHistory,
  orderedEventKinds,
  summarizeHealth,
} from '@/features/insights/logic/events';
import {
  formatMultiple,
  formatShare,
  formatUsd,
  isClaudeModelId,
  maskEmailsInText,
  modelLabel,
  orderedWhatIf,
  shortSessionKey,
} from '@/features/insights/logic/format';
import {
  aggregateByAccount,
  aggregateByModel,
  aggregateRows,
  collectUnpricedModels,
  modelMixByAccount,
  rowTokens,
} from '@/features/insights/logic/models';
import {
  accountsWithoutPlan,
  classifyValueRatio,
  planPerDay,
  resolveCacheTotals,
  resolveValueTotals,
  sortValueAccounts,
} from '@/features/insights/logic/value';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 10, 12, 30);

const row = (overrides: Partial<ModelUsageRow> = {}): ModelUsageRow => ({
  authIndex: 'a',
  provider: 'claude',
  model: 'm1',
  requests: 10,
  inputTokens: 100,
  uncachedInputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 800,
  cacheCreation5mTokens: 60,
  cacheCreation1hTokens: 40,
  cacheHitRatio: 0.8,
  apiValueUsd: 2,
  cacheSavingsUsd: null,
  ...overrides,
});

const valueAccount = (overrides: Partial<ValueAccount> = {}): ValueAccount => ({
  authIndex: 'a',
  provider: 'claude',
  label: 'claude-a.json',
  requests: 10,
  apiValueUsd: 100,
  hasUnpricedUsage: false,
  cacheSavingsUsd: null,
  noCacheValueUsd: null,
  subscriptionUsdPerMonth: 200,
  subscriptionUsdForWindow: 50,
  valueRatio: 2,
  ...overrides,
});

let eventSeq = 0;
const event = (
  kind: string,
  hoursAgo: number,
  overrides: Partial<UsageEvent> = {}
): UsageEvent => ({
  id: `e${++eventSeq}`,
  t: '',
  tMs: NOW - hoursAgo * HOUR,
  kind,
  authIndex: 'a',
  provider: 'claude',
  model: '',
  sessionKey: '',
  statusCode: null,
  detail: '',
  ...overrides,
});

describe('value', () => {
  test('bands: ≥1× pays off, 0.5–1× partly, below half underused', () => {
    expect(classifyValueRatio(1)).toBe('good');
    expect(classifyValueRatio(8.7)).toBe('good');
    expect(classifyValueRatio(0.5)).toBe('fair');
    expect(classifyValueRatio(0.49)).toBe('poor');
    expect(classifyValueRatio(null)).toBe('none');
    expect(classifyValueRatio(Number.POSITIVE_INFINITY)).toBe('none');
  });

  test('totals are rebuilt from accounts when missing; the ratio ignores accounts without a plan', () => {
    const totals = resolveValueTotals({
      accounts: [
        valueAccount({ apiValueUsd: 100, subscriptionUsdForWindow: 50 }),
        valueAccount({
          authIndex: 'b',
          apiValueUsd: 60,
          subscriptionUsdForWindow: null,
          subscriptionUsdPerMonth: null,
        }),
      ],
      totals: { apiValueUsd: null, subscriptionUsdForWindow: null, valueRatio: null },
    });
    expect(totals).toEqual({ apiValueUsd: 160, subscriptionUsdForWindow: 50, valueRatio: 2 });
    const backend = { apiValueUsd: 1, subscriptionUsdForWindow: 2, valueRatio: 0.5 };
    expect(resolveValueTotals({ accounts: [], totals: backend })).toEqual(backend);
    expect(
      resolveValueTotals({
        accounts: [],
        totals: { apiValueUsd: null, subscriptionUsdForWindow: null, valueRatio: null },
      })
    ).toEqual({
      apiValueUsd: null,
      subscriptionUsdForWindow: null,
      valueRatio: null,
    });
  });

  test('accounts sort by value with unknowns last; missing plans are listed', () => {
    const accounts = [
      valueAccount({ authIndex: 'x', apiValueUsd: null }),
      valueAccount({ authIndex: 'y', apiValueUsd: 5 }),
      valueAccount({
        authIndex: 'z',
        apiValueUsd: 50,
        subscriptionUsdPerMonth: null,
        subscriptionUsdForWindow: null,
      }),
    ];
    expect(sortValueAccounts(accounts).map((account) => account.authIndex)).toEqual([
      'z',
      'y',
      'x',
    ]);
    expect(accountsWithoutPlan(accounts).map((account) => account.authIndex)).toEqual(['z']);
  });
});

describe('cache savings and plan proration', () => {
  test('backend cache totals win; missing ones are summed over the accounts that report them', () => {
    const accounts = [
      valueAccount({ cacheSavingsUsd: 3, noCacheValueUsd: 10 }),
      valueAccount({ authIndex: 'b', cacheSavingsUsd: null, noCacheValueUsd: null }),
      valueAccount({ authIndex: 'c', cacheSavingsUsd: 1.5, noCacheValueUsd: 4 }),
    ];
    const none = { apiValueUsd: null, subscriptionUsdForWindow: null, valueRatio: null };
    expect(resolveCacheTotals({ accounts, totals: none })).toEqual({
      cacheSavingsUsd: 4.5,
      noCacheValueUsd: 14,
    });
    expect(
      resolveCacheTotals({ accounts, totals: { ...none, cacheSavingsUsd: 9, noCacheValueUsd: 20 } })
    ).toEqual({ cacheSavingsUsd: 9, noCacheValueUsd: 20 });
    // An older hub reports neither anywhere.
    expect(resolveCacheTotals({ accounts: [valueAccount()], totals: none })).toEqual({
      cacheSavingsUsd: null,
      noCacheValueUsd: null,
    });
  });

  test('plans prorate over a 30-day month', () => {
    expect(planPerDay(200)).toBeCloseTo(6.6667, 4);
    expect(formatUsd(planPerDay(200), 'en-US')).toBe('$6.67');
    expect(planPerDay(null)).toBeNull();
  });

  test('model rows sum their cache savings; none reported stays null', () => {
    expect(
      aggregateRows([row({ cacheSavingsUsd: 0.5 }), row({ cacheSavingsUsd: 0.25 })]).cacheSavingsUsd
    ).toBe(0.75);
    expect(aggregateRows([row()]).cacheSavingsUsd).toBeNull();
  });
});

describe('model aggregation', () => {
  test('tokens count uncached input, cache reads and writes, and output once', () => {
    expect(rowTokens(row())).toBe(100 + 800 + 100 + 50);
    // Codex input includes cached tokens; the normalized uncached figure avoids double counting.
    expect(rowTokens(row({ inputTokens: 900, uncachedInputTokens: 100 }))).toBe(1050);
  });

  test('totals, hit ratio and value with unpriced traffic flagged', () => {
    const totals = aggregateRows([row(), row({ model: 'm2', apiValueUsd: null })], ['m2']);
    expect(totals.requests).toBe(20);
    expect(totals.cacheHitRatio).toBeCloseTo(1600 / 2000);
    expect(totals.apiValueUsd).toBe(2);
    expect(totals.hasUnpriced).toBe(true);
    expect(aggregateRows([row({ apiValueUsd: null })]).apiValueUsd).toBeNull();
    expect(aggregateRows([]).cacheHitRatio).toBeNull();
  });

  test('per model and per account roll-ups', () => {
    const rows = [
      row({ authIndex: 'a', model: 'opus', apiValueUsd: 5 }),
      row({ authIndex: 'b', model: 'opus', apiValueUsd: 3 }),
      row({ authIndex: 'b', model: 'mini', provider: 'codex', apiValueUsd: null }),
    ];
    const models = aggregateByModel(rows);
    expect(models.map((model) => [model.model, model.apiValueUsd])).toEqual([
      ['opus', 8],
      ['mini', null],
    ]);
    expect(models[0].authIndexes).toEqual(['a', 'b']);
    const accounts = aggregateByAccount(rows);
    expect(accounts[0]).toMatchObject({ authIndex: 'b', models: ['mini', 'opus'] });
    expect(collectUnpricedModels(rows, ['preview'])).toEqual(['mini', 'preview']);
  });

  test('model mix per account, most tokens first', () => {
    const rows = [
      row({ authIndex: 'a', model: 'claude-fable-5-2', outputTokens: 5_000 }),
      row({ authIndex: 'a', model: 'claude-opus-5-5' }),
      row({ authIndex: 'b', model: 'claude-opus-5-5' }),
    ];
    const mix = modelMixByAccount(rows);
    expect(mix.map((account) => account.authIndex)).toEqual(['a', 'b']);
    expect(mix[0].models.map((model) => model.model)).toEqual([
      'claude-fable-5-2',
      'claude-opus-5-5',
    ]);
    expect(mix[0].tokens).toBe(rowTokens(rows[0]) + rowTokens(rows[1]));
  });
});

describe('allocation', () => {
  const item = (
    key: string,
    tokens: number,
    value: number | null = tokens / 10
  ): AllocationItem => ({
    key,
    label: key,
    tokens,
    value,
  });

  test('colours follow the entity: switching measure never repaints a part', () => {
    const items = [item('b', 100, 1), item('a', 10, 50), item('c', 50, null)];
    const byTokens = buildAllocation(items, 'tokens');
    const byValue = buildAllocation(items, 'value');
    const slot = (alloc: typeof byTokens, key: string) =>
      alloc.segments.find((segment) => segment.key === key)?.slot;
    expect(slot(byTokens, 'a')).toBe(slot(byValue, 'a'));
    expect(slot(byTokens, 'b')).toBe(slot(byValue, 'b'));
    expect(byTokens.segments.map((segment) => segment.key)).toEqual(['b', 'c', 'a']);
    // Unpriced counts as zero in the value split and drops out of the bar.
    expect(byValue.segments.map((segment) => segment.key)).toEqual(['a', 'b']);
    expect(byValue.total).toBe(51);
  });

  test('past eight entities the smallest fold into Other instead of cycling hues', () => {
    const items = Array.from({ length: 10 }, (_, index) => item(`k${index}`, 1000 - index * 10));
    const slots = assignAllocationSlots(items);
    expect(slots.size).toBe(7);
    expect(new Set(slots.values()).size).toBe(7);
    const { segments } = buildAllocation(items, 'tokens');
    const other = segments[segments.length - 1];
    expect(other).toMatchObject({ key: OTHER_KEY, slot: null, folded: 3 });
    expect(segments.reduce((sum, segment) => sum + segment.share, 0)).toBeCloseTo(1);
  });

  test('bars can share one colour assignment; entities without a slot fold into Other', () => {
    const shared = assignAllocationSlots([item('a', 100), item('b', 50), item('c', 10)]);
    const account = buildAllocation([item('c', 5), item('z', 5)], 'tokens', 8, shared);
    expect(account.segments.find((segment) => segment.key === 'c')?.slot).toBe(shared.get('c'));
    expect(account.segments.find((segment) => segment.key === OTHER_KEY)?.folded).toBe(1);
  });

  test('nothing to split yields an empty bar', () => {
    expect(buildAllocation([item('a', 0, 0)], 'tokens')).toEqual({ total: 0, segments: [] });
  });
});

describe('health events', () => {
  test('hourly counts win over a truncated event list', () => {
    const report = {
      events: [event('failover', 1)],
      counts: [
        { hour: '', hourMs: NOW - HOUR, kind: 'failover', count: 4 },
        { hour: '', hourMs: NOW - 2 * HOUR, kind: 'rate_limited', count: 3 },
        { hour: '', hourMs: NOW - 2 * HOUR, kind: 'dead_login', count: 1 },
      ],
    };
    expect(countEventsByKind(report).get('failover')).toBe(4);
    expect(summarizeHealth(report)).toEqual({
      failovers: 4,
      rebinds: 0,
      errors: 4,
      rateLimited: 3,
      deadLogins: 1,
    });
    expect(countEventsByKind({ events: [event('rebind', 1)], counts: [] }).get('rebind')).toBe(1);
    expect(summarizeHealth(null).failovers).toBe(0);
  });

  test('kinds keep contract order and newer kinds trail', () => {
    const kinds = orderedEventKinds(['zeta_kind', 'failover']);
    expect(kinds[0]).toBe('rate_limited');
    expect(kinds[kinds.length - 1]).toBe('zeta_kind');
  });

  test('filters by kind and account; accounts ranked by activity', () => {
    const events = [
      event('failover', 1),
      event('rebind', 2, { authIndex: 'b' }),
      event('failover', 3, { authIndex: 'b' }),
    ];
    expect(filterEvents(events, { kinds: new Set(['failover']) })).toHaveLength(2);
    expect(filterEvents(events, { authIndex: 'b' })).toHaveLength(2);
    expect(filterEvents(events, { kinds: new Set(), authIndex: '' })).toHaveLength(3);
    expect(eventAccounts(events)).toEqual(['b', 'a']);
  });

  test('kind × hour matrix ends with the current hour and drops empty kinds', () => {
    const matrix = buildHourlyMatrix({
      counts: [
        { hour: '', hourMs: Date.UTC(2026, 10, 10, 12), kind: 'failover', count: 2 },
        { hour: '', hourMs: Date.UTC(2026, 10, 9, 13), kind: 'failover', count: 1 },
        { hour: '', hourMs: Date.UTC(2026, 10, 8, 12), kind: 'failover', count: 9 },
      ],
      windowMs: 24 * HOUR,
      nowMs: NOW,
      kinds: ['failover', 'rebind'],
    });
    expect(matrix.hours).toHaveLength(24);
    expect(matrix.hours[23]).toBe(Date.UTC(2026, 10, 10, 12));
    expect(matrix.rows.map((r) => r.kind)).toEqual(['failover']);
    expect(matrix.rows[0].cells[23]).toBe(2);
    expect(matrix.rows[0].cells[0]).toBe(1);
    expect(matrix.rows[0].total).toBe(3);
    expect(matrix.max).toBe(2);
    const fromEvents = buildHourlyMatrix({
      events: [event('rebind', 0.2)],
      windowMs: 24 * HOUR,
      nowMs: NOW,
      kinds: ['rebind'],
    });
    expect(fromEvents.rows[0].cells[23]).toBe(1);
  });

  test('heat levels: 1 · 2–3 · 4–9 · 10+', () => {
    expect([0, 1, 2, 3, 4, 9, 10, 50].map(heatLevel)).toEqual([0, 1, 2, 2, 3, 3, 4, 4]);
  });

  test('a dead login is active until the same account recovers after it', () => {
    const events = [
      event('dead_login', 10, { authIndex: 'a' }),
      event('recovered', 5, { authIndex: 'a' }),
      event('dead_login', 3, { authIndex: 'b' }),
      event('recovered', 4, { authIndex: 'b' }),
      event('dead_login', 1, { authIndex: 'c' }),
      event('dead_login', 0.5, { authIndex: '' }),
    ];
    expect(activeDeadLogins(events).map((e) => e.authIndex)).toEqual(['c', 'b']);
  });

  test('move history and day grouping', () => {
    const events = [event('failover', 1), event('rate_limited', 2), event('rebind', 30)];
    expect(moveHistory(events).map((e) => e.kind)).toEqual(['failover', 'rebind']);
    const days = groupEventsByDay(events, (ms) => new Date(ms).toISOString().slice(0, 10));
    expect(days.map((day) => [day.key, day.events.length])).toEqual([
      ['2026-11-10', 2],
      ['2026-11-09', 1],
    ]);
  });
});

describe('formatting and accounts', () => {
  test('money, multiples and shares', () => {
    expect(formatUsd(0.004, 'en-US')).toBe('<$0.01');
    expect(formatUsd(41.2, 'en-US')).toBe('$41.20');
    expect(formatUsd(1234.5, 'en-US')).toBe('$1,235');
    expect(formatUsd(123_456, 'en-US')).toBe('$123.5K');
    expect(formatUsd(null)).toBe('—');
    expect(formatMultiple(4.25, 'en-US')).toBe('4.3×');
    expect(formatMultiple(12.6, 'en-US')).toBe('13×');
    expect(formatMultiple(0.04, 'en-US')).toBe('0.04×');
    expect(formatShare(0.004)).toBe('<1%');
    expect(formatShare(0.456)).toBe('46%');
  });

  test('emails in free text are masked unless revealed; session keys shorten', () => {
    const text = 'refresh failed for alex@example.org: invalid_grant';
    expect(maskEmailsInText(text, false)).toBe('refresh failed for a•••@e•••.org: invalid_grant');
    expect(maskEmailsInText(text, true)).toBe(text);
    expect(shortSessionKey('sess_0123456789abcdef')).toBe('sess_012…');
  });

  test('Claude model ids read as family and version; anything else stays as is', () => {
    expect(modelLabel('claude-fable-5-2')).toBe('Fable 5.2');
    expect(modelLabel('anthropic/claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-haiku-5-5-20260101')).toBe('Haiku 5.5');
    expect(modelLabel('claude-3-5-sonnet-latest')).toBe('claude-3-5-sonnet-latest');
    expect(modelLabel('gpt-6.1-sol')).toBe('gpt-6.1-sol');
    expect(isClaudeModelId('Anthropic/Claude-Sonnet-5-5')).toBe(true);
    expect(isClaudeModelId('gpt-5.1-codex')).toBe(false);
  });

  test('what-if figures list Opus 5.5, then Sonnet 5.5, then anything else', () => {
    expect(
      orderedWhatIf({ 'claude-sonnet-5-5': 1, 'claude-x-9': 3, 'claude-opus-5-5': 2 }).map(
        ([model]) => model
      )
    ).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-x-9']);
  });

  test('account names come from the first source with a label and are masked by default', () => {
    const directory = buildAccountDirectory(
      [{ authIndex: 'a', label: '' }],
      [{ authIndex: 'a', label: 'claude-alex@example.com.json', provider: 'Claude' }]
    );
    expect(directory.get('a')).toEqual({
      authIndex: 'a',
      label: 'claude-alex@example.com.json',
      provider: 'claude',
    });
    expect(accountName('a', directory, false)).toBe('claude-a•••@e•••.com.json');
    expect(accountName('a', directory, true)).toBe('claude-alex@example.com.json');
    expect(accountName('zz', directory, false)).toBe('#zz');
  });
});
