import { ScheduledJob, SiteConfig } from '../types/site';

export class JobQueue {
  private kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async enqueueJob(job: ScheduledJob): Promise<boolean> {
    try {
      const queueKey = 'scheduler:queue';
      const queueData = await this.kv.get(queueKey);
      
      const queue: ScheduledJob[] = queueData ? JSON.parse(queueData) : [];
      
      const existingIndex = queue.findIndex(j => j.siteId === job.siteId);
      if (existingIndex >= 0) {
        queue[existingIndex] = job;
      } else {
        queue.push(job);
      }
      
      queue.sort((a, b) => a.priority - b.priority);
      
      await this.kv.put(queueKey, JSON.stringify(queue));
      return true;
    } catch (error) {
      console.error('Failed to enqueue job:', error);
      return false;
    }
  }

  async dequeueJobs(schedule: string): Promise<ScheduledJob[]> {
    try {
      const queueKey = 'scheduler:queue';
      const queueData = await this.kv.get(queueKey);
      
      if (!queueData) {
        return [];
      }

      let queue: ScheduledJob[] = JSON.parse(queueData);
      const now = new Date().toISOString();
      
      const jobsToRun = queue.filter(job => 
        job.schedule === schedule && job.nextRun <= now
      );
      
      queue = queue.filter(job => 
        !(job.schedule === schedule && job.nextRun <= now)
      );
      
      await this.kv.put(queueKey, JSON.stringify(queue));
      
      return jobsToRun;
    } catch (error) {
      console.error('Failed to dequeue jobs:', error);
      return [];
    }
  }

  async getQueueStatus(): Promise<{ totalJobs: number; upcomingJobs: ScheduledJob[] }> {
    try {
      const queueData = await this.kv.get('scheduler:queue');
      if (!queueData) {
        return { totalJobs: 0, upcomingJobs: [] };
      }

      const queue: ScheduledJob[] = JSON.parse(queueData);
      const upcomingJobs = queue
        .sort((a, b) => new Date(a.nextRun).getTime() - new Date(b.nextRun).getTime())
        .slice(0, 10);

      return {
        totalJobs: queue.length,
        upcomingJobs
      };
    } catch (error) {
      console.error('Failed to get queue status:', error);
      return { totalJobs: 0, upcomingJobs: [] };
    }
  }

  async clearQueue(): Promise<boolean> {
    try {
      await this.kv.delete('scheduler:queue');
      return true;
    } catch (error) {
      console.error('Failed to clear queue:', error);
      return false;
    }
  }

  async requeueFailedJob(job: ScheduledJob, delayMinutes: number = 30): Promise<boolean> {
    const retryTime = new Date();
    retryTime.setMinutes(retryTime.getMinutes() + delayMinutes);
    
    job.nextRun = retryTime.toISOString();
    job.priority = Math.max(1, job.priority - 1);
    
    return this.enqueueJob(job);
  }

  async getJobsForSite(siteId: string): Promise<ScheduledJob[]> {
    try {
      const queueData = await this.kv.get('scheduler:queue');
      if (!queueData) {
        return [];
      }

      const queue: ScheduledJob[] = JSON.parse(queueData);
      return queue.filter(job => job.siteId === siteId);
    } catch (error) {
      console.error(`Failed to get jobs for site ${siteId}:`, error);
      return [];
    }
  }

  async markJobCompleted(job: ScheduledJob): Promise<boolean> {
    try {
      const jobKey = `job:${job.siteId}:${Date.now()}`;
      const jobData = {
        ...job,
        completedAt: new Date().toISOString(),
        status: 'completed'
      };
      
      await this.kv.put(jobKey, JSON.stringify(jobData));
      
      const nextRun = this.calculateNextRun(job.schedule);
      const nextJob: ScheduledJob = {
        siteId: job.siteId,
        schedule: job.schedule,
        nextRun,
        priority: job.priority
      };
      
      return this.enqueueJob(nextJob);
    } catch (error) {
      console.error('Failed to mark job completed:', error);
      return false;
    }
  }

  private calculateNextRun(cronExpression: string): string {
    const parts = cronExpression.split(' ');
    const now = new Date();
    
    const nextRun = new Date(now);
    nextRun.setDate(nextRun.getDate() + 1);
    
    return nextRun.toISOString();
  }

  async getJobHistory(siteId: string, limit: number = 50): Promise<any[]> {
    try {
      const list = await this.kv.list({
        prefix: `job:${siteId}:`,
        limit
      });

      const jobs = [];
      for (const key of list.keys.reverse()) {
        const jobData = await this.kv.get(key.name);
        if (jobData) {
          jobs.push(JSON.parse(jobData));
        }
      }

      return jobs;
    } catch (error) {
      console.error(`Failed to get job history for ${siteId}:`, error);
      return [];
    }
  }
}