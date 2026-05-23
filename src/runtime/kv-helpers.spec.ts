import { describe, expect, it, vi } from 'vitest';
import { listKeysWithPrefix } from './kv-helpers';

function createMockKV(initial: Record<string, string> = {}, pageSize = 5) {
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
      // Force small pages so we can test pagination logic regardless of the limit param
      const limit = pageSize;
      const offset = Number.parseInt(options?.cursor ?? '0', 10);
      const allMatching = Array.from(store.keys())
        .filter((name) => name.startsWith(prefix))
        .sort();
      const keys = allMatching.slice(offset, offset + limit).map((name) => ({
        name,
        expiration: undefined,
        metadata: undefined
      }));
      const nextOffset = offset + keys.length;

      return Promise.resolve({
        keys,
        list_complete: nextOffset >= allMatching.length,
        cursor: nextOffset < allMatching.length ? String(nextOffset) : undefined
      });
    })
  } as unknown as KVNamespace;

  return { kv, store };
}

describe('listKeysWithPrefix', () => {
  it('returns an empty array when no keys match', async () => {
    const { kv } = createMockKV({});
    const result = await listKeysWithPrefix(kv, 'backup:');
    expect(result).toEqual([]);
  });

  it('returns all matching keys when they fit in a single page', async () => {
    const { kv } = createMockKV({
      'backup:site-1:2026-05-01:abc': 'content',
      'backup:site-1:2026-05-01:def': 'content',
      'meta:site-1:2026-05-01:abc': 'meta'
    });

    const result = await listKeysWithPrefix(kv, 'backup:');
    expect(result).toHaveLength(2);
    expect(result).toContain('backup:site-1:2026-05-01:abc');
    expect(result).toContain('backup:site-1:2026-05-01:def');
  });

  it('paginates through multiple pages to return all matching keys', async () => {
    const initial: Record<string, string> = {};
    for (let i = 0; i < 25; i++) {
      initial[`backup:site-1:2026-05-01:${String(i).padStart(3, '0')}`] = 'content';
    }

    const { kv } = createMockKV(initial, 5);
    const result = await listKeysWithPrefix(kv, 'backup:');

    expect(result).toHaveLength(25);
    expect(kv.list).toHaveBeenCalledTimes(5);
  });

  it('does not return keys that do not match the prefix', async () => {
    const { kv } = createMockKV({
      'backup:site-1:2026-05-01:abc': 'content',
      'diff:site-1:2026-05-01:abc': 'diff'
    });

    const result = await listKeysWithPrefix(kv, 'backup:');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('backup:site-1:2026-05-01:abc');
  });
});
