import { serveDiffViewer, serveBackupViewer } from './viewers';
import { BackupFetcher } from '../backup/fetcher';
import { serveOperatorConsole } from './operator-console';
import { jsonResponse } from './responses';
import { SiteManager } from '../sites/manager';
import { SlackNotifier } from '../slack/notifier';
import { matchesCronExpression } from '../scheduler/cron';
import { toPublicSiteConfig } from '../sites/public-config';
import { SiteRegistry } from '../sites/registry';
import { SiteConfig } from '../types/site';
import { DiffGenerator } from '../diff/generator';
import { readBackupContent } from '../runtime/content-storage';
import { executeSiteBackupRun } from '../runtime/site-execution';
import { SiteDataService } from '../runtime/site-data';
import { listKeysWithPrefix } from '../runtime/kv-helpers';
import { RunStore } from '../runtime/run-store';
import type { Env } from '../types/env';

export interface RouteDeps {
  siteManager: SiteManager;
  siteRegistry: SiteRegistry;
  slackNotifier: SlackNotifier;
}

export function buildScrapeApiOptions(env: Env) {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_SCRAPE_API_TOKEN) {
    return undefined;
  }
  const cacheTtlSeconds = env.CLOUDFLARE_SCRAPE_CACHE_TTL
    ? Number.parseInt(env.CLOUDFLARE_SCRAPE_CACHE_TTL, 10)
    : undefined;
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_SCRAPE_API_TOKEN,
    cacheTtlSeconds: Number.isFinite(cacheTtlSeconds) ? cacheTtlSeconds : undefined
  };
}

export async function handleGetRequest(
  url: URL,
  siteManager: SiteManager,
  siteRegistry: SiteRegistry,
  env: Env
): Promise<Response> {
  const path = url.pathname;
  const siteId = url.searchParams.get('siteId');

  switch (path) {
    case '/':
    case '/app':
      return serveOperatorConsole();

    case '/api/sites':
      if (siteId) {
        const siteConfig = await siteManager.getSiteConfig(siteId);
        return siteConfig
          ? jsonResponse(url.searchParams.get('includeSecrets') === '1' ? siteConfig : toPublicSiteConfig(siteConfig))
          : jsonResponse({ error: 'Site not found' }, 404);
      } else {
        const allSites = await siteManager.getAllSiteConfigs();
        return jsonResponse(allSites.map(toPublicSiteConfig));
      }

    case '/api/sites/overview':
      return jsonResponse(await buildSitesOverview(siteManager, siteRegistry, env.BACKUP_KV, env));

    case '/api/sites/health':
      if (siteId) {
        const health = await siteRegistry.validateSiteHealth(siteId);
        return jsonResponse(health);
      } else {
        const allHealth = await siteRegistry.validateAllSites();
        return jsonResponse(allHealth);
      }

    case '/api/runs':
      return jsonResponse(await handleRecentRuns(url, env.BACKUP_KV));

    case '/api/sites/metrics': {
      if (!siteId) {
        return jsonResponse({ error: 'siteId parameter required' }, 400);
      }
      const days = parseInt(url.searchParams.get('days') || '7', 10);
      const metrics = await siteRegistry.getSiteMetrics(siteId, days);
      return jsonResponse(metrics);
    }

    case '/api/sites/dates':
      if (!siteId) {
        return jsonResponse({ error: 'siteId parameter required' }, 400);
      }
      return await handleGetSiteDates(siteId, env.BACKUP_KV);

    case '/api/status':
      return jsonResponse(await buildSchedulerStatus(siteManager, env.BACKUP_KV));

    case '/api/test': {
      const testResult = await siteRegistry.validateAllSites();
      return jsonResponse(testResult);
    }

    case '/diff/viewer':
      return await serveDiffViewer();

    case '/backup/viewer':
      return await serveBackupViewer();

    default: {
      if (path.startsWith('/api/sites/') && path.includes('/preview/')) {
        return await handlePreviewRequest(path, env.BACKUP_KV);
      }
      if (path.startsWith('/api/sites/') && path.includes('/diff/') && path.includes('/url/')) {
        return await handleUrlHistoryRequest(path, env.BACKUP_KV);
      }
      if (path.startsWith('/api/sites/') && path.includes('/diff/')) {
        return await handleDiffRequest(path, env.BACKUP_KV);
      }
      const urlsMatch = /^\/api\/sites\/([^/]+)\/urls$/.exec(path);
      if (urlsMatch) {
        return await handleListBackedUpUrls(urlsMatch[1], url, env.BACKUP_KV);
      }
      const historyMatch = /^\/api\/sites\/([^/]+)\/backup\/([^/]+)\/history$/.exec(path);
      if (historyMatch) {
        return await handleBackupHistory(historyMatch[1], historyMatch[2], env.BACKUP_KV);
      }
      const sourceMatch = /^\/api\/sites\/([^/]+)\/backup\/(\d{4}-\d{2}-\d{2})\/([^/]+)\/source$/.exec(path);
      if (sourceMatch) {
        return await handleBackupSource(sourceMatch[1], sourceMatch[2], sourceMatch[3], env.BACKUP_KV);
      }
      return jsonResponse({ error: 'Not found' }, 404);
    }
  }
}

export async function handlePostRequest(
  request: Request,
  url: URL,
  siteManager: SiteManager,
  slackNotifier: SlackNotifier,
  env: Env
): Promise<Response> {
  const path = url.pathname;

  switch (path) {
    case '/api/sites': {
      const body = await request.json() as SiteConfig;
      const validationResult = await siteManager.validateSiteConfig(body);

      if (!validationResult.valid) {
        return jsonResponse({ error: 'Invalid configuration', details: validationResult.errors }, 400);
      }

      const saved = await siteManager.saveSiteConfig(body);
      if (!saved) {
        return jsonResponse({ error: 'Failed to save site configuration' }, 500);
      }

      return jsonResponse({ success: true, siteId: body.id }, 201);
    }

    case '/api/slack/test': {
      const slackBody = await request.json() as { webhook?: string };
      const testSuccess = await slackNotifier.sendTestNotification(slackBody.webhook);
      return jsonResponse({ success: testSuccess });
    }

    case '/api/backup/trigger': {
      const triggerBody = await request.json() as {
        siteId: string;
        batchSize?: number;
        batchOffset?: number;
        continueFromLast?: boolean;
      };
      const siteConfig = await siteManager.getSiteConfig(triggerBody.siteId);

      if (!siteConfig) {
        return jsonResponse({ error: 'Site not found' }, 404);
      }

      const execution = await executeSiteBackupRun(env, siteConfig, {
        trigger: 'manual',
        batchSize: triggerBody.batchSize ?? siteConfig.batchSize,
        batchOffset: triggerBody.batchOffset,
        continueFromLast: triggerBody.continueFromLast ?? true
      });

      const sanitizedResults = execution.siteBackupResult.results.map(r => ({
        url: r.url,
        success: r.success,
        error: r.error,
        metadata: r.metadata
      }));

      const responsePayload = {
        ...execution.siteBackupResult,
        hasMore: execution.runRecord.hasMore,
        progress: execution.runRecord.progress,
        run: execution.runRecord,
        results: sanitizedResults
      };

      return jsonResponse(responsePayload);
    }

    case '/api/backup/progress': {
      const progressBody = await request.json() as { siteId: string };
      const progressFetcher = new BackupFetcher(env.BACKUP_KV, buildScrapeApiOptions(env));
      const progress = await progressFetcher.getBatchProgress(progressBody.siteId);

      return jsonResponse(progress || { hasMore: false, message: 'No batch in progress' });
    }

    case '/api/backup/reset': {
      const resetBody = await request.json() as { siteId: string };
      const resetSiteConfig = await siteManager.getSiteConfig(resetBody.siteId);
      if (!resetSiteConfig) {
        return jsonResponse({ error: 'Site not found' }, 404);
      }
      const resetFetcher = new BackupFetcher(env.BACKUP_KV, buildScrapeApiOptions(env));
      await resetFetcher.resetSiteProgress(resetBody.siteId);
      return jsonResponse({ success: true, message: 'Batch progress and URL cache cleared for site' });
    }

    default:
      return jsonResponse({ error: 'Not found' }, 404);
  }
}

export async function handlePutRequest(
  request: Request,
  url: URL,
  siteManager: SiteManager
): Promise<Response> {
  const siteId = url.searchParams.get('siteId');

  if (!siteId) {
    return jsonResponse({ error: 'siteId parameter required' }, 400);
  }

  const existingSite = await siteManager.getSiteConfig(siteId);
  if (!existingSite) {
    return jsonResponse({ error: 'Site not found' }, 404);
  }

  const body = await request.json() as SiteConfig;
  const validationResult = await siteManager.validateSiteConfig(body);

  if (!validationResult.valid) {
    return jsonResponse({ error: 'Invalid configuration', details: validationResult.errors }, 400);
  }

  const saved = await siteManager.saveSiteConfig(body);
  return saved
    ? jsonResponse({ success: true })
    : jsonResponse({ error: 'Failed to update site configuration' }, 500);
}

export async function handleDeleteRequest(
  url: URL,
  kv: KVNamespace,
  siteManager: SiteManager
): Promise<Response> {
  const siteId = url.searchParams.get('siteId');

  if (!siteId) {
    return jsonResponse({ error: 'siteId parameter required' }, 400);
  }

  const siteDataService = new SiteDataService(kv);
  const deletedKeys = await siteDataService.deleteSiteData(siteId);
  await siteManager.deleteSiteConfig(siteId);
  return jsonResponse({ success: true, deletedKeys });
}

async function buildSitesOverview(
  siteManager: SiteManager,
  siteRegistry: SiteRegistry,
  kv: KVNamespace,
  env: Env
): Promise<Array<Record<string, unknown>>> {
  const sites = await siteManager.getAllSiteConfigs();
  const runStore = new RunStore(kv);
  const fetcher = new BackupFetcher(kv, buildScrapeApiOptions(env));

  return Promise.all(sites.map(async (site) => {
    try {
      const [health, metrics, latestRun, progress] = await Promise.all([
        siteRegistry.validateSiteHealth(site.id),
        siteRegistry.getSiteMetrics(site.id, 7),
        runStore.getLatestRun(site.id),
        fetcher.getBatchProgress(site.id)
      ]);

      return {
        ...toPublicSiteConfig(site),
        health,
        metrics,
        latestRun,
        progress,
        latestSummary: latestRun?.summary || null
      };
    } catch (error) {
      console.error(`Overview failed for site ${site.id}:`, error);
      return {
        ...toPublicSiteConfig(site),
        health: { status: 'unknown', errors: ['Failed to load health data'] },
        metrics: null,
        latestRun: null,
        progress: null,
        latestSummary: null
      };
    }
  }));
}

async function handleRecentRuns(url: URL, kv: KVNamespace): Promise<unknown> {
  const runStore = new RunStore(kv);
  const siteId = url.searchParams.get('siteId') || undefined;
  const limit = Math.min(
    Number.parseInt(url.searchParams.get('limit') || '25', 10) || 25,
    100
  );

  return runStore.listRecentRuns(limit, siteId);
}

async function buildSchedulerStatus(siteManager: SiteManager, kv: KVNamespace): Promise<unknown> {
  const sites = await siteManager.getAllSiteConfigs();
  const now = new Date();
  const runStore = new RunStore(kv);

  const dueSites = sites.filter((site) => matchesCronExpression(site.schedule, now));
  const latestRuns = await Promise.all(sites.map((site) => runStore.getLatestRun(site.id)));

  return {
    totalSites: sites.length,
    dueSites: dueSites.map((site) => site.id),
    schedules: [...new Set(sites.map((site) => site.schedule))].sort(),
    latestRuns: latestRuns.filter((run): run is NonNullable<typeof run> => run !== null)
  };
}

async function handleGetSiteDates(siteId: string, kv: KVNamespace): Promise<Response> {
  try {
    const keys = await listKeysWithPrefix(kv, `backup:${siteId}:`);
    const dates = new Set<string>();

    const regex = new RegExp(`backup:${siteId}:(\\d{4}-\\d{2}-\\d{2})`);
    for (const keyName of keys) {
      const match = keyName.match(regex);
      if (match) {
        dates.add(match[1]);
      }
    }

    return jsonResponse(Array.from(dates).sort().reverse());
  } catch (error) {
    console.error('Failed to get site dates:', error);
    return jsonResponse({ error: 'Failed to retrieve dates' }, 500);
  }
}

async function handleDiffRequest(path: string, kv: KVNamespace): Promise<Response> {
  const match = path.match(/\/api\/sites\/([^/]+)\/diff\/(\d{4}-\d{2}-\d{2})/);
  if (!match) {
    return jsonResponse({ error: 'Invalid diff request' }, 400);
  }

  const [, siteId, date] = match;

  try {
    const siteManager = new SiteManager(kv);
    const siteConfig = await siteManager.getSiteConfig(siteId);
    if (!siteConfig) {
      return jsonResponse({ error: 'Site not found' }, 404);
    }

    const keys = await listKeysWithPrefix(kv, `backup:${siteId}:${date}:`);
    const urls: Array<{
      url: string;
      urlHash: string;
      contentChanges: number;
      styleChanges: number;
      structureChanges: number;
    }> = [];

    // Fetch all metadata in parallel instead of sequential KV reads
    const urlRegex = new RegExp(`backup:${siteId}:${date}:([a-f0-9]+)`);
    const urlHashes: string[] = [];
    for (const keyName of keys) {
      const urlMatch = keyName.match(urlRegex);
      if (urlMatch) {
        urlHashes.push(urlMatch[1]);
      }
    }

    const metaResults = await Promise.all(
      urlHashes.map(async (urlHash) => {
        const metaKey = `meta:${siteId}:${date}:${urlHash}`;
        const metaData = await kv.get(metaKey, 'text');
        return { urlHash, metaData };
      })
    );

    for (const { urlHash, metaData } of metaResults) {
      if (metaData) {
        try {
          const data = JSON.parse(metaData);
          urls.push({
            url: data.url,
            urlHash,
            contentChanges: 0,
            styleChanges: 0,
            structureChanges: 0
          });
        } catch (error) {
          console.error('Failed to parse backup data:', error);
        }
      }
    }

    const diffGenerator = new DiffGenerator(kv);
    const previousDate = await getPreviousDate(siteId, date, kv);

    if (previousDate) {
      // Fetch all previous + current metadata in parallel, then generate diffs in parallel
      await Promise.all(
        urls.map(async (urlData) => {
          try {
            const [prevMetaData, currMetaData] = await Promise.all([
              kv.get(`meta:${siteId}:${previousDate}:${urlData.urlHash}`, 'text'),
              kv.get(`meta:${siteId}:${date}:${urlData.urlHash}`, 'text')
            ]);

            if (!prevMetaData || !currMetaData) return;

            const prevData = JSON.parse(prevMetaData);
            const currData = JSON.parse(currMetaData);

            const [prevBackupContent, currBackupContent] = await Promise.all([
              readBackupContent(kv, siteId, previousDate, urlData.urlHash, prevData),
              readBackupContent(kv, siteId, date, urlData.urlHash, currData)
            ]);

            if (prevBackupContent && currBackupContent) {
              const diff = await diffGenerator.generateDiff(
                siteId,
                date,
                urlData.url,
                prevBackupContent,
                currBackupContent,
                prevData.hash,
                currData.hash,
                { includeContent: true, includeStyle: true, includeStructure: true }
              );

              urlData.contentChanges = diff.summary.contentChanges;
              urlData.styleChanges = diff.summary.styleChanges;
              urlData.structureChanges = diff.summary.structureChanges;
            }
          } catch (error) {
            console.error('Failed to generate diff:', error);
          }
        })
      );
    }

    return jsonResponse({
      siteId,
      date,
      urls: urls.filter(u => u.contentChanges > 0 || u.styleChanges > 0 || u.structureChanges > 0),
      summary: {
        totalUrls: urls.length,
        changedUrls: urls.filter(u => u.contentChanges > 0 || u.styleChanges > 0 || u.structureChanges > 0).length
      }
    });
  } catch (error) {
    console.error('Failed to handle diff request:', error);
    return jsonResponse({ error: 'Failed to generate diff' }, 500);
  }
}

async function handleUrlHistoryRequest(path: string, kv: KVNamespace): Promise<Response> {
  const match = path.match(/\/api\/sites\/([^/]+)\/diff\/(\d{4}-\d{2}-\d{2})\/url\/([a-f0-9]+)/);
  if (!match) {
    return jsonResponse({ error: 'Invalid URL history request' }, 400);
  }

  const [, siteId, date, urlHash] = match;

  try {
    const siteManager = new SiteManager(kv);
    const siteConfig = await siteManager.getSiteConfig(siteId);
    if (!siteConfig) {
      return jsonResponse({ error: 'Site not found' }, 404);
    }

    const metaKey = `meta:${siteId}:${date}:${urlHash}`;
    const currentMetaData = await kv.get(metaKey, 'text');

    if (!currentMetaData) {
      return jsonResponse({ error: 'URL not found for this date' }, 404);
    }

    const previousDate = await getPreviousDate(siteId, date, kv);

    if (!previousDate) {
      return jsonResponse({ error: 'No previous backup found' }, 404);
    }

    const previousMetaData = await kv.get(`meta:${siteId}:${previousDate}:${urlHash}`, 'text');

    if (!previousMetaData) {
      return jsonResponse({ error: 'Previous version not found' }, 404);
    }

    const prevData = JSON.parse(previousMetaData);
    const currData = JSON.parse(currentMetaData);

    const [prevBackupContent, currBackupContent] = await Promise.all([
      readBackupContent(kv, siteId, previousDate, urlHash, prevData),
      readBackupContent(kv, siteId, date, urlHash, currData)
    ]);

    if (!prevBackupContent || !currBackupContent) {
      return jsonResponse({ error: 'Backup content not found' }, 404);
    }

    const diffGenerator = new DiffGenerator(kv);
    const diff = await diffGenerator.generateDiff(
      siteId,
      date,
      currData.url,
      prevBackupContent,
      currBackupContent,
      prevData.hash,
      currData.hash,
      { includeContent: true, includeStyle: true, includeStructure: true }
    );

    return jsonResponse({
      ...diff,
      currentDate: date,
      previousDate,
      urlHash,
      source: {
        previous: prevBackupContent,
        current: currBackupContent
      }
    });
  } catch (error) {
    console.error('Failed to handle URL history request:', error);
    return jsonResponse({ error: 'Failed to generate URL diff' }, 500);
  }
}

async function handlePreviewRequest(path: string, kv: KVNamespace): Promise<Response> {
  try {
    const match = path.match(/\/api\/sites\/([^/]+)\/preview\/([^/]+)\/([^/]+)/);
    if (!match) {
      return jsonResponse({ error: 'Invalid preview path' }, 400);
    }

    const [, siteId, date, urlHash] = match;
    const metaKey = `meta:${siteId}:${date}:${urlHash}`;
    const metadataRaw = await kv.get(metaKey, 'text');
    const metadata = metadataRaw ? JSON.parse(metadataRaw) : null;
    const content = await readBackupContent(kv, siteId, date, urlHash, metadata);

    if (!content) {
      return jsonResponse({ error: 'Backup not found' }, 404);
    }

    return new Response(content, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'SAMEORIGIN'
      }
    });
  } catch (error) {
    console.error('Failed to handle preview request:', error);
    return jsonResponse({ error: 'Failed to load preview' }, 500);
  }
}

async function handleListBackedUpUrls(siteId: string, requestUrl: URL, kv: KVNamespace): Promise<Response> {
  try {
    const cursor = requestUrl.searchParams.get('cursor') || undefined;
    const limit = Math.min(parseInt(requestUrl.searchParams.get('limit') || '100', 10), 500);
    const search = requestUrl.searchParams.get('search')?.toLowerCase() || '';
    const sort = requestUrl.searchParams.get('sort') || 'url';
    const order = requestUrl.searchParams.get('order') || 'asc';

    const allUrls: Array<{
      url: string;
      urlHash: string;
      latestDate: string;
      latestTimestamp: string;
      latestStatus: number;
      latestSize: number;
      contentType: string;
    }> = [];

    let listCursor: string | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      const listResult = await kv.list({
        prefix: `latest:${siteId}:`,
        cursor: listCursor,
        limit: 1000
      }) as KVNamespaceListResult<unknown, string>;

      // Fetch all KV values in parallel for this page instead of sequentially
      const pageEntries = await Promise.all(
        listResult.keys.map(async (key) => {
          const urlHash = key.name.replace(`latest:${siteId}:`, '');
          const latestData = await kv.get(key.name, 'text');
          if (!latestData) return null;
          try {
            const metadata = JSON.parse(latestData);
            const urlEntry = {
              url: metadata.url,
              urlHash,
              latestDate: metadata.timestamp.split('T')[0],
              latestTimestamp: metadata.timestamp,
              latestStatus: metadata.status,
              latestSize: metadata.size,
              contentType: metadata.contentType || 'text/html'
            };
            if (!search || urlEntry.url.toLowerCase().includes(search)) {
              return urlEntry;
            }
            return null;
          } catch (error) {
            console.error(`Failed to parse latest data for ${key.name}:`, error);
            return null;
          }
        })
      );

      for (const entry of pageEntries) {
        if (entry) {
          allUrls.push(entry);
        }
      }

      hasMore = !listResult.list_complete;
      listCursor = (listResult as { cursor?: string }).cursor;
    }

    allUrls.sort((a, b) => {
      let comparison = 0;
      switch (sort) {
        case 'date':
          comparison = new Date(a.latestTimestamp).getTime() - new Date(b.latestTimestamp).getTime();
          break;
        case 'size':
          comparison = a.latestSize - b.latestSize;
          break;
        case 'status':
          comparison = a.latestStatus - b.latestStatus;
          break;
        case 'url':
        default:
          comparison = a.url.localeCompare(b.url);
          break;
      }
      return order === 'desc' ? -comparison : comparison;
    });

    let startIndex = 0;
    if (cursor) {
      const cursorIndex = parseInt(cursor, 10);
      if (!isNaN(cursorIndex)) {
        startIndex = cursorIndex;
      }
    }

    const paginatedUrls = allUrls.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < allUrls.length ? String(startIndex + limit) : null;

    return jsonResponse({
      urls: paginatedUrls,
      total: allUrls.length,
      limit,
      cursor: cursor || '0',
      nextCursor,
      hasMore: nextCursor !== null
    });
  } catch (error) {
    console.error('Failed to list backed up URLs:', error);
    return jsonResponse({ error: 'Failed to list URLs' }, 500);
  }
}

async function handleBackupHistory(siteId: string, urlHash: string, kv: KVNamespace): Promise<Response> {
  try {
    const keys = await listKeysWithPrefix(kv, `meta:${siteId}:`);
    const history: Array<{
      date: string;
      timestamp: string;
      status: number;
      size: number;
      hash: string;
      contentType: string;
    }> = [];

    // Collect matching keys first, then fetch all metadata in parallel
    const matchingKeys: Array<{ keyName: string; date: string }> = [];
    for (const keyName of keys) {
      const keyParts = keyName.split(':');
      if (keyParts.length >= 4 && keyParts[3] === urlHash) {
        matchingKeys.push({ keyName, date: keyParts[2] });
      }
    }

    const historyEntries = await Promise.all(
      matchingKeys.map(async ({ keyName, date }) => {
        const metaData = await kv.get(keyName, 'text');
        if (!metaData) return null;
        try {
          const metadata = JSON.parse(metaData);
          return {
            date,
            timestamp: metadata.timestamp,
            status: metadata.status,
            size: metadata.size,
            hash: metadata.hash,
            contentType: metadata.contentType || 'text/html'
          };
        } catch (error) {
          console.error(`Failed to parse metadata for ${keyName}:`, error);
          return null;
        }
      })
    );

    for (const entry of historyEntries) {
      if (entry) {
        history.push(entry);
      }
    }

    history.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return jsonResponse(history);
  } catch (error) {
    console.error('Failed to get backup history:', error);
    return jsonResponse({ error: 'Failed to get backup history' }, 500);
  }
}

async function handleBackupSource(siteId: string, date: string, urlHash: string, kv: KVNamespace): Promise<Response> {
  try {
    const metaKey = `meta:${siteId}:${date}:${urlHash}`;
    const metadataRaw = await kv.get(metaKey, 'text');
    const metadata = metadataRaw ? JSON.parse(metadataRaw) : null;
    const content = await readBackupContent(kv, siteId, date, urlHash, metadata);

    if (!content) {
      return jsonResponse({ error: 'Backup not found' }, 404);
    }

    return new Response(content, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8'
      }
    });
  } catch (error) {
    console.error('Failed to get backup source:', error);
    return jsonResponse({ error: 'Failed to load backup source' }, 500);
  }
}

async function getPreviousDate(siteId: string, currentDate: string, kv: KVNamespace): Promise<string | null> {
  const keys = await listKeysWithPrefix(kv, `backup:${siteId}:`);
  const dates = new Set<string>();

  for (const keyName of keys) {
    const match = keyName.match(/backup:[^:]+:(\d{4}-\d{2}-\d{2})/);
    if (match) {
      dates.add(match[1]);
    }
  }

  const sortedDates = Array.from(dates).sort().reverse();
  const currentIndex = sortedDates.indexOf(currentDate);

  if (currentIndex === -1 || currentIndex === sortedDates.length - 1) {
    return null;
  }

  return sortedDates[currentIndex + 1];
}