/**
 * "Show emails" preference shared by the quota and cache views.
 *
 * Off by default so a screen share never leaks account names. Persisted in localStorage; every
 * access is guarded because storage can be unavailable (private mode, blocked site data) and the
 * toggle must keep working in memory when it is.
 */

import { useCallback, useSyncExternalStore } from 'react';

export const SHOW_EMAILS_STORAGE_KEY = 'cpamc.showEmails';

const listeners = new Set<() => void>();
let memoryValue: boolean | null = null;

export function readShowEmails(): boolean {
  if (memoryValue !== null) return memoryValue;
  try {
    memoryValue = window.localStorage.getItem(SHOW_EMAILS_STORAGE_KEY) === 'true';
  } catch {
    memoryValue = false;
  }
  return memoryValue;
}

export function writeShowEmails(next: boolean): void {
  memoryValue = next;
  try {
    window.localStorage.setItem(SHOW_EMAILS_STORAGE_KEY, next ? 'true' : 'false');
  } catch {
    // Storage unavailable: the in-memory value still drives this session.
  }
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const serverSnapshot = () => false;

export function useShowEmails(): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(subscribe, readShowEmails, serverSnapshot);
  const set = useCallback((next: boolean) => writeShowEmails(next), []);
  return [value, set];
}
