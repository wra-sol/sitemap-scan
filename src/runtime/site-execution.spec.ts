import { describe, it, expect, vi } from 'vitest';
import { executeSiteBackupRun } from './site-execution';
import { SiteConfig } from '../types/site';
import { RunStore } from './run-store';
import { BackupFetcher } from '../backup/fetcher';
import { SlackNotifier } from '../slack/notifier';

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

function createMockRunStore(partial: Partial<RunStore> = {}): RunStore {
  return {
    startRun: vi.fn().mockResolvedValue({
      runId: 'run-123',
      siteId: 'test-site',
      siteName: 'Test Site',
      trigger: 'scheduled',
      status: 'running',
      startedAt: '2026-06-14T02:00:00Z',
      totalUrls: 0,
      processedUrls: 0,
      successfulBackups: 0,
      failedBackups: 0,
      storedBackups: 0,
      failedStores: 0,
      changedUrls: [],
      changedUrlCount: 0,
      hasMore: false,
      errors: [],
      summary: 'Scheduled run started.'
    }),
    saveRun: vi.fn().mockResolvedValue(undefined),
    ...partial
  } as unknown as RunStore;
}

function createMockFetcher(partial: Partial<BackupFetcher> = {}): BackupFetcher {
  return {
    performSiteBackup: vi.fn().mockResolvedValue({
      totalUrls: 2,
      successfulBackups: 2,
      failedBackups: 0,
      storedBackups: 2,
      failedStores: 0,
      changedUrls: [],
      executionTime: 500,
      errors: [],
      results: [],
      hasMore: false,
      progress: { completed: 2, total: 2, percentComplete: 100 }
    }),
    ...partial
  } as unknown as BackupFetcher;
}

function createMockNotifier(partial: Partial<SlackNotifier> = {}): SlackNotifier {
  return {
    sendChangeNotificationWithDetails: vi.fn().mockResolvedValue({ attempted: false, delivered: false, channel: 'change' }),
    sendErrorNotificationWithDetails: vi.fn().mockResolvedValue({ attempted: false, delivered: false, channel: 'error' }),
    ...partial
  } as unknown as SlackNotifier;
}

function mockEnv() {
  return {
    BACKUP_KV: {
      get: vi.fn(() => Promise.resolve(null)),
      put: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.resolve()),
      list: vi.fn(() => Promise.resolve({ keys: [], list_complete: true, cursor: undefined }))
    } as unknown as KVNamespace
  };
}

describe('executeSiteBackupRun', () => {
  it('returns success result when backup succeeds with no changes', async () => {
    const env = mockEnv();
    const runStore = createMockRunStore();
    const fetcher = createMockFetcher();
    const notifier = createMockNotifier();

    const result = await executeSiteBackupRun(env, minimalSiteConfig(), { trigger: 'scheduled' }, {
      runStore,
      fetcher,
      slackNotifier: notifier
    });

    expect(result.siteBackupResult.successfulBackups).toBe(2);
    expect(result.runRecord.status).toBe('success');
    expect(result.notification.attempted).toBe(false);
    expect(runStore.saveRun).toHaveBeenCalledTimes(1);
  });

  it('sends change notification when URLs changed', async () => {
    const env = mockEnv();
    const runStore = createMockRunStore();
    const fetcher = createMockFetcher({
      performSiteBackup: vi.fn().mockResolvedValue({
        totalUrls: 2,
        successfulBackups: 2,
        failedBackups: 0,
        storedBackups: 2,
        failedStores: 0,
        changedUrls: ['https://example.com/page1'],
        executionTime: 500,
        errors: [],
        results: [],
        hasMore: false,
        progress: { completed: 2, total: 2, percentComplete: 100 }
      })
    });
    const sendChangeNotificationWithDetails = vi.fn().mockResolvedValue({
      attempted: true,
      delivered: true,
      channel: 'change',
      deliveredAt: '2026-06-14T02:00:00Z'
    });
    const notifier = createMockNotifier({ sendChangeNotificationWithDetails });

    const result = await executeSiteBackupRun(env, minimalSiteConfig(), { trigger: 'scheduled' }, {
      runStore,
      fetcher,
      slackNotifier: notifier
    });

    expect(result.siteBackupResult.changedUrls).toContain('https://example.com/page1');
    expect(sendChangeNotificationWithDetails).toHaveBeenCalledTimes(1);
    expect(result.notification.attempted).toBe(true);
    expect(result.notification.delivered).toBe(true);
  });

  it('returns partial status when some backups fail', async () => {
    const env = mockEnv();
    const runStore = createMockRunStore();
    const fetcher = createMockFetcher({
      performSiteBackup: vi.fn().mockResolvedValue({
        totalUrls: 2,
        successfulBackups: 1,
        failedBackups: 1,
        storedBackups: 1,
        failedStores: 0,
        changedUrls: [],
        executionTime: 500,
        errors: ['Fetch failed'],
        results: [],
        hasMore: false,
        progress: { completed: 2, total: 2, percentComplete: 100 }
      })
    });
    const notifier = createMockNotifier();

    const result = await executeSiteBackupRun(env, minimalSiteConfig(), { trigger: 'scheduled' }, {
      runStore,
      fetcher,
      slackNotifier: notifier
    });

    expect(result.runRecord.status).toBe('partial');
    expect(result.runRecord.failedBackups).toBe(1);
  });

  it('returns noop status when no URLs processed and no changes', async () => {
    const env = mockEnv();
    const runStore = createMockRunStore();
    const fetcher = createMockFetcher({
      performSiteBackup: vi.fn().mockResolvedValue({
        totalUrls: 0,
        successfulBackups: 0,
        failedBackups: 0,
        storedBackups: 0,
        failedStores: 0,
        changedUrls: [],
        executionTime: 0,
        errors: [],
        results: [],
        hasMore: false,
        progress: { completed: 0, total: 0, percentComplete: 0 }
      })
    });
    const notifier = createMockNotifier();

    const result = await executeSiteBackupRun(env, minimalSiteConfig(), { trigger: 'scheduled' }, {
      runStore,
      fetcher,
      slackNotifier: notifier
    });

    expect(result.runRecord.status).toBe('noop');
    expect(result.runRecord.summary).toBe('No backup work was required for this run.');
  });

  it('throws and records failed run when backup fetcher throws', async () => {
    const env = mockEnv();
    const runStore = createMockRunStore();
    const fetcher = createMockFetcher({
      performSiteBackup: vi.fn().mockRejectedValue(new Error('Sitemap fetch failed'))
    });
    const sendErrorNotificationWithDetails = vi.fn().mockResolvedValue({
      attempted: true,
      delivered: true,
      channel: 'error',
      deliveredAt: '2026-06-14T02:00:00Z'
    });
    const notifier = createMockNotifier({ sendErrorNotificationWithDetails });

    await expect(
      executeSiteBackupRun(env, minimalSiteConfig(), { trigger: 'scheduled' }, {
        runStore,
        fetcher,
        slackNotifier: notifier
      })
    ).rejects.toThrow('Sitemap fetch failed');

    expect(sendErrorNotificationWithDetails).toHaveBeenCalledTimes(1);
    expect(runStore.saveRun).toHaveBeenCalledTimes(1);
    const savedRun = (runStore.saveRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(savedRun.status).toBe('failed');
    expect(savedRun.errors).toContain('Sitemap fetch failed');
  });
});
