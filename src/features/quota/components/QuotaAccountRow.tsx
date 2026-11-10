/**
 * One credential as a console row: identity | meters | actions, with the full provider body
 * (plan badges, reset grants, credits, extra usage, antigravity groups…) one click away under
 * "Details". The row meters come from the normalized projection in `meters.ts`; the details
 * panel is the provider's own body, so nothing the card view showed is lost.
 */

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown, IconRefreshCw } from '@/components/ui/icons';
import type { ClaudeQuotaState } from '@/types';
import { resolveQuotaErrorMessage } from '@/utils/quota';
import { bindQuotaClasses } from '../types';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import { meterTone, type QuotaMeterSample } from '../meters';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import { ClaudeResetGrantDetails } from '../providers/claude/ClaudeResetGrantDetails';
import { hasClaudeUsageData } from '../providers/claude/data';
import { buildResetLine, formatPercent, resolveMeterLabel } from './consoleFormat';
import bodyStyles from './QuotaBody.module.scss';
import styles from './QuotaAccountRow.module.scss';

const quotaClasses = bindQuotaClasses(bodyStyles, 'QuotaBody.module.scss');

const TONE_CLASS = {
  high: styles.fillHigh,
  medium: styles.fillMedium,
  low: styles.fillLow,
  unknown: styles.fillUnknown,
} as const;

function ConsoleMeter({ meter, now }: { meter: QuotaMeterSample; now: number }) {
  const { t, i18n } = useTranslation();
  const label = resolveMeterLabel(t, meter.label);
  const remaining = meter.remainingPercent;
  const reset = buildResetLine(meter.resetAtMs, now, i18n.resolvedLanguage);
  return (
    <div className={styles.meter}>
      <div className={styles.meterHead}>
        <span className={styles.meterLabel} title={label}>
          {label}
        </span>
        <span className={styles.meterValue}>{formatPercent(remaining)}</span>
      </div>
      <div
        className={styles.track}
        role={remaining === null ? undefined : 'meter'}
        aria-label={remaining === null ? undefined : label}
        aria-valuemin={remaining === null ? undefined : 0}
        aria-valuemax={remaining === null ? undefined : 100}
        aria-valuenow={remaining === null ? undefined : Math.round(remaining)}
      >
        <span
          className={`${styles.fill} ${TONE_CLASS[meterTone(remaining)]}`}
          style={{ width: `${remaining ?? 0}%` }}
        />
      </div>
      <div className={styles.meterReset}>
        {reset ? (
          <>
            <span className={styles.resetRelative}>{reset.relative}</span>
            <span aria-hidden="true">·</span>
            <span>{reset.absolute}</span>
          </>
        ) : (
          <span>{t('quota_management.no_reset_pending')}</span>
        )}
      </div>
    </div>
  );
}

export interface QuotaAccountRowProps {
  entry: QuotaFileEntry;
  quota?: QuotaCardState;
  /** Row meters, primary bucket first. */
  meters: QuotaMeterSample[];
  /** Meters come from the gateway's own snapshot, not a live read. */
  snapshot: boolean;
  displayName: string;
  planLabel: string | null;
  nextUp: boolean;
  now: number;
  canRefresh: boolean;
  resetting: boolean;
  onRefresh: () => void;
  onReset: () => void;
}

export function QuotaAccountRow(props: QuotaAccountRowProps) {
  const {
    entry,
    quota,
    meters,
    snapshot,
    displayName,
    planLabel,
    nextUp,
    now,
    canRefresh,
    resetting,
    onRefresh,
    onReset,
  } = props;
  const { t } = useTranslation();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const adapter = QUOTA_ADAPTERS[entry.type];
  const file = entry.file;
  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const retainedClaudeUsage =
    entry.type === 'claude' && hasClaudeUsageData(quota as ClaudeQuotaState | undefined);

  const claudeReset = useClaudeResetGrants(
    file,
    entry.type === 'claude' && status !== 'idle',
    !canRefresh || loading || resetting,
    quota,
    onRefresh
  );
  const showClaudeReset = entry.type === 'claude' && status === 'success';
  // A reset with no grant to spend is noise in the row; the grant count stays in Details.
  const showClaudeResetAction =
    entry.type === 'claude' &&
    status !== 'idle' &&
    (!claudeReset.blocked || claudeReset.busy || claudeReset.buttonLabel === 'retry');
  const showCodexReset =
    status === 'success' &&
    Boolean(adapter.resetQuota) &&
    quota !== undefined &&
    Boolean(adapter.canResetQuota?.(quota));
  const hasBody = Boolean(quota) && (status === 'success' || retainedClaudeUsage);
  const errorMessage = resolveQuotaErrorMessage(
    t,
    quota?.errorStatus,
    quota?.error || t('common.unknown_error')
  );
  const refreshDisabled = isQuotaRefreshDisabled(
    canRefresh,
    loading,
    resetting || claudeReset.busy
  );

  let metersArea;
  if (meters.length > 0 && !(loading && !retainedClaudeUsage && !snapshot)) {
    metersArea = (
      <div className={styles.meters}>
        {meters.map((meter) => (
          <ConsoleMeter key={meter.id} meter={meter} now={now} />
        ))}
      </div>
    );
  } else if (loading) {
    metersArea = (
      <div className={styles.meters} aria-busy="true">
        <span className={styles.srOnly}>{t(`${adapter.i18nPrefix}.loading`)}</span>
        {[0, 1, 2].map((index) => (
          <div key={index} className={styles.meter} aria-hidden="true">
            <span className={styles.skeletonLabel} />
            <span className={styles.skeletonTrack} />
          </div>
        ))}
      </div>
    );
  } else if (status === 'error') {
    metersArea = (
      <div className={styles.errorStrip} role="alert">
        {t(`${adapter.i18nPrefix}.load_failed`, { message: errorMessage })}
      </div>
    );
  } else if (status === 'success') {
    metersArea = <div className={styles.emptyMeters}>{t('codex_quota.empty_windows')}</div>;
  } else {
    metersArea = (
      <button
        type="button"
        className={styles.loadButton}
        onClick={onRefresh}
        disabled={!canRefresh}
      >
        <IconRefreshCw size={14} aria-hidden="true" />
        {t('quota_management.load_quota')}
      </button>
    );
  }

  return (
    <article className={styles.row}>
      <div className={styles.identity}>
        <div className={styles.nameLine}>
          <span className={styles.name} title={displayName}>
            {displayName}
          </span>
        </div>
        <div className={styles.subLine}>
          {planLabel && <span className={styles.plan}>{planLabel}</span>}
          {nextUp && (
            <span className={styles.nextUp} title={t('quota_management.next_up_hint')}>
              {t('quota_management.next_up')}
            </span>
          )}
          {snapshot && (
            <span className={styles.snapshot} title={t('quota_management.snapshot_hint')}>
              {t('quota_management.snapshot_label')}
            </span>
          )}
        </div>
      </div>

      {metersArea}

      <div className={styles.actions}>
        {showClaudeResetAction && (
          <button
            type="button"
            className={styles.textAction}
            disabled={claudeReset.blocked}
            onClick={claudeReset.confirm}
            title={t(`claude_reset.${claudeReset.buttonLabel}`)}
          >
            <IconRefreshCw size={13} className={claudeReset.busy ? styles.spinning : undefined} />
            {t(`claude_reset.${claudeReset.buttonLabel}`)}
          </button>
        )}
        {showCodexReset && (
          <button
            type="button"
            className={styles.textAction}
            onClick={onReset}
            disabled={!canRefresh || loading || resetting}
            title={t('codex_quota.reset_button')}
          >
            <IconRefreshCw size={13} className={resetting ? styles.spinning : undefined} />
            {t('codex_quota.reset_button')}
          </button>
        )}
        <button
          type="button"
          className={styles.textAction}
          onClick={onRefresh}
          disabled={refreshDisabled}
          title={t('auth_files.quota_refresh_hint')}
        >
          <IconRefreshCw size={13} className={loading ? styles.spinning : undefined} />
          {t('quota_management.refresh_quota')}
        </button>
        {hasBody && (
          <button
            type="button"
            className={`${styles.textAction} ${styles.detailsToggle}`}
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            <IconChevronDown
              size={13}
              aria-hidden="true"
              className={detailsOpen ? styles.chevronOpen : undefined}
            />
            {detailsOpen ? t('quota_management.details_hide') : t('quota_management.details_show')}
          </button>
        )}
      </div>

      {hasBody && detailsOpen && quota && (
        <div id={detailsId} className={styles.details}>
          <adapter.Body
            quota={quota}
            classes={quotaClasses}
            planItems={
              showClaudeReset ? (
                <span className={quotaClasses.codexPlanItem}>
                  <span className={quotaClasses.codexPlanLabel}>{t('claude_reset.remaining')}</span>
                  <span className={quotaClasses.codexPlanValue}>{claudeReset.count ?? '--'}</span>
                </span>
              ) : undefined
            }
            afterPlan={
              showClaudeReset ? (
                <>
                  <ClaudeResetGrantDetails grants={claudeReset.grants} classes={quotaClasses} />
                  {claudeReset.message && (
                    <div role="status" className={quotaClasses.codexResetCreditsError}>
                      {t(`claude_reset.${claudeReset.message}`)}
                    </div>
                  )}
                </>
              ) : undefined
            }
          />
        </div>
      )}
    </article>
  );
}
