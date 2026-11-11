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

/** Categorical colour class for an allocation slot; null is the neutral "Other". */
export const slotClass = (slot: number | null): string =>
  slot === null ? styles.slotOther : (SLOT_CLASS[slot] ?? styles.slotOther);
