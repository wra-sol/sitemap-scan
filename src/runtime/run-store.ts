import { SiteConfig } from '../types/site';
import { KVListResult } from './kv-types';

export type SiteRunTrigger = 'scheduled' | 'manual';
export type SiteRunStatus = 'running' | 'success' | 'partial' | 'failed' | 'noop';

export interface SiteRunNotification {
  attempted: boolean;
  delivered: boolean;
  throttled?: boolean;
  channel: 'change' | 'error' | 'summary';
  message?: string;
  deliveredAt?: string;
}

export interface SiteRunRecord {
  runId: string;
  siteId: string;
  siteName: string;
  trigger: SiteRunTrigger;
  status: SiteRunStatus;
  startedAt: string;
  finishedAt?: string;
  executionTimeMs?: number;
  totalUrls: number;
  processedUrls: number;
  successfulBackups: number;
  failedBackups: number;
  storedBackups: number;
  failedStores: number;
  changedUrls: string[];
  changedUrlCount: number;
  hasMore: boolean;
  progress?: {
    completed: number;
    total: number;
    percentComplete: number;
  };
  errors: string[];
  summary: string;
  notification?: SiteRunNotification;
}

function buildRunId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildStatusKey(siteId: string): string {
  return `run:latest:${siteId}`;
}

function buildSiteLogKey(siteId: string, startedAt: string, runId: string): string {
  return `run_site:${siteId}:${startedAt}:${runId}`;
}

function buildGlobalLogKey(startedAt: string, siteId: string, runId: string): string {
  return `run_log:${startedAt}:${siteId}:${runId}`;
}

export class RunStore {
  private kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async startRun(siteConfig: SiteConfig, trigger: SiteRunTrigger): Promise<SiteRunRecord> {
    const startedAt = new Date().toISOString();
    const record: SiteRunRecord = {
      runId: buildRunId(),
      siteId: siteConfig.id,
      siteName: siteConfig.name,
      trigger,
      status: 'running',
      startedAt,
      totalUrls: 0,
      processedUrls: 0,
      successfulBackups: 0,
      failedBackups: 0,
      storedBackups: 0,
      failedStores: 0,
      changedUrls: [],
      changedUrlCount: 0,
      hasMore: false,
      errors: [],
      summary: trigger === 'manual' ? 'Manual run started.' : 'Scheduled run started.'
    };

    await this.persistRecord(record);
    return record;
  }

  async saveRun(record: SiteRunRecord): Promise<void> {
    await this.persistRecord(record);
  }

  async getLatestRun(siteId: string): Promise<SiteRunRecord | null> {
    const raw = await this.kv.get(buildStatusKey(siteId), 'text');
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as SiteRunRecord;
    } catch (error) {
      console.error(`Failed to parse latest run for ${siteId}:`, error);
      return null;
    }
  }

  async listRecentRuns(limit: number = 25, siteId?: string): Promise<SiteRunRecord[]> {
    const prefix = siteId ? `run_site:${siteId}:` : 'run_log:';
    let cursor: string | undefined;
    const allKeys: string[] = [];

    // Phase 1 — collect key names only (no KV value reads during listing).
    // KV list returns keys in lexicographic order; since run keys embed an
    // ISO timestamp, ascending lexicographic order equals chronological order.
    do {
      const list = await this.kv.list({
        prefix,
        limit: 1000,
        cursor
      }) as KVListResult;

      allKeys.push(...list.keys.map((key) => key.name));
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);

    // Phase 2 — sort descending (newest first) and keep only the top `limit`
    // keys. Sorting key strings is far cheaper than fetching values from KV.
    const targetKeys = allKeys
      .sort((left, right) => right.localeCompare(left))
      .slice(0, limit);

    // Phase 3 — fetch values only for the keys we will actually return.
    const records: SiteRunRecord[] = [];
    for (const key of targetKeys) {
      const raw = await this.kv.get(key, 'text');
      if (!raw) {
        continue;
      }

      try {
        records.push(JSON.parse(raw) as SiteRunRecord);
      } catch (error) {
        console.error(`Failed to parse run record ${key}:`, error);
      }
    }

    return records;
  }

  private async persistRecord(record: SiteRunRecord): Promise<void> {
    const payload = JSON.stringify(record);
    const statusKey = buildStatusKey(record.siteId);
    const siteLogKey = buildSiteLogKey(record.siteId, record.startedAt, record.runId);
    const globalLogKey = buildGlobalLogKey(record.startedAt, record.siteId, record.runId);

    await Promise.all([
      this.kv.put(statusKey, payload),
      this.kv.put(siteLogKey, payload),
      this.kv.put(globalLogKey, payload)
    ]);
  }
}
