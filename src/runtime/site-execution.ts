import { BackupFetcher } from '../backup/fetcher';
import { SlackNotifier, SlackDeliveryResult } from '../slack/notifier';
import { SiteBackupResult, SiteConfig } from '../types/site';
import { RunStore, SiteRunRecord, SiteRunTrigger, SiteRunStatus } from './run-store';

interface ExecutionEnv {
  BACKUP_KV: KVNamespace;
  DEFAULT_SLACK_WEBHOOK?: string;
  PUBLIC_BASE_URL?: string;
}

interface ExecuteSiteBackupRunOptions {
  trigger: SiteRunTrigger;
  batchSize?: number;
  batchOffset?: number;
  continueFromLast?: boolean;
}

export interface ExecuteSiteBackupRunResult {
  siteBackupResult: SiteBackupResult;
  runRecord: SiteRunRecord;
  notification: SlackDeliveryResult;
}

function summarizeRun(status: SiteRunStatus, result: SiteBackupResult, hasMore: boolean): string {
  if (status === 'noop') {
    return 'No backup work was required for this run.';
  }

  const fragments = [
    `${result.successfulBackups}/${result.totalUrls} URLs succeeded`,
    `${result.changedUrls.length} changed`
  ];

  if (result.failedBackups > 0) {
    fragments.push(`${result.failedBackups} failed`);
  }

  if (result.failedStores > 0) {
    fragments.push(`${result.failedStores} store failures`);
  }

  if (hasMore) {
    fragments.push('more batches pending');
  }

  return fragments.join(', ') + '.';
}

function mapRunStatus(result: SiteBackupResult, hasMore: boolean): SiteRunStatus {
  const processedUrls = result.successfulBackups + result.failedBackups;

  if (processedUrls === 0 && result.changedUrls.length === 0 && !hasMore) {
    return 'noop';
  }

  if (result.failedBackups > 0 || result.failedStores > 0) {
    return result.successfulBackups > 0 || result.changedUrls.length > 0 ? 'partial' : 'failed';
  }

  return 'success';
}

export async function executeSiteBackupRun(
  env: ExecutionEnv,
  siteConfig: SiteConfig,
  options: ExecuteSiteBackupRunOptions
): Promise<ExecuteSiteBackupRunResult> {
  const runStore = new RunStore(env.BACKUP_KV);
  const fetcher = new BackupFetcher(env.BACKUP_KV);
  const slackNotifier = new SlackNotifier(env.BACKUP_KV, env.DEFAULT_SLACK_WEBHOOK, env.PUBLIC_BASE_URL);
  const runRecord = await runStore.startRun(siteConfig, options.trigger);

  try {
    const backupResult = await fetcher.performSiteBackup(siteConfig, {
      batchSize: options.batchSize,
      batchOffset: options.batchOffset,
      continueFromLast: options.continueFromLast
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

    let notification: SlackDeliveryResult = {
      attempted: false,
      delivered: false,
      channel: 'change'
    };

    if (backupResult.changedUrls.length > 0) {
      notification = await slackNotifier.sendChangeNotificationWithDetails(siteConfig, siteBackupResult);
    }

    const status = mapRunStatus(siteBackupResult, backupResult.hasMore);
    const completedRecord: SiteRunRecord = {
      ...runRecord,
      status,
      finishedAt: new Date().toISOString(),
      executionTimeMs: backupResult.executionTime,
      totalUrls: siteBackupResult.totalUrls,
      processedUrls: siteBackupResult.successfulBackups + siteBackupResult.failedBackups,
      successfulBackups: siteBackupResult.successfulBackups,
      failedBackups: siteBackupResult.failedBackups,
      storedBackups: siteBackupResult.storedBackups,
      failedStores: siteBackupResult.failedStores,
      changedUrls: siteBackupResult.changedUrls,
      changedUrlCount: siteBackupResult.changedUrls.length,
      hasMore: backupResult.hasMore,
      progress: backupResult.progress,
      errors: siteBackupResult.errors,
      notification: {
        attempted: notification.attempted,
        delivered: notification.delivered,
        throttled: notification.throttled,
        channel: notification.channel,
        message: notification.message,
        deliveredAt: notification.deliveredAt
      },
      summary: summarizeRun(status, siteBackupResult, backupResult.hasMore)
    };

    await runStore.saveRun(completedRecord);

    return {
      siteBackupResult,
      runRecord: completedRecord,
      notification
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const notification = await slackNotifier.sendErrorNotificationWithDetails(
      siteConfig,
      message,
      { trigger: options.trigger }
    );

    const failedRecord: SiteRunRecord = {
      ...runRecord,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      totalUrls: 0,
      processedUrls: 0,
      successfulBackups: 0,
      failedBackups: 0,
      storedBackups: 0,
      failedStores: 0,
      changedUrls: [],
      changedUrlCount: 0,
      hasMore: false,
      errors: [message],
      notification: {
        attempted: notification.attempted,
        delivered: notification.delivered,
        throttled: notification.throttled,
        channel: notification.channel,
        message: notification.message,
        deliveredAt: notification.deliveredAt
      },
      summary: `Run failed: ${message}`
    };

    await runStore.saveRun(failedRecord);
    throw error;
  }
}
