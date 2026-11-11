/**
 * Box page: `/box/health` normalisation (missing export, junk rows, unknown states) and the page
 * logic — thresholds, unit ordering and counts, the CPU temperature pick and formatting.
 */

import { describe, expect, test } from 'bun:test';
import { normalizeBoxHealth, type BoxUnit } from '@/services/api/hubInsights';
import { buildHubFixture } from '@/services/api/hubInsightsFixtures';
import {
  countUnits,
  cpuTemp,
  diskTone,
  formatGb,
  formatUptime,
  loadTone,
  percentTone,
  seriesPoints,
  sortUnits,
  tempTone,
  unitGroups,
} from '@/features/insights/logic/box';

const GB = 1024 ** 3;

const unit = (name: string, state: BoxUnit['state']): BoxUnit => ({
  name,
  group: name.split(/[-.]/)[0],
  kind: name.slice(name.lastIndexOf('.') + 1),
  description: '',
  state,
  active: '',
  sub: '',
  result: null,
  enabled: null,
  sinceMs: null,
  lastRunMs: null,
  nextRunMs: null,
});

describe('normalizeBoxHealth', () => {
  test('no export is unavailable with its reason', () => {
    const report = normalizeBoxHealth({ available: false, reason: 'no export yet' });
    expect(report.available).toBe(false);
    expect(report.reason).toBe('no export yet');
    expect(report.box).toBeNull();
  });

  test('junk input never throws', () => {
    expect(normalizeBoxHealth(null).available).toBe(false);
    expect(normalizeBoxHealth({ available: true, box: 'x' }).available).toBe(false);
  });

  test('reads the export, drops junk rows and maps unknown unit states to inactive', () => {
    const report = normalizeBoxHealth({
      available: true,
      generated_at: '2026-11-11T12:00:00Z',
      age_seconds: 12,
      stale: false,
      box: {
        host: 'box',
        uptime_seconds: 3600,
        cpu: { cores: 16, util_pct: 12.5, iowait_pct: '0.4' },
        load: { m1: 1.5, m5: 1.2, m15: 1 },
        memory: { total_bytes: 32 * GB, available_bytes: 16 * GB, used_pct: 50 },
        disks: [
          { mount: '/', total_bytes: 100 * GB, free_bytes: 60 * GB, used_pct: 40 },
          { mount: '' },
        ],
        temps: [
          { sensor: 'k10temp', label: 'Tctl', celsius: 60 },
          { sensor: 'x', celsius: 'hot' },
        ],
        units: [
          { name: 'a-loop.service', state: 'running', last_run: null },
          { name: 'a-job.timer', state: 'waiting', next_run: '2026-11-11T12:05:00Z' },
          { name: 'b-x.service', state: 'weird' },
          { state: 'failed' },
        ],
        history: [
          { t: '2026-11-11T11:59:00Z', cpu: 10, mem: 40, load1: 1 },
          { t: '2026-11-11T11:58:00Z', cpu: 20, mem: 41, load1: 1.1 },
          { t: 'never', cpu: 1 },
        ],
      },
    });
    expect(report.available).toBe(true);
    expect(report.ageSeconds).toBe(12);
    const box = report.box!;
    expect(box.cpu.iowaitPct).toBe(0.4);
    expect(box.disks).toHaveLength(1);
    expect(box.temps).toHaveLength(1);
    expect(box.units.map((u) => u.name)).toEqual(['a-loop.service', 'a-job.timer', 'b-x.service']);
    expect(box.units[1].kind).toBe('timer');
    expect(box.units[1].nextRunMs).toBe(Date.parse('2026-11-11T12:05:00Z'));
    expect(box.units[2].state).toBe('inactive');
    expect(box.history.map((p) => p.cpu)).toEqual([20, 10]);
  });

  test('the dev fixture normalises to a full report', () => {
    const report = normalizeBoxHealth(buildHubFixture('/box/health', {}, Date.now()));
    expect(report.available).toBe(true);
    expect(report.box!.history.length).toBeGreaterThan(1000);
    expect(countUnits(report.box!.units).failed).toBe(1);
  });
});

describe('box logic', () => {
  test('thresholds', () => {
    expect(percentTone(null)).toBeUndefined();
    expect(percentTone(84.9)).toBeUndefined();
    expect(percentTone(85)).toBe('warn');
    expect(percentTone(95)).toBe('bad');
    expect(diskTone(25 * GB)).toBeUndefined();
    expect(diskTone(19 * GB)).toBe('warn');
    expect(diskTone(7 * GB)).toBe('bad');
    expect(loadTone(8, 16)).toBeUndefined();
    expect(loadTone(17, 16)).toBe('warn');
    expect(loadTone(40, 16)).toBe('bad');
    expect(loadTone(5, 0)).toBeUndefined();
    expect(tempTone({ celsius: 70, high: null, crit: null })).toBeUndefined();
    expect(tempTone({ celsius: 86, high: null, crit: null })).toBe('warn');
    expect(tempTone({ celsius: 56, high: 55, crit: 85 })).toBe('warn');
    expect(tempTone({ celsius: 95, high: 89.8, crit: 94.8 })).toBe('bad');
  });

  test('cpu temperature prefers the package sensor, else the hottest', () => {
    const temps = [
      { sensor: 'nvme', label: 'Composite', celsius: 80, high: null, crit: null },
      { sensor: 'k10temp', label: 'Tctl', celsius: 60, high: null, crit: null },
    ];
    expect(cpuTemp(temps)?.celsius).toBe(60);
    expect(cpuTemp(temps.slice(0, 1))?.celsius).toBe(80);
    expect(cpuTemp([])).toBeNull();
  });

  test('units: problems first, then by name; counts and groups', () => {
    const units = [
      unit('b-loop.service', 'running'),
      unit('a-job.timer', 'waiting'),
      unit('c-keeper.service', 'stopped'),
      unit('a-job.service', 'failed'),
      unit('b-once.service', 'idle'),
      unit('z-old.service', 'inactive'),
    ];
    const sorted = sortUnits(units);
    expect(sorted.map((u) => u.name)).toEqual([
      'a-job.service',
      'c-keeper.service',
      'b-loop.service',
      'a-job.timer',
      'b-once.service',
      'z-old.service',
    ]);
    expect(countUnits(units)).toEqual({ total: 6, failed: 1, stopped: 1, ok: 3 });
    expect(unitGroups(sorted)).toEqual(['a', 'c', 'b', 'z']);
  });

  test('formatting', () => {
    expect(formatUptime(3 * 86_400 + 5 * 3600 + 60)).toBe('3d 5h');
    expect(formatUptime(5 * 3600 + 12 * 60)).toBe('5h 12m');
    expect(formatUptime(90)).toBe('1m');
    expect(formatUptime(null)).toBe('—');
    expect(formatGb(540 * GB, 'en')).toBe('540 GB');
    expect(formatGb(1.94 * GB, 'en')).toBe('1.9 GB');
  });

  test('series points span the box and clamp to the max', () => {
    const history = [
      { tMs: 0, cpu: 0, mem: null, load1: null },
      { tMs: 50, cpu: 150, mem: null, load1: null },
      { tMs: 100, cpu: 50, mem: null, load1: null },
    ];
    const opts = { width: 200, height: 100, max: 100, startMs: 0, endMs: 100 };
    expect(seriesPoints(history, (p) => p.cpu, opts)).toBe('0.0,100.0 100.0,0.0 200.0,50.0');
    expect(seriesPoints(history, (p) => p.mem, opts)).toBe('');
  });
});
