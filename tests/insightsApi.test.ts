/**
 * Hub insight endpoints: normalization of every nullable field, 404 handling, the DEV fixture
 * toggle, and the fixture payloads themselves.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import { isHubFeatureMissing } from '@/services/api/hub';
import {
  computeValueRatio,
  hubInsightsApi,
  normalizeEvents,
  normalizeModelUsage,
  normalizeRunway,
  normalizeSessions,
  normalizeValue,
} from '@/services/api/hubInsights';
import { parseHubFixtureMode, resolveHubFixtureMode } from '@/services/api/hubInsightsFixtureMode';
import { buildHubFixture, FIXTURE_ACCOUNTS } from '@/services/api/hubInsightsFixtures';
import { hubFeatureMissingError, settlePart } from '@/features/insights/hooks/useHubInsight';

const NOW = Date.UTC(2026, 10, 10, 18, 0);

describe('normalizeModelUsage', () => {
  test('reads the contract and keeps a null value as unpriced', () => {
    const report = normalizeModelUsage(
      {
        window: '7d',
        generated_at: '2026-11-10T18:00:00Z',
        rows: [
          {
            auth_index: 3,
            provider: 'Claude',
            model: 'claude-opus-4-6',
            requests: 10,
            input_tokens: 100,
            uncached_input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 800,
            cache_creation_5m_tokens: 60,
            cache_creation_1h_tokens: 40,
            cache_hit_ratio: 0.8,
            api_value_usd: null,
          },
        ],
        unpriced_models: ['claude-opus-4-6', '', 'claude-opus-4-6'],
      },
      '24h'
    );
    expect(report.window).toBe('7d');
    expect(report.rows[0]).toMatchObject({
      authIndex: '3',
      provider: 'claude',
      cacheHitRatio: 0.8,
      apiValueUsd: null,
      cacheCreation5mTokens: 60,
    });
    expect(report.unpricedModels).toEqual(['claude-opus-4-6']);
  });

  test('tolerates junk: missing fields, bad window, non-array rows', () => {
    expect(normalizeModelUsage(null, '30d')).toEqual({
      window: '30d',
      generatedAt: null,
      rows: [],
      unpricedModels: [],
    });
    const report = normalizeModelUsage({
      window: '90d',
      rows: [null, 'x', { model: 'm' }, {}],
    });
    expect(report.window).toBe('24h');
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      model: 'm',
      requests: 0,
      cacheHitRatio: null,
      apiValueUsd: null,
    });
  });

  test('derives the hit ratio when absent and falls back to input when uncached is missing', () => {
    const [row] = normalizeModelUsage({
      rows: [
        { model: 'm', input_tokens: 200, cache_read_tokens: 600, cache_creation_5m_tokens: 200 },
      ],
    }).rows;
    expect(row.uncachedInputTokens).toBe(200);
    expect(row.cacheHitRatio).toBeCloseTo(0.6);
  });
});

describe('normalizeSessions', () => {
  test('keeps every nullable field null and parses timestamps', () => {
    const { sessions } = normalizeSessions({
      sessions: [
        {
          session_key: 'sess_1',
          provider: 'claude',
          client: 'claude-code',
          project: null,
          cwd: '',
          title: null,
          t3_thread_id: null,
          t3_title: '  Fix it  ',
          t3_parent_title: null,
          subagent: 'yes',
          auth_indexes: ['a', 'a', 7, null],
          first_seen: 'not a date',
          last_seen: '2026-11-10T17:00:00Z',
          requests: '12',
          cold_cache_writes: -3,
          api_value_usd: null,
        },
      ],
    });
    expect(sessions[0]).toMatchObject({
      project: null,
      cwd: null,
      title: null,
      t3Title: 'Fix it',
      subagent: false,
      authIndexes: ['a', '7'],
      firstSeen: null,
      firstSeenMs: null,
      lastSeenMs: Date.UTC(2026, 10, 10, 17),
      requests: 12,
      coldCacheWrites: 0,
      apiValueUsd: null,
      cacheHitRatio: null,
    });
  });

  test('drops sessions with no key and no title', () => {
    expect(normalizeSessions({ sessions: [{ requests: 4 }] }).sessions).toEqual([]);
  });
});

describe('normalizeRunway', () => {
  test('reads windows, sorts history and keeps null projections', () => {
    const report = normalizeRunway({
      accounts: [
        {
          auth_index: 'a1',
          provider: 'codex',
          label: 'codex-x@example.com.json',
          windows: [
            {
              key: 'primary_window',
              kind: 'five_hour',
              used_percent: 40,
              resets_at: '2026-11-10T20:00:00Z',
              burn_rate_pct_per_hour: null,
              projected_exhaust_at: null,
              exhausts_before_reset: false,
              history: [
                { t: '2026-11-10T17:00:00Z', used_percent: 30 },
                { t: '2026-11-10T16:00:00Z', used_percent: 10 },
                { t: 'bad', used_percent: 5 },
                { t: '2026-11-10T16:30:00Z', used_percent: null },
              ],
            },
            { kind: 'weekly' },
          ],
          last_cycles: [{ window_key: 'primary_window', reset_at: null, final_used_percent: null }],
        },
      ],
    });
    const [window] = report.accounts[0].windows;
    expect(report.accounts[0].windows).toHaveLength(1);
    expect(window.burnRatePctPerHour).toBeNull();
    expect(window.projectedExhaustAtMs).toBeNull();
    expect(window.history.map((point) => point.usedPercent)).toEqual([10, 30]);
    expect(report.accounts[0].lastCycles[0]).toEqual({
      windowKey: 'primary_window',
      resetAt: null,
      resetAtMs: null,
      finalUsedPercent: null,
    });
  });

  test('infers the kind from the key and derives the flag only when it is missing', () => {
    const report = normalizeRunway({
      accounts: [
        {
          auth_index: 'a',
          windows: [
            {
              key: 'seven_day',
              resets_at: '2026-11-12T00:00:00Z',
              projected_exhaust_at: '2026-11-11T00:00:00Z',
            },
            {
              key: 'five_hour',
              resets_at: '2026-11-12T00:00:00Z',
              projected_exhaust_at: '2026-11-11T00:00:00Z',
              exhausts_before_reset: false,
            },
            { key: 'monthly_bonus' },
          ],
        },
      ],
    });
    const [weekly, fiveHour, other] = report.accounts[0].windows;
    expect(weekly.kind).toBe('weekly');
    expect(weekly.exhaustsBeforeReset).toBe(true);
    expect(fiveHour.kind).toBe('five_hour');
    expect(fiveHour.exhaustsBeforeReset).toBe(false);
    expect(other.kind).toBe('other');
  });
});

describe('normalizeValue and computeValueRatio', () => {
  test('value ratio is API value over plan cost, null without a positive plan', () => {
    expect(computeValueRatio(300, 100)).toBe(3);
    expect(computeValueRatio(0, 100)).toBe(0);
    expect(computeValueRatio(300, 0)).toBeNull();
    expect(computeValueRatio(300, null)).toBeNull();
    expect(computeValueRatio(null, 100)).toBeNull();
    expect(computeValueRatio(Number.NaN, 100)).toBeNull();
  });

  test('backend ratio wins; a missing one is computed; nulls survive', () => {
    const report = normalizeValue(
      {
        window: '30d',
        accounts: [
          {
            auth_index: 'a',
            label: 'claude-a@example.com.json',
            api_value_usd: 50,
            subscription_usd_per_month: 100,
            subscription_usd_for_window: 25,
          },
          {
            auth_index: 'b',
            api_value_usd: 10,
            subscription_usd_per_month: null,
            subscription_usd_for_window: null,
            value_ratio: null,
          },
          {
            auth_index: 'c',
            api_value_usd: 10,
            subscription_usd_for_window: 20,
            value_ratio: 9,
          },
        ],
        totals: { api_value_usd: null, subscription_usd_for_window: 45, value_ratio: null },
        unpriced_models: null,
      },
      '24h'
    );
    expect(report.window).toBe('30d');
    expect(report.accounts.map((account) => account.valueRatio)).toEqual([2, null, 9]);
    expect(report.totals).toEqual({
      apiValueUsd: null,
      subscriptionUsdForWindow: 45,
      valueRatio: null,
    });
    expect(report.unpricedModels).toEqual([]);
  });
});

describe('normalizeEvents', () => {
  test('newest first, unknown kinds kept verbatim, junk dropped', () => {
    const report = normalizeEvents({
      window: '7d',
      events: [
        { t: '2026-11-10T10:00:00Z', kind: 'failover', auth_index: 'a', status_code: 429 },
        { t: '2026-11-10T12:00:00Z', kind: 'Quota_Grant', status_code: 0 },
        { t: 'nope', kind: 'failover' },
        { t: '2026-11-10T11:00:00Z' },
      ],
      counts: [
        { hour: '2026-11-10T12:00:00Z', kind: 'failover', count: 2 },
        { hour: '2026-11-10T10:00:00Z', kind: 'failover', count: '1' },
        { hour: null, kind: 'failover', count: 1 },
      ],
    });
    expect(report.events.map((event) => event.kind)).toEqual(['quota_grant', 'failover']);
    expect(report.events[0].statusCode).toBeNull();
    expect(report.events[1].statusCode).toBe(429);
    expect(report.counts.map((entry) => entry.count)).toEqual([1, 2]);
  });
});

describe('404 handling', () => {
  const originalGet = apiClient.get.bind(apiClient);
  afterEach(() => {
    apiClient.get = originalGet;
  });

  test('a 404 from the hub rejects as "feature missing", and settlePart reports it as missing', async () => {
    apiClient.get = (async () => {
      throw Object.assign(new Error('not found'), { status: 404 });
    }) as typeof apiClient.get;
    const part = await settlePart(hubInsightsApi.getSessions('7d', 50));
    expect(part).toEqual({ data: null, missing: true, error: '' });
    await expect(hubInsightsApi.getRunway()).rejects.toMatchObject({ status: 404 });
  });

  test('other failures are errors, not "missing"', async () => {
    apiClient.get = (async () => {
      throw Object.assign(new Error('boom'), { status: 500 });
    }) as typeof apiClient.get;
    expect(await settlePart(hubInsightsApi.getValue('24h'))).toEqual({
      data: null,
      missing: false,
      error: 'boom',
    });
  });

  test('requests carry the window and a positive limit only', async () => {
    const calls: Array<[string, unknown]> = [];
    apiClient.get = (async (url: string, config?: unknown) => {
      calls.push([url, config]);
      return {};
    }) as typeof apiClient.get;
    await hubInsightsApi.getModelUsage('1h');
    await hubInsightsApi.getSessions('30d', 0);
    await hubInsightsApi.getEvents('7d', 500.7);
    await hubInsightsApi.getRunway();
    expect(calls).toEqual([
      ['/usage/models', { params: { window: '1h' } }],
      ['/usage/sessions', { params: { window: '30d' } }],
      ['/usage/events', { params: { window: '7d', limit: 500 } }],
      ['/usage/runway', undefined],
    ]);
  });

  test('the synthetic error used when every endpoint is missing reads as missing', () => {
    expect(isHubFeatureMissing(hubFeatureMissingError())).toBe(true);
  });
});

describe('DEV fixture toggle', () => {
  test('URL parameter wins over storage, including an explicit off', () => {
    expect(parseHubFixtureMode('1')).toBe('data');
    expect(parseHubFixtureMode('missing')).toBe('missing');
    expect(parseHubFixtureMode('0')).toBeNull();
    expect(resolveHubFixtureMode({ search: '?hub-fixtures=1' })).toBe('data');
    expect(resolveHubFixtureMode({ hash: '#/threads?hub-fixtures=missing' })).toBe('missing');
    expect(resolveHubFixtureMode({ stored: '1' })).toBe('data');
    expect(resolveHubFixtureMode({ search: '?hub-fixtures=0', stored: '1' })).toBeNull();
    expect(resolveHubFixtureMode({})).toBeNull();
  });
});

describe('fixtures', () => {
  test('every endpoint normalizes cleanly and stays within its window and limit', () => {
    const models = normalizeModelUsage(buildHubFixture('/usage/models', { window: '7d' }, NOW));
    const sessions = normalizeSessions(
      buildHubFixture('/usage/sessions', { window: '24h', limit: 3 }, NOW)
    );
    const runway = normalizeRunway(buildHubFixture('/usage/runway', {}, NOW));
    const value = normalizeValue(buildHubFixture('/usage/value', { window: '30d' }, NOW));
    const events = normalizeEvents(buildHubFixture('/usage/events', { window: '24h' }, NOW));
    expect(models.rows.length).toBeGreaterThan(0);
    expect(models.unpricedModels).toContain('gpt-5.2-codex-preview');
    expect(sessions.sessions).toHaveLength(3);
    expect(sessions.sessions.every((s) => (s.lastSeenMs ?? 0) >= NOW - 24 * 3_600_000)).toBe(true);
    expect(runway.accounts).toHaveLength(FIXTURE_ACCOUNTS.length);
    expect(value.totals.valueRatio).not.toBeNull();
    expect(events.events.every((event) => event.tMs > NOW - 24 * 3_600_000)).toBe(true);
    expect(buildHubFixture('/usage/unknown', {}, NOW)).toBeNull();
  });

  test('fixtures only use reserved example domains', () => {
    const text = JSON.stringify(
      ['/usage/models', '/usage/sessions', '/usage/runway', '/usage/value', '/usage/events'].map(
        (path) => buildHubFixture(path, { window: '7d' }, NOW)
      )
    );
    const domains = new Set([...text.matchAll(/@([a-z0-9.-]+\.[a-z]+)/gi)].map((m) => m[1]));
    for (const domain of domains) {
      expect(domain).toMatch(/^example\.(com|org|net)(\.json)?$/);
    }
  });

  test('a given clock always yields the same payload', () => {
    expect(buildHubFixture('/usage/events', { window: '7d' }, NOW)).toEqual(
      buildHubFixture('/usage/events', { window: '7d' }, NOW)
    );
  });
});
