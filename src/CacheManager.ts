/**
 * Incremental export state management.
 *
 * Tracks which objects have already been exported to avoid redundant work on
 * subsequent runs. The cache is written to `.anytype-cache.json` in the output directory.
 *
 * Objects whose `lastModified` timestamp and content hash both match the cached
 * values are skipped. Only changed or new objects are re-exported.
 *
 * @module
 */

import { join } from 'node:path';
import type { CacheData, CacheEntry } from './types.ts';
import { contentHash } from './hash.ts';
import { Logger } from './logger.ts';

// Bumped when the cache schema changes in a backwards-incompatible way.
const CACHE_VERSION  = '1.0';
const CACHE_FILENAME = '.anytype-cache.json';

/** Manages the `.anytype-cache.json` file for incremental exports. */
export class CacheManager {
  private data:               CacheData;
  private readonly cachePath: string;
  private readonly logger:    Logger;
  private dirty = false; // true when data has been modified since last save()

  constructor(outputDir: string, spaceId: string, logger?: Logger) {
    this.cachePath = join(outputDir, CACHE_FILENAME);
    this.logger    = logger ?? new Logger();
    this.data = {
      version:    CACHE_VERSION,
      spaceId,
      exportDate: new Date().toISOString(),
      objects:    {},
      settings:   { outputDir, includeFiles: true },
    };
  }

  /**
   * Read the cache from disk into memory.
   *
   * Silently starts fresh when the file is absent, the version or spaceId
   * doesn't match, or the file is corrupt.
   */
  async load(): Promise<void> {
    const file = Bun.file(this.cachePath);
    if (!(await file.exists())) {
      this.logger.debug('No cache file found — starting fresh export');
      return;
    }
    try {
      const parsed = await file.json() as CacheData;
      if (parsed.version !== CACHE_VERSION || parsed.spaceId !== this.data.spaceId) {
        this.logger.warn('Cache version/space mismatch — starting fresh');
        return;
      }
      this.data = parsed;
      this.logger.debug(`Loaded cache: ${Object.keys(parsed.objects).length} objects`);
    } catch (err) {
      this.logger.warn(`Could not read cache: ${err} — starting fresh`);
    }
  }

  /**
   * Flush the in-memory state to disk.
   * No-op when nothing has changed since the last save.
   */
  async save(): Promise<void> {
    if (!this.dirty) return;
    this.data.exportDate = new Date().toISOString();
    await Bun.write(this.cachePath, JSON.stringify(this.data, null, 2));
    this.logger.debug(`Cache saved (${Object.keys(this.data.objects).length} entries)`);
  }

  /**
   * Returns `true` when the object can be skipped.
   *
   * Both `lastModified` and `contentHash` must match — the hash guards against
   * exporter logic changes that affect output without modifying the source object.
   */
  isUnchanged(objectId: string, lastModified: string, hash: string): boolean {
    const entry = this.data.objects[objectId];
    if (!entry) return false;
    return entry.lastModified === lastModified && entry.contentHash === hash;
  }

  /** Returns the slug stored for this object at the last export, or `undefined`. */
  getCachedSlug(objectId: string): string | undefined {
    return this.data.objects[objectId]?.slug;
  }

  /** Record an exported object. Marks the cache dirty for the next `save()`. */
  update(objectId: string, entry: CacheEntry): void {
    this.data.objects[objectId] = entry;
    this.dirty = true;
  }

  /**
   * Returns IDs present in the last export but absent from the current API response
   * — objects deleted in Anytype since the last run. Used to remove stale `.md` files.
   */
  getDeletedIds(currentIds: Set<string>): string[] {
    return Object.keys(this.data.objects).filter(id => !currentIds.has(id));
  }

  /** Remove an object from the cache (called after deleting its output file). */
  remove(objectId: string): void {
    delete this.data.objects[objectId];
    this.dirty = true;
  }

  /** Shallow copy of all cache entries — safe to iterate while mutating. */
  getAll(): Record<string, CacheEntry> {
    return { ...this.data.objects };
  }

  /**
   * 16-char hex prefix of SHA-256(content).
   * Exposed as a static so callers with a `CacheManager` reference don't need
   * a separate import of `hash.ts`.
   */
  static hash(content: string): string {
    return contentHash(content);
  }
}
