import { useMemo, useState, type PointerEvent } from 'react';
import type { RunwayWindow } from '@/services/api/hubInsights';
import { buildRunwayChart, nearestPointIndex, type RunwayStatus } from '../logic/runway';
import styles from '../RunwayPage.module.scss';

const VIEW_W = 300;
const VIEW_H = 64;

interface RunwayChartProps {
  window: RunwayWindow;
  nowMs: number;
  status: RunwayStatus;
  label: string;
  formatTime: (ms: number) => string;
  /** "{{time}} · {{percent}} used" with values filled in. */
  pointLabel: (time: string, percent: string) => string;
  nowLabel: string;
  resetLabel: string;
}

const pct = (value: number, of: number) => `${(value / of) * 100}%`;

/**
 * Used-% history across the window's cycle (start → reset at the right edge), with the current
 * pace dashed ahead of "now". Stretches to its container; dots and labels are HTML so they keep
 * their shape. Hover shows the nearest sample.
 */
export function RunwayChart({
  window,
  nowMs,
  status,
  label,
  formatTime,
  pointLabel,
  nowLabel,
  resetLabel,
}: RunwayChartProps) {
  const geometry = useMemo(() => buildRunwayChart(window, nowMs, VIEW_W, VIEW_H), [window, nowMs]);
  const [hover, setHover] = useState<number | null>(null);
  const danger = status === 'at_risk' || status === 'exhausted';

  const handleMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const index = nearestPointIndex(
      geometry.points,
      ((event.clientX - rect.left) / rect.width) * VIEW_W
    );
    setHover(index >= 0 ? index : null);
  };

  const last = geometry.points[geometry.points.length - 1];
  const hovered = hover !== null ? geometry.points[hover] : null;

  return (
    <div className={`${styles.chart} ${danger ? styles.chartDanger : ''}`}>
      <div
        className={styles.chartPlot}
        onPointerMove={handleMove}
        onPointerLeave={() => setHover(null)}
      >
        <svg
          className={styles.chartSvg}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
        >
          <line
            className={styles.chartLimit}
            x1="0"
            x2={VIEW_W}
            y1={geometry.limitY}
            y2={geometry.limitY}
          />
          <line
            className={styles.chartBase}
            x1="0"
            x2={VIEW_W}
            y1={geometry.baseY}
            y2={geometry.baseY}
          />
          {geometry.nowX !== null && (
            <line
              className={styles.chartNow}
              x1={geometry.nowX}
              x2={geometry.nowX}
              y1="0"
              y2={VIEW_H}
            />
          )}
          {geometry.area && <path className={styles.chartArea} d={geometry.area} />}
          {geometry.line && <path className={styles.chartLine} d={geometry.line} />}
          {geometry.projection && (
            <path className={styles.chartProjection} d={geometry.projection} />
          )}
          {hovered && (
            <line className={styles.chartCursor} x1={hovered.x} x2={hovered.x} y1="0" y2={VIEW_H} />
          )}
        </svg>
        {last && (
          <span
            className={styles.chartDot}
            style={{ left: pct(last.x, VIEW_W), top: pct(last.y, VIEW_H) }}
            aria-hidden="true"
          />
        )}
        {geometry.projectionEnd?.reachesLimit && (
          <span
            className={`${styles.chartDot} ${styles.chartDotEnd}`}
            style={{
              left: pct(geometry.projectionEnd.x, VIEW_W),
              top: pct(geometry.projectionEnd.y, VIEW_H),
            }}
            aria-hidden="true"
          />
        )}
        {hovered && (
          <>
            <span
              className={`${styles.chartDot} ${styles.chartDotHover}`}
              style={{ left: pct(hovered.x, VIEW_W), top: pct(hovered.y, VIEW_H) }}
              aria-hidden="true"
            />
            <span
              className={styles.chartTip}
              style={{ left: `clamp(56px, ${pct(hovered.x, VIEW_W)}, calc(100% - 56px))` }}
              aria-hidden="true"
            >
              {pointLabel(formatTime(hovered.tMs), `${Math.round(hovered.usedPercent)}%`)}
            </span>
          </>
        )}
      </div>
      <div className={styles.chartAxis} aria-hidden="true">
        <span>{formatTime(geometry.startMs)}</span>
        {geometry.nowX !== null && geometry.nowX < VIEW_W * 0.7 && geometry.nowX > VIEW_W * 0.2 && (
          <span className={styles.chartAxisNow} style={{ left: pct(geometry.nowX, VIEW_W) }}>
            {nowLabel}
          </span>
        )}
        <span>{geometry.resetX !== null ? resetLabel : formatTime(geometry.endMs)}</span>
      </div>
    </div>
  );
}
