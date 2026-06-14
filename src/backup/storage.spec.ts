import { describe, it, expect, vi } from 'vitest';
import { StorageManager } from './storage';
import { BackupMetadata } from '../types/site';

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

function sampleMetadata(overrides: Partial<BackupMetadata> = {}): BackupMetadata {
  return {
    url: 'https://example.com/page',
    timestamp: '2026-06-14T02:00:00Z',
    hash: 'abc123',
    status: 200,
    contentType: 'text/html',
    size: 1024,
    fetchTime: 100,
    ...overrides
  };
}

describe('StorageManager', () => {
  describe('storeBackup', () => {
    it('stores backup content, metadata, and latest entry', async () => {
      const kv = createMockKV();
      const manager = new StorageManager(kv);
      const metadata = sampleMetadata();
      const result = await manager.storeBackup('test-site', '2026-06-14', 'hash123', '<html></html>', metadata);
      expect(result).toBe(true);
      expect(await kv.get('backup:test-site:2026-06-14:hash123')).not.toBeNull();
      expect(await kv.get('meta:test-site:2026-06-14:hash123')).not.toBeNull();
      expect(await kv.get('latest:test-site:hash123')).not.toBeNull();
    });

    it('returns false on KV error', async () => {
      const kv = createMockKV();
      kv.put = vi.fn(() => Promise.reject(new Error('KV down')));
      const manager = new StorageManager(kv);
      const result = await manager.storeBackup('test-site', '2026-06-14', 'hash123', '<html></html>', sampleMetadata());
      expect(result).toBe(false);
    });
  });

  describe('getBackup', () => {
    it('returns null when backup does not exist', async () => {
      const kv = createMockKV();
      const manager = new StorageManager(kv);
      const result = await manager.getBackup('test-site', '2026-06-14', 'hash123');
      expect(result).toBeNull();
    });

    it('returns backup content and metadata when it exists', async () => {
      const kv = createMockKV();
      const manager = new StorageManager(kv);
      await manager.storeBackup('test-site', '2026-06-14', 'hash123', '<html></html>', sampleMetadata());
      const result = await manager.getBackup('test-site', '2026-06-14', 'hash123');
      expect(result).not.toBeNull();
      expect(result!.content).toBe('<html></html>');
      expect(result!.metadata.url).toBe('https://example.com/page');
    });
  });

  describe('getLatestBackup', () => {
    it('returns null when no latest backup exists', async () => {
      const kv = createMockKV();
      const manager = new StorageManager(kv);
      const result = await manager.getLatestBackup('test-site', 'hash123');
      expect(result).toBeNull();
    });

    it('returns latest backup with date extracted from timestamp', async () => {
      const kv = createMockKV();
      const manager = new StorageManager(kv);
      await manager.storeBackup('test-site', '2026-06-14', 'hash123', '<html></html>', sampleMetadata());
      const result = await manager.getLatestBackup('test-site', 'hash123');
      expect(result).not.toBeNull();
      expect(result!.date).toBe('2026-06-14');
      expect(result!.content).toBe('<html></html>');
    });
  });

  describe('getBackupHistory', () => {
    it('returns empty array when no history exists', async () => {
      const kv = createMockKV();
      const manager = new StorageManager(kv);
      const result = await manager.getBackupHistory('test-site', 'hash123');
      expect(result).toEqual([]);
    });

    it('returns sorted backup history limited by default', async () => {
      const kv = createMockKV();
      const manager = new StorageManager(kv);
      const baseDate = new Date('2026-01-01');
      for (let i = 0; i < 35; i++) {
        const date = new Date(baseDate);
        date.setDate(date.getDate() + i);
        const dateStr = date.toISOString().split('T')[0];
        await manager.storeBackup('test-site', dateStr, 'hash123', `<html>${i}</html>`, sampleMetadata({ timestamp: `${dateStr}T02:00:00Z` }));
      }
      const result = await manager.getBackupHistory('test-site', 'hash123');
      expect(result).toHaveLength(30); // default limit
      expect(result[0].date).toBe('2026-02-04');
      expect(result[29].date).toBe('2026-01-06');
    });

    it('respects custom limit', async () => {
      const kv = createMockKV();
      const manager = new StorageManager(kv);
      for (let i = 1; i <= 10; i++) {
        const date = `2026-05-${String(i).padStart(2, '0')}`;
        await manager.storeBackup('test-site', date, 'hash123', `<html>${i}</html>`, sampleMetadata({ timestamp: `${date}T02:00:00Z` }));
      }
      const result = await manager.getBackupHistory('test-site', 'hash123', 5);
      expect(result).toHaveLength(5);
    });
  });

  describe('deleteBackupsBefore', () => {
    it('deletes backups before cutoff date', async () => {
      const kv = createMockKV();
      const manager = new StorageManager(kv);
      await manager.storeBackup('test-site', '2026-05-01', 'hash123', '<html></html>', sampleMetadata());
      await manager.storeBackup('test-site', '2026-06-14', 'hash123', '<html></html>', sampleMetadata());
      const deleted = await manager.deleteBackupsBefore('test-site', '2026-06-01');
      expect(deleted).toBe(2); // backup + meta keys
      expect(await kv.get('backup:test-site:2026-05-01:hash123')).toBeNull();
      expect(await kv.get('backup:test-site:2026-06-14:hash123')).not.toBeNull();
    });

    it('returns 0 when no backups exist', async () => {
      const kv = createMockKV();
      const manager = new StorageManager(kv);
      const deleted = await manager.deleteBackupsBefore('test-site', '2026-06-01');
      expect(deleted).toBe(0);
    });
  });

  describe('getStorageStats', () => {
    it('returns stats for existing backups', async () => {
      const kv = createMockKV();
      const manager = new StorageManager(kv);
      await manager.storeBackup('test-site', '2026-05-01', 'hash123', '<html></html>', sampleMetadata());
      await manager.storeBackup('test-site', '2026-06-14', 'hash123', '<html></html>', sampleMetadata());
      const stats = await manager.getStorageStats('test-site');
      expect(stats.totalBackups).toBe(2);
      expect(stats.oldestBackup).toBe('2026-05-01');
      expect(stats.newestBackup).toBe('2026-06-14');
      expect(stats.totalSizeEstimate).toBeGreaterThan(0);
    });

    it('returns zeros when no backups exist', async () => {
      const kv = createMockKV();
      const manager = new StorageManager(kv);
      const stats = await manager.getStorageStats('test-site');
      expect(stats.totalBackups).toBe(0);
      expect(stats.totalSizeEstimate).toBe(0);
      expect(stats.oldestBackup).toBeNull();
      expect(stats.newestBackup).toBeNull();
    });
  });

  describe('listAllUrls', () => {
    it('returns URLs from latest entries', async () => {
      const kv = createMockKV();
      const manager = new StorageManager(kv);
      await manager.storeBackup('test-site', '2026-06-14', 'hash1', '<html></html>', sampleMetadata({ url: 'https://example.com/page1' }));
      await manager.storeBackup('test-site', '2026-06-14', 'hash2', '<html></html>', sampleMetadata({ url: 'https://example.com/page2' }));
      const urls = await manager.listAllUrls('test-site');
      expect(urls).toEqual(['https://example.com/page1', 'https://example.com/page2']);
    });

    it('returns empty array when no URLs exist', async () => {
      const kv = createMockKV();
      const manager = new StorageManager(kv);
      const urls = await manager.listAllUrls('test-site');
      expect(urls).toEqual([]);
    });
  });

  describe('getUrlHash', () => {
    it('returns consistent hash for the same URL', async () => {
      const kv = createMockKV();
      const manager = new StorageManager(kv);
      const hash1 = await manager.getUrlHash('https://example.com/page');
      const hash2 = await manager.getUrlHash('https://example.com/page');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(16);
    });

    it('returns different hashes for different URLs', async () => {
      const kv = createMockKV();
      const manager = new StorageManager(kv);
      const hash1 = await manager.getUrlHash('https://example.com/page1');
      const hash2 = await manager.getUrlHash('https://example.com/page2');
      expect(hash1).not.toBe(hash2);
    });
  });
});
