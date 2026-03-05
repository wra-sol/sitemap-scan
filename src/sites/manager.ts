import { SiteConfig } from '../types/site';
import { SiteValidator } from './validator';

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
    return SiteValidator.validateFullConfig(config);
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