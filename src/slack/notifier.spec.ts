import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentComparer } from '../diff/comparer';
import { SlackNotifier } from './notifier';

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

describe('SlackNotifier', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('formats richer before/after detail in URL diff summaries', async () => {
    const url = 'https://example.com/page';
    const urlHash = '3641c5f2274c5471';
    const kv = createMockKV({
      [`prev_latest:test-site:${urlHash}`]: JSON.stringify({
        timestamp: '2026-03-04T12:00:00.000Z',
        hash: 'prev-hash'
      }),
      [`backup:test-site:2026-03-04:${urlHash}`]: '<html>before</html>'
    });

    const classifySpy = vi.spyOn(ContentComparer, 'classifyChanges').mockResolvedValue({
      url,
      date: '2026-03-05',
      previousHash: 'prev-hash',
      currentHash: 'curr-hash',
      classification: {
        content: [
          {
            type: 'content',
            priority: 5,
            element: 'title',
            position: { line: 1, column: 1 },
            change: 'modified',
            before: 'Old Title',
            after: 'New Title',
            context: 'Page title'
          }
        ],
        style: [
          {
            type: 'style',
            priority: 2,
            element: 'body',
            attribute: 'class',
            change: 'modified',
            before: 'theme-light',
            after: 'theme-dark'
          }
        ],
        structure: [
          {
            type: 'structure',
            priority: 1,
            element: 'section',
            change: 'added'
          }
        ]
      },
      summary: {
        totalChanges: 3,
        contentChanges: 1,
        styleChanges: 1,
        structureChanges: 1,
        highestPriority: 5
      },
      metadata: {
        generatedAt: '2026-03-05T12:00:00.000Z',
        generationTime: 10,
        isPartial: false
      }
    });

    const notifier = new SlackNotifier(kv, undefined, 'https://example.workers.dev');
    const summaryBuilder = (notifier as unknown as Record<string, Function>).buildUrlDiffSummary.bind(notifier);

    const summary = await summaryBuilder(
      'test-site',
      url,
      '2026-03-05',
      '<html>after</html>',
      'curr-hash'
    ) as string;

    expect(classifySpy).toHaveBeenCalled();
    expect(summary).toContain('*Summary:* 1 content, 1 style, 1 structure');
    expect(summary).toContain('• *title*');
    expect(summary).toContain('Before: `Old Title`');
    expect(summary).toContain('After: `New Title`');
    expect(summary).toContain('_Page title_');
    expect(summary).toContain('• *body.class*');
    expect(summary).toContain('• *section* added');
  });

  it('throttles duplicate change notifications for a short window', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('ok', { status: 200 })));
    vi.stubGlobal('fetch', fetchSpy);

    const kv = createMockKV();
    const notifier = new SlackNotifier(kv, 'https://hooks.slack.com/services/test/webhook', 'https://example.workers.dev');
    const siteConfig = {
      id: 'test-site',
      name: 'Test Site',
      baseUrl: 'https://example.com',
      urls: ['https://example.com/page'],
      retentionDays: 7,
      schedule: '0 2 * * *',
      fetchOptions: { timeout: 1000, retries: 1, concurrency: 1 },
      changeThreshold: { minChangeSize: 0, ignorePatterns: [] }
    };
    const backupResult = {
      siteId: 'test-site',
      siteName: 'Test Site',
      totalUrls: 1,
      successfulBackups: 1,
      failedBackups: 0,
      storedBackups: 1,
      failedStores: 0,
      changedUrls: ['https://example.com/page'],
      executionTime: 5,
      errors: [],
      results: [
        {
          url: 'https://example.com/page',
          success: true,
          content: '<html>after</html>',
          metadata: {
            url: 'https://example.com/page',
            timestamp: '2026-03-05T12:00:00.000Z',
            hash: 'curr-hash',
            normalizedHash: 'curr-hash',
            status: 200,
            contentType: 'text/html',
            size: 18,
            fetchTime: 5
          }
        }
      ]
    };

    const first = await notifier.sendChangeNotificationWithDetails(siteConfig, backupResult);
    const second = await notifier.sendChangeNotificationWithDetails(siteConfig, backupResult);

    expect(first.delivered).toBe(true);
    expect(second.throttled).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
