/**
 * Value: API-equivalent value (the same traffic at list prices) per account and per model, against
 * each plan's cost pro-rated to the window ("$200/mo → $6.67/day"), plus what the prompt cache
 * saves. Unpriced usage reads "unpriced" rather than $0; unpriced models and accounts without a
 * plan cost are called out with a pointer to `hub.prices` / `hub.subscriptions` in config.yaml.
 * Codex value only covers hub traffic: the Codex desktop app and its automations bypass the hub.
 */

import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconAlertTriangle } from '@/components/ui/icons';
import { useRevealGroup } from '@/hooks/motion';
import { useShowEmails } from '@/hooks/useShowEmails';
import { hubInsightsApi, INSIGHT_WINDOWS, type InsightWindow } from '@/services/api';
import { useAuthStore } from '@/stores';
import { displayAccountName } from '@/utils/accountMask';
import { classifyHitRatio, formatRatio } from '@/features/usage/logic';
import { InsightsHeader } from './components/InsightsHeader';
import {
  ErrorBanner,
  KpiStrip,
  LoadingSkeleton,
  ProviderLabel,
  UnsupportedState,
  type Kpi,
} from './components/common';
import { TONE_CLASS } from './components/tones';
import { hubFeatureMissingError, settlePart, useHubInsight } from './hooks/useHubInsight';
import { formatCompactNumber, formatMultiple, formatShare, formatUsd } from './logic/format';
import { aggregateByModel, collectUnpricedModels } from './logic/models';
import {
  accountsWithoutPlan,
  classifyValueRatio,
  planPerDay,
  resolveCacheTotals,
  resolveValueTotals,
  sortValueAccounts,
  type ValueBand,
} from './logic/value';
import styles from './Insights.module.scss';

const VALUE_TONE = { good: 'good', fair: 'warn', poor: 'bad', none: 'muted' } as const;
const HIT_TONE = { high: 'good', medium: 'warn', low: 'bad', none: 'muted' } as const;
const BAND_KEY: Record<Exclude<ValueBand, 'none'>, string> = {
  good: 'insights.value.band_good',
  fair: 'insights.value.band_fair',
  poor: 'insights.value.band_poor',
};

function ShareCell({ share }: { share: number | null }) {
  return (
    <span className={styles.shareCell}>
      <span className={styles.shareTrack} aria-hidden="true">
        <span
          className={styles.shareFill}
          style={{ width: `${Math.round((share ?? 0) * 100)}%` }}
        />
      </span>
      {formatShare(share)}
    </span>
  );
}

/**
 * A value cell: "unpriced" instead of $0 when nothing was priced, and a "+ unpriced" mark when
 * part of the usage is missing from the figure.
 */
function ValueAmount({ amount, unpriced }: { amount: number | null; unpriced: boolean }) {
  const { t, i18n } = useTranslation();
  if (amount === null) {
    return unpriced ? (
      <span className={styles.toneMuted} title={t('insights.common.unpriced_hint')}>
        {t('insights.common.unpriced')}
      </span>
    ) : (
      <>{formatUsd(null, i18n.resolvedLanguage)}</>
    );
  }
  return (
    <span className={styles.cellStackEnd}>
      <span>{formatUsd(amount, i18n.resolvedLanguage)}</span>
      {unpriced && (
        <span className={styles.subLine} title={t('insights.common.unpriced_hint')}>
          {t('insights.value.partly_unpriced')}
        </span>
      )}
    </span>
  );
}

export function ValuePage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [showEmails, setShowEmails] = useShowEmails();
  const [usageWindow, setUsageWindow] = useState<InsightWindow>('30d');
  const revealRef = useRevealGroup<HTMLDivElement>();

  const load = useCallback(async () => {
    const [value, models] = await Promise.all([
      settlePart(hubInsightsApi.getValue(usageWindow)),
      settlePart(hubInsightsApi.getModelUsage(usageWindow)),
    ]);
    if (value.missing && models.missing) throw hubFeatureMissingError();
    if (!value.data && !models.data) throw new Error(value.error || models.error);
    return { value, models };
  }, [usageWindow]);

  const { status, data, error, refreshing, reload } = useHubInsight(load, connected);
  const value = data?.value.data ?? null;
  const models = data?.models.data ?? null;

  const accounts = useMemo(() => (value ? sortValueAccounts(value.accounts) : []), [value]);
  const totals = useMemo(() => (value ? resolveValueTotals(value) : null), [value]);
  const cache = useMemo(() => (value ? resolveCacheTotals(value) : null), [value]);
  const monthlyPlans = accounts.reduce<number | null>(
    (sum, account) =>
      account.subscriptionUsdPerMonth === null ? sum : (sum ?? 0) + account.subscriptionUsdPerMonth,
    null
  );
  const hasCodex = accounts.some((account) => account.provider === 'codex');
  const modelRows = useMemo(
    () => (models ? aggregateByModel(models.rows, models.unpricedModels) : []),
    [models]
  );
  const unpriced = useMemo(
    () =>
      collectUnpricedModels(models?.rows ?? [], [
        ...(value?.unpricedModels ?? []),
        ...(models?.unpricedModels ?? []),
      ]),
    [models, value]
  );
  const noPlan = useMemo(
    () => accountsWithoutPlan(accounts).filter((account) => (account.apiValueUsd ?? 0) > 0),
    [accounts]
  );
  const totalModelValue = modelRows.reduce((sum, row) => sum + (row.apiValueUsd ?? 0), 0);
  const totalAccountValue = accounts.reduce((sum, account) => sum + (account.apiValueUsd ?? 0), 0);

  const usd = (amount: number | null) => formatUsd(amount, locale);
  const name = (label: string, authIndex: string) =>
    displayAccountName(label || `#${authIndex}`, showEmails);
  const windowLabel = t(`insights.common.window_${usageWindow}`);

  const kpis: Kpi[] = [
    {
      key: 'api',
      label: t('insights.value.kpi_api_value'),
      value: usd(totals?.apiValueUsd ?? null),
      hint:
        totals?.hasUnpricedUsage || unpriced.length > 0
          ? t('insights.value.kpi_api_value_hint_unpriced')
          : t('insights.value.kpi_api_value_hint'),
    },
    {
      key: 'subscription',
      label: t('insights.value.kpi_subscription'),
      value: usd(totals?.subscriptionUsdForWindow ?? null),
      hint:
        monthlyPlans !== null
          ? t('insights.value.kpi_subscription_hint_rate', {
              monthly: usd(monthlyPlans),
              daily: usd(planPerDay(monthlyPlans)),
            })
          : t('insights.value.kpi_subscription_hint'),
    },
    {
      key: 'ratio',
      label: t('insights.value.kpi_ratio'),
      value: formatMultiple(totals?.valueRatio ?? null, locale),
      tone: VALUE_TONE[classifyValueRatio(totals?.valueRatio)],
      hint: t('insights.value.kpi_ratio_hint'),
    },
    {
      key: 'cache',
      label: t('insights.value.kpi_cache_savings'),
      value: usd(cache?.cacheSavingsUsd ?? null),
      tone: (cache?.cacheSavingsUsd ?? 0) > 0 ? 'good' : 'muted',
      hint:
        cache?.cacheSavingsUsd === null || !cache
          ? t('insights.inference.kpi_missing')
          : cache.noCacheValueUsd !== null
            ? `${t('insights.common.cache_savings_hint')} ${t('insights.value.kpi_cache_savings_no_cache', { amount: usd(cache.noCacheValueUsd) })}`
            : t('insights.common.cache_savings_hint'),
    },
    {
      key: 'unpriced',
      label: t('insights.value.kpi_unpriced'),
      value: String(unpriced.length),
      tone: unpriced.length > 0 ? 'warn' : undefined,
      hint: t('insights.value.kpi_unpriced_hint'),
    },
  ];

  const configHint = (
    <>
      {t('insights.value.config_hint')}{' '}
      <Link to="/config" className={styles.textLink}>
        {t('insights.common.open_config')}
      </Link>
    </>
  );

  return (
    <div className={styles.page} ref={revealRef}>
      <InsightsHeader
        title={t('insights.value.title')}
        meta={
          status === 'ready'
            ? [
                {
                  key: 'accounts',
                  text: t('insights.value.meta_accounts', { count: accounts.length }),
                },
                {
                  key: 'window',
                  text: t('insights.common.meta_window', { window: windowLabel }),
                  tone: 'accent',
                },
              ]
            : []
        }
        generatedAt={value?.generatedAt ?? models?.generatedAt}
        windowControl={{ options: INSIGHT_WINDOWS, value: usageWindow, onChange: setUsageWindow }}
        showEmails={showEmails}
        onShowEmailsChange={setShowEmails}
        onRefresh={() => void reload()}
        refreshing={refreshing}
        connected={connected}
      />

      {status === 'unsupported' ? (
        <UnsupportedState endpoint="/usage/value" />
      ) : status === 'loading' ? (
        <LoadingSkeleton />
      ) : (
        <>
          <ErrorBanner message={error} />
          {value && <KpiStrip items={kpis} label={t('insights.value.kpi_label')} />}

          {unpriced.length > 0 && (
            <div className={styles.callout} role="status">
              <IconAlertTriangle size={16} className={styles.calloutIcon} aria-hidden="true" />
              <p className={styles.calloutText}>
                {t('insights.value.unpriced_callout', {
                  count: unpriced.length,
                  models: unpriced.join(', '),
                })}{' '}
                {configHint}
              </p>
            </div>
          )}
          {noPlan.length > 0 && (
            <div className={styles.callout} role="status">
              <IconAlertTriangle size={16} className={styles.calloutIcon} aria-hidden="true" />
              <p className={styles.calloutText}>
                {t('insights.value.no_plan_callout', {
                  count: noPlan.length,
                  accounts: noPlan
                    .map((account) => name(account.label, account.authIndex))
                    .join(', '),
                })}{' '}
                {unpriced.length === 0 && configHint}
              </p>
            </div>
          )}

          <section className={styles.panel} aria-labelledby="value-accounts">
            <div className={styles.panelCopy}>
              <h2 className={styles.panelTitle} id="value-accounts">
                {t('insights.value.accounts_title')}
              </h2>
              <p className={styles.panelDesc}>{t('insights.value.accounts_desc')}</p>
            </div>
            {!value ? (
              <p className={styles.panelEmpty}>{t('insights.common.panel_unsupported')}</p>
            ) : accounts.length === 0 ? (
              <p className={styles.panelEmpty}>{t('insights.value.empty_desc')}</p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">{t('insights.common.account')}</th>
                      <th scope="col">{t('insights.common.provider')}</th>
                      <th scope="col" className={styles.num}>
                        {t('insights.common.api_value')}
                      </th>
                      <th scope="col" className={styles.num}>
                        {t('insights.value.col_cache_savings')}
                      </th>
                      <th scope="col" className={styles.num}>
                        {t('insights.value.col_plan_month')}
                      </th>
                      <th scope="col" className={styles.num}>
                        {t('insights.value.col_plan_window', { window: windowLabel })}
                      </th>
                      <th scope="col" className={styles.num}>
                        {t('insights.value.col_ratio')}
                      </th>
                      <th scope="col" className={styles.num}>
                        {t('insights.value.col_share')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((account) => {
                      const band = classifyValueRatio(account.valueRatio);
                      const accountName = name(account.label, account.authIndex);
                      return (
                        <tr key={account.authIndex || account.label}>
                          <td>
                            <span className={styles.accountName} title={accountName}>
                              {accountName}
                            </span>
                          </td>
                          <td>
                            <ProviderLabel provider={account.provider} />
                          </td>
                          <td className={`${styles.num} ${styles.strong}`}>
                            <ValueAmount
                              amount={account.apiValueUsd}
                              unpriced={account.hasUnpricedUsage}
                            />
                          </td>
                          <td className={styles.num}>
                            {account.cacheSavingsUsd === null ? (
                              <span className={styles.toneMuted}>
                                {account.hasUnpricedUsage && account.apiValueUsd === null
                                  ? t('insights.common.unpriced')
                                  : '—'}
                              </span>
                            ) : (
                              usd(account.cacheSavingsUsd)
                            )}
                          </td>
                          <td className={styles.num}>
                            {account.subscriptionUsdPerMonth === null ? (
                              <span className={styles.toneMuted}>
                                {t('insights.value.no_plan')}
                              </span>
                            ) : (
                              <span className={styles.cellStackEnd}>
                                <span>
                                  {t('insights.value.per_month', {
                                    amount: usd(account.subscriptionUsdPerMonth),
                                  })}
                                </span>
                                <span className={styles.subLine}>
                                  {t('insights.value.per_day', {
                                    amount: usd(planPerDay(account.subscriptionUsdPerMonth)),
                                  })}
                                </span>
                              </span>
                            )}
                          </td>
                          <td className={styles.num}>{usd(account.subscriptionUsdForWindow)}</td>
                          <td className={styles.num}>
                            <span
                              className={`${styles.bold} ${TONE_CLASS[VALUE_TONE[band]]}`}
                              title={band === 'none' ? undefined : t(BAND_KEY[band])}
                            >
                              {formatMultiple(account.valueRatio, locale)}
                            </span>
                            {band !== 'none' && (
                              <span className={styles.srOnly}> ({t(BAND_KEY[band])})</span>
                            )}
                          </td>
                          <td className={styles.num}>
                            <ShareCell
                              share={
                                totalAccountValue > 0 && account.apiValueUsd !== null
                                  ? account.apiValueUsd / totalAccountValue
                                  : null
                              }
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={styles.panel} aria-labelledby="value-models">
            <div className={styles.panelCopy}>
              <h2 className={styles.panelTitle} id="value-models">
                {t('insights.value.models_title')}
              </h2>
              <p className={styles.panelDesc}>{t('insights.value.models_desc')}</p>
            </div>
            {!models ? (
              <p className={styles.panelEmpty}>{t('insights.common.panel_unsupported')}</p>
            ) : modelRows.length === 0 ? (
              <p className={styles.panelEmpty}>{t('insights.common.empty')}</p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">{t('insights.common.model')}</th>
                      <th scope="col">{t('insights.common.provider')}</th>
                      <th scope="col" className={styles.num}>
                        {t('insights.common.requests')}
                      </th>
                      <th scope="col" className={styles.num}>
                        {t('insights.common.tokens')}
                      </th>
                      <th scope="col" className={styles.num}>
                        {t('insights.common.cache_hit')}
                      </th>
                      <th scope="col" className={styles.num}>
                        {t('insights.common.api_value')}
                      </th>
                      <th scope="col" className={styles.num}>
                        {t('insights.value.col_share')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {modelRows.map((row) => {
                      const isUnpriced = unpriced.includes(row.model);
                      return (
                        <tr key={row.model}>
                          <td>
                            <span className={styles.provider}>
                              <span className={`${styles.mono} ${styles.strong}`}>{row.model}</span>
                              {isUnpriced && (
                                <span
                                  className={`${styles.tag} ${styles.tagWarn}`}
                                  title={t('insights.common.unpriced_hint')}
                                >
                                  <IconAlertTriangle size={11} aria-hidden="true" />
                                  {t('insights.common.unpriced')}
                                </span>
                              )}
                            </span>
                          </td>
                          <td>
                            {row.providers.length ? (
                              <ProviderLabel provider={row.providers[0]} />
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className={styles.num}>
                            {formatCompactNumber(row.requests, locale)}
                          </td>
                          <td className={styles.num}>{formatCompactNumber(row.tokens, locale)}</td>
                          <td
                            className={`${styles.num} ${TONE_CLASS[HIT_TONE[classifyHitRatio(row.cacheHitRatio)]]}`}
                          >
                            {formatRatio(row.cacheHitRatio)}
                          </td>
                          <td className={`${styles.num} ${styles.strong}`}>
                            <ValueAmount amount={row.apiValueUsd} unpriced={isUnpriced} />
                          </td>
                          <td className={styles.num}>
                            <ShareCell
                              share={
                                totalModelValue > 0 && row.apiValueUsd !== null
                                  ? row.apiValueUsd / totalModelValue
                                  : null
                              }
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {hasCodex && <p className={styles.panelNote}>{t('insights.value.codex_note')}</p>}
          {unpriced.length === 0 && noPlan.length === 0 && (
            <p className={styles.panelNote}>{configHint}</p>
          )}
        </>
      )}
    </div>
  );
}
