/**
 * "Next up": which credential the router would hand the next request to, per provider.
 *
 * Fed by the hub backend's `GET /routing/order`. Pure — the page passes the normalized order in
 * and asks per file. A credential matches on auth index first, then auth id, then its file name,
 * because older entries may lack an index and file names are what the backend uses as labels.
 */

import type { RoutingOrder, RoutingOrderEntry } from '@/services/api/hub';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';

/** The candidate a provider routes to next: lowest rank among eligible, enabled entries. */
export function pickNextUpEntry(entries: readonly RoutingOrderEntry[]): RoutingOrderEntry | null {
  let best: RoutingOrderEntry | null = null;
  for (const entry of entries) {
    if (!entry.eligible || entry.disabled) continue;
    if (best === null || entry.rank < best.rank) best = entry;
  }
  return best;
}

const identityKeys = (authIndex: string, authId: string, label: string): string[] => {
  const keys: string[] = [];
  if (authIndex) keys.push(`idx:${authIndex}`);
  if (authId) keys.push(`id:${authId}`);
  if (label) keys.push(`label:${label.toLowerCase()}`);
  return keys;
};

/** Identity keys of every provider's next-up credential; empty when the order is unavailable. */
export function selectNextUpKeys(order: RoutingOrder | null | undefined): Set<string> {
  const keys = new Set<string>();
  if (!order) return keys;
  for (const entries of Object.values(order.providers)) {
    const next = pickNextUpEntry(entries);
    if (!next) continue;
    identityKeys(next.authIndex, next.authId, next.label).forEach((key) => keys.add(key));
  }
  return keys;
}

export function isNextUpFile(file: AuthFileItem, keys: ReadonlySet<string>): boolean {
  if (keys.size === 0) return false;
  const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex) ?? '';
  const rawId = file.id ?? file['auth_id'];
  const authId = typeof rawId === 'string' ? rawId.trim() : '';
  return identityKeys(authIndex, authId, file.name ?? '').some((key) => keys.has(key));
}
