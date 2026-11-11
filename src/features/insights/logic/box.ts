/**
 * Box page logic: thresholds that colour the host figures, unit ordering and counts, the CPU
 * temperature pick, and byte/uptime formatting. Pure, so it is unit-tested.
 */

import type { BoxHealth, BoxTemp, BoxUnit, BoxUnitState } from '@/services/api';
import type { Tone } from '../components/tones';

const GB = 1024 ** 3;

/** Percent busy (CPU, memory): warn from 85%, bad from 95%. */
export function percentTone(pct: number | null): Tone | undefined {
  if (pct === null) return undefined;
  if (pct >= 95) return 'bad';
  if (pct >= 85) return 'warn';
  return undefined;
}

/** Free disk: warn under 20 GB, bad under 8 GB (the desk heartbeat's thresholds). */
export function diskTone(freeBytes: number): Tone | undefined {
  if (freeBytes < 8 * GB) return 'bad';
  if (freeBytes < 20 * GB) return 'warn';
  return undefined;
}

/** Load per core: warn above 1.0 (more runnable work than cores), bad above 2.0. */
export function loadTone(load: number | null, cores: number): Tone | undefined {
  if (load === null || cores <= 0) return undefined;
  const perCore = load / cores;
  if (perCore > 2) return 'bad';
  if (perCore > 1) return 'warn';
  return undefined;
}

/** A temperature against its sensor limits; without limits, 85/95 °C. */
export function tempTone(temp: Pick<BoxTemp, 'celsius' | 'high' | 'crit'>): Tone | undefined {
  const crit = temp.crit ?? 95;
  const high = temp.high ?? 85;
  if (temp.celsius >= crit) return 'bad';
  if (temp.celsius >= high) return 'warn';
  return undefined;
}

/** The CPU package temperature: k10temp Tctl/Tdie, coretemp Package, else the hottest reading. */
export function cpuTemp(temps: BoxTemp[]): BoxTemp | null {
  const preferred = temps.find(
    (temp) =>
      (temp.sensor === 'k10temp' && /^(tctl|tdie)$/i.test(temp.label)) ||
      (temp.sensor === 'coretemp' && /^package/i.test(temp.label)) ||
      temp.sensor === 'cpu_thermal'
  );
  if (preferred) return preferred;
  return temps.reduce<BoxTemp | null>(
    (hottest, temp) => (hottest === null || temp.celsius > hottest.celsius ? temp : hottest),
    null
  );
}

const STATE_RANK: Record<BoxUnitState, number> = {
  failed: 0,
  stopped: 1,
  starting: 2,
  running: 3,
  waiting: 4,
  idle: 5,
  inactive: 6,
};

/** Problems first (failed, then stopped), then by name. */
export function sortUnits(units: BoxUnit[]): BoxUnit[] {
  return [...units].sort(
    (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.name.localeCompare(b.name)
  );
}

export function unitStateTone(state: BoxUnitState): Tone | undefined {
  if (state === 'failed') return 'bad';
  if (state === 'stopped') return 'warn';
  if (state === 'inactive') return 'muted';
  return undefined;
}

export interface UnitCounts {
  total: number;
  failed: number;
  stopped: number;
  /** Long-running services up, timers waiting, oneshots that last exited cleanly. */
  ok: number;
}

export function countUnits(units: BoxUnit[]): UnitCounts {
  const counts: UnitCounts = { total: units.length, failed: 0, stopped: 0, ok: 0 };
  units.forEach((unit) => {
    if (unit.state === 'failed') counts.failed += 1;
    else if (unit.state === 'stopped') counts.stopped += 1;
    else if (unit.state !== 'inactive') counts.ok += 1;
  });
  return counts;
}

/** Unit groups (name prefixes) in first-seen order of the sorted list. */
export function unitGroups(units: BoxUnit[]): string[] {
  return [...new Set(units.map((unit) => unit.group).filter(Boolean))];
}

export function formatGb(bytes: number, locale?: string): string {
  const gb = bytes / GB;
  return `${gb.toLocaleString(locale, { maximumFractionDigits: gb >= 100 ? 0 : 1 })} GB`;
}

/** `3d 5h`, `5h 12m`, `12m`. */
export function formatUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatCelsius(celsius: number | null): string {
  return celsius === null ? '—' : `${celsius.toFixed(0)} °C`;
}

/** Points of one series as SVG polyline coordinates in a width × height box, 0–max on y. */
export function seriesPoints(
  history: BoxHealth['history'],
  pick: (point: BoxHealth['history'][number]) => number | null,
  {
    width,
    height,
    max,
    startMs,
    endMs,
  }: { width: number; height: number; max: number; startMs: number; endMs: number }
): string {
  const span = Math.max(1, endMs - startMs);
  return history
    .map((point) => {
      const value = pick(point);
      if (value === null) return null;
      const x = ((point.tMs - startMs) / span) * width;
      const y = height - (Math.min(value, max) / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter((entry): entry is string => entry !== null)
    .join(' ');
}
