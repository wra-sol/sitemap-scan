import { describe, expect, it, vi } from 'vitest';
import { RunStore, type SiteRunRecord } from './run-store';
import type { SiteConfig } from '../types/site';

function createMockKV(initial: Record<string, string> = {}, pageSize = 1000) {
  const store = new Map<string, string>(Object.entries(initial));

  const kv = {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    put: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    list: vi.fn((options?: { prefix?: string; limit?: number; cursor?: string }) => {
      const prefix = options?.prefix ?? '';
      const limit = Math.min(options?.limit ?? 1000, pageSize);
      const offset = Number.parseInt(options?.cursor ?? '0', 10);
      const allMatching = Array.from(store.keys())
        .filter((name) => name.startsWith(prefix))
        .sort();
      const keys = allMatching.slice(offset, offset + limit).map((name) => ({
        name,
        expiration: undefined,
        metadata: undefined,
      }));
      const nextOffset = offset + keys.length;

      return Promise.resolve({
        keys,
        list_complete: nextOffset >= allMatching.length,
        cursor: nextOffset < allMatching.length ? String(nextOffset) : undefined,
      });
    }),
  } as unknown as KVNamespace;

  return { kv, store };
}

const siteConfig: SiteConfig = {
  id: 'test-site',
  name: 'Test Site',
  baseUrl: 'https://example.com',
  sitemapUrl: 'https://example.com/sitemap.xml',
  retentionDays: 30,
  schedule: '0 1 * * *',
  fetchOptions: { timeout: 30000, retries: 3, concurrency: 5 },
  changeThreshold: {},
};

function makeRecord(
  siteId: string,
  startedAt: string,
  runId: string,
  overrides: Partial<SiteRunRecord> = {},
): SiteRunRecord {
  return {
    runId,
    siteId,
    siteName: 'Test Site',
    trigger: 'scheduled',
    status: 'success',
    startedAt,
    totalUrls: 10,
    processedUrls: 10,
    successfulBackups: 10,
    failedBackups: 0,
    storedBackups: 10,
    failedStores: 0,
    changedUrls: [],
    changedUrlCount: 0,
    hasMore: false,
    errors: [],
    summary: 'Completed successfully',
    ...overrides,
  };
}

describe('RunStore', () => {
  describe('startRun', () => {
    it('creates a running record and persists it to KV', async () => {
      const { kv, store } = createMockKV();
      const rs = new RunStore(kv);

      const record = await rs.startRun(siteConfig, 'scheduled');

      expect(record.status).toBe('running');
      expect(record.siteId).toBe('test-site');
      expect(record.siteName).toBe('Test Site');
      expect(record.trigger).toBe('scheduled');
      expect(record.runId).toBeTruthy();
      expect(record.startedAt).toBeTruthy();
      expect(record.summary).toBe('Scheduled run started.');

      // Should persist to three keys: status, site log, global log
      expect(kv.put).toHaveBeenCalledTimes(3);
      const putKeys = (kv.put as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(putKeys).toContain(`run:latest:test-site`);
      expect(putKeys.some((k) => k.startsWith('run_site:test-site:'))).toBe(true);
      expect(putKeys.some((k) => k.startsWith('run_log:'))).toBe(true);

      // Verify the persisted payload roundtrips correctly
      const persisted = JSON.parse(store.get('run:latest:test-site')!) as SiteRunRecord;
      expect(persisted.runId).toBe(record.runId);
    });

    it('uses manual summary for manual trigger', async () => {
      const { kv } = createMockKV();
      const rs = new RunStore(kv);

      const record = await rs.startRun(siteConfig, 'manual');
      expect(record.summary).toBe('Manual run started.');
    });

    it('generates a valid UUID when crypto.randomUUID is available', async () => {
      const { kv } = createMockKV();
      const rs = new RunStore(kv);

      const record = await rs.startRun(siteConfig, 'scheduled');
      // crypto.randomUUID returns a 36-char string with hyphens
      expect(record.runId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe('saveRun', () => {
    it('persists an updated record to KV', async () => {
      const { kv, store } = createMockKV();
      const rs = new RunStore(kv);

      const record = await rs.startRun(siteConfig, 'scheduled');
      record.status = 'success';
      record.finishedAt = new Date().toISOString();
      record.successfulBackups = 10;

      await rs.saveRun(record);

      // startRun (3 puts) + saveRun (3 puts)
      expect(kv.put).toHaveBeenCalledTimes(6);
      const raw = store.get('run:latest:test-site');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!) as SiteRunRecord;
      expect(parsed.status).toBe('success');
      expect(parsed.successfulBackups).toBe(10);
    });
  });

  describe('getLatestRun', () => {
    it('returns the latest run for a site', async () => {
      const record = makeRecord('test-site', '2026-06-28T01:00:00.000Z', 'run-1');
      const { kv } = createMockKV({
        'run:latest:test-site': JSON.stringify(record),
      });
      const rs = new RunStore(kv);

      const result = await rs.getLatestRun('test-site');
      expect(result).not.toBeNull();
      expect(result!.runId).toBe('run-1');
    });

    it('returns null when no run exists', async () => {
      const { kv } = createMockKV();
      const rs = new RunStore(kv);

      const result = await rs.getLatestRun('test-site');
      expect(result).toBeNull();
    });

    it('returns null and logs error when JSON is corrupted', async () => {
      const { kv } = createMockKV({
        'run:latest:test-site': '{invalid json',
      });
      const rs = new RunStore(kv);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await rs.getLatestRun('test-site');
      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to parse latest run'),
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });
  });

  describe('listRecentRuns', () => {
    it('returns an empty array when no runs exist', async () => {
      const { kv } = createMockKV();
      const rs = new RunStore(kv);

      const result = await rs.listRecentRuns(25);
      expect(result).toEqual([]);
    });

    it('returns runs sorted newest-first', async () => {
      const initial: Record<string, string> = {};
      const dates = [
        '2026-06-25T01:00:00.000Z',
        '2026-06-27T01:00:00.000Z',
        '2026-06-26T01:00:00.000Z',
      ];
      for (const date of dates) {
        const record = makeRecord('test-site', date, `run-${date.slice(0, 10)}`);
        const payload = JSON.stringify(record);
        initial[`run_log:${date}:test-site:run-${date.slice(0, 10)}`] = payload;
      }
      const { kv } = createMockKV(initial);
      const rs = new RunStore(kv);

      const result = await rs.listRecentRuns(25);
      expect(result).toHaveLength(3);
      // Newest first (descending lexicographic order of ISO timestamps)
      expect(result[0]!.startedAt).toBe('2026-06-27T01:00:00.000Z');
      expect(result[1]!.startedAt).toBe('2026-06-26T01:00:00.000Z');
      expect(result[2]!.startedAt).toBe('2026-06-25T01:00:00.000Z');
    });

    it('limits results to the specified count', async () => {
      const initial: Record<string, string> = {};
      for (let i = 1; i <= 10; i++) {
        const date = `2026-06-${String(20 + i).padStart(2, '0')}T01:00:00.000Z`;
        const record = makeRecord('test-site', date, `run-${i}`);
        initial[`run_log:${date}:test-site:run-${i}`] = JSON.stringify(record);
      }
      const { kv } = createMockKV(initial);
      const rs = new RunStore(kv);

      const result = await rs.listRecentRuns(3);
      expect(result).toHaveLength(3);
      // Should be the 3 newest
      expect(result[0]!.startedAt).toContain('2026-06-30');
      expect(result[1]!.startedAt).toContain('2026-06-29');
      expect(result[2]!.startedAt).toContain('2026-06-28');
    });

    it('paginates through multiple KV list pages', async () => {
      const initial: Record<string, string> = {};
      for (let i = 0; i < 25; i++) {
        const date = `2026-06-${String(1 + i).padStart(2, '0')}T01:00:00.000Z`;
        const record = makeRecord('test-site', date, `run-${i}`);
        initial[`run_log:${date}:test-site:run-${i}`] = JSON.stringify(record);
      }
      // pageSize=5 forces pagination
      const { kv } = createMockKV(initial, 5);
      const rs = new RunStore(kv);

      const result = await rs.listRecentRuns(25);
      expect(result).toHaveLength(25);
      // Should have made 5 list calls (25 keys / 5 per page)
      expect(kv.list).toHaveBeenCalledTimes(5);
    });

    it('filters by siteId when provided', async () => {
      const initial: Record<string, string> = {};
      const siteA = makeRecord('site-a', '2026-06-28T01:00:00.000Z', 'run-a');
      const siteB = makeRecord('site-b', '2026-06-28T02:00:00.000Z', 'run-b');
      initial['run_site:site-a:2026-06-28T01:00:00.000Z:run-a'] = JSON.stringify(siteA);
      initial['run_site:site-b:2026-06-28T02:00:00.000Z:run-b'] = JSON.stringify(siteB);
      const { kv } = createMockKV(initial);
      const rs = new RunStore(kv);

      const result = await rs.listRecentRuns(25, 'site-a');
      expect(result).toHaveLength(1);
      expect(result[0]!.siteId).toBe('site-a');

      // Verify the list call used the site-specific prefix
      const listCalls = (kv.list as ReturnType<typeof vi.fn>).mock.calls;
      expect(listCalls[0]![0]?.prefix).toBe('run_site:site-a:');
    });

    it('skips records that fail to parse as JSON', async () => {
      const initial: Record<string, string> = {};
      const goodRecord = makeRecord('test-site', '2026-06-28T01:00:00.000Z', 'run-good');
      initial['run_log:2026-06-28T01:00:00.000Z:test-site:run-good'] = JSON.stringify(goodRecord);
      initial['run_log:2026-06-27T01:00:00.000Z:test-site:run-bad'] = '{corrupted';
      const { kv } = createMockKV(initial);
      const rs = new RunStore(kv);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await rs.listRecentRuns(25);
      expect(result).toHaveLength(1);
      expect(result[0]!.runId).toBe('run-good');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to parse run record'),
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });

    it('skips records where KV get fails', async () => {
      const initial: Record<string, string> = {};
      const goodRecord = makeRecord('test-site', '2026-06-28T01:00:00.000Z', 'run-good');
      initial['run_log:2026-06-28T01:00:00.000Z:test-site:run-good'] = JSON.stringify(goodRecord);
      initial['run_log:2026-06-27T01:00:00.000Z:test-site:run-fail'] = '{}';

      const store = new Map(Object.entries(initial));
      const kv = {
        get: vi.fn((key: string) => {
          if (key.includes('run-fail')) {
            return Promise.reject(new Error('KV unavailable'));
          }
          return Promise.resolve(store.get(key) ?? null);
        }),
        put: vi.fn((key: string, value: string) => {
          store.set(key, value);
          return Promise.resolve();
        }),
        delete: vi.fn((key: string) => {
          store.delete(key);
          return Promise.resolve();
        }),
        list: vi.fn((options?: { prefix?: string; limit?: number; cursor?: string }) => {
          const prefix = options?.prefix ?? '';
          const offset = Number.parseInt(options?.cursor ?? '0', 10);
          const allMatching = Array.from(store.keys())
            .filter((name) => name.startsWith(prefix))
            .sort();
          const keys = allMatching.slice(offset, offset + 1000).map((name) => ({
            name,
            expiration: undefined,
            metadata: undefined,
          }));
          const nextOffset = offset + keys.length;
          return Promise.resolve({
            keys,
            list_complete: nextOffset >= allMatching.length,
            cursor: nextOffset < allMatching.length ? String(nextOffset) : undefined,
          });
        }),
      } as unknown as KVNamespace;

      const rs = new RunStore(kv);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await rs.listRecentRuns(25);
      expect(result).toHaveLength(1);
      expect(result[0]!.runId).toBe('run-good');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch run record'),
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });
  });
});
