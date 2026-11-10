/**
 * Account labels by auth index. Model, session and event payloads only carry `auth_index`; the
 * label (the auth file name) comes from whichever report on the page has one.
 */

import { displayAccountName } from '@/utils/accountMask';

export interface AccountInfo {
  authIndex: string;
  label: string;
  provider: string;
}

export type AccountDirectory = ReadonlyMap<string, AccountInfo>;

interface LabelSource {
  authIndex: string;
  label?: string;
  provider?: string;
}

/** Earlier sources win; later ones only fill gaps (a missing label or provider). */
export function buildAccountDirectory(
  ...sources: Array<readonly LabelSource[] | null | undefined>
): AccountDirectory {
  const directory = new Map<string, AccountInfo>();
  sources.forEach((source) => {
    source?.forEach((entry) => {
      const authIndex = entry.authIndex.trim();
      if (!authIndex) return;
      const existing = directory.get(authIndex);
      directory.set(authIndex, {
        authIndex,
        label: existing?.label || entry.label?.trim() || '',
        provider: existing?.provider || entry.provider?.trim().toLowerCase() || '',
      });
    });
  });
  return directory;
}

/**
 * Display name for an auth index: the (masked unless revealed) label, else `#<index>` so an
 * unknown account is still distinguishable without pretending to know its name.
 */
export function accountName(
  authIndex: string,
  directory: AccountDirectory,
  reveal: boolean
): string {
  const label = directory.get(authIndex)?.label;
  if (label) return displayAccountName(label, reveal);
  return authIndex ? `#${authIndex}` : '—';
}

export function accountProvider(authIndex: string, directory: AccountDirectory): string {
  return directory.get(authIndex)?.provider ?? '';
}
