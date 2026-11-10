import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconEye, IconEyeOff, IconRefreshCw } from '@/components/ui/icons';
import { readHubFixtureMode } from '@/services/api/hubInsightsFixtureMode';
import { Segmented } from './Segmented';
import styles from '../Insights.module.scss';

export interface MetaItem {
  key: string;
  text: string;
  tone?: 'accent' | 'warn' | 'muted';
}

interface WindowControl<T extends string> {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}

interface InsightsHeaderProps<T extends string> {
  title: string;
  meta?: MetaItem[];
  generatedAt?: string | null;
  windowControl?: WindowControl<T>;
  showEmails: boolean;
  onShowEmailsChange: (next: boolean) => void;
  onRefresh: () => void;
  refreshing: boolean;
  connected: boolean;
  extra?: ReactNode;
}

const TONE_CLASS = {
  accent: styles.metaAccent,
  warn: styles.metaWarn,
  muted: styles.metaMuted,
} as const;

/** Title, mono meta row, window switch, Show emails and Refresh — the Cache & Usage header. */
export function InsightsHeader<T extends string>({
  title,
  meta = [],
  generatedAt,
  windowControl,
  showEmails,
  onShowEmailsChange,
  onRefresh,
  refreshing,
  connected,
  extra,
}: InsightsHeaderProps<T>) {
  const { t, i18n } = useTranslation();
  // DEV only: statically null in production builds, so the badge (and the reader) never ship.
  const fixtureMode = import.meta.env.DEV ? readHubFixtureMode() : null;

  const items: MetaItem[] = [...meta];
  if (generatedAt) {
    const time = new Date(generatedAt).toLocaleTimeString(i18n.resolvedLanguage, {
      hour: '2-digit',
      minute: '2-digit',
    });
    items.push({ key: 'updated', text: t('insights.common.updated_at', { time }), tone: 'muted' });
  }

  return (
    <header className={styles.header}>
      <div className={styles.copy}>
        <div className={styles.titleRow}>
          <h1 className={styles.title} data-reveal>
            {title}
          </h1>
          {fixtureMode && (
            <span className={styles.fixtureBadge} title={t('insights.common.fixture_hint')}>
              {t('insights.common.fixture_badge')}
            </span>
          )}
        </div>
        {items.length > 0 && (
          <p className={styles.meta} data-reveal>
            {items.map((item, index) => (
              <Fragment key={item.key}>
                {index > 0 && (
                  <span className={styles.metaDot} aria-hidden="true">
                    ·
                  </span>
                )}
                <span className={item.tone ? TONE_CLASS[item.tone] : undefined}>{item.text}</span>
              </Fragment>
            ))}
          </p>
        )}
      </div>
      <div className={styles.actions} data-reveal>
        {extra}
        {windowControl && (
          <Segmented
            options={windowControl.options}
            value={windowControl.value}
            onChange={windowControl.onChange}
            label={t('insights.common.window_label')}
            renderOption={(option) => t(`insights.common.window_${option}`)}
          />
        )}
        <button
          type="button"
          className={`${styles.secondaryAction} ${showEmails ? styles.secondaryActionOn : ''}`}
          aria-pressed={showEmails}
          title={t('quota_management.show_emails_hint')}
          onClick={() => onShowEmailsChange(!showEmails)}
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
          onClick={onRefresh}
          disabled={!connected || refreshing}
        >
          <IconRefreshCw size={14} className={refreshing ? styles.spinning : undefined} />
          {t('insights.common.refresh')}
        </button>
      </div>
    </header>
  );
}
