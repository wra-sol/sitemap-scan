import { describe, expect, it, vi } from 'vitest';
import { applyRateLimit, RateLimitEnv } from './rate-limit';

function createMockKV() {
  const store = new Map<string, { value: string; expiration?: number }>();

  const kv = {
    get: vi.fn((key: string) => {
      const entry = store.get(key);
      if (entry && entry.expiration && entry.expiration < Math.floor(Date.now() / 1000)) {
        store.delete(key);
        return Promise.resolve(null);
      }
      return Promise.resolve(entry?.value ?? null);
    }),
    put: vi.fn((key: string, value: string, options?: { expirationTtl?: number }) => {
      const expiration = options?.expirationTtl ? Math.floor(Date.now() / 1000) + options.expirationTtl : undefined;
      store.set(key, { value, expiration });
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    })
  } as unknown as KVNamespace;

  return { kv, store };
}

function createEnv(kv: KVNamespace, overrides?: Partial<RateLimitEnv>): RateLimitEnv {
  return {
    BACKUP_KV: kv,
    ...overrides
  };
}

function makeRequest(path: string, headers?: Record<string, string>): Request {
  return new Request(`https://example.workers.dev${path}`, {
    headers: headers ?? { Authorization: 'Bearer secret-token' }
  });
}

describe('applyRateLimit', () => {
  it('allows public paths without rate limiting', async () => {
    const { kv } = createMockKV();
    const env = createEnv(kv);

    expect(await applyRateLimit(makeRequest('/'), env)).toBeNull();
    expect(await applyRateLimit(makeRequest('/app'), env)).toBeNull();
    expect(await applyRateLimit(makeRequest('/diff/viewer'), env)).toBeNull();
    expect(await applyRateLimit(makeRequest('/backup/viewer'), env)).toBeNull();
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('allows requests when under the limit', async () => {
    const { kv } = createMockKV();
    const env = createEnv(kv, { RATE_LIMIT_REQUESTS: '5', RATE_LIMIT_WINDOW_MS: '60000' });

    for (let i = 0; i < 5; i++) {
      const result = await applyRateLimit(makeRequest('/api/sites'), env);
      expect(result).toBeNull();
    }

    expect(kv.put).toHaveBeenCalledTimes(5);
  });

  it('blocks requests when over the limit', async () => {
    const { kv } = createMockKV();
    const env = createEnv(kv, { RATE_LIMIT_REQUESTS: '2', RATE_LIMIT_WINDOW_MS: '60000' });

    expect(await applyRateLimit(makeRequest('/api/sites'), env)).toBeNull();
    expect(await applyRateLimit(makeRequest('/api/sites'), env)).toBeNull();

    const blocked = await applyRateLimit(makeRequest('/api/sites'), env);
    expect(blocked).not.toBeNull();
    expect(blocked?.status).toBe(429);
    expect(await blocked?.json()).toMatchObject({ error: 'Too many requests' });
    expect(blocked?.headers.get('Retry-After')).toBeTruthy();
  });

  it('uses CF-Connecting-IP as client identifier', async () => {
    const { kv } = createMockKV();
    const env = createEnv(kv, { RATE_LIMIT_REQUESTS: '1', RATE_LIMIT_WINDOW_MS: '60000' });

    const reqA = makeRequest('/api/sites', { 'cf-connecting-ip': '1.2.3.4', Authorization: 'Bearer token-a' });
    const reqB = makeRequest('/api/sites', { 'cf-connecting-ip': '5.6.7.8', Authorization: 'Bearer token-a' });

    expect(await applyRateLimit(reqA, env)).toBeNull();
    expect(await applyRateLimit(reqB, env)).toBeNull();

    const blockedA = await applyRateLimit(reqA, env);
    expect(blockedA?.status).toBe(429);

    const blockedB = await applyRateLimit(reqB, env);
    expect(blockedB?.status).toBe(429);
  });

  it('falls back to authorization token when no IP header is present', async () => {
    const { kv } = createMockKV();
    const env = createEnv(kv, { RATE_LIMIT_REQUESTS: '1', RATE_LIMIT_WINDOW_MS: '60000' });

    const reqA = makeRequest('/api/sites', { Authorization: 'Bearer token-a' });
    const reqB = makeRequest('/api/sites', { Authorization: 'Bearer token-b' });

    expect(await applyRateLimit(reqA, env)).toBeNull();
    expect(await applyRateLimit(reqA, env)).not.toBeNull();
    expect(await applyRateLimit(reqB, env)).toBeNull();
  });

  it('falls back to x-api-key when no IP or bearer token is present', async () => {
    const { kv } = createMockKV();
    const env = createEnv(kv, { RATE_LIMIT_REQUESTS: '1', RATE_LIMIT_WINDOW_MS: '60000' });

    const reqA = makeRequest('/api/sites', { 'x-api-key': 'key-a' });
    const reqB = makeRequest('/api/sites', { 'x-api-key': 'key-b' });

    expect(await applyRateLimit(reqA, env)).toBeNull();
    expect(await applyRateLimit(reqA, env)).not.toBeNull();
    expect(await applyRateLimit(reqB, env)).toBeNull();
  });

  it('resets the counter when the window rolls over', async () => {
    const { kv, store } = createMockKV();
    const env = createEnv(kv, { RATE_LIMIT_REQUESTS: '1', RATE_LIMIT_WINDOW_MS: '1000' });

    const req = makeRequest('/api/sites');

    expect(await applyRateLimit(req, env)).toBeNull();
    expect(await applyRateLimit(req, env)).not.toBeNull();

    // Force the stored key to look expired by manipulating its expiration
    const key = Array.from(store.keys()).find((k) => k.startsWith('rate_limit:'));
    expect(key).toBeTruthy();
    if (key) {
      store.set(key, { value: '99', expiration: Math.floor(Date.now() / 1000) - 1 });
    }

    expect(await applyRateLimit(req, env)).toBeNull();
  });

  it('returns 429 with Retry-After header', async () => {
    const { kv } = createMockKV();
    const env = createEnv(kv, { RATE_LIMIT_REQUESTS: '1', RATE_LIMIT_WINDOW_MS: '60000' });

    const req = makeRequest('/api/sites');
    await applyRateLimit(req, env);

    const blocked = await applyRateLimit(req, env);
    expect(blocked?.status).toBe(429);
    const retryAfter = blocked?.headers.get('Retry-After');
    expect(retryAfter).toBeTruthy();
    expect(Number.parseInt(retryAfter!, 10)).toBeGreaterThan(0);
  });

  it('skips rate limiting when env variables are invalid', async () => {
    const { kv } = createMockKV();
    const env = createEnv(kv, { RATE_LIMIT_REQUESTS: '-1', RATE_LIMIT_WINDOW_MS: '0' });

    expect(await applyRateLimit(makeRequest('/api/sites'), env)).toBeNull();
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('allows requests when KV read throws', async () => {
    const kv = {
      get: vi.fn(() => Promise.reject(new Error('KV down'))),
      put: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.resolve())
    } as unknown as KVNamespace;

    const env = createEnv(kv, { RATE_LIMIT_REQUESTS: '1', RATE_LIMIT_WINDOW_MS: '60000' });

    expect(await applyRateLimit(makeRequest('/api/sites'), env)).toBeNull();
  });

  it('allows requests when KV write throws', async () => {
    const kv = {
      get: vi.fn(() => Promise.resolve('0')),
      put: vi.fn(() => Promise.reject(new Error('KV down'))),
      delete: vi.fn(() => Promise.resolve())
    } as unknown as KVNamespace;

    const env = createEnv(kv, { RATE_LIMIT_REQUESTS: '1', RATE_LIMIT_WINDOW_MS: '60000' });

    expect(await applyRateLimit(makeRequest('/api/sites'), env)).toBeNull();
  });
});
