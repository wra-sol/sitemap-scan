import { afterEach, describe, it, expect, vi } from 'vitest';
import { BackupFetcher } from './fetcher';
import type { SiteConfig } from '../types/site';

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
      const keys = Array.from(store.keys())
        .filter((name) => name.startsWith(prefix))
        .slice(0, limit)
        .map((name) => ({ name, expiration: undefined, metadata: undefined }));

      return Promise.resolve({
        keys,
        list_complete: true,
        cursor: undefined
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
    fetchOptions: { timeout: 10000, retries: 2, concurrency: 3 },
    changeThreshold: { minChangeSize: 0, ignorePatterns: [] },
    ...overrides
  };
}

describe('BackupFetcher', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('sitemap cycle detection', () => {
    it('terminates when sitemap index has cycle (A → B → A) and returns finite list', async () => {
      const sitemapA = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-b.xml</loc></sitemap>
</sitemapindex>`;
      const sitemapB = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap.xml</loc></sitemap>
</sitemapindex>`;

      const fetchCalls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | Request | URL) => {
          const url = typeof input === 'string' ? input : (input as Request).url ?? input.toString();
          fetchCalls.push(url);
          const body = url.includes('sitemap-b') ? sitemapB : sitemapA;
          return Promise.resolve(
            new Response(body, {
              status: 200,
              headers: new Headers({ 'Content-Type': 'application/xml' })
            })
          );
        })
      );

      const kv = createMockKV();
      const fetcher = new BackupFetcher(kv);
      const config = minimalSiteConfig({ sitemapUrl: 'https://example.com/sitemap.xml' });

      const result = await fetcher.performSiteBackup(config, { continueFromLast: false, batchSize: 25 });

      expect(result.totalUrls).toBe(0);
      expect(fetchCalls.length).toBeLessThanOrEqual(5);
    }, 15000);

    it('returns URLs from flat urlset without cycle', async () => {
      const urlset = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://example.com/page2</loc></url>
</urlset>`;

      vi.stubGlobal(
        'fetch',
        vi.fn(() =>
          Promise.resolve(
            new Response(urlset, { status: 200, headers: new Headers({ 'Content-Type': 'application/xml' }) })
          )
        )
      );

      const kv = createMockKV();
      const fetcher = new BackupFetcher(kv);
      const config = minimalSiteConfig({ sitemapUrl: 'https://example.com/sitemap.xml' });

      const result = await fetcher.performSiteBackup(config, { continueFromLast: false, batchSize: 25 });

      expect(result.totalUrls).toBe(2);
    }, 15000);
  });

  describe('URL cache', () => {
    it('uses cached URL list when continueFromLast and batch progress exist, so fetch (sitemap) is not called', async () => {
      const today = new Date().toISOString().split('T')[0];
      const cachedUrls = Array.from({ length: 100 }, (_, i) => `https://example.com/page${i}`);
      const metaKey = `urls_cache:test-site:${today}`;
      const chunk0Key = `urls_cache:test-site:${today}:chunk:0`;
      const chunk0 = cachedUrls.slice(0, 2000);
      const store: Record<string, string> = {
        [`batch_progress:test-site`]: JSON.stringify({
          nextOffset: 25,
          totalUrls: 100,
          lastRunTime: new Date().toISOString()
        }),
        [metaKey]: JSON.stringify({ chunkCount: 1, totalUrls: 100 }),
        [chunk0Key]: JSON.stringify(chunk0)
      };

      const kv = createMockKV(store);
      const fetchCalls: string[] = [];
      const fetchSpy = vi.fn((input: string | Request | URL) => {
        const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
        fetchCalls.push(url);
        return Promise.resolve(
          new Response('<html><body>ok</body></html>', {
            status: 200,
            headers: new Headers({ 'Content-Type': 'text/html' })
          })
        );
      });
      vi.stubGlobal('fetch', fetchSpy);

      const fetcher = new BackupFetcher(kv);
      const config = minimalSiteConfig({ sitemapUrl: 'https://example.com/sitemap.xml' });

      const result = await fetcher.performSiteBackup(config, { continueFromLast: true, batchSize: 25 });

      expect(result.totalUrls).toBe(100);
      const sitemapFetches = fetchCalls.filter((u) => u.includes('sitemap') || u.endsWith('.xml'));
      expect(sitemapFetches.length).toBe(0);
    }, 15000);
  });

  describe('sitemap change detection', () => {
    it('does not re-scan when only <lastmod> changes but <loc> list is stable', async () => {
      const sitemap1 = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc><lastmod>2026-02-22T00:00:00Z</lastmod></url>
  <url><loc>https://example.com/page2</loc><lastmod>2026-02-22T00:00:00Z</lastmod></url>
</urlset>`;
      const sitemap2 = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc><lastmod>2026-02-22T00:05:00Z</lastmod></url>
  <url><loc>https://example.com/page2</loc><lastmod>2026-02-22T00:05:00Z</lastmod></url>
</urlset>`;

      const fetchCalls: string[] = [];
      let sitemapFetchCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | Request | URL) => {
          const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
          fetchCalls.push(url);

          if (url.endsWith('/sitemap.xml')) {
            sitemapFetchCount++;
            const body = sitemapFetchCount === 1 ? sitemap1 : sitemap2;
            return Promise.resolve(
              new Response(body, {
                status: 200,
                headers: new Headers({ 'Content-Type': 'application/xml' })
              })
            );
          }

          return Promise.resolve(
            new Response('<html><body>ok</body></html>', {
              status: 200,
              headers: new Headers({ 'Content-Type': 'text/html' })
            })
          );
        })
      );

      const kv = createMockKV();
      const fetcher = new BackupFetcher(kv);
      const config = minimalSiteConfig({ sitemapUrl: 'https://example.com/sitemap.xml' });

      const first = await fetcher.performSiteBackup(config, { continueFromLast: true, batchSize: 25 });
      expect(first.totalUrls).toBe(2);
      expect(await kv.get('full_scan:test-site')).not.toBeNull();

      const second = await fetcher.performSiteBackup(config, { continueFromLast: true, batchSize: 25 });
      expect(second.totalUrls).toBe(0);
      expect(second.processedInBatch).toBe(0);

      // First run: 1 sitemap + 2 pages. Second run: 1 sitemap check only.
      expect(fetchCalls.length).toBe(4);

    }, 15000);
  });

  describe('sitemap listener mode (large sites)', () => {
    it('switches to listener mode when sitemap has >100 URLs and does not backfill', async () => {
      const urls = Array.from({ length: 101 }, (_, i) => `https://example.com/page${i + 1}`);
      const sitemap = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}
</urlset>`;

      const fetchSpy = vi.fn((input: string | Request | URL) => {
        const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
        if (url.endsWith('/sitemap.xml')) {
          return Promise.resolve(
            new Response(sitemap, { status: 200, headers: new Headers({ 'Content-Type': 'application/xml' }) })
          );
        }
        return Promise.resolve(
          new Response('<html><body>ok</body></html>', { status: 200, headers: new Headers({ 'Content-Type': 'text/html' }) })
        );
      });
      vi.stubGlobal('fetch', fetchSpy);

      const kv = createMockKV();
      const fetcher = new BackupFetcher(kv);
      const config = minimalSiteConfig({ sitemapUrl: 'https://example.com/sitemap.xml' });

      const result = await fetcher.performSiteBackup(config, { continueFromLast: true, batchSize: 25 });

      expect(result.totalUrls).toBe(0);
      expect(result.processedInBatch).toBe(0);
      expect(await kv.get('sitemap_listener:test-site')).toBe('1');
      expect(await kv.get('sitemap_snapshot:test-site')).not.toBeNull();
      // Only sitemap fetch; no page fetches (no backfill)
      expect(fetchSpy).toHaveBeenCalledTimes(1);

    }, 15000);

    it('rechecks a rolling batch of existing URLs even when the sitemap is unchanged', async () => {
      const urls1 = Array.from({ length: 101 }, (_, i) => `https://example.com/page${i + 1}`);
      const sitemap1 = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls1.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}
</urlset>`;

      const fetchSpy = vi.fn((input: string | Request | URL) => {
        const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
        if (url.endsWith('/sitemap.xml')) {
          return Promise.resolve(
            new Response(sitemap1, { status: 200, headers: new Headers({ 'Content-Type': 'application/xml' }) })
          );
        }
        return Promise.resolve(
          new Response('<html><body>ok</body></html>', { status: 200, headers: new Headers({ 'Content-Type': 'text/html' }) })
        );
      });
      vi.stubGlobal('fetch', fetchSpy);

      const kv = createMockKV();
      const fetcher = new BackupFetcher(kv);
      const config = minimalSiteConfig({ sitemapUrl: 'https://example.com/sitemap.xml' });

      // Run 1: enables listener mode and snapshots without backfill.
      const first = await fetcher.performSiteBackup(config, { continueFromLast: true, batchSize: 25 });
      expect(first.totalUrls).toBe(0);
      expect(await kv.get('sitemap_listener:test-site')).toBe('1');

      // Run 2: the watcher should still recheck a rolling batch of existing URLs.
      const second = await fetcher.performSiteBackup(config, { continueFromLast: true, batchSize: 25 });
      expect(second.processedInBatch).toBe(25);
      expect(second.totalUrls).toBe(101);
      expect(second.progress.completed).toBe(25);

      const pageFetches = fetchSpy.mock.calls
        .map((args) => args[0])
        .map((input) => (typeof input === 'string' ? input : (input as Request).url ?? String(input)))
        .filter((u) => !u.endsWith('/sitemap.xml'));

      expect(pageFetches.length).toBe(25);
      expect(pageFetches).toContain('https://example.com/page1');

      const progress = await fetcher.getBatchProgress('test-site');
      expect(progress).toMatchObject({
        mode: 'listener',
        pendingNewUrls: 0,
        monitoringPoolSize: 101,
        totalUrls: 101,
        completed: 25
      });
 
    }, 15000);

    it('discovers new URLs from child sitemaps during a stale listener refresh even if the root index is unchanged', async () => {
      const urls1 = Array.from({ length: 101 }, (_, i) => `https://example.com/page${i + 1}`);
      const urls2 = [...urls1, 'https://example.com/new-page'];
      const rootIndex = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/child-sitemap.xml</loc></sitemap>
</sitemapindex>`;
      const childSitemap1 = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls1.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}
</urlset>`;
      const childSitemap2 = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls2.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}
</urlset>`;

      let useUpdatedChildSitemap = false;
      const fetchSpy = vi.fn((input: string | Request | URL) => {
        const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
        if (url.endsWith('/sitemap.xml')) {
          return Promise.resolve(
            new Response(rootIndex, { status: 200, headers: new Headers({ 'Content-Type': 'application/xml' }) })
          );
        }
        if (url.endsWith('/child-sitemap.xml')) {
          return Promise.resolve(
            new Response(useUpdatedChildSitemap ? childSitemap2 : childSitemap1, {
              status: 200,
              headers: new Headers({ 'Content-Type': 'application/xml' })
            })
          );
        }
        return Promise.resolve(
          new Response('<html><body>ok</body></html>', { status: 200, headers: new Headers({ 'Content-Type': 'text/html' }) })
        );
      });
      vi.stubGlobal('fetch', fetchSpy);

      const kv = createMockKV();
      const fetcher = new BackupFetcher(kv);
      const config = minimalSiteConfig({ sitemapUrl: 'https://example.com/sitemap.xml' });

      const first = await fetcher.performSiteBackup(config, { continueFromLast: true, batchSize: 25 });
      expect(first.totalUrls).toBe(0);
      expect(await kv.get('sitemap_listener:test-site')).toBe('1');

      const snapshotRaw = await kv.get('sitemap_snapshot:test-site');
      expect(snapshotRaw).not.toBeNull();
      const snapshotMeta = JSON.parse(snapshotRaw as string);
      snapshotMeta.updatedAt = '2000-01-01T00:00:00.000Z';
      await kv.put('sitemap_snapshot:test-site', JSON.stringify(snapshotMeta));

      useUpdatedChildSitemap = true;

      const second = await fetcher.performSiteBackup(config, { continueFromLast: true, batchSize: 25 });
      expect(second.processedInBatch).toBe(1);
      expect(second.successfulBackups).toBe(1);
      expect(second.totalUrls).toBe(1);

      const pageFetches = fetchSpy.mock.calls
        .map((args) => args[0])
        .map((input) => (typeof input === 'string' ? input : (input as Request).url ?? String(input)))
        .filter((u) => !u.endsWith('/sitemap.xml') && !u.endsWith('/child-sitemap.xml'));
      expect(pageFetches).toContain('https://example.com/new-page');

    }, 15000);
  });

  describe('resetSiteProgress', () => {
    it('clears batch progress, URL cache keys, and full_scan for site', async () => {
      const kv = createMockKV({
        'batch_progress:test-site': '{}',
        'urls_cache:test-site:2025-01-01': '{}',
        'full_scan:test-site': '{}'
      });
      const fetcher = new BackupFetcher(kv);
      await fetcher.resetSiteProgress('test-site');
      expect(kv.delete).toHaveBeenCalledWith('batch_progress:test-site');
      expect(kv.delete).toHaveBeenCalledWith('full_scan:test-site');
      expect(kv.delete).toHaveBeenCalledWith('sitemap_listener_cursor:test-site');
      expect(kv.list).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'urls_cache:test-site:' }));
    });
  });
});
