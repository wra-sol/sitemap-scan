import { requireApiAuth } from './http/auth';
import { applyRateLimit } from './http/rate-limit';
import { jsonResponse } from './http/responses';
import { SiteManager } from './sites/manager';
import { SlackNotifier } from './slack/notifier';
import { SiteRegistry } from './sites/registry';
import { matchesCronExpression } from './scheduler/cron';
import { SiteConfig, SiteBackupResult, MAX_SITE_BATCH_SIZE } from './types/site';
import { executeSiteBackupRun } from './runtime/site-execution';
import {
  handleGetRequest,
  handlePostRequest,
  handlePutRequest,
  handleDeleteRequest,
} from './http/routes';
import type { Env } from './types/env';

export { type Env };

export default {
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log(`Scheduled event triggered: ${event.cron}`);

    const siteManager = new SiteManager(env.BACKUP_KV);
    const slackNotifier = new SlackNotifier(env.BACKUP_KV, env.DEFAULT_SLACK_WEBHOOK, env.PUBLIC_BASE_URL);

    try {
      const sites = await siteManager.getAllSiteConfigs();
      const now = new Date();
      const dueSites = sites.filter((site) => matchesCronExpression(site.schedule, now));
      console.log(`Processing ${dueSites.length} scheduled site(s) out of ${sites.length} configured...`);

      if (dueSites.length === 0) {
        return;
      }

      let successful = 0;
      let failed = 0;
      const summaryResults: Array<{ siteConfig: SiteConfig; backupResult: SiteBackupResult }> = [];

      for (const site of dueSites) {
        try {
          console.log(`Backing up: ${site.name} (${site.id})`);

          const execution = await executeSiteBackupRun(env, site, {
            trigger: 'scheduled',
            continueFromLast: true,
            batchSize: site.batchSize ?? MAX_SITE_BATCH_SIZE
          });

          if (execution.runRecord.status === 'failed' || execution.runRecord.status === 'partial') {
            failed++;
          } else {
            successful++;
          }

          summaryResults.push({
            siteConfig: site,
            backupResult: execution.siteBackupResult
          });

          console.log(
            `${site.name}: ${execution.runRecord.processedUrls}/${execution.siteBackupResult.totalUrls} URLs processed, ` +
            `${execution.siteBackupResult.changedUrls.length} changes, status ${execution.runRecord.status}`
          );
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

      if (summaryResults.length > 1) {
        await slackNotifier.sendSummaryNotification(
          new Date().toISOString().split('T')[0],
          summaryResults
        );
      }

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

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const rateLimitResponse = await applyRateLimit(request, env);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

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
          return await handleDeleteRequest(url, env.BACKUP_KV, siteManager);

        default:
          return jsonResponse({ error: 'Method not allowed' }, 405);
      }
    } catch (error) {
      console.error('API request failed:', error);
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }
};