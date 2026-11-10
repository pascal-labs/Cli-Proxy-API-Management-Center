/**
 * Cache & Usage: per-account token and prompt-cache usage from the hub backend.
 *
 * The question this page answers is "are my sessions keeping their prompt cache?". A healthy
 * account reads most of its prompt from cache; a busy account with a low hit ratio usually means
 * consecutive turns of one conversation are landing on different accounts, which the callout
 * points at `routing.session-affinity`.
 */

import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconAlertTriangle, IconEye, IconEyeOff, IconRefreshCw } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { useRevealGroup } from '@/hooks/motion';
import { useShowEmails } from '@/hooks/useShowEmails';
import { USAGE_WINDOWS, type UsageWindow } from '@/services/api';
import { useAuthStore, useThemeStore } from '@/stores';
import { displayAccountName } from '@/utils/accountMask';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { CacheSparkline } from './components/CacheSparkline';
import { useUsageAccounts } from './hooks/useUsageAccounts';
import {
  classifyHitRatio,
  findLowHitAccounts,
  formatCompact,
  formatRatio,
  sortUsageAccounts,
  type HitRatioBand,
} from './logic';
import styles from './UsageCachePage.module.scss';

const BAND_CLASS: Record<HitRatioBand, string> = {
  high: styles.ratioHigh,
  medium: styles.ratioMedium,
  low: styles.ratioLow,
  none: styles.ratioNone,
};

const BAND_LABEL_KEY: Record<Exclude<HitRatioBand, 'none'>, string> = {
  high: 'usage_cache.hit_high',
  medium: 'usage_cache.hit_medium',
  low: 'usage_cache.hit_low',
};

export function UsageCachePage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const [showEmails, setShowEmails] = useShowEmails();
  const [usageWindow, setUsageWindow] = useState<UsageWindow>('24h');
  const revealRef = useRevealGroup<HTMLDivElement>();
  const windowGroupId = useId();
  const windowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const { status, report, lastHour, error, refreshing, reload } = useUsageAccounts(
    usageWindow,
    connected
  );

  const accounts = useMemo(() => sortUsageAccounts(report?.accounts ?? []), [report]);
  const lowHit = useMemo(() => findLowHitAccounts(lastHour?.accounts ?? []), [lastHour]);
  const name = (label: string) => displayAccountName(label, showEmails);
  const fmt = (value: number) => formatCompact(value, locale);

  const selectWindow = (index: number) => {
    const next = USAGE_WINDOWS[(index + USAGE_WINDOWS.length) % USAGE_WINDOWS.length];
    setUsageWindow(next);
    windowRefs.current[USAGE_WINDOWS.indexOf(next)]?.focus();
  };
  const handleWindowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = USAGE_WINDOWS.indexOf(usageWindow);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      selectWindow(current + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      selectWindow(current - 1);
    }
  };

  const totals = report?.totals;
  const totalCells = totals
    ? [
        { key: 'requests', label: t('usage_cache.total_requests'), value: fmt(totals.requests) },
        { key: 'input', label: t('usage_cache.total_input'), value: fmt(totals.inputTokens) },
        { key: 'output', label: t('usage_cache.total_output'), value: fmt(totals.outputTokens) },
        {
          key: 'read',
          label: t('usage_cache.total_cache_read'),
          value: fmt(totals.cacheReadTokens),
        },
        {
          key: 'write',
          label: t('usage_cache.total_cache_write'),
          value: fmt(totals.cacheCreationTokens),
        },
        {
          key: 'ratio',
          label: t('usage_cache.total_hit_ratio'),
          value: formatRatio(totals.cacheHitRatio),
          band: classifyHitRatio(totals.cacheHitRatio),
        },
      ]
    : [];

  return (
    <div className={styles.page} ref={revealRef}>
      <header className={styles.header}>
        <div className={styles.copy}>
          <h1 className={styles.title} data-reveal>
            {t('usage_cache.title')}
          </h1>
          <p className={styles.meta} data-reveal hidden={status === 'unsupported'}>
            <span>{t('usage_cache.meta_accounts', { count: accounts.length })}</span>
            <span className={styles.metaDot} aria-hidden="true">
              ·
            </span>
            <span className={styles.metaAccent}>
              {t('usage_cache.meta_window', { window: t(`usage_cache.window_${usageWindow}`) })}
            </span>
            {report?.generatedAt && (
              <>
                <span className={styles.metaDot} aria-hidden="true">
                  ·
                </span>
                <span className={styles.metaMuted}>
                  {t('usage_cache.updated_at', {
                    time: new Date(report.generatedAt).toLocaleTimeString(locale, {
                      hour: '2-digit',
                      minute: '2-digit',
                    }),
                  })}
                </span>
              </>
            )}
          </p>
        </div>
        <div className={styles.actions} data-reveal>
          <div
            role="radiogroup"
            aria-labelledby={windowGroupId}
            className={styles.segmented}
            onKeyDown={handleWindowKeyDown}
          >
            <span id={windowGroupId} className={styles.srOnly}>
              {t('usage_cache.window_label')}
            </span>
            {USAGE_WINDOWS.map((option, index) => {
              const checked = option === usageWindow;
              return (
                <button
                  key={option}
                  ref={(node) => {
                    windowRefs.current[index] = node;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={checked ? 0 : -1}
                  className={checked ? styles.segmentActive : styles.segment}
                  onClick={() => setUsageWindow(option)}
                >
                  {t(`usage_cache.window_${option}`)}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className={`${styles.secondaryAction} ${showEmails ? styles.secondaryActionOn : ''}`}
            aria-pressed={showEmails}
            title={t('quota_management.show_emails_hint')}
            onClick={() => setShowEmails(!showEmails)}
          >
            {showEmails ? (
              <IconEye size={14} aria-hidden="true" />
            ) : (
              <IconEyeOff size={14} aria-hidden="true" />
            )}
            {t('quota_management.show_emails')}
          </button>
          <button
            type="button"
            className={styles.primaryAction}
            onClick={() => void reload()}
            disabled={!connected || refreshing}
          >
            <IconRefreshCw size={14} className={refreshing ? styles.spinning : undefined} />
            {t('usage_cache.refresh')}
          </button>
        </div>
      </header>

      {status === 'unsupported' ? (
        <EmptyState
          title={t('usage_cache.unsupported_title')}
          description={t('usage_cache.unsupported_desc')}
        />
      ) : status === 'loading' ? (
        <div className={styles.skeletons} aria-hidden="true">
          <Skeleton height={88} rounded={16} />
          <Skeleton height={280} rounded={16} />
        </div>
      ) : (
        <>
          {error && (
            <div className={styles.errorBanner} role="alert">
              {t('usage_cache.load_failed', { message: error })}
            </div>
          )}

          {lowHit.length > 0 && (
            <div className={styles.callout} role="status">
              <IconAlertTriangle size={16} className={styles.calloutIcon} aria-hidden="true" />
              <p className={styles.calloutText}>
                {t('usage_cache.low_hit_callout', {
                  accounts: lowHit.map((account) => name(account.label)).join(', '),
                })}
              </p>
              <Link to="/routing" className={styles.calloutLink}>
                {t('usage_cache.open_routing')}
              </Link>
            </div>
          )}

          {totals && (
            <section className={styles.totals} aria-label={t('usage_cache.title')}>
              {totalCells.map((cell) => (
                <div key={cell.key} className={styles.total}>
                  <span className={styles.totalLabel}>{cell.label}</span>
                  <span
                    className={`${styles.totalValue} ${'band' in cell && cell.band ? BAND_CLASS[cell.band] : ''}`}
                  >
                    {cell.value}
                  </span>
                </div>
              ))}
            </section>
          )}

          {accounts.length === 0 ? (
            status === 'ready' && (
              <EmptyState
                title={t('usage_cache.empty_title')}
                description={t('usage_cache.empty_desc')}
              />
            )
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table} aria-label={t('usage_cache.table_label')}>
                <thead>
                  <tr>
                    <th scope="col">{t('usage_cache.col_account')}</th>
                    <th scope="col">{t('usage_cache.col_provider')}</th>
                    <th scope="col" className={styles.num}>
                      {t('usage_cache.total_requests')}
                    </th>
                    <th scope="col" className={styles.num}>
                      {t('usage_cache.total_cache_read')}
                    </th>
                    <th scope="col" className={styles.num}>
                      {t('usage_cache.total_cache_write')}
                    </th>
                    <th scope="col" className={styles.num}>
                      {t('usage_cache.total_hit_ratio')}
                    </th>
                    <th scope="col" className={styles.trendHead}>
                      {t('usage_cache.col_trend')}
                      <span className={styles.legend} aria-hidden="true">
                        <span className={styles.legendRead} />
                        {t('usage_cache.total_cache_read')}
                        <span className={styles.legendWrite} />
                        {t('usage_cache.total_cache_write')}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((account) => {
                    const band = classifyHitRatio(account.cacheHitRatio);
                    const iconSrc = account.provider
                      ? getAuthFileIcon(account.provider, resolvedTheme)
                      : null;
                    const providerLabel = account.provider
                      ? getTypeLabel(t, account.provider)
                      : '—';
                    const accountName = name(account.label || account.authId || account.authIndex);
                    return (
                      <tr key={`${account.authIndex}:${account.authId}:${account.label}`}>
                        <td className={styles.accountCell}>
                          <span className={styles.accountName} title={accountName}>
                            {accountName}
                          </span>
                        </td>
                        <td>
                          <span className={styles.provider}>
                            {iconSrc && (
                              <span
                                className={styles.providerIcon}
                                style={
                                  isThemeSurfaceIconProvider(account.provider)
                                    ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
                                    : undefined
                                }
                              >
                                <img src={iconSrc} alt="" />
                              </span>
                            )}
                            {providerLabel}
                          </span>
                        </td>
                        <td className={styles.num}>{fmt(account.requests)}</td>
                        <td className={styles.num}>{fmt(account.cacheReadTokens)}</td>
                        <td className={styles.num}>{fmt(account.cacheCreationTokens)}</td>
                        <td className={styles.num}>
                          <span
                            className={`${styles.ratio} ${BAND_CLASS[band]}`}
                            title={band === 'none' ? undefined : t(BAND_LABEL_KEY[band])}
                          >
                            {formatRatio(account.cacheHitRatio)}
                          </span>
                        </td>
                        <td className={styles.trendCell}>
                          <CacheSparkline
                            series={account.series}
                            label={t('usage_cache.sparkline_label', { account: accountName })}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
