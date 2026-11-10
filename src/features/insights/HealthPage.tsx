/**
 * Health: the hub's routing and login events — rate limits, errors, failovers, rebinds, cooldowns,
 * dead logins, recoveries, restarts. Filters by kind and account, an hourly kind × hour grid, the
 * failover/rebind history, and a day-grouped timeline. Logins that died and have not recovered
 * are raised at the top.
 */

import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconAlertTriangle } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { useRevealGroup } from '@/hooks/motion';
import { useNow } from '@/hooks/useNow';
import { useShowEmails } from '@/hooks/useShowEmails';
import {
  EVENT_WINDOWS,
  hubApi,
  hubInsightsApi,
  type EventWindow,
  type UsageEvent,
} from '@/services/api';
import { useAuthStore } from '@/stores';
import { DAY_MS } from '@/utils/time/durations';
import { EventHeatmap } from './components/EventHeatmap';
import { InsightsHeader } from './components/InsightsHeader';
import {
  ErrorBanner,
  KpiStrip,
  LoadingSkeleton,
  UnsupportedState,
  type Kpi,
} from './components/common';
import { settlePart, useHubInsight } from './hooks/useHubInsight';
import { accountName, buildAccountDirectory } from './logic/accounts';
import {
  activeDeadLogins,
  buildHourlyMatrix,
  countEventsByKind,
  eventAccounts,
  filterEvents,
  groupEventsByDay,
  moveHistory,
  orderedEventKinds,
} from './logic/events';
import {
  dayKey,
  formatClock,
  formatDay,
  formatWeekdayInstant,
  maskEmailsInText,
  shortSessionKey,
} from './logic/format';
import styles from './Insights.module.scss';
import hs from './HealthPage.module.scss';

const EVENT_LIMIT = 500;
const MOVES_PAGE = 25;
const TIMELINE_PAGE = 100;
const WINDOW_MS: Record<EventWindow, number> = { '24h': DAY_MS, '7d': 7 * DAY_MS };

const KIND_DOT: Record<string, string> = {
  rate_limited: hs.kindWarn,
  cooldown: hs.kindWarn,
  transient_error: hs.kindBad,
  network_error: hs.kindBad,
  dead_login: hs.kindBad,
  failover: hs.kindMove,
  rebind: hs.kindRebind,
  recovered: hs.kindGood,
};

export function HealthPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [showEmails, setShowEmails] = useShowEmails();
  const [eventWindow, setEventWindow] = useState<EventWindow>('24h');
  const [kinds, setKinds] = useState<ReadonlySet<string>>(() => new Set());
  const [account, setAccount] = useState('');
  const [movesShown, setMovesShown] = useState(MOVES_PAGE);
  const [timelineShown, setTimelineShown] = useState(TIMELINE_PAGE);
  const revealRef = useRevealGroup<HTMLDivElement>();
  const nowMs = useNow();

  const load = useCallback(async () => {
    const [events, runway, accounts] = await Promise.all([
      hubInsightsApi.getEvents(eventWindow, EVENT_LIMIT),
      // Labels only; either source may be missing.
      settlePart(hubInsightsApi.getRunway()),
      settlePart(hubApi.getUsageAccounts('24h')),
    ]);
    return { events, runway: runway.data, accounts: accounts.data };
  }, [eventWindow]);

  const { status, data, error, refreshing, reload } = useHubInsight(load, connected);
  const report = data?.events ?? null;
  const events = useMemo(() => report?.events ?? [], [report]);

  const directory = useMemo(
    () => buildAccountDirectory(data?.runway?.accounts, data?.accounts?.accounts),
    [data]
  );
  const labelOf = useCallback(
    (authIndex: string) =>
      authIndex ? accountName(authIndex, directory, showEmails) : t('insights.health.hub_scope'),
    [directory, showEmails, t]
  );
  const kindLabel = useCallback(
    (kind: string) => {
      const key = `insights.event_kinds.${kind}`;
      const text = t(key);
      return text === key ? kind : text;
    },
    [t]
  );

  const totals = useMemo(() => countEventsByKind(report), [report]);
  const allKinds = useMemo(
    () => orderedEventKinds([...totals.keys(), ...events.map((event) => event.kind)]),
    [totals, events]
  );
  const chipKinds = allKinds.filter((kind) => (totals.get(kind) ?? 0) > 0 || kinds.has(kind));
  const selectedKinds = useMemo(
    () => (kinds.size > 0 ? allKinds.filter((kind) => kinds.has(kind)) : allKinds),
    [kinds, allKinds]
  );

  const filtered = useMemo(
    () => filterEvents(events, { kinds, authIndex: account }),
    [events, kinds, account]
  );
  const byAccount = useMemo(() => filterEvents(events, { authIndex: account }), [events, account]);
  const useEventsForMatrix = Boolean(account) || (report?.counts.length ?? 0) === 0;
  const matrix = useMemo(
    () =>
      buildHourlyMatrix({
        counts: report?.counts,
        events: useEventsForMatrix ? byAccount : undefined,
        windowMs: WINDOW_MS[eventWindow],
        nowMs,
        kinds: selectedKinds,
      }),
    [report, useEventsForMatrix, byAccount, eventWindow, nowMs, selectedKinds]
  );
  const moves = useMemo(() => moveHistory(byAccount), [byAccount]);
  const deadLogins = useMemo(() => activeDeadLogins(events), [events]);
  const days = useMemo(
    () => groupEventsByDay(filtered.slice(0, timelineShown), (ms) => dayKey(ms)),
    [filtered, timelineShown]
  );
  const accountOptions = useMemo(
    () => [
      { value: '', label: t('insights.health.all_accounts') },
      ...eventAccounts(events).map((authIndex) => ({
        value: authIndex,
        label: labelOf(authIndex),
      })),
    ],
    [events, labelOf, t]
  );
  const totalCount = [...totals.values()].reduce((sum, count) => sum + count, 0);
  const truncated = events.length >= EVENT_LIMIT || totalCount > events.length;

  const get = (kind: string) => totals.get(kind) ?? 0;
  const kpis: Kpi[] = [
    {
      key: 'rate',
      label: kindLabel('rate_limited'),
      value: String(get('rate_limited')),
      tone: get('rate_limited') > 0 ? 'warn' : undefined,
      hint: `${kindLabel('cooldown')}: ${get('cooldown')}`,
    },
    {
      key: 'errors',
      label: `${kindLabel('transient_error')} · ${kindLabel('network_error')}`,
      value: `${get('transient_error')} · ${get('network_error')}`,
      tone: get('transient_error') + get('network_error') > 0 ? 'bad' : undefined,
    },
    {
      key: 'moves',
      label: `${kindLabel('failover')} · ${kindLabel('rebind')}`,
      value: `${get('failover')} · ${get('rebind')}`,
    },
    {
      key: 'dead',
      label: kindLabel('dead_login'),
      value: String(get('dead_login')),
      tone: deadLogins.length > 0 ? 'bad' : get('dead_login') > 0 ? 'warn' : 'good',
      hint: `${kindLabel('recovered')}: ${get('recovered')} · ${kindLabel('hub_start')}: ${get('hub_start')}`,
    },
  ];

  const toggleKind = (kind: string) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const tickFor = (hourMs: number) => {
    const date = new Date(hourMs);
    if (eventWindow === '24h') {
      return date.getHours() % 6 === 0 ? formatClock(hourMs, locale) : null;
    }
    return date.getHours() === 0 ? date.toLocaleDateString(locale, { weekday: 'short' }) : null;
  };

  const kindMarker = (kind: string) => (
    <span className={hs.kind}>
      <span className={`${hs.kindDot} ${KIND_DOT[kind] ?? ''}`} aria-hidden="true" />
      {kindLabel(kind)}
    </span>
  );

  const eventMeta = (event: UsageEvent) =>
    [
      event.model,
      event.statusCode !== null ? String(event.statusCode) : '',
      event.sessionKey ? shortSessionKey(event.sessionKey) : '',
    ].filter(Boolean);

  return (
    <div className={styles.page} ref={revealRef}>
      <InsightsHeader
        title={t('insights.health.title')}
        meta={
          status === 'ready'
            ? [
                { key: 'events', text: t('insights.health.meta_events', { count: totalCount }) },
                {
                  key: 'window',
                  text: t('insights.common.meta_window', {
                    window: t(`insights.common.window_${eventWindow}`),
                  }),
                  tone: 'accent',
                },
              ]
            : []
        }
        generatedAt={report?.generatedAt}
        windowControl={{ options: EVENT_WINDOWS, value: eventWindow, onChange: setEventWindow }}
        showEmails={showEmails}
        onShowEmailsChange={setShowEmails}
        onRefresh={() => void reload()}
        refreshing={refreshing}
        connected={connected}
      />

      {status === 'unsupported' ? (
        <UnsupportedState endpoint="/usage/events" />
      ) : status === 'loading' ? (
        <LoadingSkeleton />
      ) : (
        <>
          <ErrorBanner message={error} />

          {deadLogins.map((event) => (
            <div key={event.id} className={styles.calloutDanger} role="alert">
              <IconAlertTriangle size={16} className={styles.calloutIcon} aria-hidden="true" />
              <p className={styles.calloutText}>
                {t('insights.health.dead_login_alert', {
                  account: labelOf(event.authIndex),
                  time: formatWeekdayInstant(event.tMs, nowMs, locale),
                })}
              </p>
              <Link to="/oauth" className={styles.calloutLink}>
                {t('insights.health.open_oauth')}
              </Link>
            </div>
          ))}

          {report && totalCount === 0 && events.length === 0 ? (
            <div className={styles.panel}>
              <p className={styles.panelTitle}>{t('insights.health.empty_title')}</p>
              <p className={styles.panelDesc}>{t('insights.health.empty_desc')}</p>
            </div>
          ) : (
            <>
              <KpiStrip items={kpis} label={t('insights.health.kpi_label')} />

              <div className={hs.filters}>
                <div
                  className={hs.chips}
                  role="group"
                  aria-label={t('insights.health.filter_kinds')}
                >
                  <button
                    type="button"
                    className={`${hs.chip} ${kinds.size === 0 ? hs.chipOn : ''}`}
                    aria-pressed={kinds.size === 0}
                    onClick={() => setKinds(new Set())}
                  >
                    {t('insights.health.all_kinds')}
                    <span className={hs.chipCount}>{totalCount}</span>
                  </button>
                  {chipKinds.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      className={`${hs.chip} ${kinds.has(kind) ? hs.chipOn : ''}`}
                      aria-pressed={kinds.has(kind)}
                      onClick={() => toggleKind(kind)}
                    >
                      <span
                        className={`${hs.kindDot} ${KIND_DOT[kind] ?? ''}`}
                        aria-hidden="true"
                      />
                      {kindLabel(kind)}
                      <span className={hs.chipCount}>{get(kind)}</span>
                    </button>
                  ))}
                </div>
                <span className={hs.spacer} />
                <div className={hs.accountSelect}>
                  <Select
                    value={account}
                    options={accountOptions}
                    onChange={setAccount}
                    ariaLabel={t('insights.health.filter_account')}
                    size="sm"
                  />
                </div>
                {(kinds.size > 0 || account) && (
                  <button
                    type="button"
                    className={styles.secondaryAction}
                    onClick={() => {
                      setKinds(new Set());
                      setAccount('');
                    }}
                  >
                    {t('insights.health.clear_filters')}
                  </button>
                )}
              </div>

              <section className={styles.panel} aria-labelledby="health-hourly">
                <div className={styles.panelCopy}>
                  <h2 className={styles.panelTitle} id="health-hourly">
                    {t('insights.health.hourly_title')}
                  </h2>
                  <p className={styles.panelDesc}>
                    {account
                      ? t('insights.health.hourly_desc_account')
                      : t('insights.health.hourly_desc')}
                  </p>
                </div>
                {matrix.rows.length === 0 ? (
                  <p className={styles.panelEmpty}>{t('insights.health.hourly_empty')}</p>
                ) : (
                  <>
                    <EventHeatmap
                      matrix={matrix}
                      kindLabel={kindLabel}
                      tickFor={tickFor}
                      legendLabel={t('insights.health.hourly_legend')}
                      cellLabel={(kind, hourMs, count) =>
                        t('insights.health.hourly_cell', {
                          kind: kindLabel(kind),
                          time: formatWeekdayInstant(hourMs, nowMs, locale),
                          count,
                        })
                      }
                    />
                    <details className={hs.details}>
                      <summary>{t('insights.health.hourly_table_toggle')}</summary>
                      <div className={hs.detailsBody}>
                        <table className={styles.table}>
                          <thead>
                            <tr>
                              <th scope="col">{t('insights.health.col_hour')}</th>
                              {matrix.rows.map((row) => (
                                <th key={row.kind} scope="col" className={styles.num}>
                                  {kindLabel(row.kind)}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {matrix.hours
                              .map((hour, index) => ({ hour, index }))
                              .filter(({ index }) =>
                                matrix.rows.some((row) => row.cells[index] > 0)
                              )
                              .reverse()
                              .map(({ hour, index }) => (
                                <tr key={hour}>
                                  <td>{formatWeekdayInstant(hour, nowMs, locale)}</td>
                                  {matrix.rows.map((row) => (
                                    <td key={row.kind} className={styles.num}>
                                      {row.cells[index] || ''}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  </>
                )}
              </section>

              <section className={styles.panel} aria-labelledby="health-moves">
                <div className={styles.panelCopy}>
                  <h2 className={styles.panelTitle} id="health-moves">
                    {t('insights.health.moves_title')}
                  </h2>
                  <p className={styles.panelDesc}>{t('insights.health.moves_desc')}</p>
                </div>
                {moves.length === 0 ? (
                  <p className={styles.panelEmpty}>{t('insights.health.moves_empty')}</p>
                ) : (
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th scope="col">{t('insights.health.col_time')}</th>
                          <th scope="col">{t('insights.health.col_kind')}</th>
                          <th scope="col">{t('insights.health.col_account')}</th>
                          <th scope="col">{t('insights.health.col_model')}</th>
                          <th scope="col" className={styles.num}>
                            {t('insights.health.col_status')}
                          </th>
                          <th scope="col">{t('insights.health.col_session')}</th>
                          <th scope="col">{t('insights.health.col_detail')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {moves.slice(0, movesShown).map((event) => (
                          <tr key={event.id}>
                            <td className={styles.mono}>
                              {formatWeekdayInstant(event.tMs, nowMs, locale)}
                            </td>
                            <td>{kindMarker(event.kind)}</td>
                            <td>
                              <span className={styles.accountName}>{labelOf(event.authIndex)}</span>
                            </td>
                            <td className={styles.mono}>{event.model || '—'}</td>
                            <td className={styles.num}>{event.statusCode ?? '—'}</td>
                            <td className={styles.mono}>
                              {event.sessionKey ? shortSessionKey(event.sessionKey) : '—'}
                            </td>
                            <td className={styles.wrapCell}>
                              {maskEmailsInText(event.detail, showEmails) || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {moves.length > movesShown && (
                  <div className={styles.moreRow}>
                    <button
                      type="button"
                      className={styles.secondaryAction}
                      onClick={() => setMovesShown((count) => count + MOVES_PAGE * 4)}
                    >
                      {t('insights.health.show_more', {
                        count: Math.min(MOVES_PAGE * 4, moves.length - movesShown),
                      })}
                    </button>
                  </div>
                )}
              </section>

              <section className={styles.panel} aria-labelledby="health-timeline">
                <div className={styles.panelCopy}>
                  <h2 className={styles.panelTitle} id="health-timeline">
                    {t('insights.health.timeline_title')}
                  </h2>
                </div>
                {filtered.length === 0 ? (
                  <p className={styles.panelEmpty}>{t('insights.health.timeline_empty')}</p>
                ) : (
                  <div className={hs.timeline}>
                    {days.map((day) => (
                      <div key={day.key}>
                        <div className={hs.day}>{formatDay(day.events[0].tMs, locale)}</div>
                        {day.events.map((event) => (
                          <div
                            key={event.id}
                            className={`${hs.event} ${event.kind === 'dead_login' ? hs.eventDead : ''}`}
                          >
                            <span className={hs.eventTime}>{formatClock(event.tMs, locale)}</span>
                            {kindMarker(event.kind)}
                            <span className={hs.eventAccount} title={labelOf(event.authIndex)}>
                              {labelOf(event.authIndex)}
                            </span>
                            <span className={hs.eventDetail}>
                              <span>{maskEmailsInText(event.detail, showEmails)}</span>
                              {eventMeta(event).length > 0 && (
                                <span className={hs.eventMeta}>{eventMeta(event).join(' · ')}</span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    ))}
                    {filtered.length > timelineShown && (
                      <div className={styles.moreRow}>
                        <button
                          type="button"
                          className={styles.secondaryAction}
                          onClick={() => setTimelineShown((count) => count + TIMELINE_PAGE * 2)}
                        >
                          {t('insights.health.show_more', {
                            count: Math.min(TIMELINE_PAGE * 2, filtered.length - timelineShown),
                          })}
                        </button>
                      </div>
                    )}
                    {truncated && (
                      <p className={hs.timelineNote}>
                        {t('insights.health.timeline_truncated', { count: events.length })}
                      </p>
                    )}
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
