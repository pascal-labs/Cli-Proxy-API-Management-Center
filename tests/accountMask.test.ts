import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { displayAccountName, maskAccountName } from '@/utils/accountMask';
import { SHOW_EMAILS_STORAGE_KEY, readShowEmails, writeShowEmails } from '@/hooks/useShowEmails';

describe('maskAccountName', () => {
  test('masks an email-shaped auth file name the way the console shows it', () => {
    expect(maskAccountName('claude-tom@1password.dev.json')).toBe('claude-t•••@1•••.dev.json');
    expect(maskAccountName('claude-tess@pixel.gg.json')).toBe('claude-t•••@p•••.gg.json');
  });

  test('keeps only the top-level domain of multi-label domains', () => {
    expect(maskAccountName('codex-jane.doe@mail.example.com.json')).toBe(
      'codex-j•••@m•••.com.json'
    );
  });

  test('masks plain emails and names without a provider prefix', () => {
    expect(maskAccountName('someone@example.org')).toBe('s•••@e•••.org');
    expect(maskAccountName('kimi-a1b2c3d4.json')).toBe('kimi-a•••.json');
    expect(maskAccountName('plainname')).toBe('p•••');
  });

  test('does not keep an unknown leading word, which could be a person', () => {
    expect(maskAccountName('johnny-work@corp.io.json')).toBe('j•••@c•••.io.json');
  });

  test('hides length: long and short identities mask to the same width', () => {
    const short = maskAccountName('claude-a@b.co.json');
    const long = maskAccountName('claude-averyveryverylongname@bigcorporation.co.json');
    expect(short).toBe('claude-a•••@b•••.co.json');
    expect(long).toBe('claude-a•••@b•••.co.json');
  });

  test('masks each half of a `file · identity` display label', () => {
    expect(maskAccountName('devin-1.json · dev@team.ai')).toBe('devin-1•••.json · d•••@t•••.ai');
  });

  test('leaves empty input alone and reveals when asked', () => {
    expect(maskAccountName('')).toBe('');
    expect(displayAccountName('claude-tom@x.dev.json', true)).toBe('claude-tom@x.dev.json');
    expect(displayAccountName('claude-tom@x.dev.json', false)).toBe('claude-t•••@x•••.dev.json');
  });
});

describe('show emails preference', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  let store: Map<string, string>;
  let throwOnAccess = false;

  beforeEach(() => {
    store = new Map();
    throwOnAccess = false;
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: (key: string) => {
          if (throwOnAccess) throw new Error('blocked');
          return store.get(key) ?? null;
        },
        setItem: (key: string, value: string) => {
          if (throwOnAccess) throw new Error('blocked');
          store.set(key, value);
        },
      },
    };
  });

  afterAll(() => {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
  });

  test('persists the choice and keeps working when storage throws', () => {
    writeShowEmails(true);
    expect(store.get(SHOW_EMAILS_STORAGE_KEY)).toBe('true');
    expect(readShowEmails()).toBe(true);

    throwOnAccess = true;
    expect(() => writeShowEmails(false)).not.toThrow();
    expect(readShowEmails()).toBe(false);
  });
});
