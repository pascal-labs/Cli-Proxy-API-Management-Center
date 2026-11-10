/**
 * Plain-text plan tier for the console row ("Max", "Pro 200", "SuperGrok").
 *
 * The provider bodies render the plan as a styled badge (gold / jade tiers, see cardTier.ts);
 * the console row only needs the words, muted under the file name. Mirrors the bodies' label
 * rules so the two never disagree.
 */

import type { TFunction } from 'i18next';
import {
  BUSINESS_PREMIUM_CODEX_PLAN_TYPE,
  PRO_CODEX_PLAN_TYPE,
  PRO_LITE_CODEX_PLAN_TYPES,
  PRO_MAX_CODEX_PLAN_TYPES,
  normalizePlanType,
} from '@/utils/quota';
import { isRecord } from '@/utils/helpers';
import { XAI_SUPERGROK_HEAVY_LIMIT_CENTS, XAI_SUPERGROK_LIMIT_CENTS } from './cardTier';
import type { QuotaProviderType } from './providers/types';

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

export function codexPlanLabel(t: TFunction, planType: unknown): string | null {
  const raw = text(planType);
  const normalized = normalizePlanType(raw);
  if (!normalized) return null;
  if (normalized === BUSINESS_PREMIUM_CODEX_PLAN_TYPE) {
    return t('codex_quota.plan_business_premium');
  }
  if (PRO_MAX_CODEX_PLAN_TYPES.has(normalized)) return t('codex_quota.plan_promax');
  if (normalized === PRO_CODEX_PLAN_TYPE) return t('codex_quota.plan_pro');
  if (PRO_LITE_CODEX_PLAN_TYPES.has(normalized)) return t('codex_quota.plan_prolite');
  if (normalized === 'plus') return t('codex_quota.plan_plus');
  if (normalized === 'team') return t('codex_quota.plan_team');
  if (normalized === 'free') return t('codex_quota.plan_free');
  return raw || normalized;
}

function antigravityPlanLabel(t: TFunction, subscription: unknown): string | null {
  if (!isRecord(subscription)) return null;
  switch (subscription.plan) {
    case 'free':
      return t('antigravity_subscription.plan_free');
    case 'pro':
      return t('antigravity_subscription.plan_pro');
    case 'ultra':
      return t('antigravity_subscription.plan_ultra');
    case 'ultra-lite':
      return t('antigravity_subscription.plan_ultra_lite');
    default:
      return (
        text(subscription.tierName) ??
        text(subscription.tierId) ??
        (subscription.plan === 'unknown' ? t('antigravity_subscription.plan_unknown') : null)
      );
  }
}

function xaiPlanLabel(t: TFunction, billing: unknown): string | null {
  if (!isRecord(billing)) return null;
  const label = text(billing.planLabel);
  if (label) return label;
  if (billing.mode === 'paid-health') return t('xai_quota.plan_paid');
  if (billing.monthlyLimitCents === XAI_SUPERGROK_HEAVY_LIMIT_CENTS) {
    return t('xai_quota.plan_supergrok_heavy');
  }
  if (billing.monthlyLimitCents === XAI_SUPERGROK_LIMIT_CENTS) return t('xai_quota.plan_supergrok');
  return null;
}

/** Plan words for a loaded credential, or null when the provider did not report one. */
export function resolvePlanLabel(
  type: QuotaProviderType,
  quota: unknown,
  t: TFunction
): string | null {
  if (!isRecord(quota)) return null;
  switch (type) {
    case 'claude': {
      const planType = text(quota.planType);
      return planType ? t(`claude_quota.${planType}`) : null;
    }
    case 'codex':
      return codexPlanLabel(t, quota.planType);
    case 'kimi':
      return text(quota.planName);
    case 'xai':
      return xaiPlanLabel(t, quota.billing);
    case 'antigravity':
      return antigravityPlanLabel(t, quota.subscription);
    case 'plugin': {
      const subscription = isRecord(quota.subscription) ? quota.subscription : {};
      return text(subscription.tierName) ?? text(subscription.plan) ?? text(subscription.tierId);
    }
    case 'devin':
      return text(quota.plan);
    case 'meta':
      return isRecord(quota.data) ? text(quota.data.planName) : null;
    default:
      return null;
  }
}
