import { SiteConfig, BackupResult, BackupMetadata } from '../types/site';
import { FetchResult } from '../types/backup';
import { ContentComparer } from '../diff/comparer';

export interface BatchOptions {
  batchSize?: number;      // Max URLs to process in this batch (default: 500, max recommended: 800)
  batchOffset?: number;    // Starting index for this batch
  continueFromLast?: boolean; // Continue from last saved progress
}

export interface BatchedBackupResult {
  totalUrls: number;
  processedInBatch: number;
  successfulBackups: number;
  failedBackups: number;
  changedUrls: string[];
  executionTime: number;
  errors: string[];
  results: BackupResult[];
  // Batch info
  batchOffset: number;
  batchSize: number;
  hasMore: boolean;
  nextOffset: number | null;
  progress: {
    completed: number;
    total: number;
    percentComplete: number;
  };
}

export class BackupFetcher {
  private kv: KVNamespace;
  // Cloudflare Workers have a 1000 subrequest limit per invocation
  // Each URL requires: 1 fetch + ~4 KV operations (get latest, put content, put meta, put latest)
  // Plus detect changes needs additional KV reads
  // Testing showed 25 URLs works reliably; 30+ can hit limits
  private static readonly DEFAULT_BATCH_SIZE = 25;
  private static readonly MAX_BATCH_SIZE = 30; // Proven safe limit

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async performSiteBackup(
    siteConfig: SiteConfig, 
    batchOptions?: BatchOptions
  ): Promise<BatchedBackupResult> {
    const startTime = Date.now();
    const today = new Date().toISOString().split('T')[0];
    
    // Determine batch parameters
    let batchOffset = batchOptions?.batchOffset ?? 0;
    const batchSize = Math.min(
      batchOptions?.batchSize ?? BackupFetcher.DEFAULT_BATCH_SIZE,
      BackupFetcher.MAX_BATCH_SIZE
    );

    // If continueFromLast, load saved progress
    let hadSavedProgress = false;
    if (batchOptions?.continueFromLast) {
      const progress = await this.loadBatchProgress(siteConfig.id);
      if (progress && progress.nextOffset !== null) {
        batchOffset = progress.nextOffset;
        hadSavedProgress = true;
      }
    }

    // If there is no saved progress and we're at the start of a cycle, avoid re-scanning
    // the same site repeatedly. We run frequently to complete large sites within a day.
    if (batchOptions?.continueFromLast && !hadSavedProgress && batchOffset === 0) {
      const fullScan = await this.getFullScanState(siteConfig.id);
      if (fullScan?.date === today) {
        // For sitemap-driven sites, only re-run if the sitemap changed.
        if (siteConfig.sitemapUrl) {
          const changed = await this.hasSitemapChanged(siteConfig.id, siteConfig.sitemapUrl);
          if (!changed) {
            return this.buildNoopResult(startTime);
          }
        } else {
          // For explicit URL lists, default to once-per-day.
          return this.buildNoopResult(startTime);
        }
      }
    }

    // Get all URLs (this can be expensive for large sitemaps; we only do it when we intend to work)
    const allUrls = await this.getUrlsToBackup(siteConfig);
    const totalUrls = allUrls.length;

    // Slice URLs for this batch
    const batchUrls = allUrls.slice(batchOffset, batchOffset + batchSize);
    const processedInBatch = batchUrls.length;
    
    console.log(`Starting batch backup for ${siteConfig.name} - URLs ${batchOffset + 1} to ${batchOffset + processedInBatch} of ${totalUrls}`);

    if (batchUrls.length === 0) {
      // No more URLs to process
      await this.clearBatchProgress(siteConfig.id);
      await this.setFullScanState(siteConfig.id, {
        date: today,
        completedAt: new Date().toISOString(),
        totalUrls
      });
      return {
        totalUrls,
        processedInBatch: 0,
        successfulBackups: 0,
        failedBackups: 0,
        changedUrls: [],
        executionTime: Date.now() - startTime,
        errors: [],
        results: [],
        batchOffset,
        batchSize,
        hasMore: false,
        nextOffset: null,
        progress: {
          completed: totalUrls,
          total: totalUrls,
          percentComplete: 100
        }
      };
    }

    const results = await this.fetchUrlsWithConcurrency(
      batchUrls, 
      siteConfig.fetchOptions,
      siteConfig.changeThreshold?.ignorePatterns
    );

    const successfulResults = results.filter(r => r.success);
    const failedResults = results.filter(r => !r.success);

    const changedUrls = await this.detectChanges(
      siteConfig.id, 
      successfulResults
    );

    await this.storeBackups(siteConfig.id, successfulResults);
    
    // Only cleanup on first batch to avoid repeated cleanup
    if (batchOffset === 0) {
      await this.cleanupOldBackups(siteConfig.id, siteConfig.retentionDays);
    }

    const executionTime = Date.now() - startTime;
    const errors = failedResults.map(r => r.error || 'Unknown error');

    // Calculate next batch info
    const nextOffset = batchOffset + processedInBatch;
    const hasMore = nextOffset < totalUrls;
    const completed = Math.min(nextOffset, totalUrls);
    const percentComplete = Math.round((completed / totalUrls) * 100);

    // Save batch progress for continuation
    if (hasMore) {
      await this.saveBatchProgress(siteConfig.id, {
        nextOffset,
        totalUrls,
        lastRunTime: new Date().toISOString()
      });
    } else {
      await this.clearBatchProgress(siteConfig.id);
      await this.setFullScanState(siteConfig.id, {
        date: today,
        completedAt: new Date().toISOString(),
        totalUrls
      });
    }

    console.log(`Batch completed for ${siteConfig.name}: ${successfulResults.length}/${processedInBatch} successful, ${changedUrls.length} changed. Progress: ${percentComplete}%`);

    return {
      totalUrls,
      processedInBatch,
      successfulBackups: successfulResults.length,
      failedBackups: failedResults.length,
      changedUrls,
      executionTime,
      errors,
      results,
      batchOffset,
      batchSize,
      hasMore,
      nextOffset: hasMore ? nextOffset : null,
      progress: {
        completed,
        total: totalUrls,
        percentComplete
      }
    };
  }

  private buildNoopResult(startTime: number): BatchedBackupResult {
    return {
      totalUrls: 0,
      processedInBatch: 0,
      successfulBackups: 0,
      failedBackups: 0,
      changedUrls: [],
      executionTime: Date.now() - startTime,
      errors: [],
      results: [],
      batchOffset: 0,
      batchSize: 0,
      hasMore: false,
      nextOffset: null,
      progress: {
        completed: 0,
        total: 0,
        percentComplete: 100
      }
    };
  }

  private async saveBatchProgress(siteId: string, progress: { nextOffset: number; totalUrls: number; lastRunTime: string }): Promise<void> {
    const key = `batch_progress:${siteId}`;
    await this.kv.put(key, JSON.stringify(progress), { expirationTtl: 86400 }); // 24 hour TTL
  }

  private async loadBatchProgress(siteId: string): Promise<{ nextOffset: number; totalUrls: number; lastRunTime: string } | null> {
    const key = `batch_progress:${siteId}`;
    const data = await this.kv.get(key);
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  private async clearBatchProgress(siteId: string): Promise<void> {
    const key = `batch_progress:${siteId}`;
    await this.kv.delete(key);
  }

  async getBatchProgress(siteId: string): Promise<{ nextOffset: number; totalUrls: number; lastRunTime: string; hasMore: boolean } | null> {
    const progress = await this.loadBatchProgress(siteId);
    if (!progress) return null;
    return {
      ...progress,
      hasMore: progress.nextOffset < progress.totalUrls
    };
  }

  private async getUrlsToBackup(siteConfig: SiteConfig): Promise<string[]> {
    let urls: string[];
    
    if (siteConfig.urls && siteConfig.urls.length > 0) {
      urls = siteConfig.urls;
    } else if (siteConfig.sitemapUrl) {
      urls = await this.parseSitemap(siteConfig.id, siteConfig.sitemapUrl);
    } else {
      urls = [siteConfig.baseUrl];
    }

    // Apply exclusion patterns (default: exclude common i18n paths)
    const excludePatterns = siteConfig.excludePatterns ?? [
      '^.*/fr/.*$',   // French
      '^.*/en/.*$',   // English (if site has explicit /en/ paths)
      '^.*/es/.*$',   // Spanish
      '^.*/de/.*$',   // German
      '^.*/it/.*$',   // Italian
      '^.*/pt/.*$',   // Portuguese
      '^.*/zh/.*$',   // Chinese
      '^.*/ja/.*$',   // Japanese
      '^.*/ko/.*$',   // Korean
      '^.*/ar/.*$',   // Arabic
      '^.*/ru/.*$',   // Russian
    ];

    if (excludePatterns.length > 0) {
      const excludeRegexes = excludePatterns.map(pattern => {
        try {
          return new RegExp(pattern, 'i');
        } catch (e) {
          console.error(`Invalid exclude pattern: ${pattern}`);
          return null;
        }
      }).filter(Boolean) as RegExp[];

      const beforeCount = urls.length;
      urls = urls.filter(url => !excludeRegexes.some(regex => regex.test(url)));
      const excludedCount = beforeCount - urls.length;
      
      if (excludedCount > 0) {
        console.log(`Excluded ${excludedCount} URLs matching i18n/exclude patterns`);
      }
    }

    return urls;
  }

  private async parseSitemap(siteId: string, sitemapUrl: string): Promise<string[]> {
    try {
      const response = await fetch(sitemapUrl, {
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        throw new Error(`Sitemap fetch failed: ${response.status}`);
      }

      const xmlText = await response.text();
      // Persist sitemap state for change detection.
      await this.recordSitemapState(siteId, response, xmlText);
      const { XMLParser } = await import('fast-xml-parser');
      
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_'
      });

      const result = parser.parse(xmlText);
      
      if (result.urlset && result.urlset.url) {
        const urls = Array.isArray(result.urlset.url) ? result.urlset.url : [result.urlset.url];
        return urls.map((item: any) => item.loc).filter(Boolean);
      }

      if (result.sitemapindex && result.sitemapindex.sitemap) {
        const sitemaps = Array.isArray(result.sitemapindex.sitemap) ? result.sitemapindex.sitemap : [result.sitemapindex.sitemap];
        const allUrls: string[] = [];
        
        for (const sitemap of sitemaps) {
          try {
            const subUrls = await this.parseSitemap(siteId, sitemap.loc);
            allUrls.push(...subUrls);
          } catch (error) {
            console.error(`Failed to parse sub-sitemap ${sitemap.loc}:`, error);
          }
        }
        
        return allUrls;
      }

      return [];
    } catch (error) {
      console.error(`Failed to parse sitemap ${sitemapUrl}:`, error);
      return [];
    }
  }

  private async hasSitemapChanged(siteId: string, sitemapUrl: string): Promise<boolean> {
    try {
      const stateKey = `sitemap_state:${siteId}`;
      const existingRaw = await this.kv.get(stateKey);
      const existing = existingRaw ? JSON.parse(existingRaw) as { etag?: string; lastModified?: string; contentHash?: string } : {};

      const headers: Record<string, string> = {};
      if (existing.etag) headers['If-None-Match'] = existing.etag;
      if (existing.lastModified) headers['If-Modified-Since'] = existing.lastModified;

      const response = await fetch(sitemapUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10000)
      });

      if (response.status === 304) {
        return false;
      }

      if (!response.ok) {
        // If we can't verify, assume it changed so we don't miss updates.
        console.warn(`Sitemap check failed (${response.status}); assuming changed`);
        return true;
      }

      const xmlText = await response.text();
      const newHash = await this.calculateHash(xmlText);

      // If we don't have ETag/Last-Modified support, fall back to content hash comparison.
      if (!existing.etag && !existing.lastModified && existing.contentHash && existing.contentHash === newHash) {
        // Refresh checkedAt timestamp
        await this.kv.put(stateKey, JSON.stringify({
          ...existing,
          checkedAt: new Date().toISOString()
        }), { expirationTtl: 7 * 24 * 3600 });
        return false;
      }

      await this.recordSitemapState(siteId, response, xmlText);
      return true;
    } catch (error) {
      console.warn('Failed to check sitemap change; assuming changed', error);
      return true;
    }
  }

  private async recordSitemapState(siteId: string, response: Response, xmlText: string): Promise<void> {
    try {
      const etag = response.headers.get('etag') || undefined;
      const lastModified = response.headers.get('last-modified') || undefined;
      const contentHash = await this.calculateHash(xmlText);
      const key = `sitemap_state:${siteId}`;
      await this.kv.put(key, JSON.stringify({
        etag,
        lastModified,
        contentHash,
        checkedAt: new Date().toISOString()
      }), { expirationTtl: 7 * 24 * 3600 });
    } catch {
      // ignore
    }
  }

  private async getFullScanState(siteId: string): Promise<{ date: string; completedAt: string; totalUrls: number } | null> {
    try {
      const raw = await this.kv.get(`full_scan:${siteId}`);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private async setFullScanState(siteId: string, state: { date: string; completedAt: string; totalUrls: number }): Promise<void> {
    try {
      await this.kv.put(`full_scan:${siteId}`, JSON.stringify(state), { expirationTtl: 14 * 24 * 3600 });
    } catch {
      // ignore
    }
  }

  private async fetchUrlsWithConcurrency(
    urls: string[], 
    options: SiteConfig['fetchOptions'],
    ignorePatterns?: string[]
  ): Promise<BackupResult[]> {
    const results: BackupResult[] = [];
    // Limit concurrency to 5 to avoid subrequest exhaustion
    const concurrency = Math.min(options.concurrency, 5);

    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency);
      const batchPromises = batch.map(url => 
        this.fetchUrlWithRetries(url, options, ignorePatterns)
          .catch(error => ({
            url,
            success: false,
            error: error.message || String(error)
          }))
      );

      const batchResults = await Promise.allSettled(batchPromises);
      
      for (const promiseResult of batchResults) {
        if (promiseResult.status === 'fulfilled') {
          results.push(promiseResult.value);
        } else {
          results.push({
            url: 'unknown',
            success: false,
            error: 'Batch processing failed'
          });
        }
      }
    }

    return results;
  }

  private async fetchUrlWithRetries(
    url: string, 
    options: SiteConfig['fetchOptions'],
    ignorePatterns?: string[]
  ): Promise<BackupResult> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= options.retries; attempt++) {
      try {
        const fetchResult = await this.performFetch(url, options);
        
        const metadata: BackupMetadata = {
          url: fetchResult.url,
          timestamp: new Date().toISOString(),
          hash: await this.calculateHash(fetchResult.content),
          normalizedHash: await ContentComparer.calculateNormalizedHash(fetchResult.content, ignorePatterns),
          status: fetchResult.status,
          contentType: fetchResult.headers['content-type'] || 'unknown',
          etag: fetchResult.headers.etag,
          size: fetchResult.content.length,
          fetchTime: fetchResult.fetchTime,
          redirectCount: fetchResult.redirectCount
        };

        return {
          url: fetchResult.url,
          success: true,
          metadata,
          content: fetchResult.content
        };

      } catch (error) {
        lastError = error as Error;
        
        if (attempt < options.retries) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    return {
      url,
      success: false,
      error: lastError?.message || 'Unknown error'
    };
  }

  private async performFetch(url: string, options: SiteConfig['fetchOptions']): Promise<FetchResult> {
    const startTime = Date.now();
    let redirectCount = 0;
    let currentUrl = url;
    let finalUrl = url;

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout>;
    const clearMyTimeout = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
    
    timeoutId = setTimeout(() => {
      controller.abort();
    }, options.timeout);

    try {
      let response = await fetch(currentUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'MultiSiteBackup/1.0 (Cloudflare Worker)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        }
      });

      finalUrl = response.url;

      while (response.redirected && redirectCount < 5) {
        const location = response.headers.get('location');
        if (!location) break;

        currentUrl = new URL(location, currentUrl).href;
        redirectCount++;

        clearMyTimeout();
        timeoutId = setTimeout(() => controller.abort(), options.timeout);

        response = await fetch(currentUrl, {
          method: 'GET',
          signal: controller.signal,
          redirect: 'manual',
          headers: {
            'User-Agent': 'MultiSiteBackup/1.0 (Cloudflare Worker)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          }
        });

        finalUrl = response.url;
      }

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const content = await response.text();
      const fetchTime = Date.now() - startTime;

      clearMyTimeout();

      return {
        content,
        status: response.status,
        headers,
        url,
        finalUrl,
        redirectCount,
        fetchTime
      };

    } catch (error) {
      clearMyTimeout();
      throw error;
    }
  }

  private async calculateHash(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private async detectChanges(siteId: string, results: BackupResult[]): Promise<string[]> {
    const changedUrls: string[] = [];
    
    for (const result of results) {
      if (!result.metadata) continue;
      
      const urlHash = await this.getUrlHash(result.url);
      const latestKey = `latest:${siteId}:${urlHash}`;
      const previousMetadata = await this.kv.get(latestKey);
      
      if (previousMetadata) {
        try {
          const previous = JSON.parse(previousMetadata);
          const prevComparableHash = previous.normalizedHash || previous.hash;
          const currComparableHash = result.metadata.normalizedHash || result.metadata.hash;

          if (prevComparableHash !== currComparableHash) {
            changedUrls.push(result.url);
          }
        } catch (error) {
          console.error(`Failed to parse previous metadata for ${result.url}:`, error);
          changedUrls.push(result.url);
        }
      } else {
        changedUrls.push(result.url);
      }
    }
    
    return changedUrls;
  }

  private async storeBackups(siteId: string, results: BackupResult[]): Promise<void> {
    const date = new Date().toISOString().split('T')[0];
    
    for (const result of results) {
      if (!result.metadata || !result.content) continue;
      
      const urlHash = await this.getUrlHash(result.url);
      
      const contentKey = `backup:${siteId}:${date}:${urlHash}`;
      const metadataKey = `meta:${siteId}:${date}:${urlHash}`;
      const latestKey = `latest:${siteId}:${urlHash}`;
      const prevLatestKey = `prev_latest:${siteId}:${urlHash}`;
      
      try {
        // Preserve previous latest metadata for diff generation in notifications
        const previousLatest = await this.kv.get(latestKey);

        await Promise.all([
          this.kv.put(contentKey, result.content),
          this.kv.put(metadataKey, JSON.stringify(result.metadata)),
          this.kv.put(latestKey, JSON.stringify(result.metadata)),
          ...(previousLatest ? [this.kv.put(prevLatestKey, previousLatest)] : [])
        ]);
      } catch (error) {
        console.error(`Failed to store backup for ${result.url}:`, error);
      }
    }
  }

  private async cleanupOldBackups(siteId: string, retentionDays: number): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    const cutoffString = cutoffDate.toISOString().split('T')[0];

    try {
      const list = await this.kv.list({
        prefix: `backup:${siteId}:`,
        limit: 1000
      });

      const keysToDelete: string[] = [];

      for (const key of list.keys) {
        const keyParts = key.name.split(':');
        if (keyParts.length >= 4) {
          const date = keyParts[2];
          if (date < cutoffString) {
            keysToDelete.push(key.name);
            
            const metadataKey = key.name.replace('backup:', 'meta:');
            keysToDelete.push(metadataKey);
          }
        }
      }

      for (const key of keysToDelete) {
        await this.kv.delete(key);
      }

      console.log(`Cleaned up ${keysToDelete.length} old backup entries for ${siteId}`);
    } catch (error) {
      console.error(`Failed to cleanup old backups for ${siteId}:`, error);
    }
  }

  private async getUrlHash(url: string): Promise<string> {
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .substring(0, 16);
  }
}