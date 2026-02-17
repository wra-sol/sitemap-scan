import { SiteConfig } from '../types/site';

export class SiteManager {
  private kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async getSiteConfig(siteId: string): Promise<SiteConfig | null> {
    try {
      const config = await this.kv.get(`site_config:${siteId}`);
      return config ? JSON.parse(config) : null;
    } catch (error) {
      console.error(`Failed to get site config for ${siteId}:`, error);
      return null;
    }
  }

  async getAllSiteConfigs(): Promise<SiteConfig[]> {
    try {
      const sitesList = await this.kv.get('sites:list');
      if (!sitesList) {
        return [];
      }

      const siteIds = JSON.parse(sitesList) as string[];
      const configs = await Promise.allSettled(
        siteIds.map(id => this.getSiteConfig(id))
      );

      return configs
        .filter((result): result is PromiseFulfilledResult<SiteConfig> => 
          result.status === 'fulfilled' && result.value !== null
        )
        .map(result => result.value);
    } catch (error) {
      console.error('Failed to get all site configs:', error);
      return [];
    }
  }

  async saveSiteConfig(config: SiteConfig): Promise<boolean> {
    try {
      await this.kv.put(`site_config:${config.id}`, JSON.stringify(config));
      
      const sitesList = await this.kv.get('sites:list');
      const siteIds = sitesList ? JSON.parse(sitesList) as string[] : [];
      
      if (!siteIds.includes(config.id)) {
        siteIds.push(config.id);
        await this.kv.put('sites:list', JSON.stringify(siteIds));
      }

      return true;
    } catch (error) {
      console.error(`Failed to save site config for ${config.id}:`, error);
      return false;
    }
  }

  async deleteSiteConfig(siteId: string): Promise<boolean> {
    try {
      await this.kv.delete(`site_config:${siteId}`);
      
      const sitesList = await this.kv.get('sites:list');
      if (sitesList) {
        const siteIds = JSON.parse(sitesList) as string[];
        const updatedIds = siteIds.filter(id => id !== siteId);
        await this.kv.put('sites:list', JSON.stringify(updatedIds));
      }

      return true;
    } catch (error) {
      console.error(`Failed to delete site config for ${siteId}:`, error);
      return false;
    }
  }

  async validateSiteConfig(config: SiteConfig): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (!config.id || config.id.trim() === '') {
      errors.push('Site ID is required');
    }

    if (!config.name || config.name.trim() === '') {
      errors.push('Site name is required');
    }

    if (!config.baseUrl || config.baseUrl.trim() === '') {
      errors.push('Base URL is required');
    } else {
      try {
        new URL(config.baseUrl);
      } catch {
        errors.push('Base URL must be a valid URL');
      }
    }

    if (config.sitemapUrl) {
      try {
        new URL(config.sitemapUrl);
      } catch {
        errors.push('Sitemap URL must be a valid URL');
      }
    }

    if (config.urls && config.urls.length > 0) {
      for (const url of config.urls) {
        try {
          new URL(url);
        } catch {
          errors.push(`Invalid URL in urls array: ${url}`);
        }
      }
    }

    if (!config.sitemapUrl && (!config.urls || config.urls.length === 0)) {
      errors.push('Either sitemapUrl or urls array must be provided');
    }

    if (!config.schedule || config.schedule.trim() === '') {
      errors.push('Schedule is required');
    }

    if (!config.fetchOptions) {
      errors.push('Fetch options are required');
    } else {
      if (config.fetchOptions.timeout < 1000 || config.fetchOptions.timeout > 30000) {
        errors.push('Fetch timeout must be between 1000ms and 30000ms');
      }
      if (config.fetchOptions.retries < 0 || config.fetchOptions.retries > 5) {
        errors.push('Fetch retries must be between 0 and 5');
      }
      if (config.fetchOptions.concurrency < 1 || config.fetchOptions.concurrency > 20) {
        errors.push('Fetch concurrency must be between 1 and 20');
      }
    }

    if (!config.changeThreshold) {
      errors.push('Change threshold configuration is required');
    }

    return { valid: errors.length === 0, errors };
  }

  async getSitesBySchedule(schedule: string): Promise<SiteConfig[]> {
    const allConfigs = await this.getAllSiteConfigs();
    return allConfigs.filter(config => config.schedule === schedule);
  }

  async updateSiteLastRun(siteId: string, timestamp: string): Promise<boolean> {
    try {
      const config = await this.getSiteConfig(siteId);
      if (!config) {
        return false;
      }

      const statsKey = `stats:${siteId}:${new Date().toISOString().split('T')[0]}`;
      const existingStats = await this.kv.get(statsKey);
      
      if (existingStats) {
        const stats = JSON.parse(existingStats);
        stats.lastRun = timestamp;
        await this.kv.put(statsKey, JSON.stringify(stats));
      }

      return true;
    } catch (error) {
      console.error(`Failed to update last run for ${siteId}:`, error);
      return false;
    }
  }
}