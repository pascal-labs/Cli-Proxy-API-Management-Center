/**
 * Model mix: each model's share of tokens or API value, overall and per account, on one shared
 * colour assignment so a model keeps its colour from bar to bar. Labelled as API-price estimates:
 * subscription limits are what actually bind.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ModelUsageRow, UsageSession } from '@/services/api/hubInsights';
import {
  ALLOCATION_SLOTS,
  assignAllocationSlots,
  buildAllocation,
  OTHER_KEY,
  type Allocation,
  type AllocationItem,
  type AllocationMetric,
  type AllocationSegment,
} from '../logic/allocation';
import { formatCompactNumber, formatShare, formatUsd, modelLabel } from '../logic/format';
import { aggregateByModel, modelMixByAccount } from '../logic/models';
import { sessionMetrics } from '../logic/threads';
import { Segmented } from './Segmented';
import { slotClass } from './slots';
import { WhatIfLine } from './WhatIf';
import styles from '../Insights.module.scss';

const METRICS: readonly AllocationMetric[] = ['tokens', 'value'];

/** Thin stacked bar; the figures are repeated as text beside it, so the bar is one image. */
export function MixBar({
  allocation,
  label,
  nameOf,
  small = false,
}: {
  allocation: Allocation;
  label: string;
  nameOf: (segment: AllocationSegment) => string;
  small?: boolean;
}) {
  const parts = allocation.segments
    .map((segment) => `${nameOf(segment)} ${formatShare(segment.share)}`)
    .join(', ');
  return (
    <span
      className={`${styles.mixBar} ${small ? styles.mixBarSmall : ''}`}
      role="img"
      aria-label={`${label}: ${parts}`}
    >
      {allocation.segments.map((segment) => (
        <span
          key={segment.key}
          className={`${styles.mixPart} ${slotClass(segment.slot)}`}
          style={{ flexGrow: segment.share, flexBasis: 0 }}
          title={`${nameOf(segment)} · ${formatShare(segment.share)}`}
        />
      ))}
    </span>
  );
}

interface ModelMixPanelProps {
  rows: readonly ModelUsageRow[];
  unpricedModels: readonly string[];
  /** Sessions in the same window, for the what-if line; null when that endpoint is missing. */
  sessions: readonly UsageSession[] | null;
  accountName: (authIndex: string) => string;
}

export function ModelMixPanel({ rows, unpricedModels, sessions, accountName }: ModelMixPanelProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const [metric, setMetric] = useState<AllocationMetric>('tokens');

  const overall = useMemo(() => aggregateByModel(rows, unpricedModels), [rows, unpricedModels]);
  const accounts = useMemo(() => modelMixByAccount(rows, unpricedModels), [rows, unpricedModels]);
  const items = (models: typeof overall): AllocationItem[] =>
    models.map((model) => ({
      key: model.model,
      label: modelLabel(model.model),
      tokens: model.tokens,
      value: model.apiValueUsd,
    }));
  const overallItems = items(overall);
  const slots = assignAllocationSlots(overallItems);
  const lines = [
    {
      key: '__all__',
      name: t('insights.inference.mix_all_accounts'),
      allocation: buildAllocation(overallItems, metric, ALLOCATION_SLOTS, slots),
      strong: true,
    },
    ...accounts.map((account) => ({
      key: account.authIndex,
      name: accountName(account.authIndex),
      allocation: buildAllocation(items(account.models), metric, ALLOCATION_SLOTS, slots),
      strong: false,
    })),
  ].filter((line) => line.allocation.segments.length > 0);

  const legend = overall
    .filter((model) => slots.has(model.model))
    .sort((a, b) => (slots.get(a.model) ?? 0) - (slots.get(b.model) ?? 0));
  const folded = overall.length - legend.length;
  const segmentName = (segment: AllocationSegment) =>
    segment.key === OTHER_KEY
      ? t('insights.common.other_count', { count: segment.folded })
      : segment.label;
  const amount = (value: number) =>
    metric === 'tokens' ? formatCompactNumber(value, locale) : formatUsd(value, locale);
  const whatIf = useMemo(() => (sessions ? sessionMetrics(sessions) : null), [sessions]);

  return (
    <section className={styles.panel} aria-labelledby="inference-mix">
      <div className={styles.panelHead}>
        <div className={styles.panelCopy}>
          <h2 className={styles.panelTitle} id="inference-mix">
            {t('insights.inference.mix_title')}
          </h2>
          <p className={styles.panelDesc}>
            {metric === 'tokens'
              ? t('insights.inference.mix_desc_tokens')
              : t('insights.inference.mix_desc_value')}
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
      {lines.length === 0 ? (
        <p className={styles.panelEmpty}>{t('insights.common.empty')}</p>
      ) : (
        <>
          <ul className={styles.mixLegend} aria-label={t('insights.inference.mix_legend')}>
            {legend.map((model) => (
              <li key={model.model} className={styles.mixLegendItem} title={model.model}>
                <span
                  className={`${styles.swatch} ${slotClass(slots.get(model.model) ?? null)}`}
                  aria-hidden="true"
                />
                {modelLabel(model.model)}
                {unpricedModels.includes(model.model) && (
                  <span className={styles.toneMuted}>({t('insights.common.unpriced')})</span>
                )}
              </li>
            ))}
            {folded > 0 && (
              <li className={styles.mixLegendItem}>
                <span className={`${styles.swatch} ${styles.slotOther}`} aria-hidden="true" />
                {t('insights.common.other_count', { count: folded })}
              </li>
            )}
          </ul>
          <div className={styles.tableWrap}>
            <table className={`${styles.table} ${styles.mixTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('insights.common.account')}</th>
                  <th scope="col" className={styles.mixBarHead}>
                    {t('insights.inference.mix_split')}
                  </th>
                  <th scope="col">{t('insights.inference.mix_top')}</th>
                  <th scope="col" className={styles.num}>
                    {metric === 'tokens'
                      ? t('insights.common.tokens')
                      : t('insights.common.api_value')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.key}>
                    <th scope="row" className={styles.mixName}>
                      <span
                        className={line.strong ? styles.strong : styles.accountName}
                        title={line.name}
                      >
                        {line.name}
                      </span>
                    </th>
                    <td className={styles.mixBarCell}>
                      <MixBar allocation={line.allocation} label={line.name} nameOf={segmentName} />
                    </td>
                    <td>
                      {line.allocation.segments
                        .slice(0, 2)
                        .map((segment) => `${segmentName(segment)} ${formatShare(segment.share)}`)
                        .join(' · ')}
                    </td>
                    <td className={`${styles.num} ${line.strong ? styles.strong : ''}`}>
                      {amount(line.allocation.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {whatIf?.whatIfUsd && (
        <p className={styles.panelNote}>
          <span className={styles.estimateTag}>{t('insights.common.api_estimate')}</span>{' '}
          {t('insights.inference.mix_what_if_lead')}{' '}
          <WhatIfLine actualUsd={whatIf.claudeValueUsd} whatIfUsd={whatIf.whatIfUsd} />
        </p>
      )}
      <p className={styles.panelNote}>
        {t('insights.common.limits_note')}{' '}
        <Link to="/runway" className={styles.textLink}>
          {t('insights.inference.open_runway')}
        </Link>
      </p>
      <p className={styles.panelNote}>
        {t('insights.common.reading_hint')}{' '}
        <Link to="/threads" className={styles.textLink}>
          {t('insights.inference.mix_threads_link')}
        </Link>
      </p>
    </section>
  );
}
