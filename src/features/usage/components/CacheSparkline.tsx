import { useMemo } from 'react';
import type { UsageSeriesPoint } from '@/services/api/hub';
import { buildSparkline, densifyHourlySeries } from '../logic';
import styles from '../UsageCachePage.module.scss';

const WIDTH = 120;
const HEIGHT = 28;

/** Hourly cache read (solid) vs cache creation (dashed) on one shared scale. */
export function CacheSparkline({ series, label }: { series: UsageSeriesPoint[]; label: string }) {
  const geometry = useMemo(
    () => buildSparkline(densifyHourlySeries(series), WIDTH, HEIGHT),
    [series]
  );
  if (!geometry.read) {
    return <span className={styles.sparkEmpty} aria-hidden="true" />;
  }
  return (
    <svg
      className={styles.spark}
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={label}
      preserveAspectRatio="none"
    >
      <line className={styles.sparkBase} x1="0" x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} />
      <path className={styles.sparkWrite} d={geometry.write} />
      <path className={styles.sparkRead} d={geometry.read} />
    </svg>
  );
}
