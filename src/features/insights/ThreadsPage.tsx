/**
 * Threads: usage per T3 thread (falling back to the client's session title, the project, then the
 * session key), with subagents nested under their parent (by T3 thread, else by the native session
 * id their `…:agent:…` key shares). Sortable, searchable, optionally grouped by project. Threads
 * whose prompt cache keeps going cold are flagged: they burn quota rebuilding the same context.
 * Each thread opens to its model split and what the same Claude tokens would cost on Opus 5.5 or
 * Sonnet 5.5 at API prices.
 */

import { Fragment, useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronUp,
  IconSearch,
} from '@/components/ui/icons';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useRevealGroup } from '@/hooks/motion';
import { useNow } from '@/hooks/useNow';
import { useShowEmails } from '@/hooks/useShowEmails';
import { hubApi, hubInsightsApi, INSIGHT_WINDOWS, type InsightWindow } from '@/services/api';
import { useAuthStore } from '@/stores';
import { classifyHitRatio, formatRatio } from '@/features/usage/logic';
import { InsightsHeader } from './components/InsightsHeader';
import {
  ErrorBanner,
  KpiStrip,
  LoadingSkeleton,
  UnsupportedState,
  type Kpi,
} from './components/common';
import { MixBar } from './components/ModelMix';
import { slotClass } from './components/slots';
import { TONE_CLASS } from './components/tones';
import { WhatIfLine } from './components/WhatIf';
import { settlePart, useHubInsight } from './hooks/useHubInsight';
import { accountName, buildAccountDirectory } from './logic/accounts';
import {
  ALLOCATION_SLOTS,
  assignAllocationSlots,
  buildAllocation,
  OTHER_KEY,
  type AllocationSegment,
} from './logic/allocation';
import {
  formatAgo,
  formatCompactNumber,
  formatShare,
  formatUsd,
  formatWeekdayInstant,
  modelLabel,
} from './logic/format';
import {
  buildThreadRows,
  countWastefulThreads,
  defaultSortDirection,
  filterThreadRows,
  groupThreadRowsByProject,
  isSubagentSession,
  readingProfile,
  sessionMetrics,
  sortThreadRows,
  type SortDirection,
  type ThreadMetrics,
  type ThreadRow,
  type ThreadSortKey,
} from './logic/threads';
import styles from './Insights.module.scss';
import ts from './ThreadsPage.module.scss';

const HIT_TONE = { high: 'good', medium: 'warn', low: 'bad', none: 'muted' } as const;

const COLUMNS: Array<{ key: ThreadSortKey; label: string; numeric?: boolean }> = [
  { key: 'title', label: 'insights.threads.col_thread' },
  { key: 'project', label: 'insights.threads.col_project' },
  { key: 'client', label: 'insights.threads.col_client' },
  { key: 'accounts', label: 'insights.threads.col_accounts' },
  { key: 'lastActive', label: 'insights.threads.col_last_active' },
  { key: 'requests', label: 'insights.threads.col_requests', numeric: true },
  { key: 'tokens', label: 'insights.threads.col_tokens', numeric: true },
  { key: 'cacheHit', label: 'insights.threads.col_cache_hit', numeric: true },
  { key: 'coldWrites', label: 'insights.threads.col_cold_writes', numeric: true },
  { key: 'value', label: 'insights.threads.col_value', numeric: true },
];

export function ThreadsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [showEmails, setShowEmails] = useShowEmails();
  const [usageWindow, setUsageWindow] = useState<InsightWindow>('7d');
  const [query, setQuery] = useState('');
  const [groupByProject, setGroupByProject] = useState(false);
  const [sort, setSort] = useState<{ key: ThreadSortKey; direction: SortDirection }>({
    key: 'lastActive',
    direction: 'desc',
  });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [details, setDetails] = useState<ReadonlySet<string>>(() => new Set());
  const revealRef = useRevealGroup<HTMLDivElement>();
  const nowMs = useNow();

  const load = useCallback(async () => {
    const [sessions, runway, accounts] = await Promise.all([
      hubInsightsApi.getSessions(usageWindow, 500),
      // Labels only: sessions carry auth indexes, not file names. Either source may be missing.
      settlePart(hubInsightsApi.getRunway()),
      settlePart(hubApi.getUsageAccounts('24h')),
    ]);
    return { sessions, runway: runway.data, accounts: accounts.data };
  }, [usageWindow]);

  const { status, data, error, refreshing, reload } = useHubInsight(load, connected);

  const directory = useMemo(
    () => buildAccountDirectory(data?.runway?.accounts, data?.accounts?.accounts),
    [data]
  );
  const labelOf = useCallback(
    (authIndex: string) => accountName(authIndex, directory, showEmails),
    [directory, showEmails]
  );

  const rows = useMemo(() => buildThreadRows(data?.sessions.sessions ?? []), [data]);
  const filtered = useMemo(() => filterThreadRows(rows, query), [rows, query]);
  const sorted = useMemo(
    () => sortThreadRows(filtered, sort.key, sort.direction, labelOf),
    [filtered, sort, labelOf]
  );
  const groups = useMemo(
    () =>
      groupByProject ? groupThreadRowsByProject(filtered, sort.key, sort.direction, labelOf) : null,
    [filtered, groupByProject, sort, labelOf]
  );
  const overall = useMemo(() => sessionMetrics(data?.sessions.sessions ?? []), [data]);
  const wasteful = useMemo(() => countWastefulThreads(rows), [rows]);
  const subagentCount = useMemo(
    () => (data?.sessions.sessions ?? []).filter(isSubagentSession).length,
    [data]
  );
  // One colour per model across every thread, assigned by overall token volume.
  const modelSlots = useMemo(
    () =>
      assignAllocationSlots(
        overall.models.map((model) => ({
          key: model.model,
          label: model.model,
          tokens: model.tokens,
          value: model.apiValueUsd,
        }))
      ),
    [overall]
  );
  const hasModelSplit = overall.models.length > 0;

  const parentIds = useMemo(
    () => rows.filter((row) => row.children.length > 0).map((row) => row.id),
    [rows]
  );
  const searching = query.trim().length > 0;
  const allExpanded = parentIds.length > 0 && parentIds.every((id) => expanded.has(id));
  const isOpen = (row: ThreadRow) => searching || expanded.has(row.id);
  const flip = (prev: ReadonlySet<string>, id: string) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  const toggle = (id: string) => setExpanded((prev) => flip(prev, id));
  const toggleDetail = (id: string) => setDetails((prev) => flip(prev, id));

  const onSort = (key: ThreadSortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: defaultSortDirection(key) }
    );

  const fmt = (value: number) => formatCompactNumber(value, locale);
  const kpis: Kpi[] = [
    {
      key: 'threads',
      label: t('insights.threads.kpi_threads'),
      value: fmt(rows.length),
      hint: t('insights.threads.kpi_threads_hint', {
        sessions: overall.sessions,
        subagents: subagentCount,
      }),
    },
    {
      key: 'value',
      label: t('insights.threads.kpi_value'),
      value: formatUsd(overall.apiValueUsd, locale),
      hint: t('insights.threads.kpi_value_hint'),
    },
    {
      key: 'cache',
      label: t('insights.threads.kpi_cache'),
      value: formatRatio(overall.cacheHitRatio),
      tone: HIT_TONE[classifyHitRatio(overall.cacheHitRatio)],
      hint: t('insights.threads.kpi_cache_hint'),
    },
    {
      key: 'waste',
      label: t('insights.threads.kpi_wasteful'),
      value: String(wasteful),
      tone: wasteful > 0 ? 'warn' : 'good',
      hint: t('insights.threads.kpi_wasteful_hint'),
    },
  ];

  const segmentName = (segment: AllocationSegment) =>
    segment.key === OTHER_KEY
      ? t('insights.common.other_count', { count: segment.folded })
      : segment.label;

  const renderRow = (row: ThreadRow, child = false): ReactNode => {
    const m = row.metrics;
    const open = isOpen(row);
    const detailOpen = details.has(row.id);
    const detailId = `thread-detail-${row.id}`;
    const mix = buildAllocation(
      m.models.map((model) => ({
        key: model.model,
        label: modelLabel(model.model),
        tokens: model.tokens,
        value: model.apiValueUsd,
      })),
      'tokens',
      ALLOCATION_SLOTS,
      modelSlots
    );
    const lead = mix.segments[0];
    const flagged = row.flags.length > 0;
    const accounts = m.authIndexes.map(labelOf);
    const hitBand = classifyHitRatio(m.cacheHitRatio);
    return (
      <Fragment key={row.id}>
        <tr
          className={[child ? ts.childRow : '', flagged ? ts.flaggedRow : '']
            .filter(Boolean)
            .join(' ')}
        >
          <td>
            <div className={ts.titleWrap}>
              {row.children.length > 0 ? (
                <button
                  type="button"
                  className={`${ts.disclosure} ${open ? ts.disclosureOpen : ''}`}
                  aria-expanded={open}
                  aria-label={t(
                    open ? 'insights.threads.hide_subagents' : 'insights.threads.show_subagents',
                    { title: row.title }
                  )}
                  onClick={() => toggle(row.id)}
                  disabled={searching}
                >
                  <IconChevronDown size={14} aria-hidden="true" />
                </button>
              ) : (
                !child && <span className={ts.disclosureSpacer} aria-hidden="true" />
              )}
              <div className={ts.titleText}>
                <span
                  className={`${ts.title} ${child ? ts.titleChild : ''}`}
                  title={row.cwd ? `${row.title}\n${row.cwd}` : row.title}
                >
                  {row.title}
                </span>
                <ThreadTags row={row} child={child} />
              </div>
            </div>
          </td>
          <td>{row.project ?? <span className={styles.toneMuted}>—</span>}</td>
          <td>{m.clients.join(', ') || '—'}</td>
          <td>
            <span className={ts.accounts} title={accounts.join('\n')}>
              <span className={ts.accountsMain}>{accounts[0] ?? '—'}</span>
              {accounts.length > 1 && (
                <span className={ts.more}>
                  {t('insights.threads.more_accounts', { count: accounts.length - 1 })}
                </span>
              )}
            </span>
          </td>
          <td title={formatWeekdayInstant(m.lastSeenMs, nowMs, locale)}>
            {formatAgo(m.lastSeenMs, nowMs, locale)}
          </td>
          <td className={styles.num}>{fmt(m.requests)}</td>
          <td className={styles.num}>{fmt(m.tokens)}</td>
          <td className={`${styles.num} ${TONE_CLASS[HIT_TONE[hitBand]]}`}>
            {formatRatio(m.cacheHitRatio)}
          </td>
          <td
            className={`${styles.num} ${row.flags.includes('cold_writes') ? styles.toneWarn : ''}`}
          >
            {fmt(m.coldCacheWrites)}
          </td>
          <td className={`${styles.num} ${styles.strong}`}>
            {m.apiValueUsd === null && m.hasUnpriced ? (
              <span className={styles.toneMuted}>{t('insights.common.unpriced')}</span>
            ) : (
              formatUsd(m.apiValueUsd, locale)
            )}
          </td>
          <td>
            {lead ? (
              <button
                type="button"
                className={`${ts.modelsButton} ${detailOpen ? ts.modelsButtonOpen : ''}`}
                aria-expanded={detailOpen}
                aria-controls={detailOpen ? detailId : undefined}
                aria-label={t(
                  detailOpen ? 'insights.threads.hide_models' : 'insights.threads.show_models',
                  { title: row.title }
                )}
                onClick={() => toggleDetail(row.id)}
              >
                <MixBar
                  small
                  allocation={mix}
                  label={t('insights.threads.col_models')}
                  nameOf={segmentName}
                />
                <span className={ts.modelsLead}>
                  {segmentName(lead)} {formatShare(lead.share)}
                </span>
                {mix.segments.length > 1 && (
                  <span className={ts.more}>
                    {t('insights.threads.more_accounts', { count: mix.segments.length - 1 })}
                  </span>
                )}
                <IconChevronDown size={12} aria-hidden="true" className={ts.modelsChevron} />
              </button>
            ) : (
              <span className={styles.toneMuted}>—</span>
            )}
          </td>
        </tr>
        {detailOpen && (
          <tr className={ts.detailRow} id={detailId}>
            <td colSpan={COLUMNS.length + 1}>
              <ThreadModelDetail row={row} slots={modelSlots} />
            </td>
          </tr>
        )}
        {open && row.children.map((kid) => renderRow(kid, true))}
      </Fragment>
    );
  };

  const groupHeader = (title: string, count: number, metrics: ThreadMetrics) => (
    <tr className={ts.groupRow}>
      <th colSpan={COLUMNS.length + 1} scope="rowgroup">
        <span className={ts.groupHead}>
          <span className={ts.groupName}>{title}</span>
          <span className={ts.groupMeta}>
            {t('insights.threads.group_threads', { count })} ·{' '}
            {formatUsd(metrics.apiValueUsd, locale)}
          </span>
        </span>
      </th>
    </tr>
  );

  return (
    <div className={styles.page} ref={revealRef}>
      <InsightsHeader
        title={t('insights.threads.title')}
        meta={
          status === 'ready'
            ? [
                {
                  key: 'threads',
                  text: t('insights.threads.meta_threads', { count: rows.length }),
                },
                {
                  key: 'window',
                  text: t('insights.common.meta_window', {
                    window: t(`insights.common.window_${usageWindow}`),
                  }),
                  tone: 'accent',
                },
              ]
            : []
        }
        generatedAt={data?.sessions.generatedAt}
        windowControl={{ options: INSIGHT_WINDOWS, value: usageWindow, onChange: setUsageWindow }}
        showEmails={showEmails}
        onShowEmailsChange={setShowEmails}
        onRefresh={() => void reload()}
        refreshing={refreshing}
        connected={connected}
      />

      {status === 'unsupported' ? (
        <UnsupportedState endpoint="/usage/sessions" />
      ) : status === 'loading' ? (
        <LoadingSkeleton />
      ) : (
        <>
          <ErrorBanner message={error} />
          {rows.length === 0 ? (
            status === 'ready' && (
              <div className={styles.panel}>
                <p className={styles.panelTitle}>{t('insights.threads.empty_title')}</p>
                <p className={styles.panelDesc}>{t('insights.threads.empty_desc')}</p>
              </div>
            )
          ) : (
            <>
              <KpiStrip items={kpis} label={t('insights.threads.kpi_label')} />

              {wasteful > 0 && (
                <div className={styles.callout} role="status">
                  <IconAlertTriangle size={16} className={styles.calloutIcon} aria-hidden="true" />
                  <p className={styles.calloutText}>
                    {t('insights.threads.waste_callout', { count: wasteful })}
                  </p>
                  <Link to="/routing" className={styles.calloutLink}>
                    {t('insights.common.open_routing')}
                  </Link>
                </div>
              )}

              <div className={ts.toolbar}>
                <label className={ts.search}>
                  <span className={styles.srOnly}>{t('insights.threads.search_label')}</span>
                  <IconSearch size={15} aria-hidden="true" />
                  <input
                    type="search"
                    className={ts.searchInput}
                    value={query}
                    placeholder={t('insights.threads.search_placeholder')}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <ToggleSwitch
                  checked={groupByProject}
                  onChange={setGroupByProject}
                  label={t('insights.threads.group_by_project')}
                />
                <span className={ts.toolbarSpacer} />
                {parentIds.length > 0 && (
                  <button
                    type="button"
                    className={styles.secondaryAction}
                    onClick={() => setExpanded(allExpanded ? new Set() : new Set(parentIds))}
                    disabled={searching}
                  >
                    {allExpanded
                      ? t('insights.threads.collapse_all')
                      : t('insights.threads.expand_all')}
                  </button>
                )}
              </div>

              {hasModelSplit && (
                <p className={styles.panelNote}>
                  <span className={styles.estimateTag}>{t('insights.common.api_estimate')}</span>{' '}
                  {t('insights.threads.models_note')}
                </p>
              )}

              <div className={styles.tableWrap}>
                <table
                  className={`${styles.table} ${ts.table}`}
                  aria-label={t('insights.threads.table_label')}
                >
                  <thead>
                    <tr>
                      {COLUMNS.map((column) => {
                        const active = sort.key === column.key;
                        return (
                          <th
                            key={column.key}
                            scope="col"
                            className={column.numeric ? styles.num : undefined}
                            aria-sort={
                              active
                                ? sort.direction === 'asc'
                                  ? 'ascending'
                                  : 'descending'
                                : undefined
                            }
                          >
                            <button
                              type="button"
                              className={`${ts.sortButton} ${active ? ts.sortActive : ''}`}
                              onClick={() => onSort(column.key)}
                            >
                              {t(column.label)}
                              {active && sort.direction === 'asc' ? (
                                <IconChevronUp size={12} aria-hidden="true" />
                              ) : (
                                <IconChevronDown size={12} aria-hidden="true" />
                              )}
                            </button>
                          </th>
                        );
                      })}
                      <th scope="col">{t('insights.threads.col_models')}</th>
                    </tr>
                  </thead>
                  {filtered.length === 0 ? (
                    <tbody>
                      <tr>
                        <td colSpan={COLUMNS.length + 1} className={ts.noMatch}>
                          {t('insights.threads.no_match', { query: query.trim() })}
                        </td>
                      </tr>
                    </tbody>
                  ) : groups ? (
                    groups.map((group) => (
                      <tbody key={group.id}>
                        {groupHeader(
                          group.project ?? t('insights.threads.no_project'),
                          group.rows.length,
                          group.metrics
                        )}
                        {group.rows.map((row) => renderRow(row))}
                      </tbody>
                    ))
                  ) : (
                    <tbody>{sorted.map((row) => renderRow(row))}</tbody>
                  )}
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function ThreadTags({ row, child }: { row: ThreadRow; child: boolean }) {
  const { t } = useTranslation();
  const tags: ReactNode[] = [];
  if (child || row.subagent) {
    tags.push(
      <span key="subagent" className={styles.tag}>
        {t('insights.threads.subagent')}
      </span>
    );
  }
  if (row.children.length > 0) {
    tags.push(
      <span key="children" className={styles.tag} title={t('insights.threads.includes_subagents')}>
        {t('insights.common.subagents', { count: row.children.length })}
      </span>
    );
  }
  if (row.placeholder) {
    tags.push(
      <span key="placeholder" className={styles.tag}>
        {t('insights.threads.parent_missing')}
      </span>
    );
  }
  row.flags.forEach((flag) =>
    tags.push(
      <span key={flag} className={`${styles.tag} ${styles.tagWarn}`}>
        <IconAlertTriangle size={11} aria-hidden="true" />
        {flag === 'low_hit'
          ? t('insights.threads.flag_low_hit')
          : t('insights.threads.flag_cold_writes')}
      </span>
    )
  );
  if (tags.length === 0) return null;
  return <span className={ts.titleMeta}>{tags}</span>;
}

/**
 * A thread's model split (its subagents included for a parent row), what the same Claude tokens
 * would cost on Opus 5.5 / Sonnet 5.5 at API prices, and how much of it is reading versus writing.
 * Descriptive only: it never recommends a model.
 */
function ThreadModelDetail({ row, slots }: { row: ThreadRow; slots: ReadonlyMap<string, number> }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const m = row.metrics;
  const fmt = (value: number) => formatCompactNumber(value, locale);
  const totalTokens = m.models.reduce((sum, model) => sum + model.tokens, 0);
  const reading = readingProfile(m);
  return (
    <div className={ts.detail}>
      <div className={ts.detailHead}>
        <span className={ts.detailTitle}>{t('insights.threads.detail_title')}</span>
        {row.children.length > 0 && (
          <span className={styles.tag}>
            {t('insights.threads.detail_includes', { count: row.children.length })}
          </span>
        )}
        <span className={styles.estimateTag}>{t('insights.common.api_estimate')}</span>
      </div>
      {m.models.length === 0 ? (
        <p className={styles.panelEmpty}>{t('insights.threads.split_unavailable')}</p>
      ) : (
        <table className={ts.detailTable}>
          <thead>
            <tr>
              <th scope="col">{t('insights.common.model')}</th>
              <th scope="col" className={styles.num}>
                {t('insights.common.requests')}
              </th>
              <th scope="col" className={styles.num}>
                {t('insights.common.tokens')}
              </th>
              <th scope="col" className={styles.num}>
                {t('insights.threads.col_output')}
              </th>
              <th scope="col" className={styles.num}>
                {t('insights.threads.col_cache_read')}
              </th>
              <th scope="col" className={styles.num}>
                {t('insights.threads.col_cache_write')}
              </th>
              <th scope="col" className={styles.num}>
                {t('insights.common.api_value')}
              </th>
              <th scope="col" className={styles.num}>
                {t('insights.threads.col_token_share')}
              </th>
            </tr>
          </thead>
          <tbody>
            {m.models.map((model) => (
              <tr key={model.model}>
                <th scope="row">
                  <span className={styles.provider} title={model.model}>
                    <span
                      className={`${styles.swatch} ${slotClass(slots.get(model.model) ?? null)}`}
                      aria-hidden="true"
                    />
                    <span className={styles.strong}>{modelLabel(model.model)}</span>
                  </span>
                </th>
                <td className={styles.num}>{fmt(model.requests)}</td>
                <td className={styles.num}>{fmt(model.tokens)}</td>
                <td className={styles.num}>{fmt(model.outputTokens)}</td>
                <td className={styles.num}>{fmt(model.cacheReadTokens)}</td>
                <td className={styles.num}>{fmt(model.cacheCreationTokens)}</td>
                <td className={`${styles.num} ${styles.strong}`}>
                  {model.apiValueUsd === null ? (
                    <span className={styles.toneMuted}>{t('insights.common.unpriced')}</span>
                  ) : (
                    formatUsd(model.apiValueUsd, locale)
                  )}
                </td>
                <td className={styles.num}>
                  {formatShare(totalTokens > 0 ? model.tokens / totalTokens : null)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className={ts.detailLine}>
        {m.whatIfUsd ? (
          <WhatIfLine actualUsd={m.claudeValueUsd} whatIfUsd={m.whatIfUsd} />
        ) : (
          <span className={styles.toneMuted}>
            {m.models.length === 0
              ? t('insights.threads.what_if_unavailable')
              : t('insights.threads.what_if_none')}
          </span>
        )}
      </p>
      {reading.readToOutput !== null && reading.outputPerRequest !== null && (
        <p className={ts.detailLine}>
          <span>
            {t('insights.threads.reading_profile', {
              ratio: fmt(Math.round(reading.readToOutput)),
              perRequest: fmt(Math.round(reading.outputPerRequest)),
            })}
          </span>
          {reading.mostlyReading && (
            <span className={styles.tag}>{t('insights.threads.mostly_reading')}</span>
          )}
        </p>
      )}
      <p className={ts.detailNote}>
        {t('insights.threads.what_if_caption')}
        {reading.mostlyReading && <> {t('insights.common.reading_hint')}</>}
      </p>
    </div>
  );
}
