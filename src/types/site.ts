export interface SiteConfig {
  id: string;
  name: string;
  baseUrl: string;
  sitemapUrl?: string;
  urls?: string[];
  retentionDays: number;
  schedule: string;
  slackWebhook?: string;
  fetchOptions: {
    timeout: number;
    retries: number;
    concurrency: number;
  };
  changeThreshold: {
    minChangeSize?: number;
    ignorePatterns?: string[];
  };
  // URL patterns to exclude from backup (regex patterns)
  // Default excludes common i18n paths: /fr/, /en/, /es/, etc.
  excludePatterns?: string[];
}

export interface BackupMetadata {
  url: string;
  timestamp: string;
  hash: string;
  /**
   * Hash of normalized content (dynamic noise removed).
   * Used for change detection to reduce false positives.
   */
  normalizedHash?: string;
  status: number;
  contentType: string;
  etag?: string;
  size: number;
  fetchTime: number;
  redirectCount?: number;
}

export interface BackupResult {
  url: string;
  success: boolean;
  metadata?: BackupMetadata;
  content?: string;
  error?: string;
}

export interface SiteBackupResult {
  siteId: string;
  siteName: string;
  totalUrls: number;
  successfulBackups: number;
  failedBackups: number;
  changedUrls: string[];
  executionTime: number;
  errors: string[];
  results: BackupResult[];
}

export interface DiffResult {
  url: string;
  hasChanged: boolean;
  previousHash?: string;
  currentHash?: string;
  changeSize: number;
  changeType: 'content' | 'status' | 'metadata';
}

export interface SlackMessage {
  siteName: string;
  date: string;
  totalChanged: number;
  totalUrls: number;
  failedCount: number;
  executionTime: number;
  changes: Array<{
    url: string;
    type: string;
  }>;
  dashboardLink?: string;
}

export interface ScheduledJob {
  siteId: string;
  schedule: string;
  lastRun?: string;
  nextRun: string;
  priority: number;
}

export interface ExecutionStats {
  siteId: string;
  date: string;
  startTime: string;
  endTime: string;
  totalUrls: number;
  successCount: number;
  failureCount: number;
  changedCount: number;
  cpuTime: number;
  subrequestsUsed: number;
  errors: string[];
}