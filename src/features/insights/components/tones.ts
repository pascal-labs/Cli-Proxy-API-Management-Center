import styles from '../Insights.module.scss';

export type Tone = 'good' | 'warn' | 'bad' | 'muted';

/** Status ink for a figure (always paired with a label or a band name). */
export const TONE_CLASS: Record<Tone, string> = {
  good: styles.toneGood,
  warn: styles.toneWarn,
  bad: styles.toneBad,
  muted: styles.toneMuted,
};
