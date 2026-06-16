import { describe, it, expect, vi } from 'vitest';
import { SiteRegistry } from './registry';

function createMockKV(
  store: Record<string, string> = {}
): KVNamespace {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: '' })),
  } as unknown as KVNamespace;
}

describe('SiteRegistry', () => {
  describe('discoverSites', () => {
    it('returns empty array when sites:list is missing', async () => {
      const kv = createMockKV();
      const registry = new SiteRegistry(kv);
      const sites = await registry.discoverSites();
      expect(sites).toEqual([]);
    });

    it('returns parsed site configs', async () => {
      const kv = createMockKV({
        'sites:list': JSON.stringify(['site-a', 'site-b']),
        'site_config:site-a': JSON.stringify({ id: 'site-a', name: 'A', baseUrl: 'https://a.com' }),
        'site_config:site-b': JSON.stringify({ id: 'site-b', name: 'B', baseUrl: 'https://b.com' }),
      });
      const registry = new SiteRegistry(kv);
      const sites = await registry.discoverSites();
      expect(sites).toHaveLength(2);
      expect(sites[0]!.id).toBe('site-a');
    });

    it('skips sites with invalid JSON config', async () => {
      const kv = createMockKV({
        'sites:list': JSON.stringify(['site-a', 'site-b']),
        'site_config:site-a': JSON.stringify({ id: 'site-a', name: 'A', baseUrl: 'https://a.com' }),
        'site_config:site-b': 'not-json',
      });
      const registry = new SiteRegistry(kv);
      const sites = await registry.discoverSites();
      expect(sites).toHaveLength(1);
    });
  });

  describe('validateSiteHealth', () => {
    it('returns not found when config is missing', async () => {
      const kv = createMockKV();
      const registry = new SiteRegistry(kv);
      const result = await registry.validateSiteHealth('missing-site');
      expect(result.healthy).toBe(false);
      expect(result.issues).toContain('Site configuration not found');
    });

    it('returns invalid JSON issue when config is malformed', async () => {
      const kv = createMockKV({
        'site_config:bad-site': 'not-json',
      });
      const registry = new SiteRegistry(kv);
      const result = await registry.validateSiteHealth('bad-site');
      expect(result.healthy).toBe(false);
      expect(result.issues[0]).toMatch(/Invalid site configuration JSON/);
    });

    it('returns healthy when base URL and sitemap are OK', async () => {
      const kv = createMockKV({
        'site_config:good-site': JSON.stringify({
          id: 'good-site',
          name: 'Good',
          baseUrl: 'https://example.com',
          sitemapUrl: 'https://example.com/sitemap.xml',
        }),
      });
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))));
      const registry = new SiteRegistry(kv);
      const result = await registry.validateSiteHealth('good-site');
      vi.unstubAllGlobals();
      expect(result.healthy).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('flags base URL failure', async () => {
      const kv = createMockKV({
        'site_config:bad-site': JSON.stringify({
          id: 'bad-site',
          name: 'Bad',
          baseUrl: 'https://example.com',
        }),
      });
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))));
      const registry = new SiteRegistry(kv);
      const result = await registry.validateSiteHealth('bad-site');
      vi.unstubAllGlobals();
      expect(result.healthy).toBe(false);
      expect(result.issues[0]).toMatch(/Base URL health check failed/);
    });
  });

  describe('validateAllSites', () => {
    it('validates all listed sites', async () => {
      const kv = createMockKV({
        'sites:list': JSON.stringify(['site-a']),
        'site_config:site-a': JSON.stringify({
          id: 'site-a',
          name: 'A',
          baseUrl: 'https://a.com',
        }),
      });
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))));
      const registry = new SiteRegistry(kv);
      const results = await registry.validateAllSites();
      vi.unstubAllGlobals();
      expect(results['site-a']!.healthy).toBe(true);
    });
  });

  describe('cleanupOldStats', () => {
    it('returns 0 when no sites exist', async () => {
      const kv = createMockKV();
      const registry = new SiteRegistry(kv);
      const deleted = await registry.cleanupOldStats(30);
      expect(deleted).toBe(0);
    });
  });
});
