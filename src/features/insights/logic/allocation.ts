/**
 * One-whole-split-into-parts allocation (tokens or value per account / model) for the segmented
 * bar and its legend table.
 *
 * Colour follows the entity, never its rank under the current measure: slots are handed out
 * alphabetically among the entities that earn one (ranked by tokens, which does not change when
 * the measure toggles), so switching Tokens ↔ Value never repaints a segment. Past eight entities
 * the rest fold into a single neutral "Other" part instead of cycling hues.
 */

export type AllocationMetric = 'tokens' | 'value';

export const ALLOCATION_SLOTS = 8;

export interface AllocationItem {
  key: string;
  label: string;
  tokens: number;
  /** Null when unpriced; counts as zero for the value split. */
  value: number | null;
}

export interface AllocationSegment {
  key: string;
  label: string;
  amount: number;
  /** 0–1 of the total. */
  share: number;
  /** Categorical slot 0–7; null for the folded "Other" part. */
  slot: number | null;
  /** Folded entity count (Other only). */
  folded: number;
}

export interface Allocation {
  total: number;
  segments: AllocationSegment[];
}

export const OTHER_KEY = '__other__';

/** Stable slot per entity key. Entities without a slot are folded into Other. */
export function assignAllocationSlots(
  items: readonly AllocationItem[],
  maxSlots = ALLOCATION_SLOTS
): Map<string, number> {
  const ranked = [...items]
    .filter((item) => item.tokens > 0 || (item.value ?? 0) > 0)
    .sort(
      (a, b) => b.tokens - a.tokens || (b.value ?? 0) - (a.value ?? 0) || a.key.localeCompare(b.key)
    );
  const winners = ranked.length <= maxSlots ? ranked : ranked.slice(0, maxSlots - 1);
  const slots = new Map<string, number>();
  [...winners]
    .sort((a, b) => a.key.localeCompare(b.key))
    .forEach((item, index) => slots.set(item.key, index));
  return slots;
}

export function buildAllocation(
  items: readonly AllocationItem[],
  metric: AllocationMetric,
  maxSlots = ALLOCATION_SLOTS
): Allocation {
  const slots = assignAllocationSlots(items, maxSlots);
  const amountOf = (item: AllocationItem) =>
    Math.max(0, metric === 'tokens' ? item.tokens : (item.value ?? 0));
  const total = items.reduce((sum, item) => sum + amountOf(item), 0);
  if (total <= 0) return { total: 0, segments: [] };

  const segments: AllocationSegment[] = [];
  let otherAmount = 0;
  let otherCount = 0;
  items.forEach((item) => {
    const amount = amountOf(item);
    const slot = slots.get(item.key);
    if (slot === undefined) {
      if (amount > 0 || item.tokens > 0) {
        otherAmount += amount;
        otherCount += 1;
      }
      return;
    }
    if (amount <= 0) return;
    segments.push({
      key: item.key,
      label: item.label,
      amount,
      share: amount / total,
      slot,
      folded: 0,
    });
  });
  segments.sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
  if (otherAmount > 0) {
    segments.push({
      key: OTHER_KEY,
      label: '',
      amount: otherAmount,
      share: otherAmount / total,
      slot: null,
      folded: otherCount,
    });
  }
  return { total, segments };
}
