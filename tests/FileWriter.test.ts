import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { FileWriter } from '../src/FileWriter.ts';
import { DEFAULT_CONFIG } from '../src/types.ts';
import type { ExportConfig } from '../src/types.ts';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// ── Helpers ────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'anytype-fw-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<ExportConfig> = {}): ExportConfig {
  return {
    ...DEFAULT_CONFIG,
    apiKey: 'test',
    spaceId: 's1',
    spaceName: 'S',
    outputDir: tmpDir,
    filesDir: 'files',
    ...overrides,
  };
}

function makeWriter(overrides: Partial<ExportConfig> = {}) {
  return new FileWriter(makeConfig(overrides));
}

// ── ensureOutputDir ────────────────────────────────────────────────────────────

describe('FileWriter.ensureOutputDir', () => {
  test('creates outputDir', async () => {
    const writer = makeWriter();
    await writer.ensureOutputDir();
    expect(await Bun.file(join(tmpDir, 'files')).exists()).toBe(false); // dir not file
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(tmpDir);
    expect(entries).toContain('files');
  });

  test('does NOT create files dir when includeFiles=false', async () => {
    const writer = makeWriter({ includeFiles: false });
    await writer.ensureOutputDir();
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(tmpDir);
    expect(entries).not.toContain('files');
  });

  test('is idempotent — second call does not throw', async () => {
    const writer = makeWriter();
    await writer.ensureOutputDir();
    await expect(writer.ensureOutputDir()).resolves.toBeUndefined();
  });
});

// ── writeMarkdown ──────────────────────────────────────────────────────────────

describe('FileWriter.writeMarkdown', () => {
  test('writes markdown to outputDir/slug.md', async () => {
    const writer = makeWriter();
    await writer.ensureOutputDir();
    const path = await writer.writeMarkdown('my-note', '# Hello');
    expect(path).toContain('my-note.md');
    const content = await Bun.file(path).text();
    expect(content).toBe('# Hello');
  });

  test('writes to subdirectory when groupByType=true', async () => {
    const writer = makeWriter({ groupByType: true });
    await writer.ensureOutputDir();
    const path = await writer.writeMarkdown('my-note', '# Hello', 'Note');
    expect(path).toContain(join('types', 'Note', 'my-note.md'));
    const content = await Bun.file(path).text();
    expect(content).toBe('# Hello');
  });

  test('sanitizes type name in directory path', async () => {
    const writer = makeWriter({ groupByType: true });
    await writer.ensureOutputDir();
    const path = await writer.writeMarkdown('note', 'body', 'My Custom/Type!');
    // The full path always has OS separators — check only the sanitized dir segment
    expect(path).toContain('My_Custom_Type_');
    // The type name itself must not appear unsanitized in the path
    expect(path).not.toContain('My Custom/Type!');
  });

  test('dry-run does not write to disk', async () => {
    const writer = makeWriter({ dryRun: true });
    await writer.ensureOutputDir();
    const path = await writer.writeMarkdown('my-note', '# Hello');
    expect(await Bun.file(path).exists()).toBe(false);
  });
});

// ── deleteMarkdown ─────────────────────────────────────────────────────────────

describe('FileWriter.deleteMarkdown', () => {
  test('removes an existing md file', async () => {
    const writer = makeWriter();
    await writer.ensureOutputDir();
    await writer.writeMarkdown('to-delete', 'content');
    const path = join(tmpDir, 'to-delete.md');
    expect(await Bun.file(path).exists()).toBe(true);
    await writer.deleteMarkdown('to-delete');
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test('is a no-op when file does not exist', async () => {
    const writer = makeWriter();
    await writer.ensureOutputDir();
    await expect(writer.deleteMarkdown('nonexistent')).resolves.toBeUndefined();
  });

  test('dry-run does not delete', async () => {
    const writer = makeWriter({ dryRun: true });
    await writer.ensureOutputDir();
    // Write using real writer, then attempt delete via dry-run writer
    const realWriter = makeWriter();
    await realWriter.ensureOutputDir();
    await realWriter.writeMarkdown('keep-me', 'body');
    await writer.deleteMarkdown('keep-me');
    expect(await Bun.file(join(tmpDir, 'keep-me.md')).exists()).toBe(true);
  });
});

// ── downloadFile — extension detection ────────────────────────────────────────

describe('FileWriter.downloadFile — extension handling', () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  afterEach(() => fetchSpy?.mockRestore());

  function mockDownload(contentType: string, body = 'data') {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': contentType, 'Content-Length': String(body.length) },
      })
    );
  }

  test('detects .jpg extension from image/jpeg content-type', async () => {
    mockDownload('image/jpeg');
    const writer = makeWriter();
    await writer.ensureOutputDir();
    const path = await writer.downloadFile('http://127.0.0.1:31009/image/abc123', 'abc123', 'test-key');
    expect(path).toContain('.jpg');
    expect(path).not.toContain('.jpg.jpg');
  });

  test('detects .png extension from image/png content-type', async () => {
    mockDownload('image/png');
    const writer = makeWriter();
    await writer.ensureOutputDir();
    const path = await writer.downloadFile('http://127.0.0.1:31009/image/myhash', 'myhash', 'key');
    expect(path).toContain('.png');
  });

  test('no double extension when filename already has .png (BUG 2 regression)', async () => {
    mockDownload('image/png');
    const writer = makeWriter();
    await writer.ensureOutputDir();
    // filename already contains extension (old broken behaviour was "abc123.png.png")
    const path = await writer.downloadFile(
      'http://127.0.0.1:31009/image/abc123.png',
      'abc123', // stripped by ExportPipeline fix — FileWriter receives bare CID
      'key'
    );
    expect(path).not.toMatch(/\.png\.png$/);
    expect(path).toMatch(/\.png$/);
  });

  test('falls back to .bin for unknown content-type', async () => {
    mockDownload('application/octet-stream');
    const writer = makeWriter();
    await writer.ensureOutputDir();
    const path = await writer.downloadFile('http://127.0.0.1:31009/file/somefile', 'somefile', 'key');
    expect(path).toContain('.bin');
  });

  test('skips writing already-downloaded files (no duplicate on disk)', async () => {
    mockDownload('image/png', 'img data');
    const writer = makeWriter();
    await writer.ensureOutputDir();
    // Download once
    const path1 = await writer.downloadFile('http://127.0.0.1:31009/image/cachedfile', 'cachedfile', 'key');
    // Download again — returns same path, does not create a second file
    const path2 = await writer.downloadFile('http://127.0.0.1:31009/image/cachedfile', 'cachedfile', 'key');
    expect(path1).toBe(path2);
    // Only one file exists on disk
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(join(tmpDir, 'files')).filter(f => f.startsWith('cachedfile'));
    expect(files).toHaveLength(1);
  });

  test('returns null when all URLs fail', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));
    const writer = makeWriter();
    await writer.ensureOutputDir();
    const path = await writer.downloadFile(['http://a/file/x', 'http://b/file/x'], 'x', 'key');
    expect(path).toBeNull();
  });

  test('tries next URL when first returns 404', async () => {
    let call = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(new Response('nope', { status: 404 }));
      return Promise.resolve(new Response('data', {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Content-Length': '4' },
      }));
    });
    const writer = makeWriter();
    await writer.ensureOutputDir();
    const path = await writer.downloadFile(['http://a/1', 'http://b/2'], 'myfile', 'key');
    expect(path).not.toBeNull();
    expect(path).toContain('.png');
  });

  test('returns null when file exceeds maxFileSizeMb', async () => {
    const bigSize = 200 * 1024 * 1024; // 200 MB
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('x', {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(bigSize) },
      })
    );
    const writer = makeWriter({ maxFileSizeMb: 50 });
    await writer.ensureOutputDir();
    const path = await writer.downloadFile('http://a/big', 'bigfile', 'key');
    expect(path).toBeNull();
  });

  test('dry-run returns path without fetching', async () => {
    fetchSpy = spyOn(globalThis, 'fetch');
    const writer = makeWriter({ dryRun: true });
    const path = await writer.downloadFile('http://127.0.0.1:31009/image/abc123.png', 'abc123', 'key');
    expect(path).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── writeIndex ─────────────────────────────────────────────────────────────────

describe('FileWriter.writeIndex', () => {
  test('writes index.md with grouped object links', async () => {
    const writer = makeWriter();
    await writer.ensureOutputDir();
    await writer.writeIndex('My Space', [
      { slug: 'note-a', name: 'Note A', type: 'Note' },
      { slug: 'task-1', name: 'Task 1', type: 'Task' },
      { slug: 'note-b', name: 'Note B', type: 'Note' },
    ]);
    const content = await Bun.file(join(tmpDir, 'index.md')).text();
    expect(content).toContain('# My Space');
    expect(content).toContain('## Note (2)');
    expect(content).toContain('## Task (1)');
    expect(content).toContain('[[note-a|Note A]]');
    expect(content).toContain('[[task-1|Task 1]]');
  });

  test('types are sorted alphabetically', async () => {
    const writer = makeWriter();
    await writer.ensureOutputDir();
    await writer.writeIndex('Space', [
      { slug: 'z', name: 'Z', type: 'Zettel' },
      { slug: 'a', name: 'A', type: 'Article' },
    ]);
    const content = await Bun.file(join(tmpDir, 'index.md')).text();
    const articlePos = content.indexOf('## Article');
    const zettelPos = content.indexOf('## Zettel');
    expect(articlePos).toBeLessThan(zettelPos);
  });
});
