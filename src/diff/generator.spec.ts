import { describe, expect, it, vi, afterEach } from 'vitest';
import { DiffGenerator } from './generator';
import { ContentComparer } from './comparer';

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
    list: vi.fn(({ prefix }: { prefix?: string }) =>
      Promise.resolve({
        keys: Array.from(store.keys())
          .filter((k) => !prefix || k.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
        cursor: undefined
      })
    )
  } as unknown as KVNamespace;
}

function mockDiffValue(): {
  classification: { content: unknown[]; style: unknown[]; structure: unknown[] };
  summary: { contentChanges: number; styleChanges: number; structureChanges: number; totalChanges: number };
  metadata: { generationTime: number; isPartial: boolean };
} {
  return {
    classification: { content: [], style: [], structure: [] },
    summary: { contentChanges: 0, styleChanges: 0, structureChanges: 0, totalChanges: 0 },
    metadata: { generationTime: 0, isPartial: false }
  };
}

describe('DiffGenerator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads URL history from metadata keys that match active storage', async () => {
    const url = 'https://example.com/page';
    const urlHash = (await ContentComparer.calculateHash(url)).substring(0, 16);
    const today = new Date().toISOString().split('T')[0];
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = yesterdayDate.toISOString().split('T')[0];
    const kv = createMockKV({
      [`meta:test-site:${today}:${urlHash}`]: JSON.stringify({ hash: 'hash-b' }),
      [`meta:test-site:${yesterday}:${urlHash}`]: JSON.stringify({ hash: 'hash-a' })
    });

    const generator = new DiffGenerator(kv);
    const history = await generator.getUrlHistory('test-site', url, 2);

    expect(history).toEqual([
      { date: today, hash: 'hash-b', hasChanges: false },
      { date: yesterday, hash: 'hash-a', hasChanges: true }
    ]);
  });

  it('compares dates using backup content and metadata hashes', async () => {
    const url = 'https://example.com/page';
    const urlHash = (await ContentComparer.calculateHash(url)).substring(0, 16);
    const kv = createMockKV({
      [`backup:test-site:2026-03-04:${urlHash}`]: '<html>before</html>',
      [`backup:test-site:2026-03-05:${urlHash}`]: '<html>after</html>',
      [`meta:test-site:2026-03-04:${urlHash}`]: JSON.stringify({ hash: 'hash-a' }),
      [`meta:test-site:2026-03-05:${urlHash}`]: JSON.stringify({ hash: 'hash-b' })
    });

    const expectedDiff = {
      classification: { content: [], style: [], structure: [] },
      summary: { contentChanges: 0, styleChanges: 0, structureChanges: 0, totalChanges: 0 },
      metadata: { generationTime: 0, isPartial: false }
    };
    const classifySpy = vi
      .spyOn(ContentComparer, 'classifyChanges')
      .mockResolvedValue(expectedDiff as never);

    const generator = new DiffGenerator(kv);
    const diff = await generator.compareDates('test-site', '2026-03-04', '2026-03-05', url);

    expect(diff).toBe(expectedDiff);
    expect(classifySpy).toHaveBeenCalledWith(
      url,
      '<html>before</html>',
      '<html>after</html>',
      'hash-a',
      'hash-b',
      '2026-03-05'
    );
  });

  it('uses the truncated URL hash for cache keys', async () => {
    const url = 'https://example.com/page';
    const urlHash = (await ContentComparer.calculateHash(url)).substring(0, 16);
    const kv = createMockKV();
    const diffValue = {
      classification: { content: [], style: [], structure: [] },
      summary: { contentChanges: 0, styleChanges: 0, structureChanges: 0, totalChanges: 0 },
      metadata: { generationTime: 0, isPartial: false }
    };

    vi.spyOn(ContentComparer, 'classifyChanges').mockResolvedValue(diffValue as never);

    const generator = new DiffGenerator(kv);
    await generator.generateDiff(
      'test-site',
      '2026-03-05',
      url,
      '<html>before</html>',
      '<html>after</html>',
      'hash-a',
      'hash-b'
    );

    expect(kv.put).toHaveBeenCalledWith(
      `diff:test-site:2026-03-05:${urlHash}`,
      expect.any(String),
      { expirationTtl: 3600 }
    );
  });

  it('generates batch diffs in chunks of 5', async () => {
    const kv = createMockKV();
    vi.spyOn(ContentComparer, 'classifyChanges').mockResolvedValue(mockDiffValue() as never);

    const generator = new DiffGenerator(kv);
    const comparisons = Array.from({ length: 7 }, (_, i) => ({
      url: `https://example.com/page-${i}`,
      previousContent: '<html>before</html>',
      currentContent: '<html>after</html>',
      previousHash: 'hash-a',
      currentHash: 'hash-b'
    }));

    const result = await generator.generateBatchDiffs('test-site', '2026-03-05', comparisons);
    expect(result.size).toBe(7);
    expect(ContentComparer.classifyChanges).toHaveBeenCalledTimes(7);
  });

  it('clears all diff cache entries', async () => {
    const kv = createMockKV({
      'diff:test-site:2026-03-05:abc': JSON.stringify({ diff: {} }),
      'diff:other-site:2026-03-05:def': JSON.stringify({ diff: {} })
    });
    const generator = new DiffGenerator(kv);
    await generator.clearCache();
    expect(kv.delete).toHaveBeenCalledTimes(2);
  });

  it('clears diff cache entries for a specific site', async () => {
    const kv = createMockKV({
      'diff:test-site:2026-03-05:abc': JSON.stringify({ diff: {} }),
      'diff:other-site:2026-03-05:def': JSON.stringify({ diff: {} })
    });
    const generator = new DiffGenerator(kv);
    await generator.clearCache('test-site');
    expect(kv.delete).toHaveBeenCalledTimes(1);
    expect(kv.delete).toHaveBeenCalledWith('diff:test-site:2026-03-05:abc');
  });

  it('returns cache stats', async () => {
    const kv = createMockKV({
      'diff:test-site:2026-03-05:abc': JSON.stringify({ diff: {}, expiresAt: Date.now() + 3600000 }),
      'diff:test-site:2026-03-06:def': JSON.stringify({ diff: {}, expiresAt: Date.now() + 3600000 })
    });
    const generator = new DiffGenerator(kv);
    const stats = await generator.getCacheStats();
    expect(stats.totalEntries).toBe(2);
    expect(stats.totalSize).toBeGreaterThan(0);
  });

  it('returns zero stats when cache is empty', async () => {
    const kv = createMockKV();
    const generator = new DiffGenerator(kv);
    const stats = await generator.getCacheStats();
    expect(stats).toEqual({ totalEntries: 0, totalSize: 0 });
  });

  it('uses progressive load for large content', async () => {
    const kv = createMockKV();
    vi.spyOn(ContentComparer, 'classifyChanges').mockResolvedValue(mockDiffValue() as never);

    const generator = new DiffGenerator(kv);
    const largeContent = 'a'.repeat(150000);
    const diff = await generator.generateDiff(
      'test-site',
      '2026-03-05',
      'https://example.com/page',
      largeContent,
      largeContent,
      'hash-a',
      'hash-b',
      { progressiveLoad: true, cacheEnabled: false }
    );

    expect(diff.metadata.isPartial).toBe(true);
  });

  it('limits changes when maxChanges is set', async () => {
    const kv = createMockKV();
    const diffValue = {
      classification: {
        content: [
          { priority: 10, description: 'change-1' },
          { priority: 5, description: 'change-2' },
          { priority: 3, description: 'change-3' }
        ],
        style: [{ priority: 2, description: 'style-1' }],
        structure: [{ priority: 1, description: 'struct-1' }]
      },
      summary: { contentChanges: 3, styleChanges: 1, structureChanges: 1, totalChanges: 5 },
      metadata: { generationTime: 0, isPartial: false }
    };
    vi.spyOn(ContentComparer, 'classifyChanges').mockResolvedValue(diffValue as never);

    const generator = new DiffGenerator(kv);
    const diff = await generator.generateDiff(
      'test-site',
      '2026-03-05',
      'https://example.com/page',
      '<html>before</html>',
      '<html>after</html>',
      'hash-a',
      'hash-b',
      { maxChanges: 3, cacheEnabled: false }
    );

    expect(diff.summary.totalChanges).toBeLessThanOrEqual(3);
    expect(diff.metadata.isPartial).toBe(true);
  });
});
