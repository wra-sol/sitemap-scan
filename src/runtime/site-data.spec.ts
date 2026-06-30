import { describe, it, expect, vi } from 'vitest';
import { SiteDataService } from './site-data';
import * as kvHelpers from './kv-helpers';

describe('SiteDataService', () => {
  function createMockKV(): KVNamespace {
    const store = new Map<string, string>();
    return {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: '' })),
    } as unknown as KVNamespace;
  }

  it('deletes exact and prefix keys for a site', async () => {
    const kv = createMockKV();
    const listKeysSpy = vi.spyOn(kvHelpers, 'listKeysWithPrefix').mockResolvedValue([]);

    const service = new SiteDataService(kv);
    const deleted = await service.deleteSiteData('test-site');

    // 7 exact keys + 0 prefix keys + 0 global run keys
    expect(deleted).toBe(7);
    expect(kv.delete).toHaveBeenCalledWith('site_config:test-site');
    expect(kv.delete).toHaveBeenCalledWith('batch_progress:test-site');
    expect(kv.delete).toHaveBeenCalledWith('full_scan:test-site');
    expect(kv.delete).toHaveBeenCalledWith('sitemap_listener:test-site');
    expect(kv.delete).toHaveBeenCalledWith('sitemap_pending:test-site');
    expect(kv.delete).toHaveBeenCalledWith('sitemap_listener_cursor:test-site');
    expect(kv.delete).toHaveBeenCalledWith('run:latest:test-site');

    listKeysSpy.mockRestore();
  });

  it('deletes prefix keys returned by listKeysWithPrefix', async () => {
    const kv = createMockKV();
    const listKeysSpy = vi.spyOn(kvHelpers, 'listKeysWithPrefix').mockImplementation(async (_kv, prefix) => {
      if (prefix === 'backup:site-a:') return ['backup:site-a:2024-01-01:url1', 'backup:site-a:2024-01-01:url2'];
      if (prefix === 'meta:site-a:') return ['meta:site-a:2024-01-01:hash1'];
      return [];
    });

    const service = new SiteDataService(kv);
    const deleted = await service.deleteSiteData('site-a');

    expect(deleted).toBe(10); // 7 exact + 2 backup + 1 meta + 0 others
    expect(kv.delete).toHaveBeenCalledWith('backup:site-a:2024-01-01:url1');
    expect(kv.delete).toHaveBeenCalledWith('backup:site-a:2024-01-01:url2');
    expect(kv.delete).toHaveBeenCalledWith('meta:site-a:2024-01-01:hash1');

    listKeysSpy.mockRestore();
  });

  it('deletes global run keys that include the site id', async () => {
    const kv = createMockKV();
    const listKeysSpy = vi.spyOn(kvHelpers, 'listKeysWithPrefix').mockImplementation(async (_kv, prefix) => {
      if (prefix === 'run_log:') return ['run_log:global:site-b:2024-01-01', 'run_log:global:other-site:2024-01-01'];
      return [];
    });

    const service = new SiteDataService(kv);
    const deleted = await service.deleteSiteData('site-b');

    expect(deleted).toBe(8); // 7 exact + 1 matching global run key
    expect(kv.delete).toHaveBeenCalledWith('run_log:global:site-b:2024-01-01');
    expect(kv.delete).not.toHaveBeenCalledWith('run_log:global:other-site:2024-01-01');

    listKeysSpy.mockRestore();
  });

  it('updates sites:list when site exists in list', async () => {
    const kv = createMockKV();
    await kv.put('sites:list', JSON.stringify(['site-x', 'site-y', 'site-z']));
    vi.spyOn(kvHelpers, 'listKeysWithPrefix').mockResolvedValue([]);

    const service = new SiteDataService(kv);
    await service.deleteSiteData('site-y');

    const updatedList = await kv.get('sites:list');
    expect(JSON.parse(updatedList!)).toEqual(['site-x', 'site-z']);
  });

  it('handles malformed sites:list gracefully', async () => {
    const kv = createMockKV();
    await kv.put('sites:list', 'not-json');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(kvHelpers, 'listKeysWithPrefix').mockResolvedValue([]);

    const service = new SiteDataService(kv);
    const deleted = await service.deleteSiteData('site-c');

    expect(deleted).toBe(7);
    expect(consoleSpy).toHaveBeenCalledWith(
      'Failed to update sites:list during site deletion:',
      expect.any(SyntaxError)
    );

    consoleSpy.mockRestore();
  });

  it('deduplicates keys before deletion', async () => {
    const kv = createMockKV();
    // Simulate a key appearing in both exact and prefix lists (shouldn't happen, but test dedup)
    const listKeysSpy = vi.spyOn(kvHelpers, 'listKeysWithPrefix').mockImplementation(async (_kv, prefix) => {
      if (prefix === 'backup:test:') return ['site_config:test']; // overlapping with exact keys
      return [];
    });

    const service = new SiteDataService(kv);
    const deleted = await service.deleteSiteData('test');

    // Even though 'site_config:test' appears twice, Set dedupes it
    expect(deleted).toBe(7);
    expect(kv.delete).toHaveBeenCalledTimes(7);

    listKeysSpy.mockRestore();
  });

  it('handles large key lists by chunking deletions', async () => {
    const kv = createMockKV();
    const manyKeys = Array.from({ length: 120 }, (_, i) => `backup:big-site:2024-01-01:url${i}`);
    vi.spyOn(kvHelpers, 'listKeysWithPrefix').mockImplementation(async (_kv, prefix) => {
      if (prefix === 'backup:big-site:') return manyKeys;
      return [];
    });

    const service = new SiteDataService(kv);
    const deleted = await service.deleteSiteData('big-site');

    expect(deleted).toBe(127); // 7 exact + 120 prefix keys
    expect(kv.delete).toHaveBeenCalledTimes(127);
  });
});
