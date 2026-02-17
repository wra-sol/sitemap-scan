import { SiteConfig, SiteBackupResult } from '../types/site';
import { JobQueue } from './queue';
import { SiteManager } from '../sites/manager';

export class SchedulerDispatcher {
  private jobQueue: JobQueue;
  private siteManager: SiteManager;
  private kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
    this.jobQueue = new JobQueue(kv);
    this.siteManager = new SiteManager(kv);
  }

  async initializeScheduler(): Promise<boolean> {
    try {
      const sites = await this.siteManager.getAllSiteConfigs();
      
      for (const site of sites) {
        const nextRun = this.calculateNextRun(site.schedule);
        
        await this.jobQueue.enqueueJob({
          siteId: site.id,
          schedule: site.schedule,
          nextRun,
          priority: this.calculatePriority(site.schedule)
        });
      }

      console.log(`Scheduler initialized with ${sites.length} sites`);
      return true;
    } catch (error) {
      console.error('Failed to initialize scheduler:', error);
      return false;
    }
  }

  async processScheduledJobs(schedule: string): Promise<{ processed: number; successful: number; failed: number }> {
    const jobs = await this.jobQueue.dequeueJobs(schedule);
    if (jobs.length === 0) {
      return { processed: 0, successful: 0, failed: 0 };
    }

    console.log(`Processing ${jobs.length} jobs for schedule: ${schedule}`);

    let successful = 0;
    let failed = 0;

    for (const job of jobs) {
      try {
        const success = await this.executeJob(job);
        if (success) {
          successful++;
          await this.jobQueue.markJobCompleted(job);
        } else {
          failed++;
          await this.jobQueue.requeueFailedJob(job, 60);
        }
      } catch (error) {
        console.error(`Job execution failed for site ${job.siteId}:`, error);
        failed++;
        await this.jobQueue.requeueFailedJob(job, 60);
      }
    }

    console.log(`Job processing complete: ${successful} successful, ${failed} failed`);
    return { processed: jobs.length, successful, failed };
  }

  private async executeJob(job: { siteId: string; schedule: string }): Promise<boolean> {
    const siteConfig = await this.siteManager.getSiteConfig(job.siteId);
    if (!siteConfig) {
      console.error(`Site configuration not found: ${job.siteId}`);
      return false;
    }

    const startTime = new Date().toISOString();
    
    try {
      const stats = await this.recordJobStart(job.siteId, startTime);
      
      console.log(`Starting backup job for site: ${siteConfig.name} (${siteConfig.id})`);
      
      const backupModule = await import('../backup/fetcher');
      const fetcher = new backupModule.BackupFetcher(this.kv);
      
      const result = await fetcher.performSiteBackup(siteConfig);
      
      await this.recordJobComplete(job.siteId, startTime, result);
      
      if (result.changedUrls.length > 0) {
        const siteBackupResult: SiteBackupResult = {
          ...result,
          siteId: siteConfig.id,
          siteName: siteConfig.name
        };
        
        const slackModule = await import('../slack/notifier');
        const notifier = new slackModule.SlackNotifier(this.kv);
        await notifier.sendChangeNotification(siteConfig, siteBackupResult);
      }
      
      return result.failedBackups === 0;
    } catch (error) {
      console.error(`Backup job execution failed for ${job.siteId}:`, error);
      await this.recordJobError(job.siteId, startTime, error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private async recordJobStart(siteId: string, startTime: string): Promise<any> {
    const statsKey = `stats:${siteId}:${new Date(startTime).toISOString().split('T')[0]}`;
    const stats = {
      siteId,
      date: new Date(startTime).toISOString().split('T')[0],
      startTime,
      endTime: null,
      totalUrls: 0,
      successCount: 0,
      failureCount: 0,
      changedCount: 0,
      cpuTime: 0,
      subrequestsUsed: 0,
      errors: []
    };
    
    await this.kv.put(statsKey, JSON.stringify(stats));
    return stats;
  }

  private async recordJobComplete(siteId: string, startTime: string, result: any): Promise<void> {
    const statsKey = `stats:${siteId}:${new Date(startTime).toISOString().split('T')[0]}`;
    const existingStats = await this.kv.get(statsKey);
    
    if (existingStats) {
      const stats = JSON.parse(existingStats);
      stats.endTime = new Date().toISOString();
      stats.totalUrls = result.totalUrls;
      stats.successCount = result.successfulBackups;
      stats.failureCount = result.failedBackups;
      stats.changedCount = result.changedUrls.length;
      
      await this.kv.put(statsKey, JSON.stringify(stats));
    }
  }

  private async recordJobError(siteId: string, startTime: string, error: any): Promise<void> {
    const statsKey = `stats:${siteId}:${new Date(startTime).toISOString().split('T')[0]}`;
    const existingStats = await this.kv.get(statsKey);
    
    if (existingStats) {
      const stats = JSON.parse(existingStats);
      stats.endTime = new Date().toISOString();
      stats.errors.push(error.message || String(error));
      
      await this.kv.put(statsKey, JSON.stringify(stats));
    }
  }

  async addSiteToScheduler(siteConfig: SiteConfig): Promise<boolean> {
    try {
      const nextRun = this.calculateNextRun(siteConfig.schedule);
      
      return this.jobQueue.enqueueJob({
        siteId: siteConfig.id,
        schedule: siteConfig.schedule,
        nextRun,
        priority: this.calculatePriority(siteConfig.schedule)
      });
    } catch (error) {
      console.error(`Failed to add site ${siteConfig.id} to scheduler:`, error);
      return false;
    }
  }

  async removeSiteFromScheduler(siteId: string): Promise<boolean> {
    try {
      const jobs = await this.jobQueue.getJobsForSite(siteId);
      let removed = 0;
      
      for (const job of jobs) {
        const success = await this.jobQueue.requeueFailedJob(job, 365 * 24 * 60);
        if (success) removed++;
      }
      
      return removed > 0;
    } catch (error) {
      console.error(`Failed to remove site ${siteId} from scheduler:`, error);
      return false;
    }
  }

  private calculateNextRun(cronExpression: string): string {
    const parts = cronExpression.split(' ');
    const now = new Date();
    
    const nextRun = new Date(now);
    
    const minute = parseInt(parts[0]) || 0;
    const hour = parseInt(parts[1]) || 0;
    
    nextRun.setMinutes(minute);
    nextRun.setHours(hour);
    
    if (nextRun <= now) {
      nextRun.setDate(nextRun.getDate() + 1);
    }
    
    return nextRun.toISOString();
  }

  private calculatePriority(schedule: string): number {
    const parts = schedule.split(' ');
    const hour = parseInt(parts[1]) || 0;
    
    if (hour >= 0 && hour < 6) return 3;
    if (hour >= 6 && hour < 12) return 1;
    if (hour >= 12 && hour < 18) return 2;
    return 1;
  }

  async getSchedulerStatus(): Promise<any> {
    const queueStatus = await this.jobQueue.getQueueStatus();
    const sites = await this.siteManager.getAllSiteConfigs();
    
    return {
      totalSites: sites.length,
      queuedJobs: queueStatus.totalJobs,
      upcomingJobs: queueStatus.upcomingJobs,
      schedules: [...new Set(sites.map(site => site.schedule))]
    };
  }
}