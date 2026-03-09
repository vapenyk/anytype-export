import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { CacheManager } from '../src/CacheManager.ts';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// ── Helpers ────────────────────────────────────────────────────────────────────

let tmpDir: string;

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'anytype-cache-test-'));
}

async function cleanTempDir(dir: string) {
  await rm(dir, { recursive: true, force: true });
}

async function makeCache(overrides: { spaceId?: string; dir?: string } = {}): Promise<CacheManager> {
  const dir = overrides.dir ?? tmpDir;
  return new CacheManager(dir, overrides.spaceId ?? 'space-1');
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = await makeTempDir();
});

afterEach(async () => {
  await cleanTempDir(tmpDir);
});

// ── load ───────────────────────────────────────────────────────────────────────

describe('CacheManager.load', () => {
  test('starts fresh when cache file does not exist', async () => {
    const cache = await makeCache();
    await cache.load(); // no error, empty state
    expect(cache.getAll()).toEqual({});
  });

  test('loads valid cache from disk', async () => {
    const cache = await makeCache();
    cache.update('obj1', { slug: 'my-note', lastModified: '2024-01-01T00:00:00.000Z', contentHash: 'abc123' });
    await cache.save();

    const cache2 = await makeCache();
    await cache2.load();
    expect(cache2.getAll()['obj1']?.slug).toBe('my-note');
  });

  test('starts fresh on version mismatch', async () => {
    const cachePath = join(tmpDir, '.anytype-cache.json');
    await Bun.write(cachePath, JSON.stringify({
      version: '0.0', // wrong version
      spaceId: 'space-1',
      exportDate: new Date().toISOString(),
      objects: { obj1: { slug: 'old', lastModified: '', contentHash: '' } },
      settings: { outputDir: tmpDir, includeFiles: true },
    }));
    const cache = await makeCache();
    await cache.load();
    expect(cache.getAll()).toEqual({});
  });

  test('starts fresh on spaceId mismatch', async () => {
    const cache = await makeCache({ spaceId: 'space-A' });
    cache.update('obj1', { slug: 'note', lastModified: '', contentHash: 'x' });
    await cache.save();

    const cache2 = await makeCache({ spaceId: 'space-B' }); // different space
    await cache2.load();
    expect(cache2.getAll()).toEqual({});
  });

  test('starts fresh on corrupt JSON', async () => {
    const cachePath = join(tmpDir, '.anytype-cache.json');
    await Bun.write(cachePath, 'this is not json {{{');
    const cache = await makeCache();
    await cache.load(); // should not throw
    expect(cache.getAll()).toEqual({});
  });
});

// ── save ───────────────────────────────────────────────────────────────────────

describe('CacheManager.save', () => {
  test('writes file to disk', async () => {
    const cache = await makeCache();
    cache.update('obj1', { slug: 'my-note', lastModified: '2024-01-01T00:00:00.000Z', contentHash: 'abc' });
    await cache.save();

    const cachePath = join(tmpDir, '.anytype-cache.json');
    const exists = await Bun.file(cachePath).exists();
    expect(exists).toBe(true);
  });

  test('is a no-op when nothing changed (dirty=false)', async () => {
    const cache = await makeCache();
    // Don't call update — cache should not be written
    await cache.save();
    const cachePath = join(tmpDir, '.anytype-cache.json');
    expect(await Bun.file(cachePath).exists()).toBe(false);
  });

  test('written JSON is re-loadable', async () => {
    const cache = await makeCache();
    cache.update('obj1', { slug: 'hello', lastModified: '2024-06-01T00:00:00.000Z', contentHash: 'hash1' });
    await cache.save();

    const cache2 = await makeCache();
    await cache2.load();
    const entry = cache2.getAll()['obj1'];
    expect(entry?.slug).toBe('hello');
    expect(entry?.contentHash).toBe('hash1');
  });
});

// ── isUnchanged ────────────────────────────────────────────────────────────────

describe('CacheManager.isUnchanged', () => {
  test('returns false for unknown object', async () => {
    const cache = await makeCache();
    expect(cache.isUnchanged('unknown', '2024-01-01', 'hash')).toBe(false);
  });

  test('returns true when both lastModified and hash match', async () => {
    const cache = await makeCache();
    cache.update('obj1', { slug: 'x', lastModified: '2024-01-01', contentHash: 'abc' });
    expect(cache.isUnchanged('obj1', '2024-01-01', 'abc')).toBe(true);
  });

  test('returns false when lastModified differs', async () => {
    const cache = await makeCache();
    cache.update('obj1', { slug: 'x', lastModified: '2024-01-01', contentHash: 'abc' });
    expect(cache.isUnchanged('obj1', '2024-01-02', 'abc')).toBe(false);
  });

  test('returns false when contentHash differs', async () => {
    const cache = await makeCache();
    cache.update('obj1', { slug: 'x', lastModified: '2024-01-01', contentHash: 'abc' });
    expect(cache.isUnchanged('obj1', '2024-01-01', 'xyz')).toBe(false);
  });

  test('returns false when both differ', async () => {
    const cache = await makeCache();
    cache.update('obj1', { slug: 'x', lastModified: '2024-01-01', contentHash: 'abc' });
    expect(cache.isUnchanged('obj1', '2024-02-01', 'new-hash')).toBe(false);
  });
});

// ── getDeletedIds ──────────────────────────────────────────────────────────────

describe('CacheManager.getDeletedIds', () => {
  test('returns ids present in cache but missing from current set', async () => {
    const cache = await makeCache();
    cache.update('obj1', { slug: 'a', lastModified: '', contentHash: '' });
    cache.update('obj2', { slug: 'b', lastModified: '', contentHash: '' });
    cache.update('obj3', { slug: 'c', lastModified: '', contentHash: '' });

    const currentIds = new Set(['obj1', 'obj3']); // obj2 was deleted
    const deleted = cache.getDeletedIds(currentIds);
    expect(deleted).toEqual(['obj2']);
  });

  test('returns empty array when nothing was deleted', async () => {
    const cache = await makeCache();
    cache.update('obj1', { slug: 'a', lastModified: '', contentHash: '' });
    expect(cache.getDeletedIds(new Set(['obj1']))).toEqual([]);
  });

  test('returns all cached ids when current set is empty', async () => {
    const cache = await makeCache();
    cache.update('obj1', { slug: 'a', lastModified: '', contentHash: '' });
    cache.update('obj2', { slug: 'b', lastModified: '', contentHash: '' });
    const deleted = cache.getDeletedIds(new Set());
    expect(deleted.sort()).toEqual(['obj1', 'obj2']);
  });
});

// ── remove & getCachedSlug ────────────────────────────────────────────────────

describe('CacheManager.remove / getCachedSlug', () => {
  test('getCachedSlug returns stored slug', async () => {
    const cache = await makeCache();
    cache.update('obj1', { slug: 'my-slug', lastModified: '', contentHash: '' });
    expect(cache.getCachedSlug('obj1')).toBe('my-slug');
  });

  test('getCachedSlug returns undefined for unknown id', async () => {
    const cache = await makeCache();
    expect(cache.getCachedSlug('nope')).toBeUndefined();
  });

  test('remove deletes entry from cache', async () => {
    const cache = await makeCache();
    cache.update('obj1', { slug: 'x', lastModified: '', contentHash: '' });
    cache.remove('obj1');
    expect(cache.getAll()['obj1']).toBeUndefined();
  });
});

// ── CacheManager.hash ─────────────────────────────────────────────────────────

describe('CacheManager.hash', () => {
  test('returns 16-char hex string', () => {
    const h = CacheManager.hash('hello world');
    expect(h).toHaveLength(16);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  test('same input → same hash', () => {
    expect(CacheManager.hash('abc')).toBe(CacheManager.hash('abc'));
  });

  test('different input → different hash', () => {
    expect(CacheManager.hash('abc')).not.toBe(CacheManager.hash('xyz'));
  });

  test('empty string is hashable', () => {
    expect(() => CacheManager.hash('')).not.toThrow();
  });
});

// ── typeName persistence (BUG 3 regression) ───────────────────────────────────

describe('CacheManager — typeName in CacheEntry', () => {
  test('stores and retrieves typeName', async () => {
    const cache = await makeCache();
    cache.update('obj1', { slug: 'note', lastModified: '', contentHash: '', typeName: 'Note' });
    await cache.save();

    const cache2 = await makeCache();
    await cache2.load();
    expect(cache2.getAll()['obj1']?.typeName).toBe('Note');
  });

  test('typeName is optional — old cache entries without it still load', async () => {
    const cachePath = join(tmpDir, '.anytype-cache.json');
    await Bun.write(cachePath, JSON.stringify({
      version: '1.0',
      spaceId: 'space-1',
      exportDate: new Date().toISOString(),
      objects: {
        obj1: { slug: 'old-note', lastModified: '2024-01-01', contentHash: 'abc' }
        // no typeName field
      },
      settings: { outputDir: tmpDir, includeFiles: true },
    }));
    const cache = await makeCache();
    await cache.load();
    expect(cache.getAll()['obj1']?.slug).toBe('old-note');
    expect(cache.getAll()['obj1']?.typeName).toBeUndefined();
  });
});
