/**
 * Per-account usage report for one window, plus the last hour for the session-hopping callout.
 *
 * A 404 means the backend lacks the hub patch: the page shows an explanation instead of an error.
 * Responses from an overtaken request or a previous connection are dropped.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  apiClient,
  hubApi,
  isHubFeatureMissing,
  type UsageAccountsReport,
  type UsageWindow,
} from '@/services/api';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useInterval } from '@/hooks/useInterval';

export type UsageLoadStatus = 'loading' | 'ready' | 'unsupported' | 'error';

export interface UsageAccountsState {
  status: UsageLoadStatus;
  report: UsageAccountsReport | null;
  /** Last-hour report backing the callout; equals `report` when the window is 1h. */
  lastHour: UsageAccountsReport | null;
  error: string;
  refreshing: boolean;
}

const POLL_MS = 60_000;

export function useUsageAccounts(usageWindow: UsageWindow, enabled: boolean) {
  const [state, setState] = useState<UsageAccountsState>({
    status: 'loading',
    report: null,
    lastHour: null,
    error: '',
    refreshing: false,
  });
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!enabled) {
      setState({ status: 'loading', report: null, lastHour: null, error: '', refreshing: false });
      return;
    }
    const revision = apiClient.getConnectionRevision();
    const isCurrent = () =>
      requestId === requestRef.current && revision === apiClient.getConnectionRevision();
    setState((prev) => ({ ...prev, refreshing: true }));
    try {
      const [report, lastHour] = await Promise.all([
        hubApi.getUsageAccounts(usageWindow),
        usageWindow === '1h'
          ? Promise.resolve(null)
          : hubApi.getUsageAccounts('1h').catch(() => null),
      ]);
      if (!isCurrent()) return;
      setState({
        status: 'ready',
        report,
        lastHour: usageWindow === '1h' ? report : lastHour,
        error: '',
        refreshing: false,
      });
    } catch (error) {
      if (!isCurrent()) return;
      if (isHubFeatureMissing(error)) {
        setState({
          status: 'unsupported',
          report: null,
          lastHour: null,
          error: '',
          refreshing: false,
        });
        return;
      }
      setState((prev) => ({
        ...prev,
        status: prev.report ? 'ready' : 'error',
        error: error instanceof Error ? error.message : String(error),
        refreshing: false,
      }));
    }
  }, [enabled, usageWindow]);

  useHeaderRefresh(load);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  useInterval(() => void load(), enabled && state.status !== 'unsupported' ? POLL_MS : null);

  return { ...state, reload: load };
}
