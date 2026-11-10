/**
 * Routing order preview from the hub backend, for the "Next up" badge.
 *
 * Best effort by design: an unpatched backend answers 404, and any other failure is equally
 * non-fatal — the badge simply does not render. Responses from a previous connection or an
 * overtaken request are dropped.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient, hubApi, isHubFeatureMissing, type RoutingOrder } from '@/services/api';
import { useInterval } from '@/hooks/useInterval';

const POLL_MS = 60_000;

export function useRoutingOrder(enabled: boolean) {
  const [order, setOrder] = useState<RoutingOrder | null>(null);
  const requestRef = useRef(0);
  // After a 404 there is nothing to poll for until the user reloads or reconnects.
  const [unsupported, setUnsupported] = useState(false);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!enabled) {
      setOrder(null);
      return;
    }
    const revision = apiClient.getConnectionRevision();
    try {
      const next = await hubApi.getRoutingOrder();
      if (requestId !== requestRef.current || revision !== apiClient.getConnectionRevision()) {
        return;
      }
      setOrder(next);
      setUnsupported(false);
    } catch (error) {
      if (requestId !== requestRef.current) return;
      setOrder(null);
      if (isHubFeatureMissing(error)) setUnsupported(true);
    }
  }, [enabled]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  useInterval(() => void load(), enabled && !unsupported ? POLL_MS : null);

  return { order, reload: load };
}
