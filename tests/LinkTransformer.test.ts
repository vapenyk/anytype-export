import { describe, test, expect } from 'bun:test';
import { LinkTransformer } from '../src/LinkTransformer.ts';
import type { SlugMap } from '../src/types.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTransformer(slugMap: SlugMap, overrides: ConstructorParameters<typeof LinkTransformer>[0] = {} as any) {
  return new LinkTransformer({ slugMap, ...overrides });
}

const SLUG_MAP: SlugMap = {
  'abc123': { slug: 'james-clear', name: 'James Clear', type: 'Person' },
  'def456': { slug: 'atomic-habits', name: 'Atomic Habits', type: 'Book' },
};

// ── transform — named markdown links ──────────────────────────────────────────

describe('LinkTransformer.transform — named links', () => {
  const t = makeTransformer(SLUG_MAP);

  test('converts [text](anytype://object?objectId=ID) to [[slug]]', () => {
    const { result } = t.transform('[James Clear](anytype://object?objectId=abc123)');
    expect(result).toBe('[[james-clear]]');
  });

  test('keeps alias when link text differs from object name', () => {
    const { result } = t.transform('[the author](anytype://object?objectId=abc123)');
    expect(result).toBe('[[james-clear|the author]]');
  });

  test('no alias when link text equals object name', () => {
    const { result } = t.transform('[James Clear](anytype://object?objectId=abc123)');
    expect(result).toBe('[[james-clear]]');
  });

  test('no alias when aliasLinks=false', () => {
    const t2 = makeTransformer(SLUG_MAP, { slugMap: SLUG_MAP, aliasLinks: false });
    const { result } = t2.transform('[the author](anytype://object?objectId=abc123)');
    expect(result).toBe('[[james-clear]]');
  });

  test('preserves anchor fragment', () => {
    const { result } = t.transform('[James Clear](anytype://object?objectId=abc123#intro)');
    expect(result).toContain('#intro');
  });
});

// ── transform — bare URLs ──────────────────────────────────────────────────────

describe('LinkTransformer.transform — bare URLs', () => {
  const t = makeTransformer(SLUG_MAP);

  test('converts bare query URL anytype://object?objectId=ID', () => {
    const { result } = t.transform('see anytype://object?objectId=abc123 for details');
    expect(result).toBe('see [[james-clear]] for details');
  });

  test('converts bare path URL anytype://object/ID', () => {
    const { result } = t.transform('see anytype://object/abc123 for details');
    expect(result).toBe('see [[james-clear]] for details');
  });
});

// ── transform — embeds ────────────────────────────────────────────────────────

describe('LinkTransformer.transform — embeds', () => {
  const t = makeTransformer(SLUG_MAP);

  test('converts ![alt](anytype://object?objectId=ID) to ![[slug]]', () => {
    const { result } = t.transform('![cover](anytype://object?objectId=abc123)');
    expect(result).toBe('![[james-clear]]');
  });

  test('embedStyle=markdown uses markdown image syntax', () => {
    const t2 = makeTransformer(SLUG_MAP, { slugMap: SLUG_MAP, embedStyle: 'markdown' });
    const { result } = t2.transform('![alt](anytype://object?objectId=abc123)');
    expect(result).toBe('![](james-clear)');
  });

  test('detectEmbeds=false leaves embed links unchanged', () => {
    const t2 = makeTransformer(SLUG_MAP, { slugMap: SLUG_MAP, detectEmbeds: false });
    const input = '![cover](anytype://object?objectId=abc123)';
    const { result } = t2.transform(input);
    // Embed regex is skipped; named-link regex has (?<!!) lookbehind so it won't match either.
    // The link stays as-is — anytype:// is preserved.
    expect(result).toBe(input);
  });
});

// ── transform — broken links ──────────────────────────────────────────────────

describe('LinkTransformer.transform — broken links', () => {
  test('brokenLinkStyle=keep keeps original as wikilink', () => {
    const t = makeTransformer({}, { slugMap: {}, brokenLinkStyle: 'keep' });
    const { result, stats } = t.transform('[unknown](anytype://object?objectId=missing999)');
    expect(result).toContain('[unknown](missing999)');
    expect(stats.broken).toBe(1);
  });

  test('brokenLinkStyle=remove removes the link', () => {
    const t = makeTransformer({}, { slugMap: {}, brokenLinkStyle: 'remove' });
    const { result } = t.transform('[unknown](anytype://object?objectId=missing999)');
    expect(result).toBe('unknown');
  });

  test('brokenLinkStyle=warn wraps in missing: prefix', () => {
    const t = makeTransformer({}, { slugMap: {}, brokenLinkStyle: 'warn' });
    const { result } = t.transform('[unknown](anytype://object?objectId=missing999)');
    expect(result).toContain('[[missing:');
  });
});

// ── transform — code block protection ─────────────────────────────────────────

describe('LinkTransformer.transform — code protection', () => {
  const t = makeTransformer(SLUG_MAP);

  test('does NOT transform links inside fenced code blocks', () => {
    const input = '```\n[James Clear](anytype://object?objectId=abc123)\n```';
    const { result } = t.transform(input);
    expect(result).toContain('anytype://object?objectId=abc123');
  });

  test('does NOT transform links inside inline code', () => {
    const input = 'see `anytype://object?objectId=abc123` here';
    const { result } = t.transform(input);
    expect(result).toContain('anytype://object?objectId=abc123');
  });

  test('transforms links outside code blocks normally', () => {
    const input = '```\ncode\n```\n[James Clear](anytype://object?objectId=abc123)';
    const { result } = t.transform(input);
    expect(result).toContain('[[james-clear]]');
    expect(result).toContain('```\ncode\n```');
  });
});

// ── transform — stats ─────────────────────────────────────────────────────────

describe('LinkTransformer.transform — stats', () => {
  test('counts transformed and broken links', () => {
    const t = makeTransformer(SLUG_MAP, { slugMap: SLUG_MAP, brokenLinkStyle: 'keep' });
    const { stats } = t.transform(
      '[James Clear](anytype://object?objectId=abc123) [unknown](anytype://object?objectId=nope)'
    );
    expect(stats.transformed).toBe(1);
    expect(stats.broken).toBe(1);
  });
});

// ── buildSlugMap ──────────────────────────────────────────────────────────────

describe('LinkTransformer.buildSlugMap', () => {
  const generateSlug = (name: string, id: string, used: Set<string>) => {
    let slug = name.toLowerCase().replace(/\s+/g, '-');
    if (used.has(slug)) slug = `${slug}-${id.slice(-4)}`;
    return slug;
  };

  test('maps id → slug for all objects', () => {
    const map = LinkTransformer.buildSlugMap(
      [{ id: 'abc', name: 'James Clear', type: { name: 'Person' } }],
      generateSlug
    );
    expect(map['abc']).toEqual({ slug: 'james-clear', name: 'James Clear', type: 'Person' });
  });

  test('resolves collisions via generateSlug', () => {
    const map = LinkTransformer.buildSlugMap(
      [
        { id: 'aaa1', name: 'Same Name', type: { name: 'Note' } },
        { id: 'bbb2', name: 'Same Name', type: { name: 'Note' } },
      ],
      generateSlug
    );
    expect(map['aaa1'].slug).not.toBe(map['bbb2'].slug);
  });

  test('falls back to "Untitled" for objects with no name', () => {
    const map = LinkTransformer.buildSlugMap(
      [{ id: 'xyz', type: { name: 'Note' } }],
      generateSlug
    );
    expect(map['xyz'].name).toBe('Untitled');
  });
});
