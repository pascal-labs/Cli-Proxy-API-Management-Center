/**
 * Value: is each subscription paying for itself? API-equivalent value (what the same traffic
 * would cost at list prices) against the plan cost pro-rated to the window.
 */

import {
  computeValueRatio,
  type ValueAccount,
  type ValueReport,
  type ValueTotals,
} from '@/services/api/hubInsights';

/** ≥1× the plan pays for itself; 0.5–1× partly; below half it is underused. */
export type ValueBand = 'good' | 'fair' | 'poor' | 'none';

export const VALUE_RATIO_GOOD = 1;
export const VALUE_RATIO_FAIR = 0.5;

export function classifyValueRatio(ratio: number | null | undefined): ValueBand {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return 'none';
  if (ratio >= VALUE_RATIO_GOOD) return 'good';
  if (ratio >= VALUE_RATIO_FAIR) return 'fair';
  return 'poor';
}

const sum = (values: Array<number | null>): number | null =>
  values.some((value) => value !== null)
    ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
    : null;

/**
 * The backend's totals, with any missing figure rebuilt from the accounts. The ratio only counts
 * accounts that have a plan cost, so an unconfigured plan does not inflate the return.
 */
export function resolveValueTotals(report: Pick<ValueReport, 'accounts' | 'totals'>): ValueTotals {
  const { accounts, totals } = report;
  const apiValueUsd = totals.apiValueUsd ?? sum(accounts.map((account) => account.apiValueUsd));
  const subscriptionUsdForWindow =
    totals.subscriptionUsdForWindow ??
    sum(accounts.map((account) => account.subscriptionUsdForWindow));
  let valueRatio = totals.valueRatio;
  if (valueRatio === null) {
    const planned = accounts.filter((account) => (account.subscriptionUsdForWindow ?? 0) > 0);
    valueRatio = computeValueRatio(
      sum(planned.map((account) => account.apiValueUsd)),
      sum(planned.map((account) => account.subscriptionUsdForWindow))
    );
  }
  return { apiValueUsd, subscriptionUsdForWindow, valueRatio };
}

/** Highest value first; accounts without a figure last; label breaks ties. */
export function sortValueAccounts(accounts: readonly ValueAccount[]): ValueAccount[] {
  return [...accounts].sort(
    (a, b) =>
      (b.apiValueUsd ?? -1) - (a.apiValueUsd ?? -1) ||
      a.label.localeCompare(b.label) ||
      a.authIndex.localeCompare(b.authIndex)
  );
}

/** Accounts with traffic but no plan cost configured under hub.subscriptions. */
export function accountsWithoutPlan(accounts: readonly ValueAccount[]): ValueAccount[] {
  return accounts.filter(
    (account) =>
      account.subscriptionUsdPerMonth === null && account.subscriptionUsdForWindow === null
  );
}
