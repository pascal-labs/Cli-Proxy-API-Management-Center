/**
 * Inference: how inference is allocated across the subscription accounts and whether it pays off,
 * on one screen. KPIs on top (value ratio, volume, cache, failovers, unused quota), then the
 * allocation by account and by model, then the five most valuable T3 threads.
 *
 * Each panel reads its own endpoint, so a partially updated hub still shows what it can; only
 * when every endpoint answers 404 does the page ask for a hub update.
 */

import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useRevealGroup } from '@/hooks/motion';
import { useShowEmails } from '@/hooks/useShowEmails';
import { hubInsightsApi, INSIGHT_WINDOWS, type InsightWindow } from '@/services/api';
import { useAuthStore } from '@/stores';
import { classifyHitRatio, formatRatio } from '@/features/usage/logic';
import { AllocationBar } from './components/AllocationBar';
import { InsightsHeader } from './components/InsightsHeader';
import {
  ErrorBanner,
  KpiStrip,
  LoadingSkeleton,
  UnsupportedState,
  type Kpi,
} from './components/common';
import type { Tone } from './components/tones';
import { Segmented } from './components/Segmented';
import { hubFeatureMissingError, settlePart, useHubInsight } from './hooks/useHubInsight';
import { accountName, buildAccountDirectory } from './logic/accounts';
import {
  buildAllocation,
  OTHER_KEY,
  type AllocationItem,
  type AllocationMetric,
  type AllocationSegment,
} from './logic/allocation';
import { summarizeHealth } from './logic/events';
import { formatCompactNumber, formatMultiple, formatPercentValue, formatUsd } from './logic/format';
import { aggregateByAccount, aggregateByModel, aggregateRows } from './logic/models';
import { summarizeUnused } from './logic/runway';
import { buildThreadRows, topThreadsByValue } from './logic/threads';
import { classifyValueRatio, resolveValueTotals } from './logic/value';
import styles from './Insights.module.scss';

const HIT_TONE = { high: 'good', medium: 'warn', low: 'bad', none: 'muted' } as const;
const VALUE_TONE = { good: 'good', fair: 'warn', poor: 'bad', none: 'muted' } as const;
const METRICS: readonly AllocationMetric[] = ['tokens', 'value'];

export function InferencePage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [showEmails, setShowEmails] = useShowEmails();
  const [usageWindow, setUsageWindow] = useState<InsightWindow>('7d');
  const [metric, setMetric] = useState<AllocationMetric>('tokens');
  const revealRef = useRevealGroup<HTMLDivElement>();

  const load = useCallback(async () => {
    const parts = await Promise.all([
      settlePart(hubInsightsApi.getModelUsage(usageWindow)),
      settlePart(hubInsightsApi.getValue(usageWindow)),
      settlePart(hubInsightsApi.getSessions(usageWindow, 500)),
      settlePart(hubInsightsApi.getEvents('24h', 500)),
      settlePart(hubInsightsApi.getRunway()),
    ]);
    if (parts.every((part) => part.missing)) throw hubFeatureMissingError();
    const failed = parts.find((part) => part.error);
    if (failed && parts.every((part) => part.data === null)) throw new Error(failed.error);
    const [models, value, sessions, events, runway] = parts;
    return { models, value, sessions, events, runway };
  }, [usageWindow]);

  const { status, data, error, refreshing, reload } = useHubInsight(load, connected);

  const models = data?.models.data ?? null;
  const value = data?.value.data ?? null;
  const sessions = data?.sessions.data ?? null;
  const events = data?.events.data ?? null;
  const runway = data?.runway.data ?? null;

  const directory = useMemo(
    () => buildAccountDirectory(value?.accounts, runway?.accounts),
    [value, runway]
  );
  const nameOf = useCallback(
    (authIndex: string) => accountName(authIndex, directory, showEmails),
    [directory, showEmails]
  );

  const totals = useMemo(
    () => (models ? aggregateRows(models.rows, models.unpricedModels) : null),
    [models]
  );
  const byAccount = useMemo(
    () => (models ? aggregateByAccount(models.rows, models.unpricedModels) : []),
    [models]
  );
  const byModel = useMemo(
    () => (models ? aggregateByModel(models.rows, models.unpricedModels) : []),
    [models]
  );
  const topThreads = useMemo(
    () => (sessions ? topThreadsByValue(buildThreadRows(sessions.sessions), 5) : []),
    [sessions]
  );

  const fmt = (amount: number) => formatCompactNumber(amount, locale);
  const usd = (amount: number | null) => formatUsd(amount, locale);
  const missingHint = t('insights.inference.kpi_missing');

  const kpis: Kpi[] = [];
  {
    const valueTotals = value ? resolveValueTotals(value) : null;
    const hasPlan = (valueTotals?.subscriptionUsdForWindow ?? 0) > 0;
    kpis.push({
      key: 'value',
      label: t('insights.inference.kpi_value_ratio'),
      value: valueTotals ? formatMultiple(valueTotals.valueRatio, locale) : '—',
      tone: valueTotals ? VALUE_TONE[classifyValueRatio(valueTotals.valueRatio)] : 'muted',
      hint: !valueTotals
        ? missingHint
        : hasPlan
          ? t('insights.inference.kpi_value_ratio_hint', {
              value: usd(valueTotals.apiValueUsd),
              cost: usd(valueTotals.subscriptionUsdForWindow),
            })
          : t('insights.inference.kpi_value_ratio_no_plan', {
              value: usd(valueTotals.apiValueUsd),
            }),
    });
    kpis.push({
      key: 'requests',
      label: t('insights.inference.kpi_requests'),
      value: totals ? fmt(totals.requests) : '—',
      hint: totals
        ? t('insights.inference.kpi_requests_hint', {
            models: byModel.length,
            accounts: byAccount.filter((account) => account.requests > 0).length,
          })
        : missingHint,
    });
    kpis.push({
      key: 'tokens',
      label: t('insights.inference.kpi_tokens'),
      value: totals ? fmt(totals.tokens) : '—',
      hint: totals
        ? t('insights.inference.kpi_tokens_hint', {
            output: fmt(totals.outputTokens),
            cached: fmt(totals.cacheReadTokens),
          })
        : missingHint,
    });
    kpis.push({
      key: 'cache',
      label: t('insights.inference.kpi_cache'),
      value: totals ? formatRatio(totals.cacheHitRatio) : '—',
      tone: totals ? (HIT_TONE[classifyHitRatio(totals.cacheHitRatio)] as Tone) : 'muted',
      hint: totals
        ? t('insights.inference.kpi_cache_hint', { written: fmt(totals.cacheWriteTokens) })
        : missingHint,
    });
    const health = events ? summarizeHealth(events) : null;
    kpis.push({
      key: 'health',
      label: t('insights.inference.kpi_health'),
      value: health ? `${health.failovers} · ${health.errors}` : '—',
      tone: health ? (health.failovers + health.errors > 0 ? 'warn' : 'good') : 'muted',
      hint: health
        ? t('insights.inference.kpi_health_hint', {
            rateLimited: health.rateLimited,
            deadLogins: health.deadLogins,
          })
        : missingHint,
    });
    const unused = runway ? summarizeUnused(runway.accounts) : null;
    kpis.push({
      key: 'unused',
      label: t('insights.inference.kpi_unused'),
      value: unused ? formatPercentValue(unused.averagePercent) : '—',
      tone: unused && (unused.averagePercent ?? 0) >= 30 ? 'warn' : unused ? undefined : 'muted',
      hint: !unused
        ? missingHint
        : unused.windows === 0
          ? t('insights.inference.kpi_unused_none')
          : t(
              unused.scope === 'weekly'
                ? 'insights.inference.kpi_unused_hint_weekly'
                : 'insights.inference.kpi_unused_hint_all',
              { count: unused.windows }
            ),
    });
  }

  const accountItems: AllocationItem[] = byAccount.map((account) => ({
    key: account.authIndex,
    label: nameOf(account.authIndex),
    tokens: account.tokens,
    value: account.apiValueUsd,
  }));
  const modelItems: AllocationItem[] = byModel.map((model) => ({
    key: model.model,
    label: model.model,
    tokens: model.tokens,
    value: model.apiValueUsd,
  }));
  const accountAllocation = buildAllocation(accountItems, metric);
  const modelAllocation = buildAllocation(modelItems, metric);
  const formatAmount = (amount: number) => (metric === 'tokens' ? fmt(amount) : usd(amount));
  const segmentName = (segment: AllocationSegment) =>
    segment.key === OTHER_KEY
      ? t('insights.common.other_count', { count: segment.folded })
      : segment.label;

  const accountsCount = directory.size || byAccount.length;
  const panelMissing = (
    <p className={styles.panelEmpty}>{t('insights.common.panel_unsupported')}</p>
  );
  const panelEmpty = <p className={styles.panelEmpty}>{t('insights.common.empty')}</p>;

  return (
    <div className={styles.page} ref={revealRef}>
      <InsightsHeader
        title={t('insights.inference.title')}
        meta={
          status === 'unsupported'
            ? []
            : [
                {
                  key: 'accounts',
                  text: t('insights.inference.meta_accounts', { count: accountsCount }),
                },
                {
                  key: 'window',
                  text: t('insights.common.meta_window', {
                    window: t(`insights.common.window_${usageWindow}`),
                  }),
                  tone: 'accent',
                },
              ]
        }
        generatedAt={models?.generatedAt ?? value?.generatedAt}
        windowControl={{ options: INSIGHT_WINDOWS, value: usageWindow, onChange: setUsageWindow }}
        showEmails={showEmails}
        onShowEmailsChange={setShowEmails}
        onRefresh={() => void reload()}
        refreshing={refreshing}
        connected={connected}
      />

      {status === 'unsupported' ? (
        <UnsupportedState endpoint="/usage/*" />
      ) : status === 'loading' ? (
        <LoadingSkeleton />
      ) : (
        <>
          <ErrorBanner message={error} />
          <KpiStrip items={kpis} label={t('insights.inference.kpi_label')} />

          <section className={styles.panel} aria-labelledby="inference-allocation">
            <div className={styles.panelHead}>
              <div className={styles.panelCopy}>
                <h2 className={styles.panelTitle} id="inference-allocation">
                  {t('insights.inference.allocation_title')}
                </h2>
                <p className={styles.panelDesc}>
                  {metric === 'tokens'
                    ? t('insights.inference.allocation_desc_tokens')
                    : t('insights.inference.allocation_desc_value')}
                </p>
              </div>
              <Segmented
                small
                options={METRICS}
                value={metric}
                onChange={setMetric}
                label={t('insights.common.metric_label')}
                renderOption={(option) => t(`insights.common.metric_${option}`)}
              />
            </div>
            {!models ? (
              panelMissing
            ) : (
              <div className={styles.grid2}>
                <div className={styles.panelCopy}>
                  <h3 className={styles.panelDesc}>{t('insights.inference.by_account')}</h3>
                  {accountAllocation.segments.length ? (
                    <AllocationBar
                      title={t('insights.inference.by_account')}
                      allocation={accountAllocation}
                      formatAmount={formatAmount}
                      nameOf={segmentName}
                    />
                  ) : (
                    panelEmpty
                  )}
                </div>
                <div className={styles.panelCopy}>
                  <h3 className={styles.panelDesc}>{t('insights.inference.by_model')}</h3>
                  {modelAllocation.segments.length ? (
                    <AllocationBar
                      title={t('insights.inference.by_model')}
                      allocation={modelAllocation}
                      formatAmount={formatAmount}
                      nameOf={segmentName}
                    />
                  ) : (
                    panelEmpty
                  )}
                </div>
              </div>
            )}
            {models && metric === 'value' && totals?.hasUnpriced && (
              <p className={styles.panelNote}>{t('insights.inference.allocation_unpriced_note')}</p>
            )}
          </section>

          <section className={styles.panel} aria-labelledby="inference-top-threads">
            <div className={styles.panelHead}>
              <div className={styles.panelCopy}>
                <h2 className={styles.panelTitle} id="inference-top-threads">
                  {t('insights.inference.top_threads_title')}
                </h2>
                <p className={styles.panelDesc}>{t('insights.inference.top_threads_desc')}</p>
              </div>
              <Link to="/threads" className={styles.textLink}>
                {t('insights.inference.all_threads')}
              </Link>
            </div>
            {!sessions ? (
              panelMissing
            ) : topThreads.length === 0 ? (
              <p className={styles.panelEmpty}>{t('insights.inference.top_threads_empty')}</p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">{t('insights.inference.col_thread')}</th>
                      <th scope="col">{t('insights.inference.col_project')}</th>
                      <th scope="col">{t('insights.inference.col_accounts')}</th>
                      <th scope="col" className={styles.num}>
                        {t('insights.common.requests')}
                      </th>
                      <th scope="col" className={styles.num}>
                        {t('insights.common.cache_hit')}
                      </th>
                      <th scope="col" className={styles.num}>
                        {t('insights.common.api_value')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {topThreads.map((row) => {
                      const band = classifyHitRatio(row.metrics.cacheHitRatio);
                      return (
                        <tr key={row.id}>
                          <td>
                            <span className={styles.cellStack}>
                              <span
                                className={`${styles.ellipsis} ${styles.strong}`}
                                title={row.title}
                              >
                                {row.title}
                              </span>
                              {row.children.length > 0 && (
                                <span className={styles.tag}>
                                  {t('insights.common.subagents', { count: row.children.length })}
                                </span>
                              )}
                            </span>
                          </td>
                          <td>{row.project ?? '—'}</td>
                          <td>
                            <span className={styles.ellipsis}>
                              {row.metrics.authIndexes.map(nameOf).join(', ') || '—'}
                            </span>
                          </td>
                          <td className={styles.num}>{fmt(row.metrics.requests)}</td>
                          <td className={`${styles.num} ${TONE_FOR_BAND[band]}`}>
                            {formatRatio(row.metrics.cacheHitRatio)}
                          </td>
                          <td className={`${styles.num} ${styles.strong}`}>
                            {usd(row.metrics.apiValueUsd)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

const TONE_FOR_BAND = {
  high: styles.toneGood,
  medium: styles.toneWarn,
  low: styles.toneBad,
  none: styles.toneMuted,
} as const;
