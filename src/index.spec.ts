import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { Env } from './index';

function createMockKV(initial: Record<string, string> = {}) {
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
      const limit = options?.limit ?? 1000;
      const offset = Number.parseInt(options?.cursor ?? '0', 10);
      const keys = Array.from(store.keys())
        .filter((name) => name.startsWith(prefix))
        .sort()
        .slice(offset, offset + limit)
        .map((name) => ({ name, expiration: undefined, metadata: undefined }));
      const nextOffset = offset + keys.length;
      const matchingCount = Array.from(store.keys()).filter((name) => name.startsWith(prefix)).length;

      return Promise.resolve({
        keys,
        list_complete: nextOffset >= matchingCount,
        cursor: nextOffset < matchingCount ? String(nextOffset) : undefined
      });
    })
  } as unknown as KVNamespace;

  return { kv, store };
}

function createEnv(kv: KVNamespace): Env {
  return {
    BACKUP_KV: kv,
    ADMIN_API_TOKEN: 'secret-token',
    DEFAULT_SLACK_WEBHOOK: 'https://hooks.slack.com/services/test/webhook',
    PUBLIC_BASE_URL: 'https://example.workers.dev'
  };
}

function authRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('Authorization', 'Bearer secret-token');

  return new Request(`https://example.workers.dev${path}`, {
    ...init,
    headers
  });
}

describe('worker integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('serves the operator console publicly while protecting API routes', async () => {
    const { kv } = createMockKV();
    const env = createEnv(kv);

    const publicResponse = await worker.fetch(new Request('https://example.workers.dev/app'), env, {} as ExecutionContext);
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.text()).toContain('Operator Console');

    const protectedResponse = await worker.fetch(new Request('https://example.workers.dev/api/sites'), env, {} as ExecutionContext);
    expect(protectedResponse.status).toBe(401);
  });

  it('creates sites, exposes secrets only on explicit request, records runs, and decodes stored backups', async () => {
    const { kv, store } = createMockKV();
    const env = createEnv(kv);

    vi.stubGlobal('fetch', vi.fn((input: string | Request | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const method = input instanceof Request ? input.method : init?.method || 'GET';

      if (url.startsWith('https://hooks.slack.com/')) {
        return Promise.resolve(new Response('ok', { status: 200 }));
      }

      if (method === 'HEAD' && url === 'https://example.com') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }

      if (url === 'https://example.com/page-1') {
        return Promise.resolve(new Response('<html><body><h1>Page One</h1></body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' }
        }));
      }

      if (url === 'https://example.com/page-2') {
        return Promise.resolve(new Response('<html><body><h1>Page Two</h1></body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' }
        }));
      }

      return Promise.resolve(new Response('not found', { status: 404 }));
    }));

    const createPayload = {
      id: 'marketing-site',
      name: 'Marketing Site',
      baseUrl: 'https://example.com',
      urls: ['https://example.com/page-1', 'https://example.com/page-2'],
      retentionDays: 7,
      schedule: '0 2 * * *',
      slackWebhook: 'https://hooks.slack.com/services/test/webhook',
      fetchOptions: { timeout: 10000, retries: 2, concurrency: 2 },
      changeThreshold: { minChangeSize: 10, ignorePatterns: [] }
    };

    const createResponse = await worker.fetch(authRequest('/api/sites', {
      method: 'POST',
      body: JSON.stringify(createPayload)
    }), env, {} as ExecutionContext);
    expect(createResponse.status).toBe(201);

    const publicSiteResponse = await worker.fetch(authRequest('/api/sites?siteId=marketing-site'), env, {} as ExecutionContext);
    expect(await publicSiteResponse.json()).toMatchObject({
      id: 'marketing-site',
      hasSlackWebhook: true
    });

    const secretSiteResponse = await worker.fetch(
      authRequest('/api/sites?siteId=marketing-site&includeSecrets=1'),
      env,
      {} as ExecutionContext
    );
    expect(await secretSiteResponse.json()).toMatchObject({
      slackWebhook: 'https://hooks.slack.com/services/test/webhook'
    });

    const triggerResponse = await worker.fetch(authRequest('/api/backup/trigger', {
      method: 'POST',
      body: JSON.stringify({ siteId: 'marketing-site', continueFromLast: false })
    }), env, {} as ExecutionContext);
    expect(triggerResponse.status).toBe(200);
    const triggerBody = await triggerResponse.json() as {
      successfulBackups: number;
      run: { status: string };
    };
    expect(triggerBody.successfulBackups).toBe(2);
    expect(triggerBody.run.status).toBe('success');

    const runsResponse = await worker.fetch(authRequest('/api/runs?limit=5'), env, {} as ExecutionContext);
    const runs = await runsResponse.json() as Array<{
      siteId: string;
      trigger: string;
      status: string;
    }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      siteId: 'marketing-site',
      trigger: 'manual',
      status: 'success'
    });

    const overviewResponse = await worker.fetch(authRequest('/api/sites/overview'), env, {} as ExecutionContext);
    const overview = await overviewResponse.json() as Array<{
      latestRun: { status: string };
    }>;
    expect(overview[0].latestRun.status).toBe('success');

    const latestMetaKey = Array.from(store.keys()).find((key) => key.startsWith('latest:marketing-site:'));
    expect(latestMetaKey).toBeTruthy();
    const urlHash = latestMetaKey!.split(':').pop()!;
    const backupDate = new Date().toISOString().split('T')[0];

    const sourceResponse = await worker.fetch(
      authRequest(`/api/sites/marketing-site/backup/${backupDate}/${urlHash}/source`),
      env,
      {} as ExecutionContext
    );
    expect(sourceResponse.status).toBe(200);
    expect(await sourceResponse.text()).toContain('<h1>');

    const previewResponse = await worker.fetch(
      authRequest(`/api/sites/marketing-site/preview/${backupDate}/${urlHash}`),
      env,
      {} as ExecutionContext
    );
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.text()).toContain('Page');
  });

  it('deletes site runtime data comprehensively', async () => {
    const today = new Date().toISOString().split('T')[0];
    const { kv, store } = createMockKV({
      'sites:list': JSON.stringify(['cleanup-site']),
      'site_config:cleanup-site': JSON.stringify({ id: 'cleanup-site', name: 'Cleanup Site' }),
      [`backup:cleanup-site:${today}:abc123`]: 'raw-content',
      [`meta:cleanup-site:${today}:abc123`]: JSON.stringify({ url: 'https://example.com', timestamp: `${today}T00:00:00.000Z` }),
      'latest:cleanup-site:abc123': JSON.stringify({ url: 'https://example.com' }),
      'prev_latest:cleanup-site:abc123': JSON.stringify({ url: 'https://example.com' }),
      'batch_progress:cleanup-site': JSON.stringify({ nextOffset: 2 }),
      'run:latest:cleanup-site': JSON.stringify({ status: 'success' }),
      'run_site:cleanup-site:2026-03-05T10:00:00.000Z:run-1': JSON.stringify({ status: 'success' }),
      'run_log:2026-03-05T10:00:00.000Z:cleanup-site:run-1': JSON.stringify({ status: 'success' }),
      'diff:cleanup-site:2026-03-05:abc123': JSON.stringify({ diff: true })
    });
    const env = createEnv(kv);

    const deleteResponse = await worker.fetch(
      authRequest('/api/sites?siteId=cleanup-site', { method: 'DELETE' }),
      env,
      {} as ExecutionContext
    );

    expect(deleteResponse.status).toBe(200);
    expect(store.get('site_config:cleanup-site')).toBeUndefined();
    expect(store.get(`backup:cleanup-site:${today}:abc123`)).toBeUndefined();
    expect(store.get(`meta:cleanup-site:${today}:abc123`)).toBeUndefined();
    expect(store.get('latest:cleanup-site:abc123')).toBeUndefined();
    expect(store.get('run:latest:cleanup-site')).toBeUndefined();
    expect(store.get('run_site:cleanup-site:2026-03-05T10:00:00.000Z:run-1')).toBeUndefined();
    expect(store.get('run_log:2026-03-05T10:00:00.000Z:cleanup-site:run-1')).toBeUndefined();
    expect(JSON.parse(store.get('sites:list') || '[]')).toEqual([]);
  });
});
