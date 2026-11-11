/**
 * Box: the health of the machine the hub runs on — CPU, memory, disk, load, uptime, temperatures,
 * a 24 h CPU/memory trace and the watched systemd user units. The numbers come from an external
 * exporter through `/box/health`; the page refreshes itself every 30 s.
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconAlertTriangle } from '@/components/ui/icons';
import { useRevealGroup } from '@/hooks/motion';
import { useNow } from '@/hooks/useNow';
import { hubInsightsApi, type BoxHealth, type BoxUnit } from '@/services/api';
import { useAuthStore } from '@/stores';
import { InsightsHeader, type MetaItem } from './components/InsightsHeader';
import {
  ErrorBanner,
  KpiStrip,
  LoadingSkeleton,
  UnsupportedState,
  type Kpi,
} from './components/common';
import { TONE_CLASS } from './components/tones';
import { useHubInsight } from './hooks/useHubInsight';
import {
  countUnits,
  cpuTemp,
  diskTone,
  formatCelsius,
  formatGb,
  formatUptime,
  loadTone,
  percentTone,
  seriesPoints,
  sortUnits,
  tempTone,
  unitGroups,
  unitStateTone,
} from './logic/box';
import { formatAgo, formatClock, formatPercentValue } from './logic/format';
import styles from './Insights.module.scss';
import bs from './BoxPage.module.scss';

const POLL_MS = 30_000;
const CHART_W = 720;
const CHART_H = 160;
const HOUR_MS = 3_600_000;

export function BoxPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const revealRef = useRevealGroup<HTMLDivElement>();
  const nowMs = useNow();
  const [group, setGroup] = useState('');

  const load = useCallback(() => hubInsightsApi.getBoxHealth(), []);
  const { status, data, error, refreshing, reload } = useHubInsight(load, connected, POLL_MS);
  const box = data?.box ?? null;

  const units = useMemo(() => sortUnits(box?.units ?? []), [box]);
  const groups = useMemo(() => unitGroups(units), [units]);
  const shownUnits = useMemo(
    () => (group ? units.filter((unit) => unit.group === group) : units),
    [units, group]
  );
  const counts = useMemo(() => countUnits(units), [units]);
  const failed = units.filter((unit) => unit.state === 'failed');

  const meta: MetaItem[] = [];
  if (box) {
    if (box.host) meta.push({ key: 'host', text: box.host, tone: 'accent' });
    if (box.os) meta.push({ key: 'os', text: box.os });
    meta.push({
      key: 'uptime',
      text: t('insights.box.meta_uptime', { uptime: formatUptime(box.uptimeSeconds) }),
    });
    if (data?.stale) meta.push({ key: 'stale', text: t('insights.box.meta_stale'), tone: 'warn' });
  }

  return (
    <div className={styles.page} ref={revealRef}>
      <InsightsHeader
        title={t('insights.box.title')}
        meta={meta}
        generatedAt={data?.generatedAt}
        onRefresh={() => void reload()}
        refreshing={refreshing}
        connected={connected}
      />

      {status === 'unsupported' ? (
        <UnsupportedState endpoint="/box/health" />
      ) : status === 'loading' ? (
        <LoadingSkeleton />
      ) : (
        <>
          <ErrorBanner message={error} />

          {data && !data.available ? (
            <div className={styles.panel}>
              <p className={styles.panelTitle}>{t('insights.box.no_export_title')}</p>
              <p className={styles.panelDesc}>
                {t('insights.box.no_export_desc', { reason: data.reason || '—' })}
              </p>
            </div>
          ) : box ? (
            <>
              {data?.stale && (
                <div className={styles.callout} role="status">
                  <IconAlertTriangle size={16} className={styles.calloutIcon} aria-hidden="true" />
                  <p className={styles.calloutText}>
                    {t('insights.box.stale_alert', {
                      ago: formatAgo(box.generatedAtMs, nowMs, locale),
                    })}
                  </p>
                </div>
              )}
              {failed.length > 0 && (
                <div className={styles.calloutDanger} role="alert">
                  <IconAlertTriangle size={16} className={styles.calloutIcon} aria-hidden="true" />
                  <p className={styles.calloutText}>
                    {t('insights.box.failed_alert', {
                      count: failed.length,
                      units: failed.map((unit) => unit.name).join(', '),
                    })}
                  </p>
                </div>
              )}

              <KpiStrip items={hostKpis(box, t, locale)} label={t('insights.box.kpi_label')} />

              <section className={styles.panel} data-reveal>
                <div className={styles.panelHead}>
                  <div className={styles.panelCopy}>
                    <h2 className={styles.panelTitle}>{t('insights.box.trend_title')}</h2>
                    <p className={styles.panelDesc}>{t('insights.box.trend_desc')}</p>
                  </div>
                  <div className={bs.legend}>
                    <span className={bs.legendItem}>
                      <span className={`${bs.legendLine} ${bs.lineCpu}`} aria-hidden="true" />
                      {t('insights.box.cpu')}
                    </span>
                    <span className={bs.legendItem}>
                      <span className={`${bs.legendLine} ${bs.lineMem}`} aria-hidden="true" />
                      {t('insights.box.memory')}
                    </span>
                  </div>
                </div>
                <TrendChart
                  box={box}
                  nowMs={nowMs}
                  locale={locale}
                  label={t('insights.box.trend_title')}
                />
              </section>

              <div className={styles.grid2}>
                <section className={styles.panel} data-reveal>
                  <div className={styles.panelCopy}>
                    <h2 className={styles.panelTitle}>{t('insights.box.temps_title')}</h2>
                    <p className={styles.panelDesc}>{t('insights.box.temps_desc')}</p>
                  </div>
                  {box.temps.length === 0 ? (
                    <p className={styles.panelEmpty}>{t('insights.box.temps_none')}</p>
                  ) : (
                    <div className={styles.tableWrap}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th>{t('insights.box.sensor')}</th>
                            <th className={styles.num}>{t('insights.box.now')}</th>
                            <th className={styles.num}>{t('insights.box.limit')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {box.temps.map((temp, index) => {
                            const tone = tempTone(temp);
                            return (
                              <tr key={`${temp.sensor}-${temp.label}-${index}`}>
                                <td>
                                  <span className={styles.strong}>{temp.sensor}</span>{' '}
                                  <span className={styles.mono}>{temp.label}</span>
                                </td>
                                <td className={`${styles.num} ${tone ? TONE_CLASS[tone] : ''}`}>
                                  {formatCelsius(temp.celsius)}
                                </td>
                                <td className={styles.num}>
                                  {temp.high === null && temp.crit === null
                                    ? '—'
                                    : [temp.high, temp.crit]
                                        .map((value) =>
                                          value === null ? '—' : formatCelsius(value)
                                        )
                                        .join(' / ')}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                <section className={styles.panel} data-reveal>
                  <div className={styles.panelCopy}>
                    <h2 className={styles.panelTitle}>{t('insights.box.system_title')}</h2>
                  </div>
                  <dl className={bs.facts}>
                    <dt>{t('insights.box.cpu_model')}</dt>
                    <dd>{box.cpu.model || '—'}</dd>
                    <dt>{t('insights.box.cores')}</dt>
                    <dd>{box.cpu.cores || '—'}</dd>
                    <dt>{t('insights.box.kernel')}</dt>
                    <dd className={styles.mono}>{box.kernel || '—'}</dd>
                    <dt>{t('insights.box.swap')}</dt>
                    <dd>
                      {box.memory.swapTotalBytes > 0
                        ? `${formatGb(box.memory.swapUsedBytes, locale)} / ${formatGb(box.memory.swapTotalBytes, locale)}`
                        : '—'}
                    </dd>
                    {box.disks.map((disk) => (
                      <FactPair
                        key={disk.mount}
                        term={t('insights.box.disk_mount', { mount: disk.mount })}
                        value={t('insights.box.disk_detail', {
                          free: formatGb(disk.freeBytes, locale),
                          total: formatGb(disk.totalBytes, locale),
                          used: formatPercentValue(disk.usedPct),
                        })}
                      />
                    ))}
                  </dl>
                </section>
              </div>

              <section className={styles.panel} data-reveal>
                <div className={styles.panelHead}>
                  <div className={styles.panelCopy}>
                    <h2 className={styles.panelTitle}>{t('insights.box.units_title')}</h2>
                    <p className={styles.panelDesc}>
                      {t('insights.box.units_desc', {
                        ok: counts.ok,
                        failed: counts.failed,
                        stopped: counts.stopped,
                      })}
                    </p>
                  </div>
                  {groups.length > 1 && (
                    <div
                      className={bs.chips}
                      role="group"
                      aria-label={t('insights.box.filter_group')}
                    >
                      {['', ...groups].map((name) => (
                        <button
                          key={name || 'all'}
                          type="button"
                          className={`${bs.chip} ${group === name ? bs.chipOn : ''}`}
                          aria-pressed={group === name}
                          onClick={() => setGroup(name)}
                        >
                          {name || t('insights.box.all_groups')}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {shownUnits.length === 0 ? (
                  <p className={styles.panelEmpty}>{t('insights.box.units_none')}</p>
                ) : (
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>{t('insights.box.unit')}</th>
                          <th>{t('insights.box.state')}</th>
                          <th>{t('insights.box.last_run')}</th>
                          <th>{t('insights.box.next_run')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shownUnits.map((unit) => (
                          <UnitRow key={unit.name} unit={unit} nowMs={nowMs} locale={locale} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

function FactPair({ term, value }: { term: string; value: string }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{value}</dd>
    </>
  );
}

function hostKpis(
  box: BoxHealth,
  t: ReturnType<typeof useTranslation>['t'],
  locale: string | undefined
): Kpi[] {
  const root = box.disks.find((disk) => disk.mount === '/') ?? box.disks[0];
  const cpuT = cpuTemp(box.temps);
  const kpis: Kpi[] = [
    {
      key: 'cpu',
      label: t('insights.box.cpu'),
      value: formatPercentValue(box.cpu.utilPct),
      tone: percentTone(box.cpu.utilPct),
      hint: t('insights.box.cpu_hint', {
        cores: box.cpu.cores,
        iowait: formatPercentValue(box.cpu.iowaitPct),
      }),
    },
    {
      key: 'memory',
      label: t('insights.box.memory'),
      value: formatPercentValue(box.memory.usedPct),
      tone: percentTone(box.memory.usedPct),
      hint: t('insights.box.memory_hint', {
        available: formatGb(box.memory.availableBytes, locale),
        total: formatGb(box.memory.totalBytes, locale),
      }),
    },
  ];
  if (root) {
    kpis.push({
      key: 'disk',
      label: t('insights.box.disk_free', { mount: root.mount }),
      value: formatGb(root.freeBytes, locale),
      tone: diskTone(root.freeBytes),
      hint: t('insights.box.disk_hint', {
        used: formatPercentValue(root.usedPct),
        total: formatGb(root.totalBytes, locale),
      }),
    });
  }
  kpis.push({
    key: 'load',
    label: t('insights.box.load'),
    value: box.load.m1 === null ? '—' : box.load.m1.toFixed(2),
    tone: loadTone(box.load.m1, box.cpu.cores),
    hint: t('insights.box.load_hint', {
      m5: box.load.m5?.toFixed(2) ?? '—',
      m15: box.load.m15?.toFixed(2) ?? '—',
    }),
  });
  if (cpuT) {
    kpis.push({
      key: 'temp',
      label: t('insights.box.cpu_temp'),
      value: formatCelsius(cpuT.celsius),
      tone: tempTone(cpuT),
      hint: `${cpuT.sensor} ${cpuT.label}`,
    });
  }
  return kpis;
}

function UnitRow({ unit, nowMs, locale }: { unit: BoxUnit; nowMs: number; locale?: string }) {
  const { t } = useTranslation();
  const tone = unitStateTone(unit.state);
  const tagClass =
    unit.state === 'failed' ? styles.tagDanger : unit.state === 'stopped' ? styles.tagWarn : '';
  const when = (ms: number | null, future = false) => {
    if (ms === null) return '—';
    return future
      ? t('insights.box.in_time', { time: formatClock(ms, locale) })
      : formatAgo(ms, nowMs, locale);
  };
  return (
    <tr>
      <td className={styles.wrapCell}>
        <div className={styles.cellStack}>
          <span className={`${styles.mono} ${styles.strong}`}>{unit.name}</span>
          {unit.description && (
            <span className={`${styles.subLine} ${bs.unitDesc}`} title={unit.description}>
              {unit.description}
            </span>
          )}
        </div>
      </td>
      <td>
        <span className={`${styles.tag} ${tagClass}`}>
          <span
            className={`${bs.stateDot} ${tone ? bs[`dot_${tone}`] : bs.dot_ok}`}
            aria-hidden="true"
          />
          {t(`insights.box.state_${unit.state}`)}
        </span>
        {unit.state === 'failed' && unit.result && (
          <span className={`${styles.subLine} ${styles.mono}`}> {unit.result}</span>
        )}
      </td>
      <td className={styles.num}>
        {when(unit.lastRunMs ?? (unit.kind === 'service' ? null : unit.sinceMs))}
      </td>
      <td className={styles.num}>{when(unit.nextRunMs, true)}</td>
    </tr>
  );
}

function TrendChart({
  box,
  nowMs,
  locale,
  label,
}: {
  box: BoxHealth;
  nowMs: number;
  locale?: string;
  label: string;
}) {
  const { t } = useTranslation();
  const history = box.history;
  if (history.length < 2) {
    return <p className={styles.panelEmpty}>{t('insights.box.trend_empty')}</p>;
  }
  const endMs = Math.max(nowMs, history[history.length - 1].tMs);
  const startMs = Math.min(history[0].tMs, endMs - HOUR_MS);
  const opts = { width: CHART_W, height: CHART_H, max: 100, startMs, endMs };
  const cpu = seriesPoints(history, (point) => point.cpu, opts);
  const mem = seriesPoints(history, (point) => point.mem, opts);
  const ticks: number[] = [];
  const stepMs = endMs - startMs > 6 * HOUR_MS ? 6 * HOUR_MS : HOUR_MS;
  for (let ms = Math.ceil(startMs / stepMs) * stepMs; ms <= endMs; ms += stepMs) ticks.push(ms);
  return (
    <div className={bs.chart}>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        preserveAspectRatio="none"
        className={bs.chartSvg}
        role="img"
        aria-label={label}
      >
        {[25, 50, 75].map((pct) => (
          <line
            key={pct}
            x1={0}
            x2={CHART_W}
            y1={CHART_H - (pct / 100) * CHART_H}
            y2={CHART_H - (pct / 100) * CHART_H}
            className={bs.grid}
          />
        ))}
        <polyline points={mem} className={`${bs.line} ${bs.lineMem}`} />
        <polyline points={cpu} className={`${bs.line} ${bs.lineCpu}`} />
      </svg>
      <div className={bs.yAxis} aria-hidden="true">
        <span>100%</span>
        <span>50%</span>
        <span>0%</span>
      </div>
      <div className={bs.xAxis} aria-hidden="true">
        {ticks.map((ms) => (
          <span key={ms} style={{ left: `${((ms - startMs) / (endMs - startMs)) * 100}%` }}>
            {formatClock(ms, locale)}
          </span>
        ))}
      </div>
    </div>
  );
}
