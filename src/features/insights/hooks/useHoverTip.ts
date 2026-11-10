import { useCallback, useRef, useState, type ReactNode } from 'react';

export interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}

const TIP_EDGE = 72;

/**
 * Hover / focus tooltip anchored inside a `position: relative` host. Coordinates are clamped so a
 * tip near either edge never widens the page.
 */
export function useHoverTip() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);

  const showAt = useCallback((x: number, y: number, content: ReactNode) => {
    const width = hostRef.current?.clientWidth ?? 0;
    const clampedX = width > TIP_EDGE * 2 ? Math.min(Math.max(x, TIP_EDGE), width - TIP_EDGE) : x;
    setTip({ x: clampedX, y, content });
  }, []);

  const showFor = useCallback(
    (element: Element, content: ReactNode) => {
      const host = hostRef.current;
      if (!host) return;
      const hostRect = host.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      showAt(rect.left - hostRect.left + rect.width / 2, rect.top - hostRect.top, content);
    },
    [showAt]
  );

  const hide = useCallback(() => setTip(null), []);

  return { hostRef, tip, showAt, showFor, hide };
}
