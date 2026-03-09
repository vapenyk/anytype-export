/**
 * Content hashing for cache invalidation.
 *
 * Defined here to avoid a circular dependency between `Exporter` and `CacheManager`.
 *
 * @module
 */

/**
 * Returns a 16-char hex prefix of SHA-256(content).
 *
 * 64 bits is sufficient for collision-free comparison across any realistic note
 * collection while keeping the cache file compact. Not cryptographically sensitive —
 * used only for cache invalidation.
 */
export function contentHash(content: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(content);
  return hasher.digest('hex').slice(0, 16);
}
