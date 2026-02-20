import { SchedulerDispatcher } from './scheduler/dispatcher';
import { SiteManager } from './sites/manager';
import { SlackNotifier } from './slack/notifier';
import { SiteRegistry } from './sites/registry';
import { SiteConfig, SiteBackupResult } from './types/site';
import { DiffGenerator } from './diff/generator';
import { ContentComparer } from './diff/comparer';

export interface Env {
  BACKUP_KV: KVNamespace;
  DEFAULT_SLACK_WEBHOOK?: string;
  PUBLIC_BASE_URL?: string;
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`Scheduled event triggered: ${event.cron}`);
    
    const siteManager = new SiteManager(env.BACKUP_KV);
    const slackNotifier = new SlackNotifier(env.BACKUP_KV, env.DEFAULT_SLACK_WEBHOOK, env.PUBLIC_BASE_URL);

    try {
      // Get all configured sites and back them up
      const sites = await siteManager.getAllSiteConfigs();
      console.log(`Processing ${sites.length} sites...`);
      
      const backupModule = await import('./backup/fetcher');
      const fetcher = new backupModule.BackupFetcher(env.BACKUP_KV);
      
      let successful = 0;
      let failed = 0;
      
      for (const site of sites) {
        try {
          console.log(`Backing up: ${site.name} (${site.id})`);
          
          // Use batched backup with continuation support
          // First, check if there's an existing batch in progress
          // Batch size of 25: tested to work reliably within subrequest limits
          let result = await fetcher.performSiteBackup(site, { 
            continueFromLast: true,
            batchSize: 25  // Tested safe batch size under subrequest limit
          });
          
          let totalSuccessful = result.successfulBackups;
          let totalFailed = result.failedBackups;
          let allChangedUrls = [...result.changedUrls];
          
          // Continue processing batches until complete (up to a reasonable limit per cron run)
          // Each batch is fresh Worker invocation for subrequest quota, so we can do more
          // But we need to be mindful of total execution time (30s limit for cron)
          let batchCount = 1;
          const maxBatchesPerRun = 1; // Only 1 batch per site per cron - subrequests don't reset between batches
          
          while (result.hasMore && batchCount < maxBatchesPerRun) {
            console.log(`${site.name}: Continuing batch ${batchCount + 1}, progress: ${result.progress.percentComplete}%`);
            result = await fetcher.performSiteBackup(site, { continueFromLast: true, batchSize: 25 });
            totalSuccessful += result.successfulBackups;
            totalFailed += result.failedBackups;
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

    try {
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
          ? new Response(JSON.stringify(siteConfig))
          : new Response('Site not found', { status: 404 });
      } else {
        const allSites = await siteManager.getAllSiteConfigs();
        return new Response(JSON.stringify(allSites));
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
      const dispatcher = new SchedulerDispatcher(siteRegistry['kv']);
      const status = await dispatcher.getSchedulerStatus();
      return new Response(JSON.stringify(status));
    
    case '/api/test':
      const webhookUrl = url.searchParams.get('webhook');
      const testResult = await siteRegistry.validateAllSites();
      return new Response(JSON.stringify(testResult));
    
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
        return new Response(
          JSON.stringify({ error: 'Invalid configuration', details: validationResult.errors }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      
      const saved = await siteManager.saveSiteConfig(body);
      if (!saved) {
        return new Response('Failed to save site configuration', { status: 500 });
      }
      
      const dispatcher = new SchedulerDispatcher(env.BACKUP_KV);
      await dispatcher.addSiteToScheduler(body);
      
      return new Response(
        JSON.stringify({ success: true, siteId: body.id }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    
    case '/api/slack/test':
      const slackBody = await request.json() as { webhook?: string };
      const testSuccess = await slackNotifier.sendTestNotification(slackBody.webhook);
      return new Response(
        JSON.stringify({ success: testSuccess }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    
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
      
      const { BackupFetcher } = await import('./backup/fetcher');
      const fetcher = new BackupFetcher(env.BACKUP_KV);
      const backupResult = await fetcher.performSiteBackup(siteConfig, {
        batchSize: triggerBody.batchSize,
        batchOffset: triggerBody.batchOffset,
        continueFromLast: triggerBody.continueFromLast
      });
      
      const siteBackupResult: SiteBackupResult = {
        siteId: siteConfig.id,
        siteName: siteConfig.name,
        totalUrls: backupResult.totalUrls,
        successfulBackups: backupResult.successfulBackups,
        failedBackups: backupResult.failedBackups,
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
      
      return new Response(
        JSON.stringify(responsePayload),
        { headers: { 'Content-Type': 'application/json' } }
      );
    
    case '/api/backup/progress':
      const progressBody = await request.json() as { siteId: string };
      const { BackupFetcher: BF } = await import('./backup/fetcher');
      const progressFetcher = new BF(env.BACKUP_KV);
      const progress = await progressFetcher.getBatchProgress(progressBody.siteId);
      
      return new Response(
        JSON.stringify(progress || { hasMore: false, message: 'No batch in progress' }),
        { headers: { 'Content-Type': 'application/json' } }
      );

    case '/api/backup/reset':
      const resetBody = await request.json() as { siteId: string };
      const resetSiteConfig = await siteManager.getSiteConfig(resetBody.siteId);
      if (!resetSiteConfig) {
        return new Response('Site not found', { status: 404 });
      }
      const { BackupFetcher: ResetFetcher } = await import('./backup/fetcher');
      const resetFetcher = new ResetFetcher(env.BACKUP_KV);
      await resetFetcher.resetSiteProgress(resetBody.siteId);
      return new Response(
        JSON.stringify({ success: true, message: 'Batch progress and URL cache cleared for site' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    
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
      JSON.stringify(diff),
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
  // Inline the diff viewer HTML
  const viewerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Diff Viewer - Website Backup Monitor</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    .header { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
    .header h1 { font-size: 24px; margin-bottom: 10px; }
    .controls { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 20px; }
    .control-group { display: flex; gap: 5px; align-items: center; }
    button, select { padding: 8px 16px; border: 1px solid #ddd; border-radius: 4px; background: white; cursor: pointer; font-size: 14px; }
    button:hover, select:hover { background: #f0f0f0; }
    button.active { background: #0066cc; color: white; border-color: #0066cc; }
    .summary { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; }
    .summary-item { text-align: center; }
    .summary-item .value { font-size: 24px; font-weight: bold; color: #0066cc; }
    .summary-item .label { font-size: 12px; color: #666; margin-top: 5px; }
    .diff-container { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); overflow: hidden; padding: 20px; }
    .changes-list { list-style: none; }
    .change-item { padding: 15px; margin-bottom: 12px; border-radius: 8px; border-left: 4px solid transparent; background: #fafafa; }
    .change-item.content { border-left-color: #0066cc; }
    .change-item.style { border-left-color: #f97316; }
    .change-item.structure { border-left-color: #22c55e; }
    .change-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    .change-element { font-weight: 600; font-size: 14px; color: #333; }
    .change-type { font-size: 11px; padding: 3px 8px; border-radius: 4px; font-weight: 600; text-transform: uppercase; }
    .change-type.added { background: #dcfce7; color: #166534; }
    .change-type.removed { background: #fee2e2; color: #991b1b; }
    .change-type.modified { background: #fef9c3; color: #854d0e; }
    .change-content { font-size: 14px; line-height: 1.6; }
    .diff-row { display: grid; grid-template-columns: 80px 1fr; gap: 10px; margin-bottom: 8px; align-items: start; }
    .diff-label { font-size: 11px; font-weight: 600; text-transform: uppercase; padding: 4px 8px; border-radius: 4px; text-align: center; }
    .diff-label.before { background: #fee2e2; color: #991b1b; }
    .diff-label.after { background: #dcfce7; color: #166534; }
    .diff-value { font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace; font-size: 13px; padding: 8px 12px; border-radius: 4px; word-break: break-word; }
    .diff-value.before { background: #fef2f2; color: #7f1d1d; }
    .diff-value.after { background: #f0fdf4; color: #14532d; }
    .change-context { font-size: 12px; color: #666; margin-top: 10px; padding-top: 10px; border-top: 1px solid #e5e5e5; }
    .empty-state { text-align: center; padding: 40px; color: #999; }
    .loading { text-align: center; padding: 40px; }
    .error { background: #fee2e2; color: #991b1b; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
    .sidebar { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
    .url-list { max-height: 300px; overflow-y: auto; }
    .url-item { padding: 10px; cursor: pointer; border-radius: 6px; margin-bottom: 6px; font-size: 13px; word-break: break-all; border: 1px solid #eee; }
    .url-item:hover { background: #f0f0f0; border-color: #ddd; }
    .url-item.selected { background: #0066cc; color: white; border-color: #0066cc; }
    .url-item.selected .badge { background: rgba(255,255,255,0.3); }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin-left: 5px; font-weight: 500; }
    .badge-content { background: #dbeafe; color: #1e40af; }
    .badge-style { background: #ffedd5; color: #c2410c; }
    .badge-structure { background: #dcfce7; color: #166534; }
    .url-item.selected .badge-content, .url-item.selected .badge-style, .url-item.selected .badge-structure { background: rgba(255,255,255,0.3); color: white; }
    .preview-btn { background: #6366f1; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .preview-btn:hover { background: #4f46e5; }
    .preview-modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 1000; }
    .preview-modal.active { display: flex; flex-direction: column; }
    .preview-header { background: #1f2937; color: white; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; }
    .preview-header h3 { font-size: 14px; font-weight: 500; }
    .preview-tabs { display: flex; gap: 10px; }
    .preview-tab { background: transparent; border: 1px solid #4b5563; color: #9ca3af; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .preview-tab:hover { border-color: #6b7280; color: white; }
    .preview-tab.active { background: #3b82f6; border-color: #3b82f6; color: white; }
    .preview-close { background: #ef4444; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
    .preview-close:hover { background: #dc2626; }
    .preview-content { flex: 1; background: white; }
    .preview-content iframe { width: 100%; height: 100%; border: none; }
    @media (max-width: 768px) { .controls { flex-direction: column; } .diff-row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 id="pageTitle">Diff Viewer</h1>
      <div id="pageInfo"></div>
    </div>
    <div class="controls">
      <div class="control-group">
        <select id="siteSelect"><option value="">Select Site...</option></select>
        <select id="dateSelect"><option value="">Select Date...</option></select>
      </div>
      <div class="control-group">
        <button id="viewAll" class="active">All Changes</button>
        <button id="viewContent">Content</button>
        <button id="viewStyle">Style</button>
        <button id="viewStructure">Structure</button>
      </div>
    </div>
    <div class="sidebar">
      <h3>Changed URLs</h3>
      <div class="url-list" id="urlList"><div class="empty-state">Select a site and date to view changes</div></div>
    </div>
    <div class="summary" id="summary" style="display: none;">
      <div class="summary-item"><div class="value" id="totalChanges">0</div><div class="label">Total Changes</div></div>
      <div class="summary-item"><div class="value" id="contentChanges">0</div><div class="label">Content Changes</div></div>
      <div class="summary-item"><div class="value" id="styleChanges">0</div><div class="label">Style Changes</div></div>
      <div class="summary-item"><div class="value" id="structureChanges">0</div><div class="label">Structure Changes</div></div>
    </div>
    <div class="diff-container" id="diffContainer" style="display: none;">
      <div id="changesContent"></div>
    </div>
    <div id="loading" class="loading" style="display: none;">Loading...</div>
    <div id="error" class="error" style="display: none;"></div>
  </div>
  <div class="preview-modal" id="previewModal">
    <div class="preview-header">
      <h3 id="previewTitle">Preview</h3>
      <div class="preview-tabs">
        <button class="preview-tab active" id="previewPrevBtn">Previous Version</button>
        <button class="preview-tab" id="previewCurrBtn">Current Version</button>
      </div>
      <button class="preview-close" id="previewClose">Close</button>
    </div>
    <div class="preview-content">
      <iframe id="previewFrame" sandbox="allow-same-origin"></iframe>
    </div>
  </div>
  <script>
    let currentDiff = null, currentUrlDiff = null, currentView = 'all';
    const baseUrl = window.location.origin;

    document.getElementById('viewAll').addEventListener('click', () => setView('all'));
    document.getElementById('viewContent').addEventListener('click', () => setView('content'));
    document.getElementById('viewStyle').addEventListener('click', () => setView('style'));
    document.getElementById('viewStructure').addEventListener('click', () => setView('structure'));
    document.getElementById('siteSelect').addEventListener('change', loadDates);
    document.getElementById('dateSelect').addEventListener('change', loadDiff);

    // Check URL params for direct link
    const params = new URLSearchParams(window.location.search);
    if (params.get('siteId') && params.get('date')) {
      setTimeout(() => {
        document.getElementById('siteSelect').value = params.get('siteId');
        loadDates().then(() => {
          document.getElementById('dateSelect').value = params.get('date');
          loadDiff();
        });
      }, 500);
    }

    async function loadSites() {
      try {
        const response = await fetch(baseUrl + '/api/sites');
        const sites = await response.json();
        const select = document.getElementById('siteSelect');
        select.innerHTML = '<option value="">Select Site...</option>';
        for (const site of sites) {
          const option = document.createElement('option');
          option.value = site.id;
          option.textContent = site.name;
          select.appendChild(option);
        }
      } catch (error) { showError('Failed to load sites: ' + error.message); }
    }

    async function loadDates() {
      const siteId = document.getElementById('siteSelect').value;
      if (!siteId) return;
      updateUrlParams();
      try {
        const response = await fetch(baseUrl + '/api/sites/dates?siteId=' + siteId);
        const dates = await response.json();
        const select = document.getElementById('dateSelect');
        select.innerHTML = '<option value="">Select Date...</option>';
        for (const date of dates) {
          const option = document.createElement('option');
          option.value = date;
          option.textContent = date;
          select.appendChild(option);
        }
      } catch (error) { showError('Failed to load dates: ' + error.message); }
    }

    async function loadDiff() {
      const siteId = document.getElementById('siteSelect').value;
      const date = document.getElementById('dateSelect').value;
      if (!siteId || !date) return;
      updateUrlParams();
      showLoading(true);
      try {
        const response = await fetch(baseUrl + '/api/sites/' + siteId + '/diff/' + date);
        if (!response.ok) throw new Error('Failed to load diff');
        currentDiff = await response.json();
        renderUrlList();
        renderSummary();
        if (currentDiff.urls.length > 0) {
          await selectUrl(currentDiff.urls[0].urlHash);
        } else {
          document.getElementById('leftContent').innerHTML = '<div class="empty-state">No changes detected</div>';
          document.getElementById('rightContent').innerHTML = '<div class="empty-state">No changes detected</div>';
        }
        document.getElementById('summary').style.display = 'grid';
        document.getElementById('diffContainer').style.display = 'grid';
      } catch (error) { showError('Failed to load diff: ' + error.message); } 
      finally { showLoading(false); }
    }

    async function selectUrl(urlHash) {
      if (!currentDiff) return;
      showLoading(true);
      try {
        const siteId = document.getElementById('siteSelect').value;
        const date = document.getElementById('dateSelect').value;
        const response = await fetch(baseUrl + '/api/sites/' + siteId + '/diff/' + date + '/url/' + urlHash);
        if (!response.ok) throw new Error('Failed to load URL diff');
        currentUrlDiff = await response.json();
        renderUrlDiff(currentUrlDiff);
      } catch (error) { showError('Failed to load URL diff: ' + error.message); } 
      finally { showLoading(false); }
    }

    function renderUrlList() {
      const container = document.getElementById('urlList');
      container.innerHTML = '';
      for (const urlData of currentDiff.urls) {
        const div = document.createElement('div');
        div.className = 'url-item';
        div.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(urlData.url) + '</span>' +
          '<button class="preview-btn" data-hash="' + urlData.urlHash + '" data-url="' + escapeHtml(urlData.url) + '">Preview</button>' +
          '</div><div style="margin-top:5px;">' +
          (urlData.contentChanges > 0 ? '<span class="badge badge-content">' + urlData.contentChanges + ' content</span>' : '') +
          (urlData.styleChanges > 0 ? '<span class="badge badge-style">' + urlData.styleChanges + ' style</span>' : '') +
          (urlData.structureChanges > 0 ? '<span class="badge badge-structure">' + urlData.structureChanges + ' structure</span>' : '') +
          (urlData.contentChanges === 0 && urlData.styleChanges === 0 && urlData.structureChanges === 0 ? '<span class="badge" style="background:#e5e7eb;color:#6b7280;">no changes</span>' : '') +
          '</div>';
        div.addEventListener('click', (e) => {
          if (e.target.classList.contains('preview-btn')) return;
          document.querySelectorAll('.url-item').forEach(el => el.classList.remove('selected'));
          div.classList.add('selected');
          selectUrl(urlData.urlHash);
        });
        const previewBtn = div.querySelector('.preview-btn');
        previewBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openPreview(urlData.urlHash, urlData.url);
        });
        container.appendChild(div);
      }
      if (container.firstChild) container.firstChild.classList.add('selected');
    }

    function renderUrlDiff(urlDiff) {
      const classification = urlDiff.classification;
      const filteredChanges = getFilteredChanges(classification);
      document.getElementById('changesContent').innerHTML = renderChanges(filteredChanges);
      document.getElementById('pageTitle').textContent = 'Changes for ' + urlDiff.url;
      document.getElementById('pageInfo').textContent = 'Comparing ' + urlDiff.date + ' to previous backup';
    }

    function getFilteredChanges(classification) {
      if (currentView === 'all') return classification;
      return {
        content: currentView === 'content' ? classification.content : [],
        style: currentView === 'style' ? classification.style : [],
        structure: currentView === 'structure' ? classification.structure : []
      };
    }

    function renderChanges(classification) {
      const changes = [
        ...classification.content.map(c => ({ ...c, category: 'content' })),
        ...classification.style.map(c => ({ ...c, category: 'style' })),
        ...classification.structure.map(c => ({ ...c, category: 'structure' }))
      ];
      if (changes.length === 0) return '<div class="empty-state">No changes detected</div>';
      return '<div class="changes-list">' + changes.map(change => {
        let contentHtml = '';
        if (change.before) {
          contentHtml += '<div class="diff-row"><span class="diff-label before">Before</span><div class="diff-value before">' + escapeHtml(change.before) + '</div></div>';
        }
        if (change.after) {
          contentHtml += '<div class="diff-row"><span class="diff-label after">After</span><div class="diff-value after">' + escapeHtml(change.after) + '</div></div>';
        }
        return '<div class="change-item ' + change.category + '">' +
          '<div class="change-header">' +
            '<span class="change-element">' + escapeHtml(change.element) + '</span>' +
            '<span class="change-type ' + change.change + '">' + change.change + '</span>' +
          '</div>' +
          '<div class="change-content">' + contentHtml + '</div>' +
          (change.context ? '<div class="change-context">' + escapeHtml(change.context) + '</div>' : '') +
        '</div>';
      }).join('') + '</div>';
    }

    function renderSummary() {
      const totals = currentDiff.urls.reduce((acc, u) => ({
        content: acc.content + u.contentChanges,
        style: acc.style + u.styleChanges,
        structure: acc.structure + u.structureChanges
      }), { content: 0, style: 0, structure: 0 });
      document.getElementById('totalChanges').textContent = totals.content + totals.style + totals.structure;
      document.getElementById('contentChanges').textContent = totals.content;
      document.getElementById('styleChanges').textContent = totals.style;
      document.getElementById('structureChanges').textContent = totals.structure;
    }

    function setView(view) {
      currentView = view;
      document.querySelectorAll('#viewAll, #viewContent, #viewStyle, #viewStructure').forEach(btn => btn.classList.remove('active'));
      document.getElementById('view' + view.charAt(0).toUpperCase() + view.slice(1)).classList.add('active');
      if (currentUrlDiff) renderUrlDiff(currentUrlDiff);
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text || '';
      return div.innerHTML;
    }

    function showLoading(show) {
      document.getElementById('loading').style.display = show ? 'block' : 'none';
      document.getElementById('diffContainer').style.display = show ? 'none' : (currentDiff ? 'grid' : 'none');
    }

    function showError(message) {
      document.getElementById('error').textContent = message;
      document.getElementById('error').style.display = 'block';
      setTimeout(() => { document.getElementById('error').style.display = 'none'; }, 5000);
    }

    function updateUrlParams() {
      const siteId = document.getElementById('siteSelect').value;
      const date = document.getElementById('dateSelect').value;
      const params = new URLSearchParams();
      if (siteId) params.set('siteId', siteId);
      if (date) params.set('date', date);
      const newUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
      window.history.replaceState({}, '', newUrl);
    }

    // Preview functionality
    let currentPreviewHash = null;
    let currentPreviewUrl = null;
    let previewVersion = 'current';

    document.getElementById('previewClose').addEventListener('click', closePreview);
    document.getElementById('previewPrevBtn').addEventListener('click', () => switchPreviewVersion('previous'));
    document.getElementById('previewCurrBtn').addEventListener('click', () => switchPreviewVersion('current'));
    document.getElementById('previewModal').addEventListener('click', (e) => {
      if (e.target.id === 'previewModal') closePreview();
    });

    async function openPreview(urlHash, url) {
      currentPreviewHash = urlHash;
      currentPreviewUrl = url;
      previewVersion = 'current';
      document.getElementById('previewTitle').textContent = url;
      document.getElementById('previewPrevBtn').classList.remove('active');
      document.getElementById('previewCurrBtn').classList.add('active');
      document.getElementById('previewModal').classList.add('active');
      await loadPreview();
    }

    function closePreview() {
      document.getElementById('previewModal').classList.remove('active');
      document.getElementById('previewFrame').src = 'about:blank';
    }

    async function switchPreviewVersion(version) {
      previewVersion = version;
      document.getElementById('previewPrevBtn').classList.toggle('active', version === 'previous');
      document.getElementById('previewCurrBtn').classList.toggle('active', version === 'current');
      await loadPreview();
    }

    async function loadPreview() {
      const siteId = document.getElementById('siteSelect').value;
      const date = document.getElementById('dateSelect').value;
      let previewDate = date;
      
      if (previewVersion === 'previous') {
        // Get the previous date from dates list
        const dates = Array.from(document.getElementById('dateSelect').options).map(o => o.value).filter(v => v);
        const currentIndex = dates.indexOf(date);
        if (currentIndex < dates.length - 1) {
          previewDate = dates[currentIndex + 1];
        } else {
          document.getElementById('previewFrame').srcdoc = '<html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#666;"><p>No previous version available</p></body></html>';
          return;
        }
      }
      
      const previewUrl = baseUrl + '/api/sites/' + siteId + '/preview/' + previewDate + '/' + currentPreviewHash;
      document.getElementById('previewFrame').src = previewUrl;
    }

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