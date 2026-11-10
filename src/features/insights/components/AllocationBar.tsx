import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { formatShare } from '../logic/format';
import type { Allocation, AllocationSegment } from '../logic/allocation';
import { useElementWidth } from '../hooks/useElementWidth';
import { useHoverTip } from '../hooks/useHoverTip';
import { HoverTip } from './common';
import styles from '../Insights.module.scss';

const SLOT_CLASS = [
  styles.slot1,
  styles.slot2,
  styles.slot3,
  styles.slot4,
  styles.slot5,
  styles.slot6,
  styles.slot7,
  styles.slot8,
];

const slotClass = (slot: number | null) =>
  slot === null ? styles.slotOther : (SLOT_CLASS[slot] ?? styles.slotOther);

/** A part's share is printed inside only when it fits with room to spare. */
const MIN_LABEL_PX = 44;
const GAP_PX = 2;

interface AllocationBarProps {
  title: string;
  allocation: Allocation;
  formatAmount: (amount: number) => string;
  /** Display name per segment (masking applied by the caller). */
  nameOf: (segment: AllocationSegment) => string;
}

/**
 * Tall segmented bar (one whole, split into parts) with its legend table. Hover or keyboard focus
 * on a part shows its name, amount and share; the table repeats every figure, so nothing depends
 * on telling colours apart.
 */
export function AllocationBar({ title, allocation, formatAmount, nameOf }: AllocationBarProps) {
  const { t } = useTranslation();
  const barRef = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(barRef);
  const { hostRef, tip, showFor, hide } = useHoverTip();
  const { segments } = allocation;
  const usable = Math.max(0, width - GAP_PX * Math.max(0, segments.length - 1));

  const tipContent = (segment: AllocationSegment) => (
    <>
      <strong>{nameOf(segment)}</strong>{' '}
      <span className={styles.tipMuted}>
        {formatAmount(segment.amount)} · {formatShare(segment.share)}
      </span>
    </>
  );

  const describe = (segment: AllocationSegment) =>
    `${nameOf(segment)}: ${formatAmount(segment.amount)} (${formatShare(segment.share)})`;

  return (
    <div className={styles.tipHost} ref={hostRef}>
      <div
        ref={barRef}
        className={styles.allocBar}
        role="group"
        aria-label={t('insights.common.bar_label', {
          title,
          parts: segments.map(describe).join('; '),
        })}
      >
        {segments.map((segment) => {
          const showLabel = segment.share * usable >= MIN_LABEL_PX;
          return (
            <div
              key={segment.key}
              className={`${styles.allocPart} ${slotClass(segment.slot)}`}
              style={{ flexGrow: segment.share, flexBasis: 0 }}
              tabIndex={0}
              aria-label={describe(segment)}
              onMouseEnter={(event) => showFor(event.currentTarget, tipContent(segment))}
              onFocus={(event) => showFor(event.currentTarget, tipContent(segment))}
              onMouseLeave={hide}
              onBlur={hide}
            >
              {showLabel ? formatShare(segment.share) : null}
            </div>
          );
        })}
      </div>
      <HoverTip tip={tip} />
      <table className={styles.legendTable} style={{ marginTop: 12 }}>
        <tbody>
          {segments.map((segment) => (
            <tr key={segment.key}>
              <td className={styles.legendNameCell}>
                <span className={styles.legendName} title={nameOf(segment)}>
                  <span
                    className={`${styles.swatch} ${slotClass(segment.slot)}`}
                    aria-hidden="true"
                  />
                  <span>{nameOf(segment)}</span>
                </span>
              </td>
              <td className={styles.legendAmount}>{formatAmount(segment.amount)}</td>
              <td className={styles.legendShare}>{formatShare(segment.share)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
