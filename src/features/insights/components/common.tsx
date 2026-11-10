/**
 * Small shared pieces of the insight pages: KPI strip, provider label, the "update the hub"
 * state, loading skeletons and the hover tooltip.
 */

import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { useThemeStore } from '@/stores';
import type { TipState } from '../hooks/useHoverTip';
import { TONE_CLASS, type Tone } from './tones';
import styles from '../Insights.module.scss';

export interface Kpi {
  key: string;
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}

export function KpiStrip({ items, label }: { items: Kpi[]; label: string }) {
  return (
    <section className={styles.kpis} aria-label={label}>
      {items.map((item) => (
        <div key={item.key} className={styles.kpi}>
          <span className={styles.kpiLabel} title={item.label}>
            {item.label}
          </span>
          <span className={`${styles.kpiValue} ${item.tone ? TONE_CLASS[item.tone] : ''}`}>
            {item.value}
          </span>
          {item.hint && <span className={styles.kpiHint}>{item.hint}</span>}
        </div>
      ))}
    </section>
  );
}

export function ProviderLabel({ provider }: { provider: string }) {
  const { t } = useTranslation();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  if (!provider) return <span>—</span>;
  const iconSrc = getAuthFileIcon(provider, resolvedTheme);
  return (
    <span className={styles.provider}>
      {iconSrc && (
        <span
          className={styles.providerIcon}
          style={
            isThemeSurfaceIconProvider(provider)
              ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
              : undefined
          }
        >
          <img src={iconSrc} alt="" />
        </span>
      )}
      {getTypeLabel(t, provider)}
    </span>
  );
}

/** A 404 from the hub: the endpoint is newer than the running build. */
export function UnsupportedState({ endpoint }: { endpoint: string }) {
  const { t } = useTranslation();
  return (
    <EmptyState
      title={t('insights.common.unsupported_title')}
      description={t('insights.common.unsupported_desc', { endpoint })}
    />
  );
}

export function LoadingSkeleton() {
  return (
    <div className={styles.skeletons} aria-hidden="true">
      <Skeleton height={96} rounded={16} />
      <Skeleton height={260} rounded={16} />
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  const { t } = useTranslation();
  if (!message) return null;
  return (
    <div className={styles.errorBanner} role="alert">
      {t('insights.common.load_failed', { message })}
    </div>
  );
}

export function HoverTip({ tip }: { tip: TipState | null }) {
  if (!tip) return null;
  return (
    <div className={styles.tip} style={{ left: tip.x, top: tip.y }} aria-hidden="true">
      {tip.content}
    </div>
  );
}
