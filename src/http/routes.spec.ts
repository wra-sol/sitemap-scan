import { describe, it, expect, vi } from 'vitest';
import {
  handleGetRequest,
  handlePostRequest,
  handlePutRequest,
  handleDeleteRequest,
  buildScrapeApiOptions,
} from './routes';
import { SiteManager } from '../sites/manager';
import { SiteRegistry } from '../sites/registry';
import { SlackNotifier } from '../slack/notifier';
import type { Env } from '../types/env';

function createMockKV(store: Record<string, string> = {}): KVNamespace {
  const data = new Map<string, string>(Object.entries(store));
  return {
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { data.set(key, value); }),
    delete: vi.fn(async (key: string) => { data.delete(key); }),
    list: vi.fn(async (opts?: { prefix?: string; limit?: number; cursor?: string }) => {
      const prefix = opts?.prefix ?? '';
      const limit = opts?.limit ?? 1000;
      const offset = Number.parseInt(opts?.cursor ?? '0', 10);
      const matching = Array.from(data.keys())
        .filter((k) => k.startsWith(prefix))
        .sort();
      const keys = matching.slice(offset, offset + limit).map((name) => ({
        name,
        expiration: undefined,
        metadata: undefined,
      }));
      const nextOffset = offset + keys.length;
      return {
        keys,
        list_complete: nextOffset >= matching.length,
        cursor: nextOffset < matching.length ? String(nextOffset) : undefined,
      };
    }),
  } as unknown as KVNamespace;
}

function createEnv(kv: KVNamespace): Env {
  return {
    BACKUP_KV: kv,
    CLOUDFLARE_ACCOUNT_ID: 'test-account',
    CLOUDFLARE_SCRAPE_API_TOKEN: 'test-token',
  } as Env;
}

function mockSiteManager(kv: KVNamespace): SiteManager {
  const manager = new SiteManager(kv);
  manager.getSiteConfig = vi.fn(async (id: string) => {
    const raw = await kv.get(`site_config:${id}`);
    return raw ? JSON.parse(raw) : null;
  });
  manager.getAllSiteConfigs = vi.fn(async () => {
    const listRaw = await kv.get('sites:list');
    if (!listRaw) return [];
    const ids: string[] = JSON.parse(listRaw);
    const configs = await Promise.all(
      ids.map(async (id) => {
        const raw = await kv.get(`site_config:${id}`);
        return raw ? JSON.parse(raw) : null;
      })
    );
    return configs.filter(Boolean);
  });
  manager.validateSiteConfig = vi.fn(async (config) => ({
    valid: Boolean(config.id && config.name),
    errors: [],
  }));
  manager.saveSiteConfig = vi.fn(async (config) => {
    await kv.put(`site_config:${config.id}`, JSON.stringify(config));
    return true;
  });
  return manager;
}

function mockSiteRegistry(kv: KVNamespace): SiteRegistry {
  const registry = new SiteRegistry(kv);
  registry.validateSiteHealth = vi.fn(async (id: string) => ({
    healthy: true,
    siteId: id,
    issues: [],
  }));
  registry.validateAllSites = vi.fn(async () => ({}));
  registry.getSiteMetrics = vi.fn(async () => ({
    totalBackups: 0,
    successfulBackups: 0,
    failedBackups: 0,
    averageExecutionTime: 0,
    recentErrors: [],
  }));
  return registry;
}

function mockSlackNotifier(): SlackNotifier {
  const notifier = new SlackNotifier({} as KVNamespace);
  notifier.sendTestNotification = vi.fn(async () => true);
  return notifier;
}

describe('buildScrapeApiOptions', () => {
  it('returns undefined when credentials are missing', () => {
    const env = { BACKUP_KV: {} as KVNamespace } as Env;
    expect(buildScrapeApiOptions(env)).toBeUndefined();
  });

  it('returns options with parsed cache TTL', () => {
    const env = createEnv(createMockKV());
    env.CLOUDFLARE_SCRAPE_CACHE_TTL = '3600';
    const opts = buildScrapeApiOptions(env);
    expect(opts).toMatchObject({
      accountId: 'test-account',
      apiToken: 'test-token',
      cacheTtlSeconds: 3600,
    });
  });

  it('ignores invalid cache TTL', () => {
    const env = createEnv(createMockKV());
    env.CLOUDFLARE_SCRAPE_CACHE_TTL = 'not-a-number';
    const opts = buildScrapeApiOptions(env);
    expect(opts?.cacheTtlSeconds).toBeUndefined();
  });
});

describe('handleGetRequest', () => {
  it('returns operator console for /', async () => {
    const kv = createMockKV();
    const response = await handleGetRequest(new URL('http://localhost/'), mockSiteManager(kv), mockSiteRegistry(kv), createEnv(kv));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('returns operator console for /app', async () => {
    const kv = createMockKV();
    const response = await handleGetRequest(new URL('http://localhost/app'), mockSiteManager(kv), mockSiteRegistry(kv), createEnv(kv));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('returns all sites without secrets by default', async () => {
    const kv = createMockKV({
      'sites:list': JSON.stringify(['site-a']),
      'site_config:site-a': JSON.stringify({ id: 'site-a', name: 'A', baseUrl: 'https://a.com', sitemapUrl: 'https://a.com/sitemap.xml', retentionDays: 7, schedule: '0 2 * * *', fetchOptions: {}, changeThreshold: {} }),
    });
    const response = await handleGetRequest(new URL('http://localhost/api/sites'), mockSiteManager(kv), mockSiteRegistry(kv), createEnv(kv));
    expect(response.status).toBe(200);
    const body = await response.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]!.id).toBe('site-a');
  });

  it('returns single site with secrets when requested', async () => {
    const kv = createMockKV({
      'site_config:site-a': JSON.stringify({ id: 'site-a', name: 'A', baseUrl: 'https://a.com', sitemapUrl: 'https://a.com/sitemap.xml', retentionDays: 7, schedule: '0 2 * * *', fetchOptions: {}, changeThreshold: {}, slackWebhook: 'secret-webhook' }),
    });
    const response = await handleGetRequest(new URL('http://localhost/api/sites?siteId=site-a&includeSecrets=1'), mockSiteManager(kv), mockSiteRegistry(kv), createEnv(kv));
    expect(response.status).toBe(200);
    const body = await response.json() as { slackWebhook: string };
    expect(body.slackWebhook).toBe('secret-webhook');
  });

  it('returns 404 for missing site', async () => {
    const kv = createMockKV();
    const response = await handleGetRequest(new URL('http://localhost/api/sites?siteId=missing'), mockSiteManager(kv), mockSiteRegistry(kv), createEnv(kv));
    expect(response.status).toBe(404);
  });

  it('returns health for single site', async () => {
    const kv = createMockKV();
    const registry = mockSiteRegistry(kv);
    const response = await handleGetRequest(new URL('http://localhost/api/sites/health?siteId=site-a'), mockSiteManager(kv), registry, createEnv(kv));
    expect(response.status).toBe(200);
    const body = await response.json() as { healthy: boolean };
    expect(body.healthy).toBe(true);
    expect(registry.validateSiteHealth).toHaveBeenCalledWith('site-a');
  });

  it('returns metrics when siteId provided', async () => {
    const kv = createMockKV();
    const registry = mockSiteRegistry(kv);
    const response = await handleGetRequest(new URL('http://localhost/api/sites/metrics?siteId=site-a'), mockSiteManager(kv), registry, createEnv(kv));
    expect(response.status).toBe(200);
    expect(registry.getSiteMetrics).toHaveBeenCalledWith('site-a', 7);
  });

  it('returns 400 when siteId missing for metrics', async () => {
    const kv = createMockKV();
    const response = await handleGetRequest(new URL('http://localhost/api/sites/metrics'), mockSiteManager(kv), mockSiteRegistry(kv), createEnv(kv));
    expect(response.status).toBe(400);
  });

  it('returns 404 for unknown route', async () => {
    const kv = createMockKV();
    const response = await handleGetRequest(new URL('http://localhost/api/unknown'), mockSiteManager(kv), mockSiteRegistry(kv), createEnv(kv));
    expect(response.status).toBe(404);
  });
});

describe('handlePostRequest', () => {
  it('creates a site and returns 201', async () => {
    const kv = createMockKV();
    const manager = mockSiteManager(kv);
    const request = new Request('http://localhost/api/sites', {
      method: 'POST',
      body: JSON.stringify({ id: 'new-site', name: 'New', baseUrl: 'https://new.com', sitemapUrl: 'https://new.com/sitemap.xml', retentionDays: 7, schedule: '0 2 * * *', fetchOptions: {}, changeThreshold: {} }),
    });
    const response = await handlePostRequest(request, new URL('http://localhost/api/sites'), manager, mockSlackNotifier(), createEnv(kv));
    expect(response.status).toBe(201);
    const body = await response.json() as { success: boolean; siteId: string };
    expect(body.success).toBe(true);
    expect(body.siteId).toBe('new-site');
  });

  it('returns 400 for invalid config', async () => {
    const kv = createMockKV();
    const manager = mockSiteManager(kv);
    manager.validateSiteConfig = vi.fn(async () => ({ valid: false, errors: ['id is required'] }));
    const request = new Request('http://localhost/api/sites', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const response = await handlePostRequest(request, new URL('http://localhost/api/sites'), manager, mockSlackNotifier(), createEnv(kv));
    expect(response.status).toBe(400);
  });

  it('returns 404 for unknown route', async () => {
    const kv = createMockKV();
    const request = new Request('http://localhost/api/unknown', { method: 'POST' });
    const response = await handlePostRequest(request, new URL('http://localhost/api/unknown'), mockSiteManager(kv), mockSlackNotifier(), createEnv(kv));
    expect(response.status).toBe(404);
  });
});

describe('handlePutRequest', () => {
  it('updates site and returns 200', async () => {
    const kv = createMockKV({
      'site_config:site-a': JSON.stringify({ id: 'site-a', name: 'A', baseUrl: 'https://a.com', sitemapUrl: 'https://a.com/sitemap.xml', retentionDays: 7, schedule: '0 2 * * *', fetchOptions: {}, changeThreshold: {} }),
    });
    const manager = mockSiteManager(kv);
    const request = new Request('http://localhost/api/sites?siteId=site-a', {
      method: 'PUT',
      body: JSON.stringify({ id: 'site-a', name: 'Updated', baseUrl: 'https://a.com', sitemapUrl: 'https://a.com/sitemap.xml', retentionDays: 7, schedule: '0 2 * * *', fetchOptions: {}, changeThreshold: {} }),
    });
    const response = await handlePutRequest(request, new URL('http://localhost/api/sites?siteId=site-a'), manager);
    expect(response.status).toBe(200);
  });

  it('returns 400 when siteId missing', async () => {
    const kv = createMockKV();
    const request = new Request('http://localhost/api/sites', { method: 'PUT', body: '{}' });
    const response = await handlePutRequest(request, new URL('http://localhost/api/sites'), mockSiteManager(kv));
    expect(response.status).toBe(400);
  });

  it('returns 404 when site does not exist', async () => {
    const kv = createMockKV();
    const request = new Request('http://localhost/api/sites?siteId=missing', { method: 'PUT', body: '{}' });
    const response = await handlePutRequest(request, new URL('http://localhost/api/sites?siteId=missing'), mockSiteManager(kv));
    expect(response.status).toBe(404);
  });
});

describe('handleDeleteRequest', () => {
  it('deletes site data and returns 200', async () => {
    const kv = createMockKV({
      'latest:site-a:abc': JSON.stringify({ url: 'https://a.com', timestamp: '2026-01-01T00:00:00Z', status: 200, size: 100 }),
      'backup:site-a:2026-01-01:abc': 'content',
    });
    const response = await handleDeleteRequest(new URL('http://localhost/api/sites?siteId=site-a'), kv);
    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; deletedKeys: number };
    expect(body.success).toBe(true);
    expect(body.deletedKeys).toBeGreaterThanOrEqual(2);
  });

  it('returns 400 when siteId missing', async () => {
    const kv = createMockKV();
    const response = await handleDeleteRequest(new URL('http://localhost/api/sites'), kv);
    expect(response.status).toBe(400);
  });
});

describe('handleListBackedUpUrls (parallel KV reads)', () => {
  it('lists URLs with parallel metadata fetching', async () => {
    const kv = createMockKV({
      'latest:site-a:hash1': JSON.stringify({ url: 'https://a.com/1', timestamp: '2026-01-01T10:00:00Z', status: 200, size: 100 }),
      'latest:site-a:hash2': JSON.stringify({ url: 'https://a.com/2', timestamp: '2026-01-02T10:00:00Z', status: 200, size: 200 }),
      'latest:site-a:hash3': JSON.stringify({ url: 'https://a.com/3', timestamp: '2026-01-03T10:00:00Z', status: 404, size: 50 }),
    });
    // We need to call handleGetRequest with the /api/sites/site-a/urls path
    const response = await handleGetRequest(
      new URL('http://localhost/api/sites/site-a/urls'),
      mockSiteManager(kv),
      mockSiteRegistry(kv),
      createEnv(kv)
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { urls: Array<{ url: string }>; total: number };
    expect(body.urls).toHaveLength(3);
    expect(body.total).toBe(3);
    // Verify parallel fetching by checking get call count
    expect(kv.get).toHaveBeenCalledWith('latest:site-a:hash1', 'text');
    expect(kv.get).toHaveBeenCalledWith('latest:site-a:hash2', 'text');
    expect(kv.get).toHaveBeenCalledWith('latest:site-a:hash3', 'text');
  });

  it('filters URLs by search parameter', async () => {
    const kv = createMockKV({
      'latest:site-a:hash1': JSON.stringify({ url: 'https://a.com/blog/1', timestamp: '2026-01-01T10:00:00Z', status: 200, size: 100 }),
      'latest:site-a:hash2': JSON.stringify({ url: 'https://a.com/about', timestamp: '2026-01-02T10:00:00Z', status: 200, size: 200 }),
    });
    const response = await handleGetRequest(
      new URL('http://localhost/api/sites/site-a/urls?search=blog'),
      mockSiteManager(kv),
      mockSiteRegistry(kv),
      createEnv(kv)
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { urls: Array<{ url: string }> };
    expect(body.urls).toHaveLength(1);
    expect(body.urls[0].url).toBe('https://a.com/blog/1');
  });
});

describe('handleBackupHistory (parallel KV reads)', () => {
  it('returns history with parallel metadata fetching', async () => {
    const kv = createMockKV({
      'meta:site-a:2026-01-01:hash1': JSON.stringify({ timestamp: '2026-01-01T10:00:00Z', status: 200, size: 100, hash: 'abc', contentType: 'text/html' }),
      'meta:site-a:2026-01-02:hash1': JSON.stringify({ timestamp: '2026-01-02T10:00:00Z', status: 200, size: 110, hash: 'def', contentType: 'text/html' }),
      'meta:site-a:2026-01-01:hash2': JSON.stringify({ timestamp: '2026-01-01T10:00:00Z', status: 200, size: 200, hash: 'ghi', contentType: 'text/html' }),
    });
    const response = await handleGetRequest(
      new URL('http://localhost/api/sites/site-a/backup/hash1/history'),
      mockSiteManager(kv),
      mockSiteRegistry(kv),
      createEnv(kv)
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Array<{ date: string }>;
    expect(body).toHaveLength(2);
    expect(body.map((h) => h.date)).toContain('2026-01-01');
    expect(body.map((h) => h.date)).toContain('2026-01-02');
  });
});
