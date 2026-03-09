import { describe, test, expect, beforeEach } from 'bun:test';
import { Exporter } from '../src/Exporter.ts';
import { DEFAULT_CONFIG } from '../src/types.ts';
import type { FullObject, ExportConfig } from '../src/types.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeExporter(overrides: Partial<ExportConfig> = {}): Exporter {
  return new Exporter({ ...DEFAULT_CONFIG, apiKey: 'test', spaceId: 's1', spaceName: 'Test', ...overrides });
}

function makeObj(overrides: Partial<FullObject> = {}): FullObject {
  return {
    id: 'obj-id-123456789012',
    name: 'Test Object',
    ...overrides,
  };
}

// ── generateSlug ───────────────────────────────────────────────────────────────

describe('Exporter.generateSlug', () => {
  let exporter: Exporter;
  beforeEach(() => { exporter = makeExporter(); });

  test('basic name → slugified string', () => {
    expect(exporter.generateSlug('Hello World', 'id123', new Set())).toBe('hello-world');
  });

  test('strips file extension from name', () => {
    expect(exporter.generateSlug('Atomic Habits.pdf', 'id123', new Set())).toBe('atomic-habits');
  });

  test('empty name slugifies to "untitled" (not id suffix)', () => {
    // slugify('') returns 'untitled' — id suffix is only used when style=id
    const slug = exporter.generateSlug('', 'abcdef123456', new Set());
    expect(slug).toBe('untitled');
  });

  test('collision → appends last-12 chars of id as suffix', () => {
    const id = 'id123456789012'; // 14 chars, slice(-12) = '123456789012'
    const used = new Set(['hello-world']);
    const slug = exporter.generateSlug('Hello World', id, used);
    expect(slug).toBe('hello-world-123456789012');
  });

  test('double collision → appends numeric counter', () => {
    const id = 'abcdef123456';
    const idSuffix = id.slice(-12); // 'abcdef123456'
    const used = new Set(['hello-world', `hello-world-${idSuffix}`]);
    const slug = exporter.generateSlug('Hello World', id, used);
    expect(slug).toBe('hello-world-2');
  });

  test('slugStyle=id uses id only', () => {
    const e = makeExporter({ slugStyle: 'id' });
    const slug = e.generateSlug('Anything', 'abcdef123456', new Set());
    expect(slug).toBe('abcdef123456');
  });

  test('strips accents via NFD normalize', () => {
    expect(exporter.generateSlug('Café René', 'x', new Set())).toBe('cafe-rene');
  });

  test('truncates long names to 80 chars', () => {
    const longName = 'a'.repeat(100);
    const slug = exporter.generateSlug(longName, 'x', new Set());
    expect(slug.length).toBeLessThanOrEqual(80);
  });

  test('cleans special chars', () => {
    const slug = exporter.generateSlug('Hello: World? (2024)', 'x', new Set());
    expect(slug).toBe('hello-world-2024');
  });
});

// ── extractContent ─────────────────────────────────────────────────────────────

describe('Exporter.extractContent', () => {
  let exporter: Exporter;
  beforeEach(() => { exporter = makeExporter(); });

  test('returns markdown body', () => {
    const obj = makeObj({ markdown: '# Hello\n\nWorld' });
    expect(exporter.extractContent(obj)).toBe('# Hello\n\nWorld');
  });

  test('strips leading --- artifact', () => {
    const obj = makeObj({ markdown: '---\n# Hello' });
    expect(exporter.extractContent(obj)).toBe('# Hello');
  });

  test('collapses 3+ blank lines to 2', () => {
    const obj = makeObj({ markdown: 'a\n\n\n\nb' });
    expect(exporter.extractContent(obj)).toBe('a\n\nb');
  });

  test('normalizes CRLF to LF', () => {
    const obj = makeObj({ markdown: 'a\r\nb' });
    expect(exporter.extractContent(obj)).toBe('a\nb');
  });

  test('decodes HTML entities', () => {
    const obj = makeObj({ markdown: 'it&#39;s &amp; &lt;b&gt;bold&lt;/b&gt;' });
    expect(exporter.extractContent(obj)).toBe("it's & <b>bold</b>");
  });

  test('strips trailing whitespace per line', () => {
    const obj = makeObj({ markdown: 'hello   \nworld  ' });
    expect(exporter.extractContent(obj)).toBe('hello\nworld');
  });

  test('falls back to description when no markdown', () => {
    const obj = makeObj({ description: 'fallback desc' });
    expect(exporter.extractContent(obj)).toBe('fallback desc');
  });

  test('falls back to snippet when no markdown or description', () => {
    const obj = makeObj({ snippet: 'fallback snippet' });
    expect(exporter.extractContent(obj)).toBe('fallback snippet');
  });

  test('returns empty string for truly empty objects', () => {
    const obj = makeObj({ markdown: '   ' });
    expect(exporter.extractContent(obj)).toBe('');
  });

  test('injects dataview stub for empty set when dataviewQueries=true', () => {
    const e = makeExporter({ dataviewQueries: true });
    const obj = makeObj({ markdown: '', layout: 'set', type: { id: 't1', name: 'Note' } });
    const content = e.extractContent(obj);
    expect(content).toContain('```dataview');
    expect(content).toContain('WHERE anytype-type = "Note"');
  });

  test('does NOT inject dataview stub when dataviewQueries=false (default)', () => {
    const obj = makeObj({ markdown: '', layout: 'set' });
    expect(exporter.extractContent(obj)).toBe('');
  });
});

// ── buildFrontmatter ───────────────────────────────────────────────────────────

describe('Exporter.buildFrontmatter', () => {
  let exporter: Exporter;
  beforeEach(() => { exporter = makeExporter(); });

  test('sets title from object name', () => {
    const fm = exporter.buildFrontmatter(makeObj({ name: 'My Note' }));
    expect(fm.title).toBe('My Note');
  });

  test('falls back to snippet for title when no name', () => {
    const fm = exporter.buildFrontmatter(makeObj({ name: undefined, snippet: 'My snippet' }));
    expect(fm.title).toBe('My snippet');
  });

  test('includes aliases array with original name', () => {
    const fm = exporter.buildFrontmatter(makeObj({ name: 'James Clear' }));
    expect(fm.aliases).toEqual(['James Clear']);
  });

  test('includes description when present', () => {
    const fm = exporter.buildFrontmatter(makeObj({ description: 'A great note' }));
    expect(fm.description).toBe('A great note');
  });

  test('maps tag property to fm.tags array', () => {
    const obj = makeObj({
      properties: [{
        key: 'tag', name: 'Tag', format: 'multi_select',
        multi_select: [{ name: 'productivity' }, { name: 'books' }],
      }],
    });
    const fm = exporter.buildFrontmatter(obj);
    expect(fm.tags).toEqual(['productivity', 'books']);
  });

  test('includes anytype-id and anytype-type when preserveIds=true', () => {
    const e = makeExporter({ preserveIds: true });
    const fm = e.buildFrontmatter(makeObj({ id: 'abc123', type: { id: 't1', name: 'Note' } }));
    expect(fm['anytype-id']).toBe('abc123');
    expect(fm['anytype-type']).toBe('Note');
  });

  test('does NOT include anytype-id when preserveIds=false', () => {
    const e = makeExporter({ preserveIds: false });
    const fm = e.buildFrontmatter(makeObj());
    expect(fm['anytype-id']).toBeUndefined();
  });

  test('formats created date as ISO by default', () => {
    const obj = makeObj({ created_date: 1700000000 }); // Unix seconds
    const fm = exporter.buildFrontmatter(obj);
    expect(typeof fm.created).toBe('string');
    expect(fm.created as string).toContain('2023');
  });

  test('includes quartz date/lastmod fields when frontmatterStyle=quartz', () => {
    const e = makeExporter({ frontmatterStyle: 'quartz' });
    const obj = makeObj({ created_date: 1700000000, last_modified_date: 1700000000 });
    const fm = e.buildFrontmatter(obj);
    expect(fm.date).toBeDefined();
    expect(fm.lastmod).toBeDefined();
  });

  test('skips SKIP_KEYS like last_modified_by', () => {
    const obj = makeObj({
      properties: [{ key: 'last_modified_by', name: 'Last Modified By', format: 'text', text: 'Alice' }],
    });
    const fm = exporter.buildFrontmatter(obj);
    expect(Object.keys(fm).some(k => k.includes('modified-by'))).toBe(false);
  });

  test('prefixes custom props with anytype-', () => {
    const obj = makeObj({
      properties: [{ key: 'my_custom', name: 'My Custom', format: 'text', text: 'value' }],
    });
    const fm = exporter.buildFrontmatter(obj);
    expect(fm['anytype-my-custom']).toBe('value');
  });
});

// ── assemble ───────────────────────────────────────────────────────────────────

describe('Exporter.assemble', () => {
  let exporter: Exporter;
  beforeEach(() => { exporter = makeExporter(); });

  test('combines frontmatter and content with blank line', () => {
    const fm = { title: 'Test' };
    const result = exporter.assemble(fm, 'Hello world');
    expect(result).toStartWith('---\n');
    expect(result).toContain('Hello world');
  });

  test('returns content only when frontmatter is empty', () => {
    const result = exporter.assemble({}, 'Just content');
    expect(result).toBe('Just content');
  });

  test('returns frontmatter only when content is empty', () => {
    const result = exporter.assemble({ title: 'X' }, '');
    expect(result).toStartWith('---\n');
    expect(result).not.toContain('\n\n'); // no trailing blank line from empty content
  });
});
