import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import {
  AnytypeClient,
  AnytypeConnectionError,
  AnytypeAuthError,
  AnytypeGoneError,
  AnytypeRateLimitError,
} from '../src/AnytypeClient.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeClient(overrides: { maxRetries?: number; retryDelay?: number; timeout?: number } = {}) {
  return new AnytypeClient({
    apiKey: 'test-key',
    baseUrl: 'http://127.0.0.1:31009',
    maxRetries: overrides.maxRetries ?? 2,
    retryDelay: overrides.retryDelay ?? 0, // no actual delays in tests
    timeout: overrides.timeout ?? 5000,
  });
}

function mockFetch(response: Response | Response[] | (() => Response)) {
  const fetchSpy = spyOn(globalThis, 'fetch');
  if (typeof response === 'function') {
    fetchSpy.mockImplementation(response as any);
  } else if (Array.isArray(response)) {
    let i = 0;
    fetchSpy.mockImplementation(() => Promise.resolve(response[i++] ?? response[response.length - 1]));
  } else {
    fetchSpy.mockResolvedValue(response);
  }
  return fetchSpy;
}

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// ── Constructor ───────────────────────────────────────────────────────────────

describe('AnytypeClient constructor', () => {
  test('throws when apiKey is empty', () => {
    expect(() => new AnytypeClient({ apiKey: '' })).toThrow('apiKey is required');
  });

  test('accepts valid config', () => {
    expect(() => makeClient()).not.toThrow();
  });
});

// ── Error classification ───────────────────────────────────────────────────────

describe('AnytypeClient — error classification', () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  afterEach(() => fetchSpy?.mockRestore());

  test('throws AnytypeConnectionError on ECONNREFUSED', async () => {
    const err = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(err);
    const client = makeClient();
    await expect(client.getSpaces()).rejects.toBeInstanceOf(AnytypeConnectionError);
  });

  test('throws AnytypeConnectionError when cause is ECONNREFUSED', async () => {
    const cause = Object.assign(new Error('inner'), { code: 'ECONNREFUSED' });
    const err = Object.assign(new Error('outer'), { cause });
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(err);
    await expect(makeClient().getSpaces()).rejects.toBeInstanceOf(AnytypeConnectionError);
  });

  test('throws AnytypeAuthError on 401', async () => {
    fetchSpy = mockFetch(new Response('Unauthorized', { status: 401 }));
    await expect(makeClient().getSpaces()).rejects.toBeInstanceOf(AnytypeAuthError);
  });

  test('throws AnytypeAuthError on 403', async () => {
    fetchSpy = mockFetch(new Response('Forbidden', { status: 403 }));
    await expect(makeClient().getSpaces()).rejects.toBeInstanceOf(AnytypeAuthError);
  });

  test('throws AnytypeGoneError on 410', async () => {
    fetchSpy = mockFetch(new Response('Gone', { status: 410 }));
    await expect(makeClient().getSpaces()).rejects.toBeInstanceOf(AnytypeGoneError);
  });

  test('throws AnytypeRateLimitError after exhausting 429 retries', async () => {
    fetchSpy = mockFetch(new Response('Rate limit', {
      status: 429,
      headers: { 'Retry-After': '0' },
    }));
    const client = makeClient({ maxRetries: 2 });
    await expect(client.getSpaces()).rejects.toBeInstanceOf(AnytypeRateLimitError);
  });

  test('throws generic Error on 404', async () => {
    fetchSpy = mockFetch(new Response('Not found', { status: 404 }));
    await expect(makeClient().getSpaces()).rejects.toThrow('Object not found');
  });
});

// ── Retry logic ────────────────────────────────────────────────────────────────

describe('AnytypeClient — retry logic', () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  afterEach(() => fetchSpy?.mockRestore());

  test('retries on 5xx and eventually succeeds', async () => {
    fetchSpy = mockFetch([
      new Response('Server error', { status: 500 }),
      jsonResponse({ data: [], pagination: { has_more: false } }),
    ]);
    const client = makeClient({ maxRetries: 2 });
    const spaces = await client.getSpaces();
    expect(spaces).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test('throws after exhausting retries on 5xx', async () => {
    fetchSpy = mockFetch(new Response('Server error', { status: 500 }));
    const client = makeClient({ maxRetries: 2 });
    await expect(client.getSpaces()).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  test('does NOT retry on 401', async () => {
    fetchSpy = mockFetch(new Response('Unauthorized', { status: 401 }));
    await expect(makeClient().getSpaces()).rejects.toBeInstanceOf(AnytypeAuthError);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // no retry
  });

  test('retries 429 up to maxRetries then throws', async () => {
    fetchSpy = mockFetch(new Response('Too Many Requests', {
      status: 429,
      headers: { 'Retry-After': '0' },
    }));
    const client = makeClient({ maxRetries: 3 });
    await expect(client.getSpaces()).rejects.toBeInstanceOf(AnytypeRateLimitError);
    // 1 initial + 3 retries = 4 calls
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  test('succeeds after 429 followed by success', async () => {
    fetchSpy = mockFetch([
      new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '0' } }),
      jsonResponse({ data: [{ id: 's1', name: 'My Space' }], pagination: { has_more: false } }),
    ]);
    const client = makeClient({ maxRetries: 2 });
    const spaces = await client.getSpaces();
    expect(spaces).toHaveLength(1);
    expect(spaces[0].name).toBe('My Space');
  });
});

// ── paginate ───────────────────────────────────────────────────────────────────

describe('AnytypeClient — pagination', () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  afterEach(() => fetchSpy?.mockRestore());

  test('returns all items across pages when has_more=true', async () => {
    fetchSpy = mockFetch([
      jsonResponse({ data: Array(100).fill({ id: 'x', name: 'a' }), pagination: { has_more: true } }),
      jsonResponse({ data: [{ id: 'y', name: 'b' }], pagination: { has_more: false } }),
    ]);
    const spaces = await makeClient().getSpaces();
    expect(spaces).toHaveLength(101);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test('stops without extra request when exactly 100 items and has_more=false', async () => {
    fetchSpy = mockFetch(
      jsonResponse({ data: Array(100).fill({ id: 'x', name: 'a' }), pagination: { has_more: false } })
    );
    const spaces = await makeClient().getSpaces();
    expect(spaces).toHaveLength(100);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // BUG 5 fix — no extra request
  });

  test('stops on empty chunk even when no pagination field', async () => {
    fetchSpy = mockFetch([
      jsonResponse({ data: Array(100).fill({ id: 'x', name: 'a' }) }),
      jsonResponse({ data: [] }),
    ]);
    const spaces = await makeClient().getSpaces();
    expect(spaces).toHaveLength(100);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test('handles single page of < 100 items', async () => {
    fetchSpy = mockFetch(jsonResponse({ data: [{ id: 'a' }, { id: 'b' }], pagination: { has_more: false } }));
    const spaces = await makeClient().getSpaces();
    expect(spaces).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ── getObjectsBatched ─────────────────────────────────────────────────────────

describe('AnytypeClient.getObjectsBatched', () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  afterEach(() => fetchSpy?.mockRestore());

  test('returns results for all summaries', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      const id = String(url).split('/').pop()?.split('?')[0];
      return Promise.resolve(jsonResponse({ object: { id, name: `obj-${id}`, markdown: 'body' } }));
    });
    const summaries = [{ id: 'a1' }, { id: 'b2' }];
    const results = await makeClient().getObjectsBatched('space1', summaries as any, 10, 0);
    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('obj-a1');
  });

  test('falls back to summary on individual fetch failure', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      const id = String(url).split('/').pop()?.split('?')[0];
      // a1 always fails, b2 always succeeds
      if (id === 'a1') return Promise.resolve(new Response('err', { status: 500 }));
      return Promise.resolve(jsonResponse({ object: { id: 'b2', name: 'B', markdown: '' } }));
    });
    const summaries = [{ id: 'a1', name: 'A Fallback' }, { id: 'b2' }];
    const results = await makeClient().getObjectsBatched('space1', summaries as any, 10, 0);
    expect(results).toHaveLength(2);
    // a1 failed all retries → fell back to summary name
    expect(results.find(r => r.id === 'a1')?.name).toBe('A Fallback');
    // b2 succeeded
    expect(results.find(r => r.id === 'b2')?.name).toBe('B');
  });

  test('calls onProgress callback', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((url: any) => {
      const id = String(url).split('/').pop()?.split('?')[0];
      return Promise.resolve(jsonResponse({ object: { id, markdown: '' } }));
    });
    const progressCalls: Array<[number, number]> = [];
    await makeClient().getObjectsBatched(
      'space1',
      [{ id: 'a' }, { id: 'b' }] as any,
      2,
      0,
      (done, total) => progressCalls.push([done, total])
    );
    expect(progressCalls.length).toBeGreaterThan(0);
    expect(progressCalls[progressCalls.length - 1]).toEqual([2, 2]);
  });
});

// ── API version warning ───────────────────────────────────────────────────────

describe('AnytypeClient — API version mismatch warning', () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  afterEach(() => fetchSpy?.mockRestore());

  test('does not throw on version mismatch — just warns', async () => {
    fetchSpy = mockFetch(new Response(JSON.stringify({ data: [], pagination: { has_more: false } }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Anytype-Version': '2020-01-01', // older than client
      },
    }));
    // Should not throw — only log a warning
    await expect(makeClient().getSpaces()).resolves.toEqual([]);
  });
});
