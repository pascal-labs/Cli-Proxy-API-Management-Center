/**
 * Runway: per account and quota window, how much is used, how fast it is burning, and whether it
 * runs out before it resets ("runs out Thu 14:00 · resets Sat 08:00"). Each window carries a small
 * used-% history and what was left unused when it last reset.
 */

import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { IconAlertTriangle } from '@/components/ui/icons';
import { useRevealGroup } from '@/hooks/motion';
import { useNow } from '@/hooks/useNow';
import { useShowEmails } from '@/hooks/useShowEmails';
import { hubInsightsApi, type RunwayAccount, type RunwayWindow } from '@/services/api';
import { useAuthStore } from '@/stores';
import { displayAccountName } from '@/utils/accountMask';
import { InsightsHeader } from './components/InsightsHeader';
import {
  ErrorBanner,
  KpiStrip,
  LoadingSkeleton,
  ProviderLabel,
  UnsupportedState,
  type Kpi,
} from './components/common';
import { RunwayChart } from './components/RunwayChart';
import { useHubInsight } from './hooks/useHubInsight';
import { formatBurnRate, formatPercentValue, formatWeekdayInstant } from './logic/format';
import {
  classifyRunway,
  collectRunwayAlerts,
  describeRunway,
  latestCycles,
  sortRunwayAccounts,
  sortRunwayWindows,
  summarizeUnused,
  unusedAtReset,
} from './logic/runway';
import styles from './Insights.module.scss';
import rs from './RunwayPage.module.scss';

export function RunwayPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [showEmails, setShowEmails] = useShowEmails();
  const revealRef = useRevealGroup<HTMLDivElement>();
  const nowMs = useNow();

  const load = useCallback(() => hubInsightsApi.getRunway(), []);
  const { status, data, error, refreshing, reload } = useHubInsight(load, connected);

  const accounts = useMemo(
    () => (data ? sortRunwayAccounts(data.accounts, nowMs) : []),
    [data, nowMs]
  );
  const alerts = useMemo(
    () => (data ? collectRunwayAlerts(data.accounts, nowMs) : []),
    [data, nowMs]
  );
  const unused = useMemo(() => (data ? summarizeUnused(data.accounts) : null), [data]);
  const totalWindows = accounts.reduce((sum, account) => sum + account.windows.length, 0);
  const atRisk = alerts.length;

  const name = (account: RunwayAccount) =>
    displayAccountName(account.label || `#${account.authIndex}`, showEmails);
  const when = (ms: number | null) => formatWeekdayInstant(ms, nowMs, locale);
  const windowName = (window: RunwayWindow) =>
    window.kind === 'other' ? window.key : t(`insights.runway.window_${window.kind}`);

  // The next window to run out; ones already at 100% are counted, not forecast.
  const soonest = alerts.find((alert) => alert.status === 'at_risk');
  const exhaustedCount =
    alerts.length - alerts.filter((alert) => alert.status === 'at_risk').length;
  const kpis: Kpi[] = [
    {
      key: 'at_risk',
      label: t('insights.runway.summary_at_risk'),
      value: String(atRisk),
      tone: atRisk > 0 ? 'bad' : 'good',
      hint: t('insights.runway.summary_at_risk_hint', { total: totalWindows }),
    },
    {
      key: 'soonest',
      label: t('insights.runway.summary_soonest'),
      value: soonest
        ? when(soonest.exhaustMs)
        : exhaustedCount > 0
          ? t('insights.runway.exhausted')
          : t('insights.runway.summary_soonest_none'),
      tone: soonest || exhaustedCount > 0 ? 'bad' : 'muted',
      hint: soonest ? `${name(soonest.account)} · ${windowName(soonest.window)}` : undefined,
    },
    {
      key: 'unused',
      label: t('insights.runway.summary_unused'),
      value: formatPercentValue(unused?.averagePercent ?? null),
      tone: (unused?.averagePercent ?? 0) >= 30 ? 'warn' : undefined,
      hint:
        unused && unused.windows > 0
          ? t(
              unused.scope === 'weekly'
                ? 'insights.inference.kpi_unused_hint_weekly'
                : 'insights.inference.kpi_unused_hint_all',
              { count: unused.windows }
            )
          : t('insights.runway.unused_none'),
    },
  ];

  return (
    <div className={styles.page} ref={revealRef}>
      <InsightsHeader
        title={t('insights.runway.title')}
        meta={
          status === 'ready'
            ? [
                {
                  key: 'accounts',
                  text: t('insights.runway.meta_accounts', { count: accounts.length }),
                },
                ...(atRisk > 0
                  ? [
                      {
                        key: 'risk',
                        text: t('insights.runway.meta_at_risk', { count: atRisk }),
                        tone: 'warn' as const,
                      },
                    ]
                  : []),
              ]
            : []
        }
        generatedAt={data?.generatedAt}
        showEmails={showEmails}
        onShowEmailsChange={setShowEmails}
        onRefresh={() => void reload()}
        refreshing={refreshing}
        connected={connected}
      />

      {status === 'unsupported' ? (
        <UnsupportedState endpoint="/usage/runway" />
      ) : status === 'loading' ? (
        <LoadingSkeleton />
      ) : (
        <>
          <ErrorBanner message={error} />
          {accounts.length === 0 ? (
            status === 'ready' && (
              <div className={styles.panel}>
                <p className={styles.panelTitle}>{t('insights.runway.empty_title')}</p>
                <p className={styles.panelDesc}>{t('insights.runway.empty_desc')}</p>
              </div>
            )
          ) : (
            <>
              <KpiStrip items={kpis} label={t('insights.runway.summary_label')} />
              <div className={rs.grid}>
                {accounts.map((account) => {
                  const cycles = latestCycles(account.lastCycles);
                  const statuses = account.windows.map(classifyRunway);
                  const danger = statuses.some((s) => s === 'at_risk' || s === 'exhausted');
                  const exhausted = statuses.includes('exhausted');
                  const accountName = name(account);
                  return (
                    <article
                      key={account.authIndex || account.label}
                      className={`${rs.card} ${danger ? rs.cardDanger : ''}`}
                    >
                      <header className={rs.cardHead}>
                        <div className={rs.cardTitle}>
                          <span className={styles.accountName} title={accountName}>
                            {accountName}
                          </span>
                        </div>
                        <ProviderLabel provider={account.provider} />
                        {danger && (
                          <span className={`${styles.tag} ${styles.tagDanger}`}>
                            <IconAlertTriangle size={12} aria-hidden="true" />
                            {exhausted
                              ? t('insights.runway.status_exhausted')
                              : t('insights.runway.status_at_risk')}
                          </span>
                        )}
                      </header>
                      {sortRunwayWindows(account.windows).map((window) => (
                        <RunwayWindowBlock
                          key={window.key}
                          window={window}
                          accountName={accountName}
                          windowName={windowName(window)}
                          nowMs={nowMs}
                          locale={locale}
                          unused={unusedAtReset(cycles.get(window.key))}
                          unusedAtMs={cycles.get(window.key)?.resetAtMs ?? null}
                        />
                      ))}
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

interface RunwayWindowBlockProps {
  window: RunwayWindow;
  accountName: string;
  windowName: string;
  nowMs: number;
  locale?: string;
  unused: number | null;
  unusedAtMs: number | null;
}

function RunwayWindowBlock({
  window,
  accountName,
  windowName,
  nowMs,
  locale,
  unused,
  unusedAtMs,
}: RunwayWindowBlockProps) {
  const { t } = useTranslation();
  const description = describeRunway(window, nowMs, locale);
  const { status } = description;
  const danger = status === 'at_risk' || status === 'exhausted';
  const used = window.usedPercent;
  const when = (ms: number | null) => formatWeekdayInstant(ms, nowMs, locale);

  const resetPart = description.resetLabel
    ? t('insights.runway.resets', { time: description.resetLabel })
    : t('insights.runway.no_reset');

  let lead: string;
  if (status === 'unknown') lead = t('insights.runway.no_data');
  else if (status === 'exhausted') lead = t('insights.runway.exhausted');
  else if (status === 'at_risk')
    lead = t('insights.runway.runs_out', { time: description.exhaustLabel ?? '—' });
  else {
    const base = status === 'idle' ? t('insights.runway.burn_idle') : t('insights.runway.lasts');
    lead =
      description.leftAtResetPercent !== null
        ? `${base} · ${t('insights.runway.left_at_reset', {
            percent: formatPercentValue(description.leftAtResetPercent),
          })}`
        : base;
  }

  return (
    <div className={rs.window}>
      <div className={rs.windowHead}>
        <span className={rs.windowLabel}>{windowName}</span>
        <span className={rs.windowUsed}>
          {formatPercentValue(used)}
          <span className={rs.windowUsedUnit}>{t('insights.runway.used')}</span>
        </span>
        <span className={rs.burn}>
          <span className={rs.burnLabel}>{t('insights.runway.burn_rate')}</span>
          {status === 'idle'
            ? t('insights.runway.burn_idle')
            : formatBurnRate(window.burnRatePctPerHour, locale)}
        </span>
      </div>
      <div
        className={rs.meter}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used === null ? undefined : Math.round(Math.min(100, used))}
        aria-label={`${accountName} · ${windowName}`}
      >
        <span
          className={`${rs.meterFill} ${danger ? rs.meterDanger : status === 'idle' || status === 'unknown' ? rs.meterIdle : ''}`}
          style={{ width: `${Math.min(100, Math.max(0, used ?? 0))}%` }}
        />
      </div>
      <p className={`${rs.line} ${danger ? rs.lineDanger : status === 'idle' ? rs.lineMuted : ''}`}>
        {danger && <IconAlertTriangle size={13} aria-hidden="true" />}
        <span>{lead}</span>
        <span aria-hidden="true">·</span>
        <span>{resetPart}</span>
      </p>
      {window.history.length > 0 && (
        <RunwayChart
          window={window}
          nowMs={nowMs}
          status={status}
          label={t('insights.runway.history_label', { window: windowName, account: accountName })}
          formatTime={when}
          pointLabel={(time, percent) => t('insights.runway.chart_point', { time, percent })}
          nowLabel={t('insights.runway.chart_now')}
          resetLabel={
            description.resetLabel
              ? `${t('insights.runway.chart_reset')} ${description.resetLabel}`
              : t('insights.runway.chart_reset')
          }
        />
      )}
      <p className={rs.unused}>
        <span>{t('insights.runway.unused_last')}</span>
        {unused === null ? (
          <span>{t('insights.runway.unused_none')}</span>
        ) : (
          <span className={rs.unusedValue}>
            {t('insights.runway.unused_last_value', {
              percent: formatPercentValue(unused),
              time: when(unusedAtMs),
            })}
          </span>
        )}
      </p>
    </div>
  );
}
