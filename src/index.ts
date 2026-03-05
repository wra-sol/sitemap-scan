import { BackupFetcher } from './backup/fetcher';
import { SchedulerDispatcher } from './scheduler/dispatcher';
import { requireApiAuth } from './http/auth';
import { SiteManager } from './sites/manager';
import { SlackNotifier } from './slack/notifier';
import { matchesCronExpression } from './scheduler/cron';
import { toPublicSiteConfig } from './sites/public-config';
import { SiteRegistry } from './sites/registry';
import { SiteConfig, SiteBackupResult } from './types/site';
import { DiffGenerator } from './diff/generator';
import { ContentComparer } from './diff/comparer';

export interface Env {
  BACKUP_KV: KVNamespace;
  ADMIN_API_TOKEN?: string;
  DEFAULT_SLACK_WEBHOOK?: string;
  PUBLIC_BASE_URL?: string;
}

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`Scheduled event triggered: ${event.cron}`);
    
    const siteManager = new SiteManager(env.BACKUP_KV);
    const slackNotifier = new SlackNotifier(env.BACKUP_KV, env.DEFAULT_SLACK_WEBHOOK, env.PUBLIC_BASE_URL);

    try {
      // Get all configured sites and back them up
      const sites = await siteManager.getAllSiteConfigs();
      const now = new Date();
      const dueSites = sites.filter((site) => matchesCronExpression(site.schedule, now));
      console.log(`Processing ${dueSites.length} scheduled site(s) out of ${sites.length} configured...`);

      if (dueSites.length === 0) {
        return;
      }

      const fetcher = new BackupFetcher(env.BACKUP_KV);
      
      let successful = 0;
      let failed = 0;
      
      for (const site of dueSites) {
        try {
          console.log(`Backing up: ${site.name} (${site.id})`);
          
          // Use batched backup with continuation support
          // Batch size 30 is the proven safe max; we do up to 2 batches per cron to speed large sites.
          let result = await fetcher.performSiteBackup(site, {
            continueFromLast: true,
            batchSize: 30
          });

          let totalSuccessful = result.successfulBackups;
          let totalFailed = result.failedBackups;
          let totalStored = result.storedBackups;
          let totalStoreFailed = result.failedStores;
          let allChangedUrls = [...result.changedUrls];

          let batchCount = 1;
          const maxBatchesPerRun = 2; // 2 batches per site per cron (~60 URLs per 10 min)

          while (result.hasMore && batchCount < maxBatchesPerRun) {
            console.log(`${site.name}: Continuing batch ${batchCount + 1}, progress: ${result.progress.percentComplete}%`);
            result = await fetcher.performSiteBackup(site, { continueFromLast: true, batchSize: 30 });
            totalSuccessful += result.successfulBackups;
            totalFailed += result.failedBackups;
            totalStored += result.storedBackups;
            totalStoreFailed += result.failedStores;
            allChangedUrls.push(...result.changedUrls);
            batchCount++;
          }
          
          if (result.hasMore) {
            console.log(`${site.name}: Batch limit reached, will continue in next cron run. Progress: ${result.progress.percentComplete}%`);
          }
          
          if (totalFailed === 0) {
            successful++;
          } else {
            failed++;
          }
          
          // Send Slack notification if there are changes
          if (allChangedUrls.length > 0) {
            const siteBackupResult: SiteBackupResult = {
              siteId: site.id,
              siteName: site.name,
              totalUrls: result.totalUrls,
              successfulBackups: totalSuccessful,
              failedBackups: totalFailed,
              storedBackups: totalStored,
              failedStores: totalStoreFailed,
              changedUrls: allChangedUrls,
              executionTime: result.executionTime,
              errors: result.errors,
              results: result.results
            };
            await slackNotifier.sendChangeNotification(site, siteBackupResult);
          }
          
          console.log(`${site.name}: ${totalSuccessful}/${result.progress.completed} URLs processed, ${allChangedUrls.length} changes, ${result.progress.percentComplete}% complete`);
        } catch (error) {
          console.error(`Backup failed for ${site.id}:`, error);
          failed++;
          await slackNotifier.sendErrorNotification(
            site,
            `Backup failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      
      console.log(`Backup complete: ${successful} sites successful, ${failed} failed`);

    } catch (error) {
      console.error('Scheduled event processing failed:', error);
      
      try {
        const sites = await siteManager.getAllSiteConfigs();
        if (sites.length > 0) {
          await slackNotifier.sendErrorNotification(
            sites[0],
            `Scheduler error: ${error instanceof Error ? error.message : String(error)}`,
            { cron: event.cron }
          );
        }
      } catch (slackError) {
        console.error('Failed to send error notification:', slackError);
      }
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const siteManager = new SiteManager(env.BACKUP_KV);
    const slackNotifier = new SlackNotifier(env.BACKUP_KV, env.DEFAULT_SLACK_WEBHOOK, env.PUBLIC_BASE_URL);
    const siteRegistry = new SiteRegistry(env.BACKUP_KV);
    const authError = requireApiAuth(request, env);

    try {
      if (authError) {
        return authError;
      }

      switch (request.method) {
        case 'GET':
          return handleGetRequest(url, siteManager, siteRegistry, env);
        
        case 'POST':
          return await handlePostRequest(request, url, siteManager, slackNotifier, env);
        
        case 'PUT':
          return await handlePutRequest(request, url, siteManager);
        
        case 'DELETE':
          return await handleDeleteRequest(url, siteManager);
        
        default:
          return new Response('Method not allowed', { status: 405 });
      }
    } catch (error) {
      console.error('API request failed:', error);
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        { 
          status: 500, 
          headers: { 'Content-Type': 'application/json' } 
        }
      );
    }
  }
};

async function handleGetRequest(
  url: URL, 
  siteManager: SiteManager, 
  siteRegistry: SiteRegistry,
  env: Env
): Promise<Response> {
  const path = url.pathname;
  const siteId = url.searchParams.get('siteId');

  switch (path) {
    case '/api/sites':
      if (siteId) {
        const siteConfig = await siteManager.getSiteConfig(siteId);
        return siteConfig 
          ? jsonResponse(toPublicSiteConfig(siteConfig))
          : new Response('Site not found', { status: 404 });
      } else {
        const allSites = await siteManager.getAllSiteConfigs();
        return jsonResponse(allSites.map(toPublicSiteConfig));
      }
    
    case '/api/sites/health':
      if (siteId) {
        const health = await siteRegistry.validateSiteHealth(siteId);
        return new Response(JSON.stringify(health));
      } else {
        const allHealth = await siteRegistry.validateAllSites();
        return new Response(JSON.stringify(allHealth));
      }
    
    case '/api/sites/metrics':
      if (!siteId) {
        return new Response('siteId parameter required', { status: 400 });
      }
      const days = parseInt(url.searchParams.get('days') || '7');
      const metrics = await siteRegistry.getSiteMetrics(siteId, days);
      return new Response(JSON.stringify(metrics));
    
    case '/api/sites/dates':
      if (!siteId) {
        return new Response('siteId parameter required', { status: 400 });
      }
      return await handleGetSiteDates(siteId, env.BACKUP_KV);
    
    case '/api/status':
      const dispatcher = new SchedulerDispatcher(env.BACKUP_KV);
      const status = await dispatcher.getSchedulerStatus();
      return jsonResponse(status);
    
    case '/api/test':
      const testResult = await siteRegistry.validateAllSites();
      return jsonResponse(testResult);
    
    case '/diff/viewer':
      return await serveDiffViewer(env.BACKUP_KV);
    
    case '/backup/viewer':
      return await serveBackupViewer(env.BACKUP_KV);
    
    default:
      // Preview endpoint: /api/sites/{siteId}/preview/{date}/{urlHash}
      if (path.startsWith('/api/sites/') && path.includes('/preview/')) {
        return await handlePreviewRequest(path, env.BACKUP_KV);
      }
      // URL history endpoint must be checked first (it contains both /diff/ and /url/)
      if (path.startsWith('/api/sites/') && path.includes('/diff/') && path.includes('/url/')) {
        return await handleUrlHistoryRequest(path, env.BACKUP_KV);
      }
      if (path.startsWith('/api/sites/') && path.includes('/diff/')) {
        return await handleDiffRequest(path, env.BACKUP_KV);
      }
      // Backup URLs list endpoint: /api/sites/{siteId}/urls
      if (path.match(/^\/api\/sites\/[^/]+\/urls$/)) {
        const match = path.match(/^\/api\/sites\/([^/]+)\/urls$/);
        if (match) {
          return await handleListBackedUpUrls(match[1], url, env.BACKUP_KV);
        }
      }
      // Backup history endpoint: /api/sites/{siteId}/backup/{urlHash}/history
      if (path.match(/^\/api\/sites\/[^/]+\/backup\/[^/]+\/history$/)) {
        const match = path.match(/^\/api\/sites\/([^/]+)\/backup\/([^/]+)\/history$/);
        if (match) {
          return await handleBackupHistory(match[1], match[2], env.BACKUP_KV);
        }
      }
      // Backup source endpoint: /api/sites/{siteId}/backup/{date}/{urlHash}/source
      if (path.match(/^\/api\/sites\/[^/]+\/backup\/\d{4}-\d{2}-\d{2}\/[^/]+\/source$/)) {
        const match = path.match(/^\/api\/sites\/([^/]+)\/backup\/(\d{4}-\d{2}-\d{2})\/([^/]+)\/source$/);
        if (match) {
          return await handleBackupSource(match[1], match[2], match[3], env.BACKUP_KV);
        }
      }
      return new Response('Not found', { status: 404 });
  }
}

async function handlePostRequest(
  request: Request,
  url: URL,
  siteManager: SiteManager,
  slackNotifier: SlackNotifier,
  env: Env
): Promise<Response> {
  const path = url.pathname;
  
  switch (path) {
    case '/api/sites':
      const body = await request.json() as SiteConfig;
      const validationResult = await siteManager.validateSiteConfig(body);
      
      if (!validationResult.valid) {
        return jsonResponse({ error: 'Invalid configuration', details: validationResult.errors }, 400);
      }
      
      const saved = await siteManager.saveSiteConfig(body);
      if (!saved) {
        return new Response('Failed to save site configuration', { status: 500 });
      }
      
      const dispatcher = new SchedulerDispatcher(env.BACKUP_KV);
      await dispatcher.addSiteToScheduler(body);
      
      return jsonResponse({ success: true, siteId: body.id }, 201);
    
    case '/api/slack/test':
      const slackBody = await request.json() as { webhook?: string };
      const testSuccess = await slackNotifier.sendTestNotification(slackBody.webhook);
      return jsonResponse({ success: testSuccess });
    
    case '/api/backup/trigger':
      const triggerBody = await request.json() as { 
        siteId: string;
        batchSize?: number;
        batchOffset?: number;
        continueFromLast?: boolean;
      };
      const siteConfig = await siteManager.getSiteConfig(triggerBody.siteId);
      
      if (!siteConfig) {
        return new Response('Site not found', { status: 404 });
      }
      
      const fetcher = new BackupFetcher(env.BACKUP_KV);
      const backupResult = await fetcher.performSiteBackup(siteConfig, {
        batchSize: triggerBody.batchSize,
        batchOffset: triggerBody.batchOffset,
        continueFromLast: triggerBody.continueFromLast ?? true
      });
      
      const siteBackupResult: SiteBackupResult = {
        siteId: siteConfig.id,
        siteName: siteConfig.name,
        totalUrls: backupResult.totalUrls,
        successfulBackups: backupResult.successfulBackups,
        failedBackups: backupResult.failedBackups,
        storedBackups: backupResult.storedBackups,
        failedStores: backupResult.failedStores,
        changedUrls: backupResult.changedUrls,
        executionTime: backupResult.executionTime,
        errors: backupResult.errors,
        results: backupResult.results
      };
      
      if (backupResult.changedUrls.length > 0) {
        await slackNotifier.sendChangeNotification(siteConfig, siteBackupResult);
      }
      
      // Strip content from results to avoid JSON parsing issues with control characters
      // and to reduce response size
      const sanitizedResults = backupResult.results.map(r => ({
        url: r.url,
        success: r.success,
        error: r.error,
        metadata: r.metadata
        // content field intentionally omitted
      }));
      
      const responsePayload = {
        ...backupResult,
        results: sanitizedResults
      };
      
      return jsonResponse(responsePayload);
    
    case '/api/backup/progress':
      const progressBody = await request.json() as { siteId: string };
      const progressFetcher = new BackupFetcher(env.BACKUP_KV);
      const progress = await progressFetcher.getBatchProgress(progressBody.siteId);
      
      return jsonResponse(progress || { hasMore: false, message: 'No batch in progress' });

    case '/api/backup/reset':
      const resetBody = await request.json() as { siteId: string };
      const resetSiteConfig = await siteManager.getSiteConfig(resetBody.siteId);
      if (!resetSiteConfig) {
        return new Response('Site not found', { status: 404 });
      }
      const resetFetcher = new BackupFetcher(env.BACKUP_KV);
      await resetFetcher.resetSiteProgress(resetBody.siteId);
      return jsonResponse({ success: true, message: 'Batch progress and URL cache cleared for site' });
    
    default:
      return new Response('Not found', { status: 404 });
  }
}

async function handlePutRequest(
  request: Request,
  url: URL,
  siteManager: SiteManager
): Promise<Response> {
  const siteId = url.searchParams.get('siteId');
  
  if (!siteId) {
    return new Response('siteId parameter required', { status: 400 });
  }
  
  const existingSite = await siteManager.getSiteConfig(siteId);
  if (!existingSite) {
    return new Response('Site not found', { status: 404 });
  }
  
  const body = await request.json() as SiteConfig;
  const validationResult = await siteManager.validateSiteConfig(body);
  
  if (!validationResult.valid) {
    return new Response(
      JSON.stringify({ error: 'Invalid configuration', details: validationResult.errors }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
  
  const saved = await siteManager.saveSiteConfig(body);
  return saved 
    ? new Response(JSON.stringify({ success: true }))
    : new Response('Failed to update site configuration', { status: 500 });
}

async function handleDeleteRequest(
  url: URL,
  siteManager: SiteManager
): Promise<Response> {
  const siteId = url.searchParams.get('siteId');
  
  if (!siteId) {
    return new Response('siteId parameter required', { status: 400 });
  }
  
  const deleted = await siteManager.deleteSiteConfig(siteId);
  return deleted 
    ? new Response(JSON.stringify({ success: true }))
    : new Response('Failed to delete site configuration', { status: 500 });
}

async function handleGetSiteDates(siteId: string, kv: KVNamespace): Promise<Response> {
  try {
    const list = await kv.list({ prefix: `backup:${siteId}:` });
    const dates = new Set<string>();
    
    for (const key of list.keys) {
      const regex = new RegExp(`backup:${siteId}:(\\d{4}-\\d{2}-\\d{2})`);
      const match = key.name.match(regex);
      if (match) {
        dates.add(match[1]);
      }
    }
    
    return new Response(
      JSON.stringify(Array.from(dates).sort().reverse()),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Failed to get site dates:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to retrieve dates' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function handleDiffRequest(path: string, kv: KVNamespace): Promise<Response> {
  const match = path.match(/\/api\/sites\/([^/]+)\/diff\/(\d{4}-\d{2}-\d{2})/);
  if (!match) {
    return new Response('Invalid diff request', { status: 400 });
  }

  const [_, siteId, date] = match;

  try {
    const siteManager = new SiteManager(kv);
    const siteConfig = await siteManager.getSiteConfig(siteId);
    if (!siteConfig) {
      return new Response('Site not found', { status: 404 });
    }

    const list = await kv.list({ prefix: `backup:${siteId}:${date}:` });
    const urls: Array<{
      url: string;
      urlHash: string;
      contentChanges: number;
      styleChanges: number;
      structureChanges: number;
    }> = [];
    
    const urlRegex = new RegExp(`backup:${siteId}:${date}:([a-f0-9]+)`);
    for (const key of list.keys) {
      const urlMatch = key.name.match(urlRegex);
      if (urlMatch) {
        const urlHash = urlMatch[1];
        const metaKey = `meta:${siteId}:${date}:${urlHash}`;
        const metaData = await kv.get(metaKey, 'text');
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
    }

    const diffGenerator = new DiffGenerator(kv);
    const previousDate = await getPreviousDate(siteId, date, kv);

    for (const urlData of urls.slice(0, 10)) {
      if (previousDate) {
        const prevKey = `meta:${siteId}:${previousDate}:${urlData.urlHash}`;
        const prevMetaData = await kv.get(prevKey, 'text');

        if (prevMetaData) {
          try {
            const prevData = JSON.parse(prevMetaData);
            const currKey = `meta:${siteId}:${date}:${urlData.urlHash}`;
            const currMetaData = await kv.get(currKey, 'text');

            if (currMetaData) {
              const currData = JSON.parse(currMetaData);
              const backupPrevKey = `backup:${siteId}:${previousDate}:${urlData.urlHash}`;
              const backupCurrKey = `backup:${siteId}:${date}:${urlData.urlHash}`;
              
              const prevBackupContent = await kv.get(backupPrevKey, 'text');
              const currBackupContent = await kv.get(backupCurrKey, 'text');
              
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
            }
          } catch (error) {
            console.error('Failed to generate diff:', error);
          }
        }
      }
    }

    return new Response(
      JSON.stringify({
        siteId,
        date,
        urls: urls.filter(u => u.contentChanges > 0 || u.styleChanges > 0 || u.structureChanges > 0),
        summary: {
          totalUrls: urls.length,
          changedUrls: urls.filter(u => u.contentChanges > 0 || u.styleChanges > 0 || u.structureChanges > 0).length
        }
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Failed to handle diff request:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to generate diff' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function handleUrlHistoryRequest(path: string, kv: KVNamespace): Promise<Response> {
  const match = path.match(/\/api\/sites\/([^/]+)\/diff\/(\d{4}-\d{2}-\d{2})\/url\/([a-f0-9]+)/);
  if (!match) {
    return new Response('Invalid URL history request', { status: 400 });
  }

  const [_, siteId, date, urlHash] = match;

  try {
    const siteManager = new SiteManager(kv);
    const siteConfig = await siteManager.getSiteConfig(siteId);
    if (!siteConfig) {
      return new Response('Site not found', { status: 404 });
    }

    const metaKey = `meta:${siteId}:${date}:${urlHash}`;
    const currentMetaData = await kv.get(metaKey, 'text');

    if (!currentMetaData) {
      return new Response('URL not found for this date', { status: 404 });
    }

    const currData = JSON.parse(currentMetaData);

    const previousDate = await getPreviousDate(siteId, date, kv);
    if (!previousDate) {
      return new Response('No previous backup found', { status: 404 });
    }

    const previousMetaKey = `meta:${siteId}:${previousDate}:${urlHash}`;
    const previousMetaData = await kv.get(previousMetaKey, 'text');

    if (!previousMetaData) {
      return new Response('Previous version not found', { status: 404 });
    }

    const prevData = JSON.parse(previousMetaData);
    
    const prevBackupKey = `backup:${siteId}:${previousDate}:${urlHash}`;
    const currBackupKey = `backup:${siteId}:${date}:${urlHash}`;
    const prevBackupContent = await kv.get(prevBackupKey, 'text');
    const currBackupContent = await kv.get(currBackupKey, 'text');

    if (!prevBackupContent || !currBackupContent) {
      return new Response('Backup content not found', { status: 404 });
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

    return new Response(
      JSON.stringify({
        ...diff,
        currentDate: date,
        previousDate,
        urlHash,
        source: {
          previous: prevBackupContent,
          current: currBackupContent
        }
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Failed to handle URL history request:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to generate URL diff' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function handlePreviewRequest(path: string, kv: KVNamespace): Promise<Response> {
  try {
    // Path format: /api/sites/{siteId}/preview/{date}/{urlHash}
    const match = path.match(/\/api\/sites\/([^/]+)\/preview\/([^/]+)\/([^/]+)/);
    if (!match) {
      return new Response('Invalid preview path', { status: 400 });
    }

    const [, siteId, date, urlHash] = match;
    const backupKey = `backup:${siteId}:${date}:${urlHash}`;
    const content = await kv.get(backupKey, 'text');

    if (!content) {
      return new Response('Backup not found', { status: 404 });
    }

    // Return the HTML content directly for iframe preview
    return new Response(content, {
      headers: { 
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'SAMEORIGIN'
      }
    });
  } catch (error) {
    console.error('Failed to handle preview request:', error);
    return new Response('Failed to load preview', { status: 500 });
  }
}

// Handler for listing all backed up URLs for a site with pagination, search, and sorting
async function handleListBackedUpUrls(siteId: string, requestUrl: URL, kv: KVNamespace): Promise<Response> {
  try {
    // Parse query parameters
    const cursor = requestUrl.searchParams.get('cursor') || undefined;
    const limit = Math.min(parseInt(requestUrl.searchParams.get('limit') || '100'), 500);
    const search = requestUrl.searchParams.get('search')?.toLowerCase() || '';
    const sort = requestUrl.searchParams.get('sort') || 'url'; // url, date, size, status
    const order = requestUrl.searchParams.get('order') || 'asc'; // asc, desc

    // We need to fetch all keys to support search and sorting
    // KV list doesn't support filtering, so we paginate through all keys
    let allUrls: Array<{
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

    // Fetch all keys (KV list returns max 1000 per call)
    while (hasMore) {
      const listResult = await kv.list({ 
        prefix: `latest:${siteId}:`,
        cursor: listCursor,
        limit: 1000
      }) as KVNamespaceListResult<unknown, string>;

      for (const key of listResult.keys) {
        const urlHash = key.name.replace(`latest:${siteId}:`, '');
        const latestData = await kv.get(key.name, 'text');
        
        if (latestData) {
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

            // Apply search filter
            if (!search || urlEntry.url.toLowerCase().includes(search)) {
              allUrls.push(urlEntry);
            }
          } catch (error) {
            console.error(`Failed to parse latest data for ${key.name}:`, error);
          }
        }
      }

      hasMore = !listResult.list_complete;
      listCursor = (listResult as { cursor?: string }).cursor;
    }

    // Apply sorting
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

    // Apply cursor-based pagination
    let startIndex = 0;
    if (cursor) {
      const cursorIndex = parseInt(cursor);
      if (!isNaN(cursorIndex)) {
        startIndex = cursorIndex;
      }
    }

    const paginatedUrls = allUrls.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < allUrls.length ? String(startIndex + limit) : null;

    return new Response(
      JSON.stringify({
        urls: paginatedUrls,
        total: allUrls.length,
        limit,
        cursor: cursor || '0',
        nextCursor,
        hasMore: nextCursor !== null
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Failed to list backed up URLs:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to list URLs' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// Handler for getting backup history for a specific URL
async function handleBackupHistory(siteId: string, urlHash: string, kv: KVNamespace): Promise<Response> {
  try {
    // List all metadata entries for this site
    const list = await kv.list({ prefix: `meta:${siteId}:` });
    const history: Array<{
      date: string;
      timestamp: string;
      status: number;
      size: number;
      hash: string;
      contentType: string;
    }> = [];

    for (const key of list.keys) {
      // Check if this key matches the urlHash
      const keyParts = key.name.split(':');
      if (keyParts.length >= 4 && keyParts[3] === urlHash) {
        const date = keyParts[2];
        const metaData = await kv.get(key.name, 'text');
        
        if (metaData) {
          try {
            const metadata = JSON.parse(metaData);
            history.push({
              date,
              timestamp: metadata.timestamp,
              status: metadata.status,
              size: metadata.size,
              hash: metadata.hash,
              contentType: metadata.contentType || 'text/html'
            });
          } catch (error) {
            console.error(`Failed to parse metadata for ${key.name}:`, error);
          }
        }
      }
    }

    // Sort by date descending (newest first)
    history.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return new Response(
      JSON.stringify(history),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Failed to get backup history:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to get backup history' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// Handler for getting raw HTML source of a backup
async function handleBackupSource(siteId: string, date: string, urlHash: string, kv: KVNamespace): Promise<Response> {
  try {
    const backupKey = `backup:${siteId}:${date}:${urlHash}`;
    const content = await kv.get(backupKey, 'text');

    if (!content) {
      return new Response('Backup not found', { status: 404 });
    }

    // Return as plain text for source view
    return new Response(content, {
      headers: { 
        'Content-Type': 'text/plain; charset=utf-8'
      }
    });
  } catch (error) {
    console.error('Failed to get backup source:', error);
    return new Response('Failed to load backup source', { status: 500 });
  }
}

async function getPreviousDate(siteId: string, currentDate: string, kv: KVNamespace): Promise<string | null> {
  const list = await kv.list({ prefix: `backup:${siteId}:` });
  const dates = new Set<string>();

  for (const key of list.keys) {
    const match = key.name.match(/backup:[^:]+:(\d{4}-\d{2}-\d{2})/);
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

async function serveDiffViewer(kv: KVNamespace): Promise<Response> {
  const viewerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Diff Viewer - Website Backup Monitor</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; color: #111827; }
    .container { max-width: 1600px; margin: 0 auto; padding: 20px; }
    .panel { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
    .header { padding: 20px; margin-bottom: 16px; }
    .header h1 { margin: 0 0 8px; font-size: 28px; }
    .subtle { color: #6b7280; font-size: 14px; }
    .auth-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 16px 20px; margin-bottom: 16px; background: #111827; color: white; border-radius: 12px; }
    .auth-bar input { flex: 1 1 280px; min-width: 220px; padding: 10px 12px; border-radius: 8px; border: 1px solid #374151; background: #1f2937; color: white; }
    .auth-bar button, .controls button, .controls select, .controls label, .preview-btn, .inline-btn { border-radius: 8px; font-size: 14px; }
    .auth-bar button, .controls button, .preview-btn, .inline-btn { border: 1px solid #d1d5db; background: #fff; color: #111827; padding: 10px 14px; cursor: pointer; }
    .auth-bar button.primary, .controls button.active { background: #2563eb; color: #fff; border-color: #2563eb; }
    .auth-bar button.secondary { background: transparent; color: white; border-color: #4b5563; }
    .controls { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; padding: 16px 20px; margin-bottom: 16px; }
    .controls-left, .controls-right { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .controls select { padding: 10px 12px; border: 1px solid #d1d5db; background: #fff; min-width: 180px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .summary-card { padding: 16px; }
    .summary-card .value { font-size: 28px; font-weight: 700; color: #2563eb; }
    .summary-card .label { margin-top: 6px; font-size: 13px; color: #6b7280; }
    .layout { display: grid; grid-template-columns: 320px 1fr; gap: 16px; }
    .sidebar { padding: 16px; }
    .sidebar h2, .content h2 { margin: 0 0 14px; font-size: 18px; }
    .url-list { display: flex; flex-direction: column; gap: 10px; max-height: 75vh; overflow: auto; }
    .url-item { padding: 12px; border: 1px solid #e5e7eb; border-radius: 10px; cursor: pointer; background: #fff; }
    .url-item:hover { border-color: #93c5fd; background: #f8fbff; }
    .url-item.selected { border-color: #2563eb; background: #eff6ff; }
    .url-item-title { font-size: 13px; font-weight: 600; line-height: 1.5; word-break: break-word; }
    .url-item-actions { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 10px; }
    .badge-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .badge { display: inline-flex; align-items: center; padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .badge-content { background: #dbeafe; color: #1d4ed8; }
    .badge-style { background: #ffedd5; color: #c2410c; }
    .badge-structure { background: #dcfce7; color: #15803d; }
    .content { display: flex; flex-direction: column; gap: 16px; }
    .content-panel { padding: 18px; }
    .content-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 16px; }
    .content-header h2 { margin-bottom: 4px; }
    .muted { color: #6b7280; font-size: 13px; }
    .empty-state, .loading { padding: 36px; text-align: center; color: #6b7280; }
    .error { display: none; margin-bottom: 16px; padding: 14px 16px; border-radius: 12px; background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
    .change-list { display: flex; flex-direction: column; gap: 12px; }
    .change-card { padding: 14px; border: 1px solid #e5e7eb; border-left: 4px solid transparent; border-radius: 10px; background: #fafafa; }
    .change-card.content { border-left-color: #2563eb; }
    .change-card.style { border-left-color: #f97316; }
    .change-card.structure { border-left-color: #22c55e; }
    .change-card-header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
    .change-element { font-weight: 700; font-size: 14px; }
    .change-kind { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; border-radius: 999px; padding: 3px 8px; }
    .change-kind.added { background: #dcfce7; color: #166534; }
    .change-kind.removed { background: #fee2e2; color: #991b1b; }
    .change-kind.modified { background: #fef3c7; color: #92400e; }
    .before-after { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .diff-block { border-radius: 8px; overflow: hidden; border: 1px solid #e5e7eb; }
    .diff-block-label { padding: 8px 10px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .diff-block-label.before { background: #fef2f2; color: #991b1b; }
    .diff-block-label.after { background: #f0fdf4; color: #166534; }
    .diff-block-value { padding: 10px 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    .diff-block-value.before { background: #fff7f7; color: #7f1d1d; }
    .diff-block-value.after { background: #f7fff9; color: #14532d; }
    .source-controls { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px; }
    .source-controls label { display: inline-flex; align-items: center; gap: 8px; color: #374151; }
    .source-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .source-pane { border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; background: #fff; }
    .source-pane-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 12px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; }
    .source-pane-title { font-weight: 700; font-size: 13px; }
    .source-note { font-size: 12px; color: #6b7280; }
    .source-lines { max-height: 70vh; overflow: auto; background: #0f172a; color: #e5e7eb; }
    .source-row { display: grid; grid-template-columns: 52px 1fr; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .source-row.same { opacity: 0.78; }
    .source-row.added { background: rgba(34,197,94,0.18); }
    .source-row.removed { background: rgba(239,68,68,0.18); }
    .source-row.modified { background: rgba(245,158,11,0.18); }
    .line-number { padding: 8px 10px; text-align: right; color: #93c5fd; background: rgba(255,255,255,0.04); border-right: 1px solid rgba(255,255,255,0.06); user-select: none; }
    .line-content { padding: 8px 12px; white-space: pre-wrap; word-break: break-word; }
    .inline-diff-added { background: rgba(34,197,94,0.3); color: #dcfce7; border-radius: 4px; padding: 1px 0; }
    .inline-diff-removed { background: rgba(239,68,68,0.32); color: #fecaca; border-radius: 4px; padding: 1px 0; }
    .truncation-note { margin-top: 10px; font-size: 12px; color: #92400e; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 10px 12px; }
    .preview-btn, .inline-btn { padding: 8px 10px; font-size: 12px; }
    .preview-btn { background: #4f46e5; color: white; border-color: #4f46e5; }
    .inline-btn { background: #fff; }
    .preview-modal { display: none; position: fixed; inset: 0; background: rgba(15,23,42,0.82); z-index: 1000; }
    .preview-modal.active { display: flex; flex-direction: column; }
    .preview-header { background: #111827; color: white; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .preview-header h3 { margin: 0; font-size: 14px; }
    .preview-tabs { display: flex; gap: 8px; }
    .preview-tab { background: transparent; border: 1px solid #4b5563; color: #9ca3af; padding: 6px 12px; border-radius: 6px; cursor: pointer; }
    .preview-tab.active { background: #2563eb; border-color: #2563eb; color: white; }
    .preview-close { background: #ef4444; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; }
    .preview-content { flex: 1; background: white; }
    .preview-content iframe { width: 100%; height: 100%; border: none; }
    @media (max-width: 1100px) {
      .layout { grid-template-columns: 1fr; }
      .url-list { max-height: none; }
      .source-grid, .before-after { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="panel header">
      <h1 id="pageTitle">Diff Viewer</h1>
      <div id="pageInfo" class="subtle">Pick a site and backup date to inspect the exact before/after changes.</div>
    </div>

    <div class="auth-bar" id="authBar">
      <strong>Admin API Token</strong>
      <input id="tokenInput" type="password" placeholder="Paste ADMIN_API_TOKEN for API requests" />
      <button id="saveTokenBtn" class="primary">Save Token</button>
      <button id="clearTokenBtn" class="secondary">Clear</button>
      <span id="authStatus" class="subtle" style="color:#d1d5db;"></span>
    </div>

    <div id="error" class="error"></div>

    <div class="panel controls">
      <div class="controls-left">
        <select id="siteSelect"><option value="">Select Site...</option></select>
        <select id="dateSelect"><option value="">Select Date...</option></select>
      </div>
      <div class="controls-right">
        <button id="viewAll" class="active">All</button>
        <button id="viewContent">Content</button>
        <button id="viewStyle">Style</button>
        <button id="viewStructure">Structure</button>
      </div>
    </div>

    <div class="summary" id="summary" style="display:none;">
      <div class="panel summary-card"><div class="value" id="totalChanges">0</div><div class="label">Total Changes</div></div>
      <div class="panel summary-card"><div class="value" id="contentChanges">0</div><div class="label">Content Changes</div></div>
      <div class="panel summary-card"><div class="value" id="styleChanges">0</div><div class="label">Style Changes</div></div>
      <div class="panel summary-card"><div class="value" id="structureChanges">0</div><div class="label">Structure Changes</div></div>
    </div>

    <div class="layout">
      <aside class="panel sidebar">
        <h2>Changed URLs</h2>
        <div id="urlList" class="url-list">
          <div class="empty-state">Select a site and date to list changed pages.</div>
        </div>
      </aside>

      <main class="content">
        <section class="panel content-panel" id="changesPanel">
          <div class="content-header">
            <div>
              <h2>Detected Changes</h2>
              <div id="changeMeta" class="muted">Select a changed URL to inspect the classified differences.</div>
            </div>
            <div>
              <button id="openPreviewBtn" class="inline-btn" style="display:none;">Open Visual Preview</button>
            </div>
          </div>
          <div id="changesContent" class="change-list">
            <div class="empty-state">No URL selected.</div>
          </div>
        </section>

        <section class="panel content-panel" id="sourcePanel">
          <div class="content-header">
            <div>
              <h2>Source Diff</h2>
              <div id="sourceMeta" class="muted">Line-level HTML comparison between the previous and current backup.</div>
            </div>
          </div>
          <div class="source-controls">
            <label><input type="checkbox" id="changedOnlyToggle" checked /> Show only changed lines</label>
            <div id="sourceStats" class="muted"></div>
          </div>
          <div class="source-grid">
            <div class="source-pane">
              <div class="source-pane-header">
                <span class="source-pane-title">Previous</span>
                <span class="source-note" id="previousDateLabel">-</span>
              </div>
              <div class="source-lines" id="previousSource"><div class="empty-state">No source loaded.</div></div>
            </div>
            <div class="source-pane">
              <div class="source-pane-header">
                <span class="source-pane-title">Current</span>
                <span class="source-note" id="currentDateLabel">-</span>
              </div>
              <div class="source-lines" id="currentSource"><div class="empty-state">No source loaded.</div></div>
            </div>
          </div>
          <div id="sourceTruncation" class="truncation-note" style="display:none;"></div>
        </section>
      </main>
    </div>

    <div id="loading" class="loading" style="display:none;">Loading...</div>
  </div>

  <div class="preview-modal" id="previewModal">
    <div class="preview-header">
      <h3 id="previewTitle">Preview</h3>
      <div class="preview-tabs">
        <button class="preview-tab" id="previewPrevBtn">Previous Version</button>
        <button class="preview-tab active" id="previewCurrBtn">Current Version</button>
      </div>
      <button class="preview-close" id="previewClose">Close</button>
    </div>
    <div class="preview-content">
      <iframe id="previewFrame" sandbox="allow-same-origin"></iframe>
    </div>
  </div>

  <script>
    const baseUrl = window.location.origin;
    const tokenStorageKey = 'backupMonitorAdminToken';
    const params = new URLSearchParams(window.location.search);
    let adminToken = localStorage.getItem(tokenStorageKey) || '';
    let currentDiff = null;
    let currentUrlDiff = null;
    let currentView = 'all';
    let currentPreviewHash = null;
    let currentPreviewUrl = null;
    let previewVersion = 'current';

    const tokenInput = document.getElementById('tokenInput');
    const authStatus = document.getElementById('authStatus');
    tokenInput.value = adminToken;

    function isLocalhost() {
      return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    }

    function updateAuthStatus(message) {
      if (message) {
        authStatus.textContent = message;
        return;
      }
      if (adminToken) {
        authStatus.textContent = 'Token saved for this browser session.';
      } else if (isLocalhost()) {
        authStatus.textContent = 'Local dev detected; token is optional.';
      } else {
        authStatus.textContent = 'Required for secured API requests.';
      }
    }

    function getAuthHeaders() {
      if (!adminToken) return {};
      return { Authorization: 'Bearer ' + adminToken };
    }

    async function fetchJson(path) {
      const response = await fetch(baseUrl + path, {
        headers: getAuthHeaders()
      });

      if (response.status === 401 || response.status === 503) {
        let message = 'API authentication is required.';
        try {
          const data = await response.json();
          if (data && data.error) message = data.error;
        } catch {}
        updateAuthStatus(message);
        throw new Error(message);
      }

      if (!response.ok) {
        let message = 'Request failed.';
        try {
          const data = await response.json();
          if (data && data.error) message = data.error;
        } catch {}
        throw new Error(message);
      }

      return response.json();
    }

    function setView(view) {
      currentView = view;
      document.querySelectorAll('#viewAll, #viewContent, #viewStyle, #viewStructure').forEach(function(btn) {
        btn.classList.remove('active');
      });
      document.getElementById('view' + view.charAt(0).toUpperCase() + view.slice(1)).classList.add('active');
      if (currentUrlDiff) renderUrlDiff(currentUrlDiff);
    }

    async function loadSites() {
      try {
        const sites = await fetchJson('/api/sites');
        const select = document.getElementById('siteSelect');
        select.innerHTML = '<option value="">Select Site...</option>';
        for (const site of sites) {
          const option = document.createElement('option');
          option.value = site.id;
          option.textContent = site.name;
          select.appendChild(option);
        }

        if (params.get('siteId')) {
          select.value = params.get('siteId');
          await loadDates();
        }
      } catch (error) {
        showError('Failed to load sites: ' + error.message);
      }
    }

    async function loadDates() {
      const siteId = document.getElementById('siteSelect').value;
      const select = document.getElementById('dateSelect');
      select.innerHTML = '<option value="">Select Date...</option>';
      currentDiff = null;
      currentUrlDiff = null;
      resetContentPanels('Select a date to view changes.');
      if (!siteId) {
        updateUrlParams();
        return;
      }

      try {
        const dates = await fetchJson('/api/sites/dates?siteId=' + encodeURIComponent(siteId));
        for (const date of dates) {
          const option = document.createElement('option');
          option.value = date;
          option.textContent = date;
          select.appendChild(option);
        }

        if (params.get('date')) {
          select.value = params.get('date');
          await loadDiff();
        }
      } catch (error) {
        showError('Failed to load dates: ' + error.message);
      } finally {
        updateUrlParams();
      }
    }

    async function loadDiff() {
      const siteId = document.getElementById('siteSelect').value;
      const date = document.getElementById('dateSelect').value;
      if (!siteId || !date) return;

      showLoading(true);
      try {
        currentDiff = await fetchJson('/api/sites/' + encodeURIComponent(siteId) + '/diff/' + encodeURIComponent(date));
        renderSummary();
        renderUrlList();

        if (currentDiff.urls.length > 0) {
          const requestedHash = params.get('urlHash');
          const initialHash = requestedHash && currentDiff.urls.some(function(item) { return item.urlHash === requestedHash; })
            ? requestedHash
            : currentDiff.urls[0].urlHash;
          await selectUrl(initialHash);
        } else {
          resetContentPanels('No changed URLs were detected for this backup date.');
        }

        document.getElementById('summary').style.display = 'grid';
      } catch (error) {
        showError('Failed to load diff: ' + error.message);
      } finally {
        updateUrlParams();
        showLoading(false);
      }
    }

    async function selectUrl(urlHash) {
      if (!currentDiff) return;
      showLoading(true);
      try {
        const siteId = document.getElementById('siteSelect').value;
        const date = document.getElementById('dateSelect').value;
        currentUrlDiff = await fetchJson('/api/sites/' + encodeURIComponent(siteId) + '/diff/' + encodeURIComponent(date) + '/url/' + encodeURIComponent(urlHash));
        highlightSelectedUrl(urlHash);
        renderUrlDiff(currentUrlDiff);
      } catch (error) {
        showError('Failed to load URL diff: ' + error.message);
      } finally {
        updateUrlParams(urlHash);
        showLoading(false);
      }
    }

    function highlightSelectedUrl(urlHash) {
      document.querySelectorAll('.url-item').forEach(function(node) {
        node.classList.toggle('selected', node.getAttribute('data-hash') === urlHash);
      });
    }

    function renderUrlList() {
      const container = document.getElementById('urlList');
      if (!currentDiff || currentDiff.urls.length === 0) {
        container.innerHTML = '<div class="empty-state">No changed URLs found.</div>';
        return;
      }

      container.innerHTML = '';
      for (const urlData of currentDiff.urls) {
        const item = document.createElement('div');
        item.className = 'url-item';
        item.setAttribute('data-hash', urlData.urlHash);
        item.innerHTML =
          '<div class="url-item-title">' + escapeHtml(urlData.url) + '</div>' +
          '<div class="url-item-actions">' +
            '<div class="badge-row">' +
              (urlData.contentChanges > 0 ? '<span class="badge badge-content">' + urlData.contentChanges + ' content</span>' : '') +
              (urlData.styleChanges > 0 ? '<span class="badge badge-style">' + urlData.styleChanges + ' style</span>' : '') +
              (urlData.structureChanges > 0 ? '<span class="badge badge-structure">' + urlData.structureChanges + ' structure</span>' : '') +
            '</div>' +
            '<button class="preview-btn" type="button">Preview</button>' +
          '</div>';

        item.addEventListener('click', function(event) {
          if (event.target && event.target.classList.contains('preview-btn')) return;
          selectUrl(urlData.urlHash);
        });

        item.querySelector('.preview-btn').addEventListener('click', function(event) {
          event.stopPropagation();
          openPreview(urlData.urlHash, urlData.url);
        });

        container.appendChild(item);
      }
    }

    function renderSummary() {
      if (!currentDiff) return;
      const totals = currentDiff.urls.reduce(function(acc, item) {
        acc.content += item.contentChanges;
        acc.style += item.styleChanges;
        acc.structure += item.structureChanges;
        return acc;
      }, { content: 0, style: 0, structure: 0 });

      document.getElementById('totalChanges').textContent = String(totals.content + totals.style + totals.structure);
      document.getElementById('contentChanges').textContent = String(totals.content);
      document.getElementById('styleChanges').textContent = String(totals.style);
      document.getElementById('structureChanges').textContent = String(totals.structure);
    }

    function renderUrlDiff(urlDiff) {
      document.getElementById('pageTitle').textContent = 'Changes for ' + urlDiff.url;
      document.getElementById('pageInfo').textContent = 'Comparing ' + urlDiff.previousDate + ' to ' + urlDiff.currentDate;
      document.getElementById('changeMeta').textContent = 'Detected structured changes for ' + urlDiff.url;
      document.getElementById('sourceMeta').textContent = 'Line-level HTML diff for ' + urlDiff.url;
      document.getElementById('previousDateLabel').textContent = urlDiff.previousDate;
      document.getElementById('currentDateLabel').textContent = urlDiff.currentDate;
      document.getElementById('openPreviewBtn').style.display = 'inline-flex';
      renderChanges(urlDiff);
      renderSourceDiff(urlDiff);
    }

    function getFilteredChanges(classification) {
      if (currentView === 'all') return classification;
      return {
        content: currentView === 'content' ? classification.content : [],
        style: currentView === 'style' ? classification.style : [],
        structure: currentView === 'structure' ? classification.structure : []
      };
    }

    function renderChanges(urlDiff) {
      const classification = getFilteredChanges(urlDiff.classification);
      const changes = []
        .concat(classification.content.map(function(change) { return Object.assign({ category: 'content' }, change); }))
        .concat(classification.style.map(function(change) { return Object.assign({ category: 'style' }, change); }))
        .concat(classification.structure.map(function(change) { return Object.assign({ category: 'structure' }, change); }));

      const container = document.getElementById('changesContent');
      if (changes.length === 0) {
        container.innerHTML = '<div class="empty-state">No ' + escapeHtml(currentView) + ' changes found for this URL.</div>';
        return;
      }

      container.innerHTML = changes.map(function(change) {
        const beforeBlock = change.before
          ? '<div class="diff-block"><div class="diff-block-label before">Before</div><div class="diff-block-value before">' + escapeHtml(change.before) + '</div></div>'
          : '';
        const afterBlock = change.after
          ? '<div class="diff-block"><div class="diff-block-label after">After</div><div class="diff-block-value after">' + escapeHtml(change.after) + '</div></div>'
          : '';

        return (
          '<div class="change-card ' + change.category + '">' +
            '<div class="change-card-header">' +
              '<span class="change-element">' + escapeHtml(change.element || change.category) + '</span>' +
              '<span class="change-kind ' + escapeHtml(change.change || 'modified') + '">' + escapeHtml(change.change || 'modified') + '</span>' +
              (change.attribute ? '<span class="muted">attribute: ' + escapeHtml(change.attribute) + '</span>' : '') +
            '</div>' +
            ((beforeBlock || afterBlock) ? '<div class="before-after">' + beforeBlock + afterBlock + '</div>' : '') +
            (change.context ? '<div class="muted" style="margin-top:10px;">' + escapeHtml(change.context) + '</div>' : '') +
          '</div>'
        );
      }).join('');
    }

    function normalizeHtmlForDiff(content) {
      if (!content) return '';
      return content
        .replace(/></g, '>\\n<')
        .replace(/\\s+$/gm, '')
        .trim();
    }

    function prepareSourceLines(content) {
      const normalized = normalizeHtmlForDiff(content);
      const allLines = normalized ? normalized.split('\\n') : [];
      const maxLines = 600;
      return {
        lines: allLines.slice(0, maxLines),
        truncated: allLines.length > maxLines,
        totalLines: allLines.length
      };
    }

    function buildOperations(leftLines, rightLines) {
      const leftLength = leftLines.length;
      const rightLength = rightLines.length;
      const dp = Array.from({ length: leftLength + 1 }, function() {
        return Array(rightLength + 1).fill(0);
      });

      for (let i = leftLength - 1; i >= 0; i--) {
        for (let j = rightLength - 1; j >= 0; j--) {
          if (leftLines[i] === rightLines[j]) {
            dp[i][j] = dp[i + 1][j + 1] + 1;
          } else {
            dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
          }
        }
      }

      const operations = [];
      let i = 0;
      let j = 0;
      while (i < leftLength && j < rightLength) {
        if (leftLines[i] === rightLines[j]) {
          operations.push({ type: 'same', left: leftLines[i], right: rightLines[j] });
          i++;
          j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          operations.push({ type: 'removed', left: leftLines[i], right: '' });
          i++;
        } else {
          operations.push({ type: 'added', left: '', right: rightLines[j] });
          j++;
        }
      }

      while (i < leftLength) {
        operations.push({ type: 'removed', left: leftLines[i], right: '' });
        i++;
      }
      while (j < rightLength) {
        operations.push({ type: 'added', left: '', right: rightLines[j] });
        j++;
      }

      const rows = [];
      let leftNumber = 1;
      let rightNumber = 1;
      for (let index = 0; index < operations.length; index++) {
        const operation = operations[index];
        const nextOperation = operations[index + 1];

        if (operation.type === 'removed' && nextOperation && nextOperation.type === 'added') {
          rows.push({
            type: 'modified',
            leftNumber: leftNumber++,
            rightNumber: rightNumber++,
            left: operation.left,
            right: nextOperation.right
          });
          index++;
          continue;
        }

        if (operation.type === 'added' && nextOperation && nextOperation.type === 'removed') {
          rows.push({
            type: 'modified',
            leftNumber: leftNumber++,
            rightNumber: rightNumber++,
            left: nextOperation.left,
            right: operation.right
          });
          index++;
          continue;
        }

        if (operation.type === 'same') {
          rows.push({
            type: 'same',
            leftNumber: leftNumber++,
            rightNumber: rightNumber++,
            left: operation.left,
            right: operation.right
          });
        } else if (operation.type === 'removed') {
          rows.push({
            type: 'removed',
            leftNumber: leftNumber++,
            rightNumber: '',
            left: operation.left,
            right: ''
          });
        } else {
          rows.push({
            type: 'added',
            leftNumber: '',
            rightNumber: rightNumber++,
            left: '',
            right: operation.right
          });
        }
      }

      return rows;
    }

    function tokenizeForInlineDiff(text) {
      if (!text) return [];
      const matches = text.match(/\\s+|[^\\s]+/g);
      return matches ? matches : [];
    }

    function buildInlineDiffSegments(leftText, rightText) {
      const leftTokens = tokenizeForInlineDiff(leftText);
      const rightTokens = tokenizeForInlineDiff(rightText);
      const leftLength = leftTokens.length;
      const rightLength = rightTokens.length;
      const dp = Array.from({ length: leftLength + 1 }, function() {
        return Array(rightLength + 1).fill(0);
      });

      for (let i = leftLength - 1; i >= 0; i--) {
        for (let j = rightLength - 1; j >= 0; j--) {
          if (leftTokens[i] === rightTokens[j]) {
            dp[i][j] = dp[i + 1][j + 1] + 1;
          } else {
            dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
          }
        }
      }

      const leftSegments = [];
      const rightSegments = [];
      let i = 0;
      let j = 0;

      while (i < leftLength && j < rightLength) {
        if (leftTokens[i] === rightTokens[j]) {
          leftSegments.push({ text: leftTokens[i], type: 'same' });
          rightSegments.push({ text: rightTokens[j], type: 'same' });
          i++;
          j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          leftSegments.push({ text: leftTokens[i], type: 'removed' });
          i++;
        } else {
          rightSegments.push({ text: rightTokens[j], type: 'added' });
          j++;
        }
      }

      while (i < leftLength) {
        leftSegments.push({ text: leftTokens[i], type: 'removed' });
        i++;
      }

      while (j < rightLength) {
        rightSegments.push({ text: rightTokens[j], type: 'added' });
        j++;
      }

      return { leftSegments: mergeAdjacentSegments(leftSegments), rightSegments: mergeAdjacentSegments(rightSegments) };
    }

    function mergeAdjacentSegments(segments) {
      const merged = [];
      for (const segment of segments) {
        const previous = merged[merged.length - 1];
        if (previous && previous.type === segment.type) {
          previous.text += segment.text;
        } else {
          merged.push({ text: segment.text, type: segment.type });
        }
      }
      return merged;
    }

    function renderInlineDiffSegments(segments, changedType) {
      return segments.map(function(segment) {
        if (segment.type === 'same') {
          return escapeHtml(segment.text);
        }

        const className = changedType === 'added' ? 'inline-diff-added' : 'inline-diff-removed';
        return '<span class="' + className + '">' + escapeHtml(segment.text) + '</span>';
      }).join('');
    }

    function renderSourceLine(row, side) {
      const lineNumber = side === 'left' ? (row.leftNumber || '') : (row.rightNumber || '');
      const lineText = side === 'left' ? (row.left || '') : (row.right || '');

      let lineHtml = escapeHtml(lineText);
      if (row.type === 'modified') {
        const inlineDiff = buildInlineDiffSegments(row.left || '', row.right || '');
        lineHtml = side === 'left'
          ? renderInlineDiffSegments(inlineDiff.leftSegments, 'removed')
          : renderInlineDiffSegments(inlineDiff.rightSegments, 'added');
      }

      return (
        '<div class="source-row ' + row.type + '">' +
          '<div class="line-number">' + lineNumber + '</div>' +
          '<div class="line-content">' + lineHtml + '</div>' +
        '</div>'
      );
    }

    function renderSourceDiff(urlDiff) {
      const previousPrepared = prepareSourceLines(urlDiff.source ? urlDiff.source.previous : '');
      const currentPrepared = prepareSourceLines(urlDiff.source ? urlDiff.source.current : '');
      const rows = buildOperations(previousPrepared.lines, currentPrepared.lines);
      const changedOnly = document.getElementById('changedOnlyToggle').checked;
      const visibleRows = changedOnly
        ? rows.filter(function(row) { return row.type !== 'same'; })
        : rows;

      const previousContainer = document.getElementById('previousSource');
      const currentContainer = document.getElementById('currentSource');

      if (visibleRows.length === 0) {
        previousContainer.innerHTML = '<div class="empty-state">No visible source changes.</div>';
        currentContainer.innerHTML = '<div class="empty-state">No visible source changes.</div>';
      } else {
        previousContainer.innerHTML = visibleRows.map(function(row) {
          return renderSourceLine(row, 'left');
        }).join('');

        currentContainer.innerHTML = visibleRows.map(function(row) {
          return renderSourceLine(row, 'right');
        }).join('');
      }

      const changedRows = rows.filter(function(row) { return row.type !== 'same'; }).length;
      document.getElementById('sourceStats').textContent =
        changedRows + ' changed line pair' + (changedRows === 1 ? '' : 's') +
        ' shown out of ' + rows.length + ' total line pair' + (rows.length === 1 ? '' : 's');

      const truncation = document.getElementById('sourceTruncation');
      if (previousPrepared.truncated || currentPrepared.truncated) {
        truncation.style.display = 'block';
        truncation.textContent =
          'Large document detected. The source diff is limited to the first 600 formatted lines per version (' +
          previousPrepared.totalLines + ' previous, ' + currentPrepared.totalLines + ' current).';
      } else {
        truncation.style.display = 'none';
        truncation.textContent = '';
      }
    }

    function resetContentPanels(message) {
      document.getElementById('changesContent').innerHTML = '<div class="empty-state">' + escapeHtml(message) + '</div>';
      document.getElementById('previousSource').innerHTML = '<div class="empty-state">' + escapeHtml(message) + '</div>';
      document.getElementById('currentSource').innerHTML = '<div class="empty-state">' + escapeHtml(message) + '</div>';
      document.getElementById('openPreviewBtn').style.display = 'none';
      document.getElementById('sourceStats').textContent = '';
      document.getElementById('sourceTruncation').style.display = 'none';
    }

    function showLoading(show) {
      document.getElementById('loading').style.display = show ? 'block' : 'none';
    }

    function showError(message) {
      const errorNode = document.getElementById('error');
      errorNode.textContent = message;
      errorNode.style.display = 'block';
      clearTimeout(showError.timer);
      showError.timer = setTimeout(function() {
        errorNode.style.display = 'none';
      }, 6000);
    }

    function escapeHtml(value) {
      const div = document.createElement('div');
      div.textContent = value == null ? '' : String(value);
      return div.innerHTML;
    }

    function updateUrlParams(urlHash) {
      const siteId = document.getElementById('siteSelect').value;
      const date = document.getElementById('dateSelect').value;
      const nextParams = new URLSearchParams();
      if (siteId) nextParams.set('siteId', siteId);
      if (date) nextParams.set('date', date);
      if (urlHash) nextParams.set('urlHash', urlHash);
      const nextUrl = window.location.pathname + (nextParams.toString() ? '?' + nextParams.toString() : '');
      window.history.replaceState({}, '', nextUrl);
    }

    document.getElementById('saveTokenBtn').addEventListener('click', function() {
      adminToken = tokenInput.value.trim();
      if (adminToken) {
        localStorage.setItem(tokenStorageKey, adminToken);
        updateAuthStatus();
        loadSites();
      }
    });

    document.getElementById('clearTokenBtn').addEventListener('click', function() {
      adminToken = '';
      tokenInput.value = '';
      localStorage.removeItem(tokenStorageKey);
      updateAuthStatus();
    });

    document.getElementById('viewAll').addEventListener('click', function() { setView('all'); });
    document.getElementById('viewContent').addEventListener('click', function() { setView('content'); });
    document.getElementById('viewStyle').addEventListener('click', function() { setView('style'); });
    document.getElementById('viewStructure').addEventListener('click', function() { setView('structure'); });
    document.getElementById('siteSelect').addEventListener('change', loadDates);
    document.getElementById('dateSelect').addEventListener('change', loadDiff);
    document.getElementById('changedOnlyToggle').addEventListener('change', function() {
      if (currentUrlDiff) renderSourceDiff(currentUrlDiff);
    });
    document.getElementById('openPreviewBtn').addEventListener('click', function() {
      if (currentUrlDiff) openPreview(currentUrlDiff.urlHash, currentUrlDiff.url);
    });

    document.getElementById('previewClose').addEventListener('click', closePreview);
    document.getElementById('previewPrevBtn').addEventListener('click', function() { switchPreviewVersion('previous'); });
    document.getElementById('previewCurrBtn').addEventListener('click', function() { switchPreviewVersion('current'); });
    document.getElementById('previewModal').addEventListener('click', function(event) {
      if (event.target.id === 'previewModal') closePreview();
    });

    function openPreview(urlHash, url) {
      currentPreviewHash = urlHash;
      currentPreviewUrl = url;
      previewVersion = 'current';
      document.getElementById('previewTitle').textContent = url;
      document.getElementById('previewPrevBtn').classList.remove('active');
      document.getElementById('previewCurrBtn').classList.add('active');
      document.getElementById('previewModal').classList.add('active');
      loadPreview();
    }

    function closePreview() {
      document.getElementById('previewModal').classList.remove('active');
      document.getElementById('previewFrame').src = 'about:blank';
    }

    function switchPreviewVersion(version) {
      previewVersion = version;
      document.getElementById('previewPrevBtn').classList.toggle('active', version === 'previous');
      document.getElementById('previewCurrBtn').classList.toggle('active', version === 'current');
      loadPreview();
    }

    function loadPreview() {
      if (!currentPreviewHash || !currentUrlDiff) return;
      const siteId = document.getElementById('siteSelect').value;
      let previewDate = currentUrlDiff.currentDate;
      if (previewVersion === 'previous') {
        previewDate = currentUrlDiff.previousDate;
      }

      const previewUrl = baseUrl + '/api/sites/' + encodeURIComponent(siteId) + '/preview/' + encodeURIComponent(previewDate) + '/' + encodeURIComponent(currentPreviewHash);
      fetch(previewUrl, {
        headers: getAuthHeaders()
      })
        .then(function(response) {
          if (!response.ok) {
            throw new Error('Failed to load preview');
          }
          return response.text();
        })
        .then(function(html) {
          document.getElementById('previewFrame').srcdoc = html;
        })
        .catch(function(error) {
          document.getElementById('previewFrame').srcdoc =
            '<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#991b1b;background:#fff7f7;"><p>' +
            escapeHtml(error.message) +
            '</p></body></html>';
        });
    }

    updateAuthStatus();
    resetContentPanels('Select a site and date to view changes.');
    loadSites();
  </script>
</body>
</html>`;

  return new Response(viewerHtml, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

async function serveBackupViewer(kv: KVNamespace): Promise<Response> {
  const viewerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Backup Viewer - Website Backup Monitor</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; height: 100vh; display: flex; flex-direction: column; }
    .header { background: white; padding: 15px 20px; border-bottom: 1px solid #e5e5e5; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
    .header h1 { font-size: 20px; margin-bottom: 10px; color: #1f2937; }
    .header-controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .nav-links { margin-left: auto; display: flex; gap: 10px; }
    .nav-links a { color: #0066cc; text-decoration: none; font-size: 14px; padding: 6px 12px; border-radius: 4px; }
    .nav-links a:hover { background: #f0f7ff; }
    select, button, input[type="text"] { padding: 8px 14px; border: 1px solid #d1d5db; border-radius: 6px; background: white; cursor: pointer; font-size: 14px; }
    select:hover, button:hover { border-color: #9ca3af; }
    select:focus, button:focus, input:focus { outline: none; border-color: #0066cc; box-shadow: 0 0 0 3px rgba(0,102,204,0.1); }
    button.active { background: #0066cc; color: white; border-color: #0066cc; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .main-content { display: flex; flex: 1; overflow: hidden; }
    .sidebar { width: 380px; background: white; border-right: 1px solid #e5e5e5; display: flex; flex-direction: column; }
    .sidebar-header { padding: 15px; border-bottom: 1px solid #e5e5e5; }
    .sidebar-header h2 { font-size: 14px; font-weight: 600; color: #374151; margin-bottom: 10px; }
    .search-row { display: flex; gap: 8px; margin-bottom: 10px; }
    .search-box { flex: 1; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; }
    .search-box:focus { outline: none; border-color: #0066cc; box-shadow: 0 0 0 3px rgba(0,102,204,0.1); }
    .sort-row { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
    .sort-row label { font-size: 12px; color: #6b7280; white-space: nowrap; }
    .sort-row select { padding: 6px 10px; font-size: 13px; flex: 1; }
    .url-stats { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #6b7280; }
    .url-count { font-weight: 500; }
    .url-list { flex: 1; overflow-y: auto; padding: 10px; }
    .url-item { padding: 12px; margin-bottom: 8px; border-radius: 8px; border: 1px solid #e5e7eb; cursor: pointer; transition: all 0.15s; }
    .url-item:hover { border-color: #d1d5db; background: #f9fafb; }
    .url-item.selected { background: #eff6ff; border-color: #3b82f6; }
    .url-item .url-path { font-size: 13px; font-weight: 500; color: #1f2937; word-break: break-all; margin-bottom: 6px; }
    .url-item .url-meta { display: flex; gap: 8px; flex-wrap: wrap; }
    .url-item .meta-badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: #f3f4f6; color: #6b7280; }
    .url-item .meta-badge.status-ok { background: #dcfce7; color: #166534; }
    .url-item .meta-badge.status-error { background: #fee2e2; color: #991b1b; }
    .pagination { display: flex; gap: 8px; justify-content: center; align-items: center; padding: 12px; border-top: 1px solid #e5e5e5; background: #fafafa; }
    .pagination button { padding: 6px 12px; font-size: 13px; }
    .pagination .page-info { font-size: 12px; color: #6b7280; }
    .content-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .content-header { padding: 15px 20px; background: white; border-bottom: 1px solid #e5e5e5; display: flex; align-items: center; gap: 15px; flex-wrap: wrap; }
    .content-header .url-display { flex: 1; font-size: 14px; color: #374151; word-break: break-all; min-width: 200px; }
    .view-toggle { display: flex; gap: 5px; }
    .view-toggle button { padding: 6px 12px; font-size: 13px; }
    .date-picker { display: flex; align-items: center; gap: 8px; }
    .date-picker label { font-size: 13px; color: #6b7280; }
    .date-picker select { padding: 6px 10px; font-size: 13px; }
    .content-body { flex: 1; overflow: hidden; position: relative; background: #fafafa; }
    .preview-frame { width: 100%; height: 100%; border: none; background: white; }
    .source-view { width: 100%; height: 100%; overflow: auto; padding: 20px; font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Consolas', monospace; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; background: #1e1e1e; color: #d4d4d4; display: none; }
    .source-view.active { display: block; }
    .preview-frame.hidden { display: none; }
    .metadata-bar { padding: 10px 20px; background: white; border-top: 1px solid #e5e5e5; display: flex; gap: 20px; flex-wrap: wrap; font-size: 12px; color: #6b7280; }
    .metadata-item { display: flex; align-items: center; gap: 5px; }
    .metadata-item strong { color: #374151; }
    .empty-state { display: flex; align-items: center; justify-content: center; height: 100%; color: #9ca3af; font-size: 14px; flex-direction: column; gap: 10px; }
    .empty-state svg { width: 48px; height: 48px; stroke: #d1d5db; }
    .loading { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #6b7280; font-size: 14px; }
    .loading-inline { text-align: center; padding: 20px; color: #6b7280; }
    .error-banner { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; padding: 12px 15px; margin: 10px; border-radius: 6px; font-size: 13px; }
    @media (max-width: 768px) {
      .main-content { flex-direction: column; }
      .sidebar { width: 100%; max-height: 50vh; }
      .content-header { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Backup Viewer</h1>
    <div class="header-controls">
      <select id="siteSelect">
        <option value="">Select a site...</option>
      </select>
      <div class="nav-links">
        <a href="/diff/viewer">Diff Viewer</a>
      </div>
    </div>
  </div>
  
  <div class="main-content">
    <div class="sidebar">
      <div class="sidebar-header">
        <h2>Backed Up URLs</h2>
        <div class="search-row">
          <input type="text" class="search-box" id="searchBox" placeholder="Search URLs...">
          <button id="searchBtn">Search</button>
        </div>
        <div class="sort-row">
          <label>Sort by:</label>
          <select id="sortSelect">
            <option value="url">URL (A-Z)</option>
            <option value="url-desc">URL (Z-A)</option>
            <option value="date-desc">Last Updated (Newest)</option>
            <option value="date">Last Updated (Oldest)</option>
            <option value="size-desc">Size (Largest)</option>
            <option value="size">Size (Smallest)</option>
            <option value="status">Status</option>
          </select>
        </div>
        <div class="url-stats">
          <span class="url-count" id="urlCount">Select a site to view URLs</span>
          <span id="showingCount"></span>
        </div>
      </div>
      <div class="url-list" id="urlList">
        <div class="empty-state">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
          <span>Select a site to view backed up pages</span>
        </div>
      </div>
      <div class="pagination" id="pagination" style="display: none;">
        <button id="prevBtn" disabled>Previous</button>
        <span class="page-info" id="pageInfo">Page 1</span>
        <button id="nextBtn">Next</button>
      </div>
    </div>
    
    <div class="content-area">
      <div class="content-header" id="contentHeader" style="display: none;">
        <div class="url-display" id="urlDisplay">No URL selected</div>
        <div class="view-toggle">
          <button id="viewRendered" class="active">Rendered</button>
          <button id="viewSource">Source</button>
        </div>
        <div class="date-picker">
          <label for="dateSelect">Version:</label>
          <select id="dateSelect">
            <option value="">Select date...</option>
          </select>
        </div>
      </div>
      
      <div class="content-body" id="contentBody">
        <div class="empty-state" id="emptyState">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.64 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.64 0-8.573-3.007-9.963-7.178z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span>Select a URL to view its backup</span>
        </div>
        <div class="loading" id="loading" style="display: none;">Loading...</div>
        <iframe class="preview-frame hidden" id="previewFrame" sandbox="allow-same-origin"></iframe>
        <pre class="source-view" id="sourceView"></pre>
      </div>
      
      <div class="metadata-bar" id="metadataBar" style="display: none;">
        <div class="metadata-item"><strong>Status:</strong> <span id="metaStatus">-</span></div>
        <div class="metadata-item"><strong>Size:</strong> <span id="metaSize">-</span></div>
        <div class="metadata-item"><strong>Content-Type:</strong> <span id="metaContentType">-</span></div>
        <div class="metadata-item"><strong>Timestamp:</strong> <span id="metaTimestamp">-</span></div>
      </div>
    </div>
  </div>
  
  <script>
    const baseUrl = window.location.origin;
    const PAGE_SIZE = 100;
    
    let currentUrls = [];
    let totalUrls = 0;
    let currentCursor = '0';
    let nextCursor = null;
    let cursorHistory = ['0'];
    let currentPage = 1;
    let selectedUrl = null;
    let selectedUrlHash = null;
    let currentView = 'rendered';
    let backupHistory = [];
    let searchTimeout = null;

    // Initialize event listeners
    document.getElementById('siteSelect').addEventListener('change', () => { resetPagination(); loadUrls(); });
    document.getElementById('searchBox').addEventListener('input', debounceSearch);
    document.getElementById('searchBox').addEventListener('keydown', (e) => { if (e.key === 'Enter') { resetPagination(); loadUrls(); } });
    document.getElementById('searchBtn').addEventListener('click', () => { resetPagination(); loadUrls(); });
    document.getElementById('sortSelect').addEventListener('change', () => { resetPagination(); loadUrls(); });
    document.getElementById('dateSelect').addEventListener('change', loadBackup);
    document.getElementById('viewRendered').addEventListener('click', () => setView('rendered'));
    document.getElementById('viewSource').addEventListener('click', () => setView('source'));
    document.getElementById('prevBtn').addEventListener('click', loadPrevPage);
    document.getElementById('nextBtn').addEventListener('click', loadNextPage);

    // Load sites on page load
    loadSites();

    // Check URL params for direct link
    const params = new URLSearchParams(window.location.search);
    if (params.get('siteId')) {
      setTimeout(() => {
        document.getElementById('siteSelect').value = params.get('siteId');
        loadUrls().then(() => {
          if (params.get('urlHash')) {
            const urlItem = currentUrls.find(u => u.urlHash === params.get('urlHash'));
            if (urlItem) {
              selectUrl(urlItem);
            }
          }
        });
      }, 300);
    }

    function debounceSearch() {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => { resetPagination(); loadUrls(); }, 300);
    }

    function resetPagination() {
      currentCursor = '0';
      nextCursor = null;
      cursorHistory = ['0'];
      currentPage = 1;
    }

    function getSortParams() {
      const sortValue = document.getElementById('sortSelect').value;
      const [sort, orderSuffix] = sortValue.includes('-desc') ? [sortValue.replace('-desc', ''), 'desc'] : [sortValue, 'asc'];
      return { sort, order: orderSuffix };
    }

    async function loadSites() {
      try {
        const response = await fetch(baseUrl + '/api/sites');
        const sites = await response.json();
        const select = document.getElementById('siteSelect');
        select.innerHTML = '<option value="">Select a site...</option>';
        for (const site of sites) {
          const option = document.createElement('option');
          option.value = site.id;
          option.textContent = site.name;
          select.appendChild(option);
        }
      } catch (error) {
        showError('Failed to load sites: ' + error.message);
      }
    }

    async function loadUrls() {
      const siteId = document.getElementById('siteSelect').value;
      if (!siteId) {
        currentUrls = [];
        totalUrls = 0;
        renderUrlList([]);
        document.getElementById('urlCount').textContent = 'Select a site to view URLs';
        document.getElementById('showingCount').textContent = '';
        document.getElementById('pagination').style.display = 'none';
        return;
      }

      updateUrlParams();
      document.getElementById('urlList').innerHTML = '<div class="loading-inline">Loading URLs...</div>';
      
      try {
        const search = document.getElementById('searchBox').value;
        const { sort, order } = getSortParams();
        
        let apiUrl = baseUrl + '/api/sites/' + siteId + '/urls?limit=' + PAGE_SIZE;
        apiUrl += '&cursor=' + currentCursor;
        apiUrl += '&sort=' + sort;
        apiUrl += '&order=' + order;
        if (search) apiUrl += '&search=' + encodeURIComponent(search);
        
        const response = await fetch(apiUrl);
        if (!response.ok) throw new Error('Failed to load URLs');
        
        const data = await response.json();
        currentUrls = data.urls;
        totalUrls = data.total;
        nextCursor = data.nextCursor;
        
        document.getElementById('urlCount').textContent = totalUrls.toLocaleString() + ' total URL' + (totalUrls !== 1 ? 's' : '');
        
        const startNum = parseInt(currentCursor) + 1;
        const endNum = Math.min(parseInt(currentCursor) + currentUrls.length, totalUrls);
        document.getElementById('showingCount').textContent = 'Showing ' + startNum + '-' + endNum;
        
        renderUrlList(currentUrls);
        updatePagination();
      } catch (error) {
        showError('Failed to load URLs: ' + error.message);
        document.getElementById('urlCount').textContent = 'Error loading URLs';
        document.getElementById('urlList').innerHTML = '<div class="empty-state"><span>Failed to load URLs</span></div>';
      }
    }

    function updatePagination() {
      const pagination = document.getElementById('pagination');
      const prevBtn = document.getElementById('prevBtn');
      const nextBtn = document.getElementById('nextBtn');
      const pageInfo = document.getElementById('pageInfo');
      
      if (totalUrls <= PAGE_SIZE) {
        pagination.style.display = 'none';
        return;
      }
      
      pagination.style.display = 'flex';
      prevBtn.disabled = currentPage === 1;
      nextBtn.disabled = !nextCursor;
      
      const totalPages = Math.ceil(totalUrls / PAGE_SIZE);
      pageInfo.textContent = 'Page ' + currentPage + ' of ' + totalPages;
    }

    function loadPrevPage() {
      if (currentPage <= 1) return;
      currentPage--;
      cursorHistory.pop();
      currentCursor = cursorHistory[cursorHistory.length - 1] || '0';
      loadUrls();
    }

    function loadNextPage() {
      if (!nextCursor) return;
      currentPage++;
      cursorHistory.push(nextCursor);
      currentCursor = nextCursor;
      loadUrls();
    }

    function renderUrlList(urls) {
      const container = document.getElementById('urlList');
      
      if (urls.length === 0) {
        container.innerHTML = '<div class="empty-state"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg><span>No URLs found</span></div>';
        return;
      }

      container.innerHTML = urls.map(u => {
        const statusClass = u.latestStatus >= 200 && u.latestStatus < 400 ? 'status-ok' : 'status-error';
        const isSelected = selectedUrlHash === u.urlHash ? 'selected' : '';
        return '<div class="url-item ' + isSelected + '" data-hash="' + u.urlHash + '" data-url="' + escapeHtml(u.url) + '">' +
          '<div class="url-path">' + escapeHtml(getDisplayUrl(u.url)) + '</div>' +
          '<div class="url-meta">' +
            '<span class="meta-badge ' + statusClass + '">' + u.latestStatus + '</span>' +
            '<span class="meta-badge">' + formatBytes(u.latestSize) + '</span>' +
            '<span class="meta-badge">' + u.latestDate + '</span>' +
          '</div>' +
        '</div>';
      }).join('');

      // Add click handlers
      container.querySelectorAll('.url-item').forEach(item => {
        item.addEventListener('click', () => {
          const urlData = urls.find(u => u.urlHash === item.dataset.hash);
          if (urlData) selectUrl(urlData);
        });
      });
    }

    async function selectUrl(urlData) {
      selectedUrl = urlData.url;
      selectedUrlHash = urlData.urlHash;
      
      // Update UI selection
      document.querySelectorAll('.url-item').forEach(el => el.classList.remove('selected'));
      const selectedEl = document.querySelector('.url-item[data-hash="' + urlData.urlHash + '"]');
      if (selectedEl) selectedEl.classList.add('selected');

      // Show content area
      document.getElementById('contentHeader').style.display = 'flex';
      document.getElementById('metadataBar').style.display = 'flex';
      document.getElementById('emptyState').style.display = 'none';
      document.getElementById('urlDisplay').textContent = urlData.url;

      updateUrlParams();

      // Load backup history for this URL
      await loadBackupHistory(urlData.urlHash);
    }

    async function loadBackupHistory(urlHash) {
      const siteId = document.getElementById('siteSelect').value;
      showLoading(true);

      try {
        const response = await fetch(baseUrl + '/api/sites/' + siteId + '/backup/' + urlHash + '/history');
        if (!response.ok) throw new Error('Failed to load backup history');
        backupHistory = await response.json();

        const dateSelect = document.getElementById('dateSelect');
        dateSelect.innerHTML = backupHistory.map((h, i) => {
          const label = h.date + (i === 0 ? ' (latest)' : '');
          return '<option value="' + h.date + '">' + label + '</option>';
        }).join('');

        // Load the latest backup
        if (backupHistory.length > 0) {
          await loadBackup();
        }
      } catch (error) {
        showError('Failed to load backup history: ' + error.message);
      } finally {
        showLoading(false);
      }
    }

    async function loadBackup() {
      const siteId = document.getElementById('siteSelect').value;
      const date = document.getElementById('dateSelect').value;
      if (!siteId || !date || !selectedUrlHash) return;

      showLoading(true);

      try {
        // Update metadata from history
        const historyItem = backupHistory.find(h => h.date === date);
        if (historyItem) {
          document.getElementById('metaStatus').textContent = historyItem.status;
          document.getElementById('metaSize').textContent = formatBytes(historyItem.size);
          document.getElementById('metaContentType').textContent = historyItem.contentType;
          document.getElementById('metaTimestamp').textContent = new Date(historyItem.timestamp).toLocaleString();
        }

        if (currentView === 'rendered') {
          await loadRenderedPreview(siteId, date, selectedUrlHash);
        } else {
          await loadSourceView(siteId, date, selectedUrlHash);
        }
      } catch (error) {
        showError('Failed to load backup: ' + error.message);
      } finally {
        showLoading(false);
      }
    }

    async function loadRenderedPreview(siteId, date, urlHash) {
      const previewUrl = baseUrl + '/api/sites/' + siteId + '/preview/' + date + '/' + urlHash;
      document.getElementById('previewFrame').src = previewUrl;
      document.getElementById('previewFrame').classList.remove('hidden');
      document.getElementById('sourceView').classList.remove('active');
    }

    async function loadSourceView(siteId, date, urlHash) {
      try {
        const response = await fetch(baseUrl + '/api/sites/' + siteId + '/backup/' + date + '/' + urlHash + '/source');
        if (!response.ok) throw new Error('Failed to load source');
        const source = await response.text();
        document.getElementById('sourceView').textContent = source;
        document.getElementById('sourceView').classList.add('active');
        document.getElementById('previewFrame').classList.add('hidden');
      } catch (error) {
        showError('Failed to load source: ' + error.message);
      }
    }

    function setView(view) {
      currentView = view;
      document.getElementById('viewRendered').classList.toggle('active', view === 'rendered');
      document.getElementById('viewSource').classList.toggle('active', view === 'source');
      
      if (selectedUrlHash) {
        loadBackup();
      }
    }

    function showLoading(show) {
      document.getElementById('loading').style.display = show ? 'block' : 'none';
    }

    function showError(message) {
      const container = document.getElementById('urlList');
      const existing = container.querySelector('.error-banner');
      if (existing) existing.remove();
      
      const errorEl = document.createElement('div');
      errorEl.className = 'error-banner';
      errorEl.textContent = message;
      container.insertBefore(errorEl, container.firstChild);
      
      setTimeout(() => errorEl.remove(), 5000);
    }

    function updateUrlParams() {
      const siteId = document.getElementById('siteSelect').value;
      const params = new URLSearchParams();
      if (siteId) params.set('siteId', siteId);
      if (selectedUrlHash) params.set('urlHash', selectedUrlHash);
      const newUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
      window.history.replaceState({}, '', newUrl);
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text || '';
      return div.innerHTML;
    }

    function getDisplayUrl(url) {
      try {
        const u = new URL(url);
        return u.pathname + u.search;
      } catch {
        return url;
      }
    }

    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }
  </script>
</body>
</html>`;

  return new Response(viewerHtml, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}