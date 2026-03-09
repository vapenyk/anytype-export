/**
 * HTTP client for the Anytype daemon.
 *
 * Modelled after the official Raycast extension's `apiFetch` pattern:
 * https://github.com/raycast/extensions/tree/main/extensions/anytype
 *
 * @module
 */

import type {
  FullObject,
  ObjectSummary,
  TypeDefinition,
  SpaceInfo,
  MemberInfo,
  ListView,
} from './types.ts';
import { Logger } from './logger.ts';

// ── Constants — single source of truth imported by types.ts and AuthFlow ──────

/** Anytype daemon — used for all REST API calls. Port is fixed by Anytype. */
export const DAEMON_URL  = 'http://127.0.0.1:31009';

/** Anytype gateway — used for file/image downloads. Port is fixed by Anytype. */
export const GATEWAY_URL = 'http://127.0.0.1:47800';

/** API version sent as the `Anytype-Version` header on every request. */
export const API_VERSION = '2025-11-08';

/** App identifier sent in the auth challenge request (visible in Anytype Settings → API). */
export const APP_NAME    = 'anytype-export';

// ── Typed Errors ─────────────────────────────────────────────────────────────

/** Thrown when the daemon is not reachable (ECONNREFUSED — Anytype app not running). */
export class AnytypeConnectionError extends Error {
  constructor() {
    super(
      `Can't connect to Anytype. Please ensure the Anytype desktop app is running.\n\n` +
      `  → Open Anytype, then try again.`
    );
    this.name = 'AnytypeConnectionError';
  }
}

/** Thrown on HTTP 401/403 — key missing, invalid, or revoked. */
export class AnytypeAuthError extends Error {
  constructor() {
    super(
      `API key is invalid or has expired.\n\n` +
      `  → Run: anytype-export login   to get a new key.`
    );
    this.name = 'AnytypeAuthError';
  }
}

/** Thrown on HTTP 429 when all retries are exhausted. */
export class AnytypeRateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Rate limit exceeded. Retry after ${retryAfterMs}ms.`);
    this.name = 'AnytypeRateLimitError';
  }
}

/** Thrown on HTTP 410 — the object was hard-deleted (not just archived) in Anytype. */
export class AnytypeGoneError extends Error {
  constructor(id: string) {
    super(`Object ${id} has been permanently deleted.`);
    this.name = 'AnytypeGoneError';
  }
}

/** Maps HTTP status codes to human-readable messages. Falls back to raw status/text. */
function httpErrorMessage(status: number, fallback: string): string {
  const messages: Record<number, string> = {
    403: 'Operation not permitted.',
    404: 'Object not found.',
    410: 'Object has been deleted.',
    429: 'Rate Limit Exceeded: Please try again later.',
  };
  return messages[status] ?? fallback;
}

// ── Client Config ─────────────────────────────────────────────────────────────

interface ClientConfig {
  apiKey:      string;
  baseUrl?:    string;    // default: DAEMON_URL
  apiVersion?: string;    // default: API_VERSION
  maxRetries?: number;    // default: 3
  retryDelay?: number;    // default: 1 000 ms
  timeout?:    number;    // default: 30 000 ms
  logger?:     Logger;
}

type SearchQuery = {
  query?:  string;
  types?:  string[];
  limit?:  number;
  offset?: number;
};

// ── AnytypeClient ─────────────────────────────────────────────────────────────

/** HTTP client for the Anytype daemon REST API. */
export class AnytypeClient {
  /** Base URL of the daemon — exposed for file download URL construction. */
  readonly baseUrl: string;

  private readonly apiKey:     string;
  private readonly apiVersion: string;
  private readonly maxRetries: number;
  private readonly retryDelay: number;
  private readonly timeout:    number;
  private readonly logger:     Logger;

  constructor(cfg: ClientConfig) {
    if (!cfg.apiKey) throw new Error('apiKey is required');
    this.apiKey      = cfg.apiKey;
    this.baseUrl     = cfg.baseUrl    ?? DAEMON_URL;
    this.apiVersion  = cfg.apiVersion ?? API_VERSION;
    this.maxRetries  = cfg.maxRetries ?? 3;
    this.retryDelay  = cfg.retryDelay ?? 1_000;
    this.timeout     = cfg.timeout    ?? 30_000;
    this.logger      = cfg.logger     ?? new Logger();
  }

  /**
   * Low-level authenticated request with retry and error classification.
   *
   * Retry policy:
   * - `ECONNREFUSED` → throw immediately (app not running)
   * - `AbortError` / `TimeoutError` → retry up to `maxRetries` with exponential backoff
   * - 429 → wait `Retry-After` ms, then retry (counts against maxRetries)
   * - 5xx → retry up to `maxRetries`
   * - 4xx (non-429) → throw immediately (retrying won't help)
   */
  private async req<T>(path: string, options: RequestInit = {}, attempt = 1): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    this.logger.debug(`→ ${options.method ?? 'GET'} ${path}`);

    let res: Response;
    try {
      res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(this.timeout),
        headers: {
          'Content-Type':    'application/json',
          'Anytype-Version':  this.apiVersion,
          'Authorization':   `Bearer ${this.apiKey}`,
          ...(options.headers as Record<string, string> ?? {}),
        },
      });
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { name?: string; cause?: NodeJS.ErrnoException };
      if (e.code === 'ECONNREFUSED' || e.cause?.code === 'ECONNREFUSED') {
        throw new AnytypeConnectionError();
      }
      if (e.name === 'AbortError' || e.name === 'TimeoutError') {
        if (attempt <= this.maxRetries) {
          this.logger.warn(`Timeout (attempt ${attempt}/${this.maxRetries}), retrying…`);
          await sleep(this.retryDelay * attempt);
          return this.req<T>(path, options, attempt + 1);
        }
        throw new Error(`Request timed out after ${this.timeout}ms: ${path}`);
      }
      if (attempt <= this.maxRetries) {
        await sleep(this.retryDelay * attempt);
        return this.req<T>(path, options, attempt + 1);
      }
      throw err;
    }

    // API version mismatch warnings
    const serverVersion = res.headers.get('Anytype-Version');
    if (serverVersion && serverVersion !== this.apiVersion) {
      const serverDate = new Date(serverVersion);
      const clientDate = new Date(this.apiVersion);
      if (!isNaN(serverDate.getTime()) && !isNaN(clientDate.getTime())) {
        if (serverDate < clientDate) {
          this.logger.warn(`Anytype app is outdated. Expected API ${this.apiVersion}, got ${serverVersion}. Please update Anytype.`);
        } else {
          this.logger.warn(`anytype-export may be outdated. Server API is ${serverVersion}, client expects ${this.apiVersion}.`);
        }
      }
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new AnytypeAuthError();
      if (res.status === 410) throw new AnytypeGoneError(path);
      if (res.status === 429) {
        const retryAfterMs = parseInt(res.headers.get('Retry-After') ?? '2', 10) * 1_000;
        if (attempt <= this.maxRetries) {
          this.logger.warn(`Rate limited. Waiting ${retryAfterMs}ms…`);
          await sleep(retryAfterMs);
          return this.req<T>(path, options, attempt + 1);
        }
        throw new AnytypeRateLimitError(retryAfterMs);
      }
      if (res.status >= 500 && attempt <= this.maxRetries) {
        await sleep(this.retryDelay * attempt);
        return this.req<T>(path, options, attempt + 1);
      }
      let body = '';
      try { body = await res.text(); } catch { /* ignore — already in error path */ }
      throw new Error(httpErrorMessage(
        res.status,
        `API request failed: [${res.status}] ${res.statusText} ${body}`
      ));
    }

    try {
      return await res.json() as T;
    } catch {
      throw new Error(`Failed to parse JSON response from ${path}`);
    }
  }

  /**
   * Fetches all pages of a paginated endpoint.
   * Uses the `has_more` field from the pagination object; falls back to a
   * chunk-size heuristic when pagination metadata is absent.
   */
  private async paginate<T>(path: string, key: string, pageDelay = 200): Promise<T[]> {
    const items: T[] = [];
    let offset = 0;
    while (true) {
      const sep  = path.includes('?') ? '&' : '?';
      const data = await this.req<Record<string, unknown>>(`${path}${sep}limit=100&offset=${offset}`);
      const chunk      = (data[key] ?? []) as T[];
      const pagination = data['pagination'] as { has_more?: boolean } | undefined;
      const hasMore    = pagination?.has_more ?? (chunk.length > 0 && chunk.length === 100);
      items.push(...chunk);
      if (chunk.length === 0) break;
      if (!hasMore) break;
      offset += 100;
      if (pageDelay > 0) await sleep(pageDelay);
    }
    return items;
  }

  // ── Spaces ──────────────────────────────────────────────────────────────────

  /** Returns all spaces the current API key has access to. */
  getSpaces(): Promise<SpaceInfo[]> {
    return this.paginate<SpaceInfo>('/v1/spaces', 'data');
  }

  /** Returns full details for a single space, including `gateway_url`. */
  async getSpace(spaceId: string): Promise<SpaceInfo> {
    const data = await this.req<{ space?: SpaceInfo }>(`/v1/spaces/${spaceId}`);
    return data.space ?? { id: spaceId };
  }

  // ── Objects ─────────────────────────────────────────────────────────────────

  /**
   * Returns lightweight object summaries for all objects in a space.
   *
   * When `typeKeys` is non-empty, type names are sent as a query parameter for
   * server-side pre-filtering. `ExportPipeline` still applies client-side
   * filtering as a safety net for case sensitivity / display-name mismatches.
   */
  getObjects(spaceId: string, typeKeys: string[] = []): Promise<ObjectSummary[]> {
    const base = `/v1/spaces/${spaceId}/objects`;
    const path = typeKeys.length > 0
      ? `${base}?type_key=${encodeURIComponent(typeKeys.map(t => t.toLowerCase()).join(','))}`
      : base;
    return this.paginate<ObjectSummary>(path, 'data');
  }

  /**
   * Returns a full object including the rendered markdown body.
   * `format=md` requests the body rendered as markdown (vs JSON blocks).
   */
  async getObject(spaceId: string, objectId: string): Promise<FullObject> {
    const data = await this.req<{ object?: FullObject }>(
      `/v1/spaces/${spaceId}/objects/${objectId}?format=md`
    );
    return data.object ?? { id: objectId };
  }

  /**
   * Fetches full objects in parallel batches with rate limiting and progress reporting.
   *
   * Uses `Promise.allSettled` so a single failed object doesn't abort the batch.
   * Failed objects fall back to their summary (no markdown body).
   */
  async getObjectsBatched(
    spaceId:       string,
    summaries:     ObjectSummary[],
    batchSize      = 10,
    rateLimitDelay = 500,
    onProgress?:   (done: number, total: number) => void
  ): Promise<FullObject[]> {
    const results: FullObject[] = [];
    for (let i = 0; i < summaries.length; i += batchSize) {
      const batch   = summaries.slice(i, i + batchSize);
      const settled = await Promise.allSettled(batch.map(o => this.getObject(spaceId, o.id)));
      for (let j = 0; j < settled.length; j++) {
        const r = settled[j];
        if (r.status === 'fulfilled') {
          results.push(r.value);
        } else {
          this.logger.warn(`Failed to fetch object ${batch[j].id}: ${r.reason}`);
          results.push(batch[j] as FullObject);
        }
      }
      onProgress?.(Math.min(i + batchSize, summaries.length), summaries.length);
      if (i + batchSize < summaries.length) await sleep(rateLimitDelay);
    }
    return results;
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  /** Searches a single page of objects in a space. */
  async searchSpace(spaceId: string, query: SearchQuery = {}): Promise<ObjectSummary[]> {
    const { query: q = '', types = [], limit = 100, offset = 0 } = query;
    const data = await this.req<{ data?: ObjectSummary[] }>(
      `/v1/spaces/${spaceId}/search?limit=${limit}&offset=${offset}`,
      { method: 'POST', body: JSON.stringify({ query: q, types }) }
    );
    return data.data ?? [];
  }

  /** Fetches all pages of search results for a space. */
  async searchSpaceAll(spaceId: string, query: Omit<SearchQuery, 'limit' | 'offset'> = {}): Promise<ObjectSummary[]> {
    const all: ObjectSummary[] = [];
    let offset = 0;
    while (true) {
      const chunk = await this.searchSpace(spaceId, { ...query, limit: 100, offset });
      all.push(...chunk);
      if (chunk.length < 100) break; // no has_more on search endpoint — use chunk size
      offset += 100;
    }
    return all;
  }

  // ── Types / Members / Lists ──────────────────────────────────────────────────

  /** Returns all object types defined in a space. */
  getTypes(spaceId: string): Promise<TypeDefinition[]> {
    return this.paginate<TypeDefinition>(`/v1/spaces/${spaceId}/types`, 'data');
  }

  /** Returns all members of a space. */
  getMembers(spaceId: string): Promise<MemberInfo[]> {
    return this.paginate<MemberInfo>(`/v1/spaces/${spaceId}/members`, 'data');
  }

  /**
   * Returns views for a Set or Collection object.
   * Returns `[]` if the object has no views or the request fails.
   */
  async getListViews(spaceId: string, listId: string): Promise<ListView[]> {
    try {
      const d = await this.req<{ data?: ListView[] }>(`/v1/spaces/${spaceId}/lists/${listId}/views`);
      return d.data ?? [];
    } catch {
      return []; // not all objects have list views — treat 404 as empty
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
