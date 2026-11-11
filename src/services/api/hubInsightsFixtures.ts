/**
 * Sample payloads for the hub insight endpoints, shaped exactly like the backend contract
 * (snake_case, nullable fields, unpriced models). Used by the DEV fixture toggle
 * (`hubInsightsFixtureMode.ts`) and by the unit tests; never bundled into production.
 *
 * Every identity is fictional (`example.com` / `.org` / `.net` addresses, made-up projects and
 * paths). Timestamps are relative to the `nowMs` passed in and the noise comes from a seeded
 * generator, so a given `nowMs` always yields the same data.
 */

import type { HubFixtureMode } from './hubInsightsFixtureMode';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Raw = Record<string, unknown>;

interface FixtureAccount {
  authIndex: string;
  provider: 'claude' | 'codex';
  label: string;
  /** USD per month; null = not configured under hub.subscriptions. */
  plan: number | null;
}

export const FIXTURE_ACCOUNTS: readonly FixtureAccount[] = [
  { authIndex: '1a2b3c4d', provider: 'claude', label: 'claude-alex@example.com.json', plan: 200 },
  { authIndex: '5e6f7a8b', provider: 'claude', label: 'claude-sam@example.org.json', plan: 100 },
  { authIndex: '9c0d1e2f', provider: 'claude', label: 'claude-ops@example.net.json', plan: null },
  { authIndex: '3a4b5c6d', provider: 'codex', label: 'codex-alex@example.com.json', plan: 200 },
  { authIndex: '7e8f9a0b', provider: 'codex', label: 'codex-lee@example.org.json', plan: 20 },
];

const [A1, A2, A3, C1, C2] = FIXTURE_ACCOUNTS.map((account) => account.authIndex);

/**
 * USD per million tokens: input, output, cache read, cache write 5m, cache write 1h. The Claude rows
 * match the hub's built-in prices; the Codex ones stand in for configured `hub.prices`. Null =
 * unpriced (C2's only model is, so that account shows "unpriced").
 */
const PRICES: Record<string, [number, number, number, number, number] | null> = {
  'claude-fable-5-2': [8, 40, 0.2, 10, 16],
  'claude-opus-5-5': [4, 20, 0.2, 5, 8],
  'claude-sonnet-5-5': [2, 10, 0.1, 2.5, 4],
  'gpt-5.1-codex': [1.25, 10, 0.125, 0, 0],
  'gpt-5.1-codex-mini': null,
  'gpt-5.2-codex-preview': null,
};

/** The models `/usage/sessions` re-prices Claude tokens on (`what_if_usd`). */
const WHAT_IF_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'];

/** Daily usage per account and model; [requests, uncached in, out, cache read, 5m write, 1h write] in tokens. */
const DAILY: Array<[string, string, number, number, number, number, number, number]> = [
  [A1, 'claude-fable-5-2', 420, 1_100_000, 900_000, 38_000_000, 2_400_000, 600_000],
  [A1, 'claude-opus-5-5', 160, 400_000, 300_000, 9_000_000, 800_000, 0],
  [A1, 'claude-sonnet-5-5', 90, 300_000, 50_000, 1_200_000, 200_000, 0],
  [A2, 'claude-fable-5-2', 260, 1_600_000, 500_000, 14_000_000, 3_100_000, 200_000],
  [A2, 'claude-opus-5-5', 120, 700_000, 240_000, 5_200_000, 900_000, 0],
  [A3, 'claude-fable-5-2', 40, 900_000, 100_000, 1_000_000, 1_500_000, 0],
  [C1, 'gpt-5.1-codex', 300, 5_000_000, 600_000, 25_000_000, 0, 0],
  [C1, 'gpt-5.2-codex-preview', 35, 900_000, 90_000, 2_100_000, 0, 0],
  [C2, 'gpt-5.1-codex-mini', 80, 1_400_000, 160_000, 3_800_000, 0, 0],
];

const WINDOW_SCALE: Record<string, number> = { '1h': 0.05, '24h': 1, '7d': 6.1, '30d': 24 };
const WINDOW_DAYS: Record<string, number> = { '1h': 1 / 24, '24h': 1, '7d': 7, '30d': 30 };
const WINDOW_MS: Record<string, number> = {
  '1h': HOUR,
  '24h': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
};

const iso = (ms: number) => new Date(ms).toISOString();
const round2 = (value: number) => Math.round(value * 100) / 100;
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** mulberry32: small, fast, deterministic. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function priceRow(
  model: string,
  uncached: number,
  output: number,
  read: number,
  write5m: number,
  write1h: number
): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const [pIn, pOut, pRead, p5m, p1h] = price;
  return round2(
    (uncached * pIn + output * pOut + read * pRead + write5m * p5m + write1h * p1h) / 1_000_000
  );
}

/** Cache reads priced as fresh input minus their cache price. */
function cacheSavings(model: string, read: number): number | null {
  const price = PRICES[model];
  return price ? round4((read * (price[0] - price[2])) / 1_000_000) : null;
}

/** The same traffic with every prompt token at the input rate. */
function noCacheValue(
  model: string,
  uncached: number,
  output: number,
  read: number,
  writes: number
): number | null {
  const price = PRICES[model];
  if (!price) return null;
  return round4(((uncached + read + writes) * price[0] + output * price[1]) / 1_000_000);
}

const hitRatio = (uncached: number, read: number, writes: number) => {
  const denominator = uncached + read + writes;
  return denominator > 0 ? Math.round((read / denominator) * 10_000) / 10_000 : 0;
};

/* ---------------------------------------------------------------------------------------------
 * /usage/models
 * ------------------------------------------------------------------------------------------- */

function modelRows(window: string): Raw[] {
  const scale = WINDOW_SCALE[window] ?? 1;
  return DAILY.map(([authIndex, model, requests, uncached, output, read, w5, w1]) => {
    const account = FIXTURE_ACCOUNTS.find((entry) => entry.authIndex === authIndex);
    const s = (value: number) => Math.round(value * scale);
    const isCodex = account?.provider === 'codex';
    return {
      auth_index: authIndex,
      provider: account?.provider ?? 'claude',
      model,
      requests: s(requests),
      // Codex reports input including cached tokens; Claude excludes them.
      input_tokens: isCodex ? s(uncached + read) : s(uncached),
      uncached_input_tokens: s(uncached),
      output_tokens: s(output),
      cache_read_tokens: s(read),
      cache_creation_5m_tokens: s(w5),
      cache_creation_1h_tokens: s(w1),
      cache_hit_ratio: hitRatio(uncached, read, w5 + w1),
      api_value_usd: priceRow(model, s(uncached), s(output), s(read), s(w5), s(w1)),
      cache_savings_usd: cacheSavings(model, s(read)),
    };
  });
}

const unpricedModels = () =>
  Object.entries(PRICES)
    .filter(([, price]) => price === null)
    .map(([model]) => model);

/* ---------------------------------------------------------------------------------------------
 * /usage/value
 * ------------------------------------------------------------------------------------------- */

function valuePayload(window: string, nowMs: number): Raw {
  const rows = modelRows(window);
  const days = WINDOW_DAYS[window] ?? 1;
  let totalValue = 0;
  let totalSubscription = 0;
  let totalSavings = 0;
  let totalNoCache = 0;
  let anyUnpriced = false;
  const accounts = FIXTURE_ACCOUNTS.map((account) => {
    const own = rows.filter((row) => row.auth_index === account.authIndex);
    const priced = own.filter((row) => row.api_value_usd !== null);
    const unpriced = own.length > priced.length;
    const add = (pick: (row: Raw) => number) =>
      round2(priced.reduce((sum, row) => sum + pick(row), 0));
    // Entirely unpriced traffic has no value at all (null), not $0.
    const hasValue = priced.length > 0 || own.length === 0;
    const apiValue = hasValue ? add((row) => row.api_value_usd as number) : null;
    const savings = hasValue ? add((row) => row.cache_savings_usd as number) : null;
    const noCache = hasValue
      ? add(
          (row) =>
            noCacheValue(
              row.model as string,
              row.uncached_input_tokens as number,
              row.output_tokens as number,
              row.cache_read_tokens as number,
              (row.cache_creation_5m_tokens as number) + (row.cache_creation_1h_tokens as number)
            ) ?? 0
        )
      : null;
    const forWindow = account.plan === null ? null : round2((account.plan * days) / 30);
    totalValue += apiValue ?? 0;
    totalSavings += savings ?? 0;
    totalNoCache += noCache ?? 0;
    anyUnpriced = anyUnpriced || unpriced;
    if (forWindow !== null) totalSubscription += forWindow;
    return {
      auth_index: account.authIndex,
      provider: account.provider,
      label: account.label,
      requests: own.reduce((sum, row) => sum + (row.requests as number), 0),
      api_value_usd: apiValue,
      has_unpriced_usage: unpriced,
      cache_savings_usd: savings,
      no_cache_value_usd: noCache,
      subscription_usd_per_month: account.plan,
      subscription_usd_for_window: forWindow,
      value_ratio:
        forWindow && apiValue !== null ? Math.round((apiValue / forWindow) * 100) / 100 : null,
    };
  });
  return {
    window,
    generated_at: iso(nowMs),
    accounts,
    totals: {
      api_value_usd: round2(totalValue),
      cache_savings_usd: round2(totalSavings),
      no_cache_value_usd: round2(totalNoCache),
      has_unpriced_usage: anyUnpriced,
      subscription_usd_for_window: round2(totalSubscription),
      value_ratio:
        totalSubscription > 0 ? Math.round((totalValue / totalSubscription) * 100) / 100 : null,
    },
    unpriced_models: unpricedModels(),
  };
}

/* ---------------------------------------------------------------------------------------------
 * /usage/sessions
 * ------------------------------------------------------------------------------------------- */

interface SessionSeed {
  key: string;
  provider: string;
  client: string;
  project: string | null;
  title: string | null;
  t3Id: string | null;
  t3Title: string | null;
  t3Parent: string | null;
  /** The T3 export's subagent flag (null when no T3 thread matched). */
  subagent: boolean | null;
  auth: string[];
  /** Hours ago: first seen, last seen. */
  first: number;
  last: number;
  requests: number;
  /** Claude: uncached input; Codex: input including cached tokens (as each provider reports). */
  input: number;
  output: number;
  read: number;
  write: number;
  cold: number;
  /** Share of the session's usage per model; defaults to one model per provider. */
  mix?: Array<[string, number]>;
}

const T3_RUNWAY = 't3-7f3a91c2';
const T3_DST = 't3-2b8e44d0';
const T3_429 = 't3-c4d19e77';

// Native session ids (made up). `…:agent:<id>` keys share their parent's.
const N_RUNWAY = '7f3a91c2-0b1d-4e5f-8a9b-1c2d3e4f5a6b';
const N_POLLER = '9b7d3a10-4c2e-4f6a-8b1c-2d3e4f5a6b7c';
const N_DST = '01a1c6f6-0664-7130-8a1b-2c3d4e5f6a7b';
const N_TTL = '5e0c2b7a-9d1f-4a3b-8c6d-7e8f9a0b1c2d';
const nid = (n: number) =>
  `0b5e${String(n).padStart(4, '0')}-1a2b-4c3d-8e4f-${String(n).padStart(12, '0')}`;

const FABLE = 'claude-fable-5-2';
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

// prettier-ignore
const SESSION_SEEDS: SessionSeed[] = [
  // Busy parent: two T3 subagent threads (by parent title), plus three Claude Code subagents whose
  // `:agent:` keys share the parent's session id and T3 thread.
  { key: `claude:${N_RUNWAY}`, provider: 'claude', client: 'claude-code', project: 'web-dashboard', title: 'Runway chart', t3Id: T3_RUNWAY, t3Title: 'Wire up the runway page', t3Parent: null, subagent: false, auth: [A1], first: 9, last: 0.2, requests: 184, input: 420_000, output: 380_000, read: 16_800_000, write: 1_100_000, cold: 2, mix: [[FABLE, 0.85], [OPUS, 0.15]] },
  { key: `claude:${N_RUNWAY}:agent:a4f0aa401b88ca320`, provider: 'claude', client: 'claude-code', project: 'web-dashboard', title: 'Runway chart', t3Id: T3_RUNWAY, t3Title: 'Wire up the runway page', t3Parent: null, subagent: false, auth: [A1], first: 6, last: 5.6, requests: 22, input: 40_000, output: 18_000, read: 2_400_000, write: 120_000, cold: 1, mix: [[SONNET, 1]] },
  { key: `claude:${N_RUNWAY}:agent:a93caed17f75b8b58`, provider: 'claude', client: 'claude-code', project: 'web-dashboard', title: 'Runway chart', t3Id: T3_RUNWAY, t3Title: 'Wire up the runway page', t3Parent: null, subagent: false, auth: [A1], first: 3, last: 2.7, requests: 17, input: 30_000, output: 12_000, read: 1_700_000, write: 90_000, cold: 1, mix: [[SONNET, 1]] },
  { key: `claude:${N_RUNWAY}:agent:ac19c107701275658`, provider: 'claude', client: 'claude-code', project: 'web-dashboard', title: 'Runway chart', t3Id: T3_RUNWAY, t3Title: 'Wire up the runway page', t3Parent: null, subagent: false, auth: [A1], first: 1.5, last: 1.1, requests: 9, input: 30_000, output: 28_000, read: 420_000, write: 90_000, cold: 1, mix: [[FABLE, 1]] },
  { key: `claude:${nid(1)}`, provider: 'claude', client: 'claude-code', project: 'web-dashboard', title: 'Explore: chart helpers', t3Id: null, t3Title: null, t3Parent: 'Wire up the runway page', subagent: true, auth: [A1], first: 6, last: 5.5, requests: 22, input: 80_000, output: 30_000, read: 1_200_000, write: 240_000, cold: 1, mix: [[SONNET, 1]] },
  { key: `claude:${nid(2)}`, provider: 'claude', client: 'claude-code', project: 'web-dashboard', title: 'Review: runway copy', t3Id: null, t3Title: 'Wire up the runway page', t3Parent: 'Wire up the runway page', subagent: true, auth: [A2], first: 3, last: 2.6, requests: 14, input: 60_000, output: 22_000, read: 700_000, write: 180_000, cold: 1, mix: [[OPUS, 1]] },
  // No T3 mapping at all: the subagents still nest under their parent by native session id.
  { key: `claude:${N_POLLER}`, provider: 'claude', client: 'claude-code', project: 'proxy-core', title: 'Refactor quota poller', t3Id: null, t3Title: null, t3Parent: null, subagent: null, auth: [A2], first: 5, last: 0.6, requests: 72, input: 160_000, output: 210_000, read: 6_100_000, write: 420_000, cold: 1, mix: [[FABLE, 1]] },
  { key: `claude:${N_POLLER}:agent:a155b24db9ffa04c8`, provider: 'claude', client: 'claude-code', project: 'proxy-core', title: 'Refactor quota poller', t3Id: null, t3Title: null, t3Parent: null, subagent: null, auth: [A2], first: 4, last: 3.8, requests: 19, input: 25_000, output: 11_000, read: 1_300_000, write: 70_000, cold: 0, mix: [[FABLE, 1]] },
  { key: `claude:${N_POLLER}:agent:a0e101c433a2abaed`, provider: 'claude', client: 'claude-code', project: 'proxy-core', title: 'Refactor quota poller', t3Id: null, t3Title: null, t3Parent: null, subagent: null, auth: [A2], first: 2, last: 1.7, requests: 11, input: 20_000, output: 9_000, read: 640_000, write: 60_000, cold: 0, mix: [[SONNET, 1]] },
  // One T3 thread, two sessions on different providers: merged into one row; a Codex subagent nests.
  { key: `codex:${N_DST}`, provider: 'codex', client: 'codex', project: 'web-dashboard', title: null, t3Id: T3_DST, t3Title: 'Fix flaky DST test', t3Parent: null, subagent: false, auth: [C1], first: 4, last: 2, requests: 46, input: 2_300_000, output: 90_000, read: 1_900_000, write: 0, cold: 0 },
  { key: `codex:${N_DST}:agent:review_patch`, provider: 'codex', client: 'codex', project: 'web-dashboard', title: null, t3Id: T3_DST, t3Title: 'Fix flaky DST test', t3Parent: null, subagent: false, auth: [C1], first: 3, last: 2.5, requests: 12, input: 600_000, output: 20_000, read: 480_000, write: 0, cold: 0 },
  { key: `claude:${nid(3)}`, provider: 'claude', client: 'claude-code', project: 'web-dashboard', title: 'DST fixture', t3Id: T3_DST, t3Title: 'Fix flaky DST test', t3Parent: null, subagent: false, auth: [A2], first: 2, last: 1.4, requests: 31, input: 90_000, output: 60_000, read: 2_400_000, write: 160_000, cold: 1, mix: [[OPUS, 1]] },
  // Hopping between accounts: low hit ratio and many cold writes.
  { key: `claude:${nid(4)}`, provider: 'claude', client: 'claude-code', project: 'proxy-core', title: 'Rate limit storm', t3Id: T3_429, t3Title: 'Investigate 429 storms', t3Parent: null, subagent: false, auth: [A2, A3], first: 20, last: 3, requests: 96, input: 2_900_000, output: 210_000, read: 1_700_000, write: 2_600_000, cold: 14 },
  { key: `claude:${nid(5)}`, provider: 'claude', client: 'claude-code', project: 'proxy-core', title: 'Explore: request logs', t3Id: null, t3Title: null, t3Parent: 'Investigate 429 storms', subagent: true, auth: [A3], first: 18, last: 17.5, requests: 12, input: 300_000, output: 20_000, read: 120_000, write: 260_000, cold: 4, mix: [[SONNET, 1]] },
  { key: `claude:${nid(6)}`, provider: 'claude', client: 'claude-code', project: 'proxy-core', title: 'Pricing table', t3Id: 't3-91aa02fe', t3Title: 'Draft pricing config', t3Parent: null, subagent: false, auth: [A1], first: 7, last: 5, requests: 58, input: 120_000, output: 140_000, read: 5_200_000, write: 300_000, cold: 1, mix: [[OPUS, 1]] },
  { key: `claude:${nid(7)}`, provider: 'claude', client: 'claude-code', project: 'proxy-core', title: null, t3Id: 't3-0d77c3b1', t3Title: 'Tune session affinity', t3Parent: null, subagent: false, auth: [A2], first: 30, last: 26, requests: 18, input: 260_000, output: 40_000, read: 900_000, write: 520_000, cold: 6 },
  { key: `codex:${nid(8)}`, provider: 'codex', client: 'codex', project: 'web-dashboard', title: null, t3Id: 't3-55e0f4a9', t3Title: 'Migrate auth store to zustand', t3Parent: null, subagent: false, auth: [C2], first: 28, last: 23, requests: 64, input: 3_100_000, output: 120_000, read: 2_500_000, write: 0, cold: 0, mix: [['gpt-5.1-codex-mini', 1]] },
  // No T3 title: falls back to the session title, then the project, then the session key.
  { key: `claude:${nid(9)}`, provider: 'claude', client: 'claude-code', project: 'docs-site', title: 'Summarize release notes', t3Id: null, t3Title: null, t3Parent: null, subagent: null, auth: [A3], first: 31, last: 30, requests: 11, input: 140_000, output: 30_000, read: 380_000, write: 90_000, cold: 1 },
  { key: `codex:${nid(10)}`, provider: 'codex', client: 'codex', project: 'billing-service', title: null, t3Id: null, t3Title: null, t3Parent: null, subagent: null, auth: [C1], first: 74, last: 72, requests: 27, input: 1_200_000, output: 50_000, read: 900_000, write: 0, cold: 0 },
  { key: 'sess_9f8e7d6c5b4a3210', provider: 'claude', client: 'other', project: null, title: null, t3Id: null, t3Title: null, t3Parent: null, subagent: null, auth: [A1], first: 98, last: 97, requests: 6, input: 40_000, output: 8_000, read: 90_000, write: 60_000, cold: 1 },
  { key: `claude:${nid(11)}`, provider: 'claude', client: 'claude-code', project: 'web-dashboard', title: 'Meters', t3Id: 't3-a3c5e7f9', t3Title: 'Refactor quota meters', t3Parent: null, subagent: false, auth: [A1, A2], first: 60, last: 49, requests: 212, input: 380_000, output: 520_000, read: 21_000_000, write: 1_400_000, cold: 3, mix: [[FABLE, 0.7], [SONNET, 0.3]] },
  // Subagents whose parent is outside the window: grouped under a stand-in parent row.
  { key: `claude:${nid(12)}`, provider: 'claude', client: 'claude-code', project: 'docs-site', title: 'Research: competitor notes', t3Id: null, t3Title: null, t3Parent: 'Plan the Q3 roadmap', subagent: true, auth: [A2], first: 146, last: 144, requests: 16, input: 210_000, output: 40_000, read: 600_000, write: 150_000, cold: 2, mix: [[SONNET, 1]] },
  { key: `claude:${nid(13)}`, provider: 'claude', client: 'claude-code', project: 'docs-site', title: 'Draft: milestone list', t3Id: null, t3Title: null, t3Parent: 'Plan the Q3 roadmap', subagent: true, auth: [A2], first: 143, last: 141, requests: 8, input: 90_000, output: 30_000, read: 310_000, write: 70_000, cold: 1 },
  { key: `claude:${N_TTL}:agent:a7d57e89650ad8068`, provider: 'claude', client: 'claude-code', project: 'proxy-core', title: 'Audit cache TTLs', t3Id: null, t3Title: null, t3Parent: null, subagent: null, auth: [A1], first: 40, last: 38, requests: 14, input: 30_000, output: 10_000, read: 900_000, write: 80_000, cold: 0, mix: [[SONNET, 1]] },
  { key: `claude:${N_TTL}:agent:af93a0aa810abb891`, provider: 'claude', client: 'claude-code', project: 'proxy-core', title: 'Audit cache TTLs', t3Id: null, t3Title: null, t3Parent: null, subagent: null, auth: [A1], first: 39, last: 37, requests: 10, input: 20_000, output: 8_000, read: 610_000, write: 50_000, cold: 0, mix: [[SONNET, 1]] },
  { key: `claude:${nid(14)}`, provider: 'claude', client: 'claude-code', project: 'docs-site', title: null, t3Id: 't3-6b2d8f10', t3Title: 'Write onboarding guide', t3Parent: null, subagent: false, auth: [A3], first: 122, last: 118, requests: 41, input: 150_000, output: 160_000, read: 2_900_000, write: 210_000, cold: 2 },
  { key: `codex:${nid(15)}`, provider: 'codex', client: 'codex', project: 'proxy-core', title: null, t3Id: 't3-e8f1a2b3', t3Title: 'Try the preview codex model', t3Parent: null, subagent: false, auth: [C1], first: 50, last: 46, requests: 35, input: 3_000_000, output: 90_000, read: 2_100_000, write: 0, cold: 0, mix: [['gpt-5.2-codex-preview', 1]] },
  // Older than a week: only in the 30d window.
  { key: `claude:${nid(16)}`, provider: 'claude', client: 'claude-code', project: 'billing-service', title: null, t3Id: 't3-0a0b0c0d', t3Title: 'Port invoices to v2 API', t3Parent: null, subagent: false, auth: [A1], first: 300, last: 290, requests: 140, input: 300_000, output: 330_000, read: 12_000_000, write: 900_000, cold: 4, mix: [[OPUS, 1]] },
  { key: `codex:${nid(17)}`, provider: 'codex', client: 'codex', project: 'proxy-core', title: null, t3Id: 't3-1e2f3a4b', t3Title: 'Remove legacy v0 routes', t3Parent: null, subagent: false, auth: [C1], first: 480, last: 470, requests: 52, input: 2_200_000, output: 70_000, read: 1_600_000, write: 0, cold: 0 },
];

/** The session's native id as the backend derives it from a `claude:` / `codex:` key. */
function nativeIdOf(key: string): string | null {
  const [prefix, id] = key.split(':');
  return (prefix === 'claude' || prefix === 'codex') && id && /^[0-9a-f-]{8,}$/.test(id)
    ? id
    : null;
}

/** Per-model rows, the session's value and its Claude tokens re-priced on the what-if models. */
function sessionModels(seed: SessionSeed) {
  const mix = seed.mix ?? [[seed.provider === 'codex' ? 'gpt-5.1-codex' : FABLE, 1]];
  const whatIf: Record<string, number> = {};
  let value: number | null = null;
  let claude = false;
  const models = mix.map(([model, share]) => {
    const part = (amount: number) => Math.round(amount * share);
    const [input, output, read, write] = [seed.input, seed.output, seed.read, seed.write].map(part);
    // Codex input already includes the cached tokens; price only the uncached part.
    const uncached = seed.provider === 'codex' ? Math.max(0, input - read) : input;
    const modelValue = priceRow(model, uncached, output, read, write, 0);
    if (modelValue !== null) value = round2((value ?? 0) + modelValue);
    if (model.startsWith('claude')) {
      claude = true;
      WHAT_IF_MODELS.forEach((target) => {
        whatIf[target] = round2(
          (whatIf[target] ?? 0) + (priceRow(target, uncached, output, read, write, 0) ?? 0)
        );
      });
    }
    return {
      model,
      requests: part(seed.requests),
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: read,
      cache_creation_tokens: write,
      api_value_usd: modelValue,
    };
  });
  return { models, value, whatIf: claude ? whatIf : null };
}

function sessionsPayload(window: string, limit: number | null, nowMs: number): Raw {
  const span = WINDOW_MS[window] ?? DAY;
  const sessions = SESSION_SEEDS.filter((seed) => seed.last * HOUR <= span)
    .sort((a, b) => a.last - b.last)
    .slice(0, limit ?? undefined)
    .map((seed) => {
      const split = sessionModels(seed);
      return {
        session_key: seed.key,
        native_session_id: nativeIdOf(seed.key),
        provider: seed.provider,
        client: seed.client,
        project: seed.project,
        cwd: seed.project ? `/home/dev/src/${seed.project}` : null,
        title: seed.title,
        t3_thread_id: seed.t3Id,
        t3_title: seed.t3Title,
        t3_parent_title: seed.t3Parent,
        subagent: seed.subagent,
        auth_indexes: seed.auth,
        first_seen: iso(nowMs - seed.first * HOUR),
        last_seen: iso(nowMs - seed.last * HOUR),
        requests: seed.requests,
        input_tokens: seed.input,
        output_tokens: seed.output,
        cache_read_tokens: seed.read,
        cache_creation_tokens: seed.write,
        cache_hit_ratio: hitRatio(seed.input, seed.read, seed.write),
        cold_cache_writes: seed.cold,
        api_value_usd: split.value,
        models: split.models,
        what_if_usd: split.whatIf,
      };
    });
  return { window, generated_at: iso(nowMs), sessions };
}

/* ---------------------------------------------------------------------------------------------
 * /usage/runway
 * ------------------------------------------------------------------------------------------- */

interface WindowSeed {
  key: string;
  kind: 'five_hour' | 'weekly';
  /** Model family of a model-specific window ("fable" on seven_day_fable). */
  model?: string;
  used: number;
  burn: number | null;
  /** Hours until reset; null = no reset pending. */
  resetIn: number | null;
  /** Final used % of the previous cycle; null = no completed cycle yet. */
  lastFinal: number | null;
  /**
   * Still learning its pace (too little history in this cycle): hours until it should have
   * enough. The history then only covers the last `historyHours`, starting at `historyFrom` %.
   */
  learnIn?: number;
  historyHours?: number;
  historyFrom?: number;
}

// prettier-ignore
const RUNWAY_SEEDS: Record<string, WindowSeed[]> = {
  [A1]: [
    { key: 'five_hour', kind: 'five_hour', used: 62, burn: 14, resetIn: 2.5, lastFinal: 41 },
    { key: 'seven_day', kind: 'weekly', used: 71, burn: 1.1, resetIn: 40, lastFinal: 88 },
    { key: 'seven_day_fable', kind: 'weekly', model: 'fable', used: 58, burn: 0.9, resetIn: 40, lastFinal: 74 },
  ],
  // Just after a hub start: 20 minutes of samples, so nothing is projected yet.
  [A2]: [
    { key: 'five_hour', kind: 'five_hour', used: 18, burn: null, resetIn: 4, lastFinal: null, learnIn: 0.67, historyHours: 0.33, historyFrom: 9 },
    { key: 'seven_day', kind: 'weekly', used: 44, burn: null, resetIn: 77, lastFinal: null, learnIn: 2.67, historyHours: 0.33, historyFrom: 42 },
    { key: 'seven_day_fable', kind: 'weekly', model: 'fable', used: 21, burn: null, resetIn: 77, lastFinal: null, learnIn: 2.67, historyHours: 0.33, historyFrom: 17 },
  ],
  // An Ultra plan: weekly limits only, no 5-hour window.
  [A3]: [
    { key: 'seven_day', kind: 'weekly', used: 12, burn: 0.1, resetIn: 132, lastFinal: 23 },
    { key: 'seven_day_fable', kind: 'weekly', model: 'fable', used: 30, burn: 0.4, resetIn: 132, lastFinal: 41 },
  ],
  [C1]: [
    { key: 'primary_window', kind: 'five_hour', used: 88, burn: 20, resetIn: 1.5, lastFinal: 97 },
    { key: 'secondary_window', kind: 'weekly', used: 54, burn: 0.6, resetIn: 48, lastFinal: 78 },
  ],
  [C2]: [
    { key: 'primary_window', kind: 'five_hour', used: 100, burn: 9, resetIn: 0.8, lastFinal: 100 },
    { key: 'secondary_window', kind: 'weekly', used: 97, burn: 0.9, resetIn: 96, lastFinal: 61 },
  ],
};

function runwayWindow(seed: WindowSeed, nowMs: number, random: () => number): Raw {
  const span = seed.kind === 'five_hour' ? 5 * HOUR : 7 * DAY;
  const learning = seed.learnIn !== undefined;
  const resetsAt = seed.resetIn === null ? null : nowMs + seed.resetIn * HOUR;
  const cycleStart = resetsAt === null ? nowMs - span : resetsAt - span;
  const start =
    seed.historyHours !== undefined
      ? Math.max(cycleStart, nowMs - seed.historyHours * HOUR)
      : cycleStart;
  const step =
    seed.historyHours !== undefined
      ? 5 * MINUTE
      : seed.kind === 'five_hour'
        ? 15 * MINUTE
        : 6 * HOUR;
  const from = seed.historyFrom ?? 0;
  const history: Raw[] = [];
  if (seed.used > 0) {
    const points = Math.max(2, Math.floor((nowMs - start) / step));
    for (let i = 0; i <= points; i++) {
      const fraction = i / points;
      // Usage builds unevenly: an eased curve plus a little noise, never decreasing.
      const eased = Math.pow(fraction, 1.3);
      const noise = i === points || i === 0 ? 0 : (random() - 0.5) * (learning ? 1 : 4);
      const value = Math.max(0, Math.min(seed.used, from + (seed.used - from) * eased + noise));
      const previous = history.length ? (history[history.length - 1].used_percent as number) : 0;
      history.push({
        t: iso(start + fraction * (nowMs - start)),
        used_percent: Math.round(Math.max(previous, value) * 10) / 10,
      });
    }
  }
  const remaining = 100 - seed.used;
  const exhaustAt =
    !learning && seed.burn && seed.burn > 0 && remaining > 0
      ? nowMs + (remaining / seed.burn) * HOUR
      : null;
  return {
    key: seed.key,
    kind: seed.kind,
    model: seed.model ?? null,
    used_percent: seed.used,
    resets_at: resetsAt === null ? null : iso(resetsAt),
    observed_at: iso(nowMs),
    burn_rate_pct_per_hour: learning ? null : seed.burn,
    projected_exhaust_at: exhaustAt === null ? null : iso(exhaustAt),
    exhausts_before_reset:
      seed.used >= 100 || (exhaustAt !== null && resetsAt !== null && exhaustAt < resetsAt),
    projection_status: learning ? 'learning' : seed.burn && seed.burn > 0 ? 'ok' : 'idle',
    learning_until: learning ? iso(nowMs + (seed.learnIn as number) * HOUR) : null,
    history,
  };
}

function runwayPayload(nowMs: number): Raw {
  const random = seeded(17);
  return {
    generated_at: iso(nowMs),
    accounts: FIXTURE_ACCOUNTS.map((account) => {
      const seeds = RUNWAY_SEEDS[account.authIndex] ?? [];
      return {
        auth_index: account.authIndex,
        provider: account.provider,
        label: account.label,
        windows: seeds.map((seed) => runwayWindow(seed, nowMs, random)),
        last_cycles: seeds
          .filter((seed) => seed.lastFinal !== null && seed.resetIn !== null)
          .map((seed) => ({
            window_key: seed.key,
            reset_at: iso(
              nowMs +
                (seed.resetIn as number) * HOUR -
                (seed.kind === 'five_hour' ? 5 * HOUR : 7 * DAY)
            ),
            final_used_percent: seed.lastFinal,
          })),
      };
    }),
  };
}

/* ---------------------------------------------------------------------------------------------
 * /usage/events
 * ------------------------------------------------------------------------------------------- */

const EVENT_DETAILS: Record<string, { detail: string; status: number | null }[]> = {
  rate_limited: [
    { detail: '429 from upstream; retry-after 32s', status: 429 },
    { detail: '429 rate_limit_error: weekly limit reached', status: 429 },
  ],
  transient_error: [
    { detail: 'upstream 529 overloaded_error', status: 529 },
    { detail: 'upstream 500 internal error', status: 500 },
  ],
  network_error: [{ detail: 'read tcp: connection reset by peer', status: null }],
  failover: [
    { detail: 'retried on next account after 429', status: 429 },
    { detail: 'retried on next account after 529', status: 529 },
  ],
  rebind: [{ detail: 'session moved to a fresh account after cooldown', status: null }],
  cooldown: [{ detail: 'cooling down 60s after 3 consecutive 429s', status: 429 }],
  recovered: [{ detail: 'login refreshed; serving again', status: null }],
  hub_start: [{ detail: 'hub started', status: null }],
};

const SESSION_KEYS_FOR_EVENTS = [
  `claude:${N_RUNWAY}`,
  `claude:${nid(4)}`,
  `codex:${N_DST}`,
  `claude:${nid(6)}`,
];

interface EventDraft {
  t: number;
  kind: string;
  auth: string;
  provider: string;
  model: string;
  session: string;
  status: number | null;
  detail: string;
}

function eventsDrafts(nowMs: number): EventDraft[] {
  const random = seeded(42);
  const drafts: EventDraft[] = [];
  const hourNow = Math.floor(nowMs / HOUR) * HOUR;
  const pickAccount = () => FIXTURE_ACCOUNTS[Math.floor(random() * FIXTURE_ACCOUNTS.length)];
  const modelFor = (provider: string) =>
    provider === 'codex'
      ? 'gpt-5.1-codex'
      : random() < 0.7
        ? 'claude-fable-5-2'
        : 'claude-opus-5-5';
  const push = (
    t: number,
    kind: string,
    account: FixtureAccount,
    override?: Partial<EventDraft>
  ) => {
    const options = EVENT_DETAILS[kind] ?? [{ detail: '', status: null }];
    const choice = options[Math.floor(random() * options.length)];
    drafts.push({
      t,
      kind,
      auth: account.authIndex,
      provider: account.provider,
      model: kind === 'hub_start' ? '' : modelFor(account.provider),
      session:
        kind === 'hub_start'
          ? ''
          : SESSION_KEYS_FOR_EVENTS[Math.floor(random() * SESSION_KEYS_FOR_EVENTS.length)],
      status: choice.status,
      detail: choice.detail,
      ...override,
    });
  };

  for (let h = 7 * 24 - 1; h >= 0; h--) {
    const hourStart = hourNow - h * HOUR;
    // Busier during the working day of the fixture's own clock.
    const busy = new Date(hourStart).getUTCHours() >= 14 && new Date(hourStart).getUTCHours() <= 23;
    const storm = h >= 18 && h <= 21;
    const rateLimited = storm ? 3 + Math.floor(random() * 4) : busy && random() < 0.35 ? 1 : 0;
    for (let i = 0; i < rateLimited; i++) {
      const account = storm ? FIXTURE_ACCOUNTS[1] : pickAccount();
      const t = hourStart + Math.floor(random() * 50) * MINUTE;
      push(t, 'rate_limited', account);
      if (random() < 0.8) push(t + 2_000, 'failover', account);
      if (storm && i === 2) push(t + 60_000, 'cooldown', account);
    }
    if (busy && random() < 0.18)
      push(hourStart + Math.floor(random() * 55) * MINUTE, 'transient_error', pickAccount());
    if (random() < 0.04)
      push(hourStart + Math.floor(random() * 55) * MINUTE, 'network_error', pickAccount());
    if (storm && random() < 0.6) push(hourStart + 40 * MINUTE, 'rebind', FIXTURE_ACCOUNTS[2]);
  }

  const at = (hoursAgo: number) => nowMs - hoursAgo * HOUR;
  const ops = FIXTURE_ACCOUNTS[2];
  const lee = FIXTURE_ACCOUNTS[4];
  push(at(52), 'dead_login', ops, {
    status: 401,
    detail: 'refresh token rejected (invalid_grant)',
    model: '',
    session: '',
  });
  push(at(47), 'recovered', ops, { model: '', session: '' });
  push(at(9.2), 'dead_login', lee, {
    status: 401,
    detail: 'refresh failed for codex-lee@example.org: invalid_grant',
    model: '',
    session: '',
  });
  push(at(75), 'hub_start', FIXTURE_ACCOUNTS[0], { auth: '', provider: '' });
  push(at(20.5), 'hub_start', FIXTURE_ACCOUNTS[0], { auth: '', provider: '' });
  return drafts.filter((draft) => draft.t <= nowMs).sort((a, b) => b.t - a.t);
}

function eventsPayload(window: string, limit: number | null, nowMs: number): Raw {
  const span = WINDOW_MS[window] ?? DAY;
  const inWindow = eventsDrafts(nowMs).filter((draft) => draft.t > nowMs - span);
  const counts = new Map<string, { hour: number; kind: string; count: number }>();
  inWindow.forEach((draft) => {
    const hour = Math.floor(draft.t / HOUR) * HOUR;
    const key = `${hour}:${draft.kind}`;
    const entry = counts.get(key) ?? { hour, kind: draft.kind, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  });
  return {
    window,
    generated_at: iso(nowMs),
    events: inWindow.slice(0, limit ?? undefined).map((draft) => ({
      t: iso(draft.t),
      kind: draft.kind,
      auth_index: draft.auth,
      provider: draft.provider,
      model: draft.model,
      session_key: draft.session,
      status_code: draft.status,
      detail: draft.detail,
    })),
    counts: [...counts.values()]
      .sort((a, b) => a.hour - b.hour || a.kind.localeCompare(b.kind))
      .map((entry) => ({ hour: iso(entry.hour), kind: entry.kind, count: entry.count })),
  };
}

/* ---------------------------------------------------------------------------------------------
 * Entry points
 * ------------------------------------------------------------------------------------------- */

type FixtureParams = Record<string, string | number | undefined>;

const readLimit = (params: FixtureParams): number | null => {
  const limit = Number(params.limit);
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
};

/** Raw payload for one endpoint, or null for a path this fixture set does not cover. */
export function buildHubFixture(path: string, params: FixtureParams, nowMs: number): Raw | null {
  const window = String(params.window ?? '24h');
  switch (path) {
    case '/usage/models':
      return {
        window,
        generated_at: iso(nowMs),
        rows: modelRows(window),
        unpriced_models: unpricedModels(),
      };
    case '/usage/sessions':
      return sessionsPayload(window, readLimit(params), nowMs);
    case '/usage/runway':
      return runwayPayload(nowMs);
    case '/usage/value':
      return valuePayload(window, nowMs);
    case '/usage/events':
      return eventsPayload(window, readLimit(params), nowMs);
    default:
      return null;
  }
}

const notFound = (path: string) =>
  Object.assign(new Error(`fixture: ${path} not found`), { name: 'ApiError', status: 404 });

/** DEV fixture transport: a short delay so loading states are visible, then data or a 404. */
export async function resolveHubFixture(
  mode: HubFixtureMode,
  path: string,
  params: FixtureParams
): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (mode === 'missing') throw notFound(path);
  const payload = buildHubFixture(path, params, Date.now());
  if (!payload) throw notFound(path);
  return payload;
}
