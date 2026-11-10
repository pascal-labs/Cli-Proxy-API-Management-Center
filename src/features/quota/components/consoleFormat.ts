/**
 * Shared text for the console quota view: meter labels, reset lines, percentages.
 */

import type { TFunction } from 'i18next';
import { formatInstantShort, formatRelativeInstant } from '@/utils/quota';
import type { QuotaMeterLabel, QuotaMeterLabelPart } from '../meters';

const labelPart = (t: TFunction, part: QuotaMeterLabelPart): string =>
  part.key ? String(t(part.key, part.params ?? {})) : (part.text ?? '');

export function resolveMeterLabel(t: TFunction, label: QuotaMeterLabel): string {
  const main = labelPart(t, label);
  const group = label.group ? labelPart(t, label.group) : '';
  return group ? `${group} · ${main}` : main;
}

export interface ResetLine {
  relative: string;
  absolute: string;
}

/** "in 1 day" + "09/13, 13:00", or null when nothing is pending. */
export function buildResetLine(
  atMs: number | null,
  nowMs: number,
  locale?: string
): ResetLine | null {
  if (atMs === null || !Number.isFinite(atMs) || atMs <= nowMs) return null;
  return {
    relative: formatRelativeInstant(atMs, nowMs, locale),
    absolute: formatInstantShort(atMs),
  };
}

export const formatPercent = (value: number | null): string =>
  value === null ? '--' : `${Math.round(value)}%`;
