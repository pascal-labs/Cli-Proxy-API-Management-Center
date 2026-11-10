/**
 * DEV-ONLY switch that answers the hub insight endpoints from fixtures instead of the backend.
 *
 * Only consulted behind `import.meta.env.DEV`, which is statically false in production builds,
 * so none of this ships in `dist/index.html`. Turn it on with either:
 *   http://localhost:5173/?hub-fixtures=1#/inference      sample data
 *   http://localhost:5173/?hub-fixtures=missing#/inference every endpoint answers 404
 * or persistently with `localStorage.setItem('cpamc.hubFixtures', '1' | 'missing')`.
 * `?hub-fixtures=0` overrides a stored value for that page load.
 */

export type HubFixtureMode = 'data' | 'missing';

export const HUB_FIXTURE_PARAM = 'hub-fixtures';
export const HUB_FIXTURE_STORAGE_KEY = 'cpamc.hubFixtures';

export function parseHubFixtureMode(value: string | null | undefined): HubFixtureMode | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'missing' || normalized === '404') return 'missing';
  if (['', '1', 'true', 'on', 'yes', 'data'].includes(normalized)) return 'data';
  return null;
}

const readParam = (query: string): string | null => {
  try {
    return new URLSearchParams(query).get(HUB_FIXTURE_PARAM);
  } catch {
    return null;
  }
};

/**
 * Pure resolution: a URL parameter (in the search part, or after `?` in the hash route) wins over
 * the stored preference, including an explicit "off".
 */
export function resolveHubFixtureMode(input: {
  search?: string;
  hash?: string;
  stored?: string | null;
}): HubFixtureMode | null {
  const hashQuery = input.hash?.includes('?') ? input.hash.slice(input.hash.indexOf('?')) : '';
  const fromUrl = readParam(input.search ?? '') ?? readParam(hashQuery);
  if (fromUrl !== null) return parseHubFixtureMode(fromUrl);
  return parseHubFixtureMode(input.stored ?? null);
}

const readStored = (): string | null => {
  try {
    return window.localStorage.getItem(HUB_FIXTURE_STORAGE_KEY);
  } catch {
    return null;
  }
};

export function readHubFixtureMode(): HubFixtureMode | null {
  if (typeof window === 'undefined') return null;
  return resolveHubFixtureMode({
    search: window.location?.search ?? '',
    hash: window.location?.hash ?? '',
    stored: readStored(),
  });
}
