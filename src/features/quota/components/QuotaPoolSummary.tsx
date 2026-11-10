/**
 * Pooled quota per provider: one equal-width cell each, inside one bordered container.
 *
 * The big number is the sum of remaining % across a provider's credentials on its primary
 * (weekly) bucket — "409% of 500%" reads as "about four accounts' worth left". The segmented bar
 * keeps the per-account picture: one segment per credential, coloured by its own remaining.
 */

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { meterTone, type MeterPool, type ProviderPoolSummary } from '../meters';
import { buildResetLine, resolveMeterLabel } from './consoleFormat';
import styles from './QuotaPoolSummary.module.scss';

const TONE_CLASS = {
  high: styles.segHigh,
  medium: styles.segMedium,
  low: styles.segLow,
  unknown: styles.segUnknown,
} as const;

function SegmentedBar({ pool, label }: { pool: MeterPool; label: string }) {
  return (
    <div className={styles.segments} role="img" aria-label={label}>
      {pool.segments.map((value, index) => (
        <span key={index} className={styles.segment}>
          <span
            className={`${styles.segmentFill} ${TONE_CLASS[meterTone(value)]}`}
            style={{ width: `${value === null ? 0 : Math.max(0, Math.min(100, value))}%` }}
          />
        </span>
      ))}
    </div>
  );
}

function ResetText({ atMs, now }: { atMs: number | null; now: number }) {
  const { t, i18n } = useTranslation();
  const line = buildResetLine(atMs, now, i18n.resolvedLanguage);
  if (!line)
    return <span className={styles.resetMuted}>{t('quota_management.no_reset_pending')}</span>;
  return (
    <>
      <span className={styles.resetRelative}>{line.relative}</span>
      <span className={styles.resetSep} aria-hidden="true">
        ·
      </span>
      <span className={styles.resetAbsolute}>{line.absolute}</span>
    </>
  );
}

function PoolCell({
  summary,
  resolvedTheme,
  now,
}: {
  summary: ProviderPoolSummary;
  resolvedTheme: ResolvedTheme;
  now: number;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const { primary, secondary } = summary;
  const iconSrc = getAuthFileIcon(summary.type, resolvedTheme);
  const typeLabel = getTypeLabel(t, summary.type);
  const headline = secondary[0] ?? null;
  const segmentsLabel = t('quota_management.pool_segments');

  return (
    <article className={styles.cell}>
      <header className={styles.cellHead}>
        <span className={styles.provider}>
          <span
            className={styles.iconWrap}
            style={
              isThemeSurfaceIconProvider(summary.type)
                ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
                : undefined
            }
          >
            {iconSrc ? (
              <img src={iconSrc} alt="" className={styles.icon} />
            ) : (
              <span className={styles.iconFallback}>{typeLabel.slice(0, 1).toUpperCase()}</span>
            )}
          </span>
          <span className={styles.providerName}>{typeLabel}</span>
        </span>
        <span className={styles.credentials}>
          {t('quota_management.pool_credentials', { count: summary.credentials })}
        </span>
      </header>

      <div className={styles.bucketLabel}>
        {primary ? resolveMeterLabel(t, primary.label) : t('quota_management.weekly_limit')}
      </div>
      <div className={styles.figure}>
        <span className={styles.figureValue}>
          {primary?.sumRemaining === null || !primary ? '--' : `${primary.sumRemaining}%`}
        </span>
        <span className={styles.figureOf}>
          {t('quota_management.pool_of', { max: summary.credentials * 100 })}
        </span>
      </div>
      {primary ? (
        <SegmentedBar pool={primary} label={segmentsLabel} />
      ) : (
        <div className={styles.segments} aria-hidden="true">
          {Array.from({ length: summary.credentials }, (_, index) => (
            <span key={index} className={styles.segment} />
          ))}
        </div>
      )}
      <div className={styles.reset}>
        <ResetText atMs={primary?.soonestResetMs ?? null} now={now} />
      </div>

      {headline && (
        <div className={styles.secondary}>
          <div className={styles.secondaryRow}>
            <span className={styles.secondaryLabel}>{resolveMeterLabel(t, headline.label)}</span>
            <span className={styles.secondaryValue}>
              {headline.sumRemaining === null ? '--' : `${headline.sumRemaining}%`}
            </span>
            <button
              type="button"
              className={styles.showToggle}
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? t('quota_management.pool_hide') : t('quota_management.pool_show')}
            </button>
          </div>
          {expanded && (
            <ul id={detailsId} className={styles.details}>
              {secondary.map((pool) => (
                <li key={pool.meterId} className={styles.detail}>
                  <div className={styles.detailHead}>
                    <span className={styles.secondaryLabel}>
                      {resolveMeterLabel(t, pool.label)}
                    </span>
                    <span className={styles.detailValue}>
                      {pool.sumRemaining === null ? '--' : `${pool.sumRemaining}%`}
                      <span className={styles.figureOf}>
                        {t('quota_management.pool_of', { max: pool.maxRemaining })}
                      </span>
                    </span>
                  </div>
                  <SegmentedBar pool={pool} label={segmentsLabel} />
                  <div className={styles.reset}>
                    <ResetText atMs={pool.soonestResetMs} now={now} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

export interface QuotaPoolSummaryProps {
  summaries: ProviderPoolSummary[];
  resolvedTheme: ResolvedTheme;
  now: number;
}

export function QuotaPoolSummary({ summaries, resolvedTheme, now }: QuotaPoolSummaryProps) {
  const { t } = useTranslation();
  if (summaries.length === 0) return null;
  return (
    <section className={styles.pool} aria-label={t('quota_management.pool_region')}>
      {summaries.map((summary) => (
        <PoolCell key={summary.type} summary={summary} resolvedTheme={resolvedTheme} now={now} />
      ))}
    </section>
  );
}
