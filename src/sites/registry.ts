import { SiteConfig } from '../types/site';
import { XMLParser } from 'fast-xml-parser';

export class SiteRegistry {
  private kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async discoverSites(): Promise<SiteConfig[]> {
    const sitesList = await this.kv.get('sites:list');
    if (!sitesList) {
      return [];
    }

    const siteIds = JSON.parse(sitesList) as string[];
    const sites: SiteConfig[] = [];

    for (const siteId of siteIds) {
      const config = await this.kv.get(`site_config:${siteId}`);
      if (config) {
        try {
          sites.push(JSON.parse(config));
        } catch (error) {
          console.error(`Failed to parse config for site ${siteId}:`, error);
        }
      }
    }

    return sites;
  }

  async validateSiteHealth(siteId: string): Promise<{ healthy: boolean; issues: string[] }> {
    const config = await this.kv.get(`site_config:${siteId}`);
    if (!config) {
      return { healthy: false, issues: ['Site configuration not found'] };
    }

    const siteConfig: SiteConfig = JSON.parse(config);
    const issues: string[] = [];

    try {
      const baseUrl = new URL(siteConfig.baseUrl);
      const testUrl = `${baseUrl.protocol}//${baseUrl.host}`;
      
      const response = await fetch(testUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      if (!response.ok) {
        issues.push(`Base URL health check failed: ${response.status}`);
      }
    } catch (error) {
      issues.push(`Base URL health check error: ${error}`);
    }

    if (siteConfig.sitemapUrl) {
      try {
        const sitemapResponse = await fetch(siteConfig.sitemapUrl, { 
          method: 'GET', 
          signal: AbortSignal.timeout(5000) 
        });
        if (!sitemapResponse.ok) {
          issues.push(`Sitemap health check failed: ${sitemapResponse.status}`);
        }
      } catch (error) {
        issues.push(`Sitemap health check error: ${error}`);
      }
    }

    return { healthy: issues.length === 0, issues };
  }

  async getSiteMetrics(siteId: string, days: number = 7): Promise<any> {
    const metrics = {
      totalBackups: 0,
      successfulBackups: 0,
      failedBackups: 0,
      averageExecutionTime: 0,
      recentErrors: [] as string[]
    };

    const today = new Date();
    const dates: string[] = [];

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      dates.push(date.toISOString().split('T')[0]);
    }

    const executionTimes: number[] = [];

    for (const date of dates) {
      const statsKey = `stats:${siteId}:${date}`;
      const stats = await this.kv.get(statsKey);
      
      if (stats) {
        try {
          const parsedStats = JSON.parse(stats);
          metrics.totalBackups++;
          
          if (parsedStats.failureCount === 0) {
            metrics.successfulBackups++;
          } else {
            metrics.failedBackups++;
          }

          if (parsedStats.endTime && parsedStats.startTime) {
            const startTime = new Date(parsedStats.startTime).getTime();
            const endTime = new Date(parsedStats.endTime).getTime();
            executionTimes.push(endTime - startTime);
          }

          if (parsedStats.errors && parsedStats.errors.length > 0) {
            metrics.recentErrors.push(...parsedStats.errors.slice(0, 3));
          }
        } catch (error) {
          console.error(`Failed to parse stats for ${statsKey}:`, error);
        }
      }
    }

    if (executionTimes.length > 0) {
      metrics.averageExecutionTime = executionTimes.reduce((a, b) => a + b, 0) / executionTimes.length;
    }

    return metrics;
  }

  async validateAllSites(): Promise<{ [siteId: string]: { healthy: boolean; issues: string[] } }> {
    const sitesList = await this.kv.get('sites:list');
    if (!sitesList) {
      return {};
    }

    const siteIds = JSON.parse(sitesList) as string[];
    const results: { [siteId: string]: { healthy: boolean; issues: string[] } } = {};

    for (const siteId of siteIds) {
      results[siteId] = await this.validateSiteHealth(siteId);
    }

    return results;
  }

  async getSitemapUrlCount(sitemapUrl: string): Promise<number> {
    try {
      const response = await fetch(sitemapUrl, { 
        signal: AbortSignal.timeout(10000) 
      });
      
      if (!response.ok) {
        throw new Error(`Sitemap fetch failed: ${response.status}`);
      }

      const xmlText = await response.text();
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_'
      });

      const result = parser.parse(xmlText);
      
      if (result.urlset && result.urlset.url) {
        return Array.isArray(result.urlset.url) ? result.urlset.url.length : 1;
      }
      
      if (result.sitemapindex && result.sitemapindex.sitemap) {
        return Array.isArray(result.sitemapindex.sitemap) ? result.sitemapindex.sitemap.length : 1;
      }

      return 0;
    } catch (error) {
      console.error(`Failed to get sitemap URL count for ${sitemapUrl}:`, error);
      return 0;
    }
  }

  async cleanupOldStats(retentionDays: number = 30): Promise<number> {
    const sitesList = await this.kv.get('sites:list');
    if (!sitesList) {
      return 0;
    }

    const siteIds = JSON.parse(sitesList) as string[];
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    
    let deletedCount = 0;

    for (const siteId of siteIds) {
      const list = await this.kv.list({
        prefix: `stats:${siteId}:`,
        limit: 1000
      });

      for (const key of list.keys) {
        const keyDate = key.name.split(':').pop();
        if (keyDate) {
          try {
            const keyDateObj = new Date(keyDate);
            if (keyDateObj < cutoffDate) {
              await this.kv.delete(key.name);
              deletedCount++;
            }
          } catch (error) {
            console.error(`Failed to parse date from key ${key.name}:`, error);
          }
        }
      }
    }

    return deletedCount;
  }
}