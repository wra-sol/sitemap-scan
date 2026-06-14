import { describe, it, expect, vi } from 'vitest';
import { SiteManager } from './manager';
import { SiteConfig } from '../types/site';

function createMockKV(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    put: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    list: vi.fn((opts?: { prefix?: string; limit?: number; cursor?: string }) => {
      const prefix = opts?.prefix ?? '';
      const limit = opts?.limit ?? 1000;
      const offset = Number.parseInt(opts?.cursor ?? '0', 10);
      const matchingKeys = Array.from(store.keys())
        .filter((name) => name.startsWith(prefix))
        .sort();
      const keys = matchingKeys
        .slice(offset, offset + limit)
        .map((name) => ({ name, expiration: undefined, metadata: undefined }));
      const nextOffset = offset + keys.length;

      return Promise.resolve({
        keys,
        list_complete: nextOffset >= matchingKeys.length,
        cursor: nextOffset < matchingKeys.length ? String(nextOffset) : undefined
      });
    })
  } as unknown as KVNamespace;
}

function minimalSiteConfig(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    id: 'test-site',
    name: 'Test Site',
    baseUrl: 'https://example.com',
    sitemapUrl: 'https://example.com/sitemap.xml',
    retentionDays: 7,
    schedule: '0 2 * * *',
    fetchOptions: { timeout: 10000, retries: 3, concurrency: 5 },
    changeThreshold: { minChangeSize: 0, ignorePatterns: [] },
    ...overrides
  };
}

describe('SiteManager', () => {
  describe('getSiteConfig', () => {
    it('returns parsed site config when key exists', async () => {
      const kv = createMockKV({
        'site_config:test-site': JSON.stringify(minimalSiteConfig())
      });
      const manager = new SiteManager(kv);
      const config = await manager.getSiteConfig('test-site');
      expect(config).toMatchObject({ id: 'test-site', name: 'Test Site' });
    });

    it('returns null when key does not exist', async () => {
      const kv = createMockKV();
      const manager = new SiteManager(kv);
      const config = await manager.getSiteConfig('missing-site');
      expect(config).toBeNull();
    });

    it('returns null on JSON parse error', async () => {
      const kv = createMockKV({
        'site_config:test-site': 'not-json'
      });
      const manager = new SiteManager(kv);
      const config = await manager.getSiteConfig('test-site');
      expect(config).toBeNull();
    });
  });

  describe('getAllSiteConfigs', () => {
    it('returns empty array when sites list is empty', async () => {
      const kv = createMockKV();
      const manager = new SiteManager(kv);
      const configs = await manager.getAllSiteConfigs();
      expect(configs).toEqual([]);
    });

    it('returns all valid site configs', async () => {
      const kv = createMockKV({
        'sites:list': JSON.stringify(['site-a', 'site-b']),
        'site_config:site-a': JSON.stringify(minimalSiteConfig({ id: 'site-a', name: 'Site A' })),
        'site_config:site-b': JSON.stringify(minimalSiteConfig({ id: 'site-b', name: 'Site B' }))
      });
      const manager = new SiteManager(kv);
      const configs = await manager.getAllSiteConfigs();
      expect(configs).toHaveLength(2);
      expect(configs.map((c) => c.id)).toContain('site-a');
      expect(configs.map((c) => c.id)).toContain('site-b');
    });

    it('filters out missing configs', async () => {
      const kv = createMockKV({
        'sites:list': JSON.stringify(['site-a', 'site-b']),
        'site_config:site-a': JSON.stringify(minimalSiteConfig({ id: 'site-a', name: 'Site A' }))
      });
      const manager = new SiteManager(kv);
      const configs = await manager.getAllSiteConfigs();
      expect(configs).toHaveLength(1);
      expect(configs[0].id).toBe('site-a');
    });
  });

  describe('saveSiteConfig', () => {
    it('stores site config and updates sites list', async () => {
      const kv = createMockKV();
      const manager = new SiteManager(kv);
      const config = minimalSiteConfig();
      const result = await manager.saveSiteConfig(config);
      expect(result).toBe(true);
      expect(await kv.get('site_config:test-site')).toBe(JSON.stringify(config));
      expect(await kv.get('sites:list')).toBe(JSON.stringify(['test-site']));
    });

    it('does not duplicate site ID in sites list', async () => {
      const kv = createMockKV({
        'sites:list': JSON.stringify(['test-site'])
      });
      const manager = new SiteManager(kv);
      const config = minimalSiteConfig();
      await manager.saveSiteConfig(config);
      expect(await kv.get('sites:list')).toBe(JSON.stringify(['test-site']));
    });

    it('returns false on KV error', async () => {
      const kv = createMockKV();
      kv.put = vi.fn(() => Promise.reject(new Error('KV down')));
      const manager = new SiteManager(kv);
      const result = await manager.saveSiteConfig(minimalSiteConfig());
      expect(result).toBe(false);
    });
  });

  describe('deleteSiteConfig', () => {
    it('deletes site config and removes from sites list', async () => {
      const kv = createMockKV({
        'sites:list': JSON.stringify(['site-a', 'site-b']),
        'site_config:site-a': JSON.stringify(minimalSiteConfig({ id: 'site-a' }))
      });
      const manager = new SiteManager(kv);
      const result = await manager.deleteSiteConfig('site-a');
      expect(result).toBe(true);
      expect(await kv.get('site_config:site-a')).toBeNull();
      expect(await kv.get('sites:list')).toBe(JSON.stringify(['site-b']));
    });

    it('returns true even if site not in list', async () => {
      const kv = createMockKV({
        'sites:list': JSON.stringify(['site-b'])
      });
      const manager = new SiteManager(kv);
      const result = await manager.deleteSiteConfig('site-a');
      expect(result).toBe(true);
    });
  });

  describe('validateSiteConfig', () => {
    it('returns valid for a correct config', async () => {
      const kv = createMockKV();
      const manager = new SiteManager(kv);
      const result = await manager.validateSiteConfig(minimalSiteConfig());
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('returns errors for an invalid config', async () => {
      const kv = createMockKV();
      const manager = new SiteManager(kv);
      const result = await manager.validateSiteConfig(minimalSiteConfig({ id: '' }));
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('getSitesBySchedule', () => {
    it('returns only sites matching the schedule', async () => {
      const kv = createMockKV({
        'sites:list': JSON.stringify(['site-a', 'site-b', 'site-c']),
        'site_config:site-a': JSON.stringify(minimalSiteConfig({ id: 'site-a', schedule: '0 2 * * *' })),
        'site_config:site-b': JSON.stringify(minimalSiteConfig({ id: 'site-b', schedule: '0 4 * * *' })),
        'site_config:site-c': JSON.stringify(minimalSiteConfig({ id: 'site-c', schedule: '0 2 * * *' }))
      });
      const manager = new SiteManager(kv);
      const sites = await manager.getSitesBySchedule('0 2 * * *');
      expect(sites).toHaveLength(2);
      expect(sites.map((s) => s.id)).toContain('site-a');
      expect(sites.map((s) => s.id)).toContain('site-c');
    });
  });

  describe('updateSiteLastRun', () => {
    it('updates stats when they exist', async () => {
      const today = new Date().toISOString().split('T')[0];
      const kv = createMockKV({
        'site_config:test-site': JSON.stringify(minimalSiteConfig()),
        [`stats:test-site:${today}`]: JSON.stringify({ lastRun: '2026-01-01T00:00:00Z' })
      });
      const manager = new SiteManager(kv);
      const result = await manager.updateSiteLastRun('test-site', '2026-06-14T02:00:00Z');
      expect(result).toBe(true);
      const stats = await kv.get(`stats:test-site:${today}`);
      expect(JSON.parse(stats!).lastRun).toBe('2026-06-14T02:00:00Z');
    });

    it('returns false when site config does not exist', async () => {
      const kv = createMockKV();
      const manager = new SiteManager(kv);
      const result = await manager.updateSiteLastRun('missing-site', '2026-06-14T02:00:00Z');
      expect(result).toBe(false);
    });
  });
});
