/**
 * Loader for the insight pages: polls, registers the header refresh, and maps a 404 to
 * `unsupported` ("update the hub") instead of an error. Responses from an overtaken request or a
 * previous connection are dropped, like the Cache & Usage page.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient, isHubFeatureMissing } from '@/services/api';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useInterval } from '@/hooks/useInterval';

export type InsightStatus = 'loading' | 'ready' | 'unsupported' | 'error';

export interface InsightState<T> {
  status: InsightStatus;
  data: T | null;
  error: string;
  refreshing: boolean;
}

const POLL_MS = 60_000;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * One optional panel's outcome on a page that combines endpoints: data, or why it is missing.
 * A secondary endpoint failing never takes the whole page down.
 */
export interface InsightPart<T> {
  data: T | null;
  missing: boolean;
  error: string;
}

export async function settlePart<T>(promise: Promise<T>): Promise<InsightPart<T>> {
  try {
    return { data: await promise, missing: false, error: '' };
  } catch (error) {
    return isHubFeatureMissing(error)
      ? { data: null, missing: true, error: '' }
      : { data: null, missing: false, error: messageOf(error) };
  }
}

/** A 404 for when every endpoint a page needs is missing, so the page shows "update the hub". */
export function hubFeatureMissingError(): Error & { status: number } {
  return Object.assign(new Error('hub feature missing'), { status: 404 });
}

export function useHubInsight<T>(load: () => Promise<T>, enabled: boolean, pollMs = POLL_MS) {
  const [state, setState] = useState<InsightState<T>>({
    status: 'loading',
    data: null,
    error: '',
    refreshing: false,
  });
  const requestRef = useRef(0);

  const run = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!enabled) {
      setState({ status: 'loading', data: null, error: '', refreshing: false });
      return;
    }
    const revision = apiClient.getConnectionRevision();
    const isCurrent = () =>
      requestId === requestRef.current && revision === apiClient.getConnectionRevision();
    setState((prev) => ({ ...prev, refreshing: true }));
    try {
      const data = await load();
      if (!isCurrent()) return;
      setState({ status: 'ready', data, error: '', refreshing: false });
    } catch (error) {
      if (!isCurrent()) return;
      if (isHubFeatureMissing(error)) {
        setState({ status: 'unsupported', data: null, error: '', refreshing: false });
        return;
      }
      setState((prev) => ({
        ...prev,
        status: prev.data ? 'ready' : 'error',
        error: messageOf(error),
        refreshing: false,
      }));
    }
  }, [enabled, load]);

  useHeaderRefresh(run);

  useEffect(() => {
    void run();
    return () => {
      requestRef.current += 1;
    };
  }, [run]);

  useInterval(() => void run(), enabled && state.status !== 'unsupported' ? pollMs : null);

  return { ...state, reload: run };
}
