import { useTranslation } from 'react-i18next';
import { formatUsd, modelLabel, orderedWhatIf } from '../logic/format';
import styles from '../Insights.module.scss';

/**
 * "As run $41.20 · ≈ $20.10 on Opus 5.5 · ≈ $10.05 on Sonnet 5.5": the same Claude tokens at API
 * prices on other models. Estimates only; the caller labels them as such.
 */
export function WhatIfLine({
  actualUsd,
  whatIfUsd,
}: {
  actualUsd: number | null;
  whatIfUsd: Record<string, number>;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const parts = [
    ...(actualUsd !== null
      ? [t('insights.common.what_if_actual', { amount: formatUsd(actualUsd, locale) })]
      : []),
    ...orderedWhatIf(whatIfUsd).map(([model, usd]) =>
      t('insights.common.what_if_on', { amount: formatUsd(usd, locale), model: modelLabel(model) })
    ),
  ];
  return <span className={styles.whatIf}>{parts.join(' · ')}</span>;
}
