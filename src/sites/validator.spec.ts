import { describe, it, expect } from 'vitest';
import { SiteValidator } from './validator';
import { SiteConfig } from '../types/site';

function minimalSiteConfig(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    id: 'test-site',
    name: 'Test Site',
    baseUrl: 'https://example.com',
    sitemapUrl: 'https://example.com/sitemap.xml',
    retentionDays: 7,
    schedule: '0 2 * * *',
    fetchOptions: { timeout: 10000, retries: 3, concurrency: 5 },
    changeThreshold: { minChangeSize: 0, ignorePatterns: [] },
    ...overrides
  };
}

describe('SiteValidator', () => {
  describe('validateId', () => {
    it('accepts valid IDs with letters, numbers, underscores, and hyphens', () => {
      expect(SiteValidator.validateId('site-1')).toBe(true);
      expect(SiteValidator.validateId('site_1')).toBe(true);
      expect(SiteValidator.validateId('Site1')).toBe(true);
      expect(SiteValidator.validateId('a')).toBe(true);
    });

    it('rejects empty IDs', () => {
      expect(SiteValidator.validateId('')).toBe(false);
    });

    it('rejects IDs with special characters', () => {
      expect(SiteValidator.validateId('site@1')).toBe(false);
      expect(SiteValidator.validateId('site 1')).toBe(false);
      expect(SiteValidator.validateId('site.1')).toBe(false);
    });

    it('rejects IDs longer than 50 characters', () => {
      expect(SiteValidator.validateId('a'.repeat(51))).toBe(false);
      expect(SiteValidator.validateId('a'.repeat(50))).toBe(true);
    });
  });

  describe('validateSchedule', () => {
    it('accepts valid cron expressions', () => {
      expect(SiteValidator.validateSchedule('0 2 * * *')).toBe(true);
      expect(SiteValidator.validateSchedule('*/5 * * * *')).toBe(true);
      expect(SiteValidator.validateSchedule('0 0 1 * *')).toBe(true);
      expect(SiteValidator.validateSchedule('0 0 * * 0')).toBe(true);
    });

    it('rejects invalid cron expressions', () => {
      expect(SiteValidator.validateSchedule('not-a-cron')).toBe(false);
      expect(SiteValidator.validateSchedule('* * * *')).toBe(false);
      expect(SiteValidator.validateSchedule('')).toBe(false);
      expect(SiteValidator.validateSchedule('0 2 * * * *')).toBe(false);
    });
  });

  describe('validateUrl', () => {
    it('accepts valid HTTP and HTTPS URLs', () => {
      expect(SiteValidator.validateUrl('https://example.com')).toBe(true);
      expect(SiteValidator.validateUrl('http://example.com')).toBe(true);
      expect(SiteValidator.validateUrl('https://example.com/path?query=1')).toBe(true);
    });

    it('rejects invalid or non-HTTP(S) URLs', () => {
      expect(SiteValidator.validateUrl('ftp://example.com')).toBe(false);
      expect(SiteValidator.validateUrl('not-a-url')).toBe(false);
      expect(SiteValidator.validateUrl('')).toBe(false);
      expect(SiteValidator.validateUrl('javascript:alert(1)')).toBe(false);
    });
  });

  describe('validateUrls', () => {
    it('returns valid for all valid URLs', () => {
      const result = SiteValidator.validateUrls(['https://a.com', 'https://b.com']);
      expect(result.valid).toBe(true);
      expect(result.invalidUrls).toEqual([]);
    });

    it('returns invalid URLs in the list', () => {
      const result = SiteValidator.validateUrls(['https://a.com', 'not-a-url', 'ftp://b.com']);
      expect(result.valid).toBe(false);
      expect(result.invalidUrls).toContain('not-a-url');
      expect(result.invalidUrls).toContain('ftp://b.com');
    });
  });

  describe('validateFetchOptions', () => {
    it('accepts valid fetch options', () => {
      const result = SiteValidator.validateFetchOptions({ timeout: 10000, retries: 3, concurrency: 5 });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('rejects timeout out of range', () => {
      const result = SiteValidator.validateFetchOptions({ timeout: 500, retries: 3, concurrency: 5 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Timeout must be between 1000ms and 30000ms');
    });

    it('rejects retries out of range', () => {
      const result = SiteValidator.validateFetchOptions({ timeout: 10000, retries: 10, concurrency: 5 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Retries must be between 0 and 5');
    });

    it('rejects concurrency out of range', () => {
      const result = SiteValidator.validateFetchOptions({ timeout: 10000, retries: 3, concurrency: 25 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Concurrency must be between 1 and 20');
    });
  });

  describe('validateChangeThreshold', () => {
    it('accepts valid change thresholds', () => {
      const result = SiteValidator.validateChangeThreshold({ minChangeSize: 100, ignorePatterns: ['^\\s+$'] });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('rejects minChangeSize out of range', () => {
      const result = SiteValidator.validateChangeThreshold({ minChangeSize: 2000000 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Minimum change size must be between 0 and 1000000 bytes');
    });

    it('rejects invalid regex patterns', () => {
      const result = SiteValidator.validateChangeThreshold({ ignorePatterns: ['(invalid'] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid ignore pattern: (invalid');
    });
  });

  describe('validateFullConfig', () => {
    it('validates a correct config as valid', async () => {
      const config = minimalSiteConfig();
      const result = await SiteValidator.validateFullConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('rejects invalid site ID', async () => {
      const config = minimalSiteConfig({ id: 'site with spaces' });
      const result = await SiteValidator.validateFullConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Site ID must contain only letters, numbers, underscores, and hyphens (max 50 chars)');
    });

    it('rejects empty or too-long site name', async () => {
      const config = minimalSiteConfig({ name: '' });
      const result = await SiteValidator.validateFullConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Site name must be 1-100 characters');
    });

    it('rejects invalid base URL', async () => {
      const config = minimalSiteConfig({ baseUrl: 'not-a-url' });
      const result = await SiteValidator.validateFullConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Base URL must be a valid HTTP/HTTPS URL');
    });

    it('rejects invalid sitemap URL', async () => {
      const config = minimalSiteConfig({ sitemapUrl: 'ftp://example.com/sitemap.xml' });
      const result = await SiteValidator.validateFullConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Sitemap URL must be a valid HTTP/HTTPS URL');
    });

    it('rejects invalid URLs in the urls list', async () => {
      const config = minimalSiteConfig({ urls: ['https://example.com', 'not-a-url'] });
      const result = await SiteValidator.validateFullConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid URLs: not-a-url');
    });

    it('requires either sitemapUrl or urls', async () => {
      const config = minimalSiteConfig({ sitemapUrl: undefined, urls: undefined });
      const result = await SiteValidator.validateFullConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Either sitemapUrl or urls must be provided');
    });

    it('rejects invalid cron schedule', async () => {
      const config = minimalSiteConfig({ schedule: 'not-a-cron' });
      const result = await SiteValidator.validateFullConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid cron schedule format');
    });

    it('rejects retention days out of range', async () => {
      const config = minimalSiteConfig({ retentionDays: 0 });
      const result = await SiteValidator.validateFullConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Retention days must be between 1 and 365');
    });

    it('rejects invalid fetch options', async () => {
      const config = minimalSiteConfig({ fetchOptions: { timeout: 500, retries: 10, concurrency: 5 } });
      const result = await SiteValidator.validateFullConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Timeout must be between 1000ms and 30000ms');
      expect(result.errors).toContain('Retries must be between 0 and 5');
    });

    it('rejects invalid batchSize', async () => {
      const config = minimalSiteConfig({ batchSize: 35 });
      const result = await SiteValidator.validateFullConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('batchSize must be an integer between 1 and 30');
    });

    it('rejects non-integer batchSize', async () => {
      const config = minimalSiteConfig({ batchSize: 5.5 });
      const result = await SiteValidator.validateFullConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('batchSize must be an integer between 1 and 30');
    });

    it('rejects invalid Slack webhook URL', async () => {
      const config = minimalSiteConfig({ slackWebhook: 'not-a-url' });
      const result = await SiteValidator.validateFullConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid Slack webhook URL format');
    });

    it('rejects non-Slack webhook URL', async () => {
      const config = minimalSiteConfig({ slackWebhook: 'https://example.com/webhook' });
      const result = await SiteValidator.validateFullConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Slack webhook must be a valid Slack webhook URL');
    });

    it('accepts valid Slack webhook URL', async () => {
      const config = minimalSiteConfig({ slackWebhook: 'https://hooks.slack.com/services/T000/B000/XXXX' });
      const result = await SiteValidator.validateFullConfig(config);
      expect(result.errors).not.toContain('Slack webhook must be a valid Slack webhook URL');
      expect(result.errors).not.toContain('Invalid Slack webhook URL format');
    });
  });

  describe('sanitizeConfig', () => {
    it('fills in defaults for missing fields', () => {
      const config = SiteValidator.sanitizeConfig({});
      expect(config.id).toBe('default-site');
      expect(config.name).toBe('Unnamed Site');
      expect(config.baseUrl).toBe('https://example.com');
      expect(config.retentionDays).toBe(7);
      expect(config.schedule).toBe('0 2 * * *');
      expect(config.fetchOptions).toEqual({ timeout: 10000, retries: 3, concurrency: 5 });
      expect(config.changeThreshold).toEqual({ minChangeSize: 0, ignorePatterns: [] });
    });

    it('preserves provided values', () => {
      const config = SiteValidator.sanitizeConfig({
        id: 'my-site',
        name: 'My Site',
        baseUrl: 'https://mysite.com',
        retentionDays: 14,
        schedule: '0 4 * * *',
        fetchOptions: { timeout: 5000, retries: 1, concurrency: 2 },
        changeThreshold: { minChangeSize: 100, ignorePatterns: ['^\\s+$'] }
      });
      expect(config.id).toBe('my-site');
      expect(config.name).toBe('My Site');
      expect(config.baseUrl).toBe('https://mysite.com');
      expect(config.retentionDays).toBe(14);
      expect(config.schedule).toBe('0 4 * * *');
      expect(config.fetchOptions).toEqual({ timeout: 5000, retries: 1, concurrency: 2 });
      expect(config.changeThreshold).toEqual({ minChangeSize: 100, ignorePatterns: ['^\\s+$'] });
    });

    it('includes optional fields when provided', () => {
      const config = SiteValidator.sanitizeConfig({
        sitemapUrl: 'https://example.com/sitemap.xml',
        urls: ['https://example.com/page1'],
        slackWebhook: 'https://hooks.slack.com/services/xxx',
        batchSize: 10
      });
      expect(config.sitemapUrl).toBe('https://example.com/sitemap.xml');
      expect(config.urls).toEqual(['https://example.com/page1']);
      expect(config.slackWebhook).toBe('https://hooks.slack.com/services/xxx');
      expect(config.batchSize).toBe(10);
    });
  });
});
