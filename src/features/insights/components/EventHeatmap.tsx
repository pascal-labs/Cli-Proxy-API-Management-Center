import { Fragment, type PointerEvent } from 'react';
import { heatLevel, type HourlyMatrix } from '../logic/events';
import { useHoverTip } from '../hooks/useHoverTip';
import { HoverTip } from './common';
import hs from '../HealthPage.module.scss';
import styles from '../Insights.module.scss';

const LEVEL_CLASS = [hs.heat0, hs.heat1, hs.heat2, hs.heat3, hs.heat4];
const SWATCH_CLASS = [hs.heatSwatch1, hs.heatSwatch2, hs.heatSwatch3, hs.heatSwatch4];
const LEGEND_STEPS = ['1', '2–3', '4–9', '10+'];

interface EventHeatmapProps {
  matrix: HourlyMatrix;
  kindLabel: (kind: string) => string;
  /** Short tick text for an hour start (e.g. "06:00" or "Tue"); null = no tick. */
  tickFor: (hourMs: number, index: number) => string | null;
  cellLabel: (kind: string, hourMs: number, count: number) => string;
  legendLabel: string;
}

/**
 * Kind × hour grid on one sequential ramp (quantized so a single dead login is as visible as a
 * busy hour of rate limits is dark). Hover a cell for its exact count; the table view below the
 * chart carries every value without colour.
 */
export function EventHeatmap({
  matrix,
  kindLabel,
  tickFor,
  cellLabel,
  legendLabel,
}: EventHeatmapProps) {
  const { hostRef, tip, showAt, hide } = useHoverTip();
  const size = matrix.hours.length;

  const handleMove = (kind: string, cells: number[]) => (event: PointerEvent<SVGSVGElement>) => {
    const host = hostRef.current;
    if (!host || size === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const index = Math.min(
      size - 1,
      Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * size))
    );
    const x = rect.left - hostRect.left + ((index + 0.5) / size) * rect.width;
    showAt(x, rect.top - hostRect.top, cellLabel(kind, matrix.hours[index], cells[index]));
  };

  const ticks = matrix.hours
    .map((hour, index) => ({ index, label: tickFor(hour, index) }))
    .filter((tick): tick is { index: number; label: string } => tick.label !== null);

  return (
    <div className={styles.tipHost} ref={hostRef}>
      <div className={hs.heat}>
        {matrix.rows.map((row) => (
          <Fragment key={row.kind}>
            <span className={hs.heatLabel}>
              <span>{kindLabel(row.kind)}</span>
              <span className={hs.heatTotal}>{row.total}</span>
            </span>
            <svg
              className={hs.heatRow}
              viewBox={`0 0 ${size} 1`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`${kindLabel(row.kind)}: ${row.total}`}
              onPointerMove={handleMove(row.kind, row.cells)}
              onPointerLeave={hide}
            >
              {row.cells.map((count, index) => (
                <rect
                  key={matrix.hours[index]}
                  className={LEVEL_CLASS[heatLevel(count)]}
                  x={index + 0.08}
                  y={0}
                  width={0.84}
                  height={1}
                  rx={size > 48 ? 0 : 0.12}
                />
              ))}
            </svg>
          </Fragment>
        ))}
        <span className={hs.heatSpacer} aria-hidden="true" />
        <div className={hs.heatAxis} aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick.index} style={{ left: `${((tick.index + 0.5) / size) * 100}%` }}>
              {tick.label}
            </span>
          ))}
        </div>
      </div>
      <HoverTip tip={tip} />
      <div className={hs.heatLegend} style={{ marginTop: 10 }}>
        <span>{legendLabel}</span>
        {LEGEND_STEPS.map((step, index) => (
          <span key={step} className={hs.heatLegendItem}>
            <span className={`${hs.heatSwatch} ${SWATCH_CLASS[index]}`} aria-hidden="true" />
            {step}
          </span>
        ))}
      </div>
    </div>
  );
}
