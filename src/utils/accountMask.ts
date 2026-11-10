/**
 * Mask account identifiers for screen sharing: `claude-tom@1password.dev.json` →
 * `claude-t•••@1•••.dev.json`.
 *
 * Kept: a leading provider prefix (`claude-`), the first character of the local part and of the
 * domain, the top-level domain, and a `.json` extension. Everything that identifies the person is
 * replaced by a fixed-width mask, so masked names do not leak their length either.
 */

export const MASK = '•••';

const EXTENSION_RE = /\.json$/i;
const PREFIX_RE = /^([A-Za-z]+)([-_])(?=.)/;
/** Only well-known provider prefixes survive; any other leading word could be a name. */
const PROVIDER_PREFIXES = new Set([
  'aistudio',
  'antigravity',
  'anthropic',
  'claude',
  'codex',
  'devin',
  'gemini',
  'grok',
  'iflow',
  'kimi',
  'kiro',
  'meta',
  'muse',
  'openai',
  'qwen',
  'vertex',
  'xai',
]);
const DISPLAY_SEPARATOR = ' · ';

const head = (value: string): string => {
  const first = Array.from(value)[0];
  return first ? `${first}${MASK}` : MASK;
};

const maskDomain = (domain: string): string => {
  const labels = domain.split('.').filter(Boolean);
  if (labels.length <= 1) return head(domain);
  return `${head(labels[0])}.${labels[labels.length - 1]}`;
};

const maskCore = (core: string): string => {
  const at = core.indexOf('@');
  if (at > 0) return `${head(core.slice(0, at))}@${maskDomain(core.slice(at + 1))}`;
  return head(core);
};

const maskSegment = (segment: string): string => {
  const trimmed = segment.trim();
  if (!trimmed) return segment;
  const extension = EXTENSION_RE.exec(trimmed)?.[0] ?? '';
  const stem = extension ? trimmed.slice(0, -extension.length) : trimmed;
  const match = PREFIX_RE.exec(stem);
  const prefix =
    match && PROVIDER_PREFIXES.has(match[1].toLowerCase()) ? `${match[1]}${match[2]}` : '';
  const core = stem.slice(prefix.length);
  return `${prefix}${core ? maskCore(core) : ''}${extension}`;
};

/** Mask a file name, email, or a `file · identity` display label. */
export function maskAccountName(value: string): string {
  if (!value) return value;
  return value.split(DISPLAY_SEPARATOR).map(maskSegment).join(DISPLAY_SEPARATOR);
}

/** Identity when revealing, masked otherwise — the one switch every view goes through. */
export const displayAccountName = (value: string, reveal: boolean): string =>
  reveal ? value : maskAccountName(value);
