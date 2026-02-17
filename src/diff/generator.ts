import { DetailedDiff, DiffGenerationOptions, DiffCacheEntry } from '../types/diff';
import { ContentComparer } from './comparer';

export class DiffGenerator {
  private kv: KVNamespace;
  private static readonly CACHE_TTL = 3600000; // 1 hour
  private static readonly MAX_DIFF_SIZE = 102400; // 100KB
  private static readonly PROGRESSIVE_LOAD_THRESHOLD = 100000; // 100KB

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async generateDiff(
    siteId: string,
    date: string,
    url: string,
    previousContent: string,
    currentContent: string,
    previousHash: string,
    currentHash: string,
    options: DiffGenerationOptions = {
      includeContent: true,
      includeStyle: true,
      includeStructure: true,
      cacheEnabled: true
    }
  ): Promise<DetailedDiff> {
    const cacheKey = this.getCacheKey(siteId, date, url);

    if (options.cacheEnabled) {
      const cached = await this.getCachedDiff(cacheKey);
      if (cached) {
        console.log(`Using cached diff for ${url}`);
        return cached;
      }
    }

    const startTime = Date.now();

    let diff: DetailedDiff;
    const contentSize = Math.max(previousContent.length, currentContent.length);

    if (contentSize > DiffGenerator.PROGRESSIVE_LOAD_THRESHOLD && options.progressiveLoad) {
      diff = await this.generateProgressiveDiff(
        url,
        date,
        previousContent,
        currentContent,
        previousHash,
        currentHash,
        options
      );
    } else {
      diff = await ContentComparer.classifyChanges(
        url,
        previousContent,
        currentContent,
        previousHash,
        currentHash,
        date
      );
    }

    if (!options.includeContent) {
      diff.classification.content = [];
      diff.summary.contentChanges = 0;
    }

    if (!options.includeStyle) {
      diff.classification.style = [];
      diff.summary.styleChanges = 0;
    }

    if (!options.includeStructure) {
      diff.classification.structure = [];
      diff.summary.structureChanges = 0;
    }

    if (options.maxChanges && diff.summary.totalChanges > options.maxChanges) {
      diff = this.limitChanges(diff, options.maxChanges);
    }

    diff.metadata.generationTime = Date.now() - startTime;
    diff.metadata.isPartial = diff.summary.totalChanges > (options.maxChanges || Infinity);

    if (options.cacheEnabled) {
      await this.cacheDiff(cacheKey, diff);
    }

    return diff;
  }

  async generateBatchDiffs(
    siteId: string,
    date: string,
    comparisons: Array<{
      url: string;
      previousContent: string;
      currentContent: string;
      previousHash: string;
      currentHash: string;
    }>,
    options?: DiffGenerationOptions
  ): Promise<Map<string, DetailedDiff>> {
    const diffs = new Map<string, DetailedDiff>();

    const batchSize = 5;
    for (let i = 0; i < comparisons.length; i += batchSize) {
      const batch = comparisons.slice(i, i + batchSize);
      const promises = batch.map(comp =>
        this.generateDiff(
          siteId,
          date,
          comp.url,
          comp.previousContent,
          comp.currentContent,
          comp.previousHash,
          comp.currentHash,
          options
        ).then(diff => [comp.url, diff] as [string, DetailedDiff])
      );

      const results = await Promise.all(promises);
      for (const [url, diff] of results) {
        diffs.set(url, diff);
      }
    }

    return diffs;
  }

  async getUrlHistory(
    siteId: string,
    url: string,
    maxDays: number = 30
  ): Promise<Array<{ date: string; hash: string; hasChanges: boolean }>> {
    const history: Array<{ date: string; hash: string; hasChanges: boolean }> = [];
    const urlHash = await ContentComparer.calculateHash(url);

    const today = new Date();
    for (let i = 0; i < maxDays; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];

      const key = `site:${siteId}:backup:${dateStr}:content:${urlHash}`;
      const stored = await this.kv.get(key, 'text');

      if (stored) {
        try {
          const data = JSON.parse(stored);
          history.push({
            date: dateStr,
            hash: data.hash,
            hasChanges: false
          });
        } catch (error) {
          console.error(`Failed to parse backup data for ${dateStr}:`, error);
        }
      }
    }

    for (let i = 1; i < history.length; i++) {
      if (history[i].hash !== history[i - 1].hash) {
        history[i].hasChanges = true;
      }
    }

    return history;
  }

  async compareDates(
    siteId: string,
    date1: string,
    date2: string,
    url: string
  ): Promise<DetailedDiff | null> {
    const urlHash = await ContentComparer.calculateHash(url);
    const key1 = `site:${siteId}:backup:${date1}:content:${urlHash}`;
    const key2 = `site:${siteId}:backup:${date2}:content:${urlHash}`;

    const [content1, content2] = await Promise.all([
      this.kv.get(key1, 'text'),
      this.kv.get(key2, 'text')
    ]);

    if (!content1 || !content2) {
      return null;
    }

    try {
      const data1 = JSON.parse(content1);
      const data2 = JSON.parse(content2);

      return await ContentComparer.classifyChanges(
        url,
        data1.content,
        data2.content,
        data1.hash,
        data2.hash,
        date2
      );
    } catch (error) {
      console.error('Failed to compare dates:', error);
      return null;
    }
  }

  private async generateProgressiveDiff(
    url: string,
    date: string,
    previousContent: string,
    currentContent: string,
    previousHash: string,
    currentHash: string,
    options: DiffGenerationOptions
  ): Promise<DetailedDiff> {
    const chunkSize = 50000;
    const chunks = Math.ceil(Math.max(previousContent.length, currentContent.length) / chunkSize);

    console.log(`Generating progressive diff for ${url} in ${chunks} chunks`);

    const partialDiff = await ContentComparer.classifyChanges(
      url,
      previousContent.substring(0, chunkSize),
      currentContent.substring(0, chunkSize),
      previousHash,
      currentHash,
      date
    );

    partialDiff.metadata.isPartial = true;

    return partialDiff;
  }

  private limitChanges(diff: DetailedDiff, maxChanges: number): DetailedDiff {
    const limited = { ...diff };

    const prioritySort = (a: any, b: any) => b.priority - a.priority;

    limited.classification.content = diff.classification.content
      .sort(prioritySort)
      .slice(0, Math.floor(maxChanges * 0.6));

    limited.classification.style = diff.classification.style
      .sort(prioritySort)
      .slice(0, Math.floor(maxChanges * 0.2));

    limited.classification.structure = diff.classification.structure
      .sort(prioritySort)
      .slice(0, Math.floor(maxChanges * 0.2));

    limited.summary.contentChanges = limited.classification.content.length;
    limited.summary.styleChanges = limited.classification.style.length;
    limited.summary.structureChanges = limited.classification.structure.length;
    limited.summary.totalChanges = limited.summary.contentChanges +
      limited.summary.styleChanges +
      limited.summary.structureChanges;

    return limited;
  }

  private getCacheKey(siteId: string, date: string, url: string): string {
    return `diff:${siteId}:${date}:${ContentComparer.calculateHash(url)}`;
  }

  private async getCachedDiff(cacheKey: string): Promise<DetailedDiff | null> {
    try {
      const cached = await this.kv.get(cacheKey, 'text');
      if (!cached) return null;

      const entry = JSON.parse(cached) as DiffCacheEntry;
      if (Date.now() > entry.expiresAt) {
        await this.kv.delete(cacheKey);
        return null;
      }

      return entry.diff;
    } catch (error) {
      console.error('Failed to get cached diff:', error);
      return null;
    }
  }

  private async cacheDiff(cacheKey: string, diff: DetailedDiff): Promise<void> {
    try {
      const entry: DiffCacheEntry = {
        key: cacheKey,
        diff,
        expiresAt: Date.now() + DiffGenerator.CACHE_TTL
      };

      const serialized = JSON.stringify(entry);

      if (serialized.length > DiffGenerator.MAX_DIFF_SIZE) {
        console.log(`Diff too large to cache (${serialized.length} bytes)`);
        return;
      }

      await this.kv.put(cacheKey, serialized, {
        expirationTtl: Math.floor(DiffGenerator.CACHE_TTL / 1000)
      });

      console.log(`Cached diff for ${cacheKey}`);
    } catch (error) {
      console.error('Failed to cache diff:', error);
    }
  }

  async clearCache(siteId?: string): Promise<void> {
    try {
      const list = await this.kv.list({ prefix: 'diff:' });

      for (const key of list.keys) {
        if (!siteId || key.name.includes(siteId)) {
          await this.kv.delete(key.name);
        }
      }

      console.log(`Cleared diff cache${siteId ? ` for site ${siteId}` : ''}`);
    } catch (error) {
      console.error('Failed to clear cache:', error);
    }
  }

  async getCacheStats(): Promise<{ totalEntries: number; totalSize: number }> {
    try {
      const list = await this.kv.list({ prefix: 'diff:' });

      let totalSize = 0;
      for (const key of list.keys) {
        const value = await this.kv.get(key.name, 'text');
        if (value) {
          totalSize += value.length;
        }
      }

      return {
        totalEntries: list.keys.length,
        totalSize
      };
    } catch (error) {
      console.error('Failed to get cache stats:', error);
      return { totalEntries: 0, totalSize: 0 };
    }
  }
}
