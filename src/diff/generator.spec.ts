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
    list: vi.fn(() =>
      Promise.resolve({
        keys: [],
        list_complete: true,
        cursor: undefined
      })
    )
  } as unknown as KVNamespace;
}

describe('DiffGenerator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads URL history from metadata keys that match active storage', async () => {
    const url = 'https://example.com/page';
    const urlHash = (await ContentComparer.calculateHash(url)).substring(0, 16);
    const kv = createMockKV({
      [`meta:test-site:2026-03-05:${urlHash}`]: JSON.stringify({ hash: 'hash-b' }),
      [`meta:test-site:2026-03-04:${urlHash}`]: JSON.stringify({ hash: 'hash-a' })
    });

    const generator = new DiffGenerator(kv);
    const history = await generator.getUrlHistory('test-site', url, 2);

    expect(history).toEqual([
      { date: '2026-03-05', hash: 'hash-b', hasChanges: false },
      { date: '2026-03-04', hash: 'hash-a', hasChanges: true }
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
});
