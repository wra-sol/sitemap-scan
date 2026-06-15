import { describe, it, expect } from 'vitest';
import { toPublicSiteConfig } from './public-config';
import type { SiteConfig } from '../types/site';

describe('toPublicSiteConfig', () => {
  it('strips slackWebhook and adds hasSlackWebhook flag', () => {
    const config: SiteConfig = {
      id: 'test-site',
      name: 'Test Site',
      baseUrl: 'https://example.com',
      sitemapUrl: 'https://example.com/sitemap.xml',
      schedule: '0 0 * * *',
      slackWebhook: 'https://hooks.slack.com/secret',
      retentionDays: 7,
      fetchOptions: { timeout: 10000, retries: 3, concurrency: 5 },
      changeThreshold: { minChangeSize: 100, ignorePatterns: ['timestamp'] },
    };

    const publicConfig = toPublicSiteConfig(config);

    expect(publicConfig).not.toHaveProperty('slackWebhook');
    expect(publicConfig.hasSlackWebhook).toBe(true);
    expect(publicConfig.id).toBe('test-site');
    expect(publicConfig.name).toBe('Test Site');
  });

  it('sets hasSlackWebhook to false when no webhook is configured', () => {
    const config: SiteConfig = {
      id: 'test-site-2',
      name: 'Test Site 2',
      baseUrl: 'https://example2.com',
      schedule: '0 0 * * *',
      retentionDays: 7,
      fetchOptions: { timeout: 10000, retries: 3, concurrency: 5 },
      changeThreshold: { minChangeSize: 100, ignorePatterns: ['timestamp'] },
    };

    const publicConfig = toPublicSiteConfig(config);

    expect(publicConfig.hasSlackWebhook).toBe(false);
    expect(publicConfig.id).toBe('test-site-2');
  });

  it('sets hasSlackWebhook to false for empty string webhook', () => {
    const config: SiteConfig = {
      id: 'test-site-3',
      name: 'Test Site 3',
      baseUrl: 'https://example3.com',
      schedule: '0 0 * * *',
      slackWebhook: '',
      retentionDays: 7,
      fetchOptions: { timeout: 10000, retries: 3, concurrency: 5 },
      changeThreshold: { minChangeSize: 100, ignorePatterns: ['timestamp'] },
    };

    const publicConfig = toPublicSiteConfig(config);

    expect(publicConfig.hasSlackWebhook).toBe(false);
  });

  it('preserves all other fields', () => {
    const config: SiteConfig = {
      id: 'test-site-4',
      name: 'Test Site 4',
      baseUrl: 'https://example4.com',
      sitemapUrl: 'https://example4.com/sitemap.xml',
      schedule: '0 0 * * *',
      retentionDays: 14,
      batchSize: 50,
      urls: ['https://example4.com/page1', 'https://example4.com/page2'],
      fetchOptions: { timeout: 15000, retries: 5, concurrency: 10 },
      changeThreshold: { minChangeSize: 100, ignorePatterns: ['timestamp'] },
    };

    const publicConfig = toPublicSiteConfig(config);

    expect(publicConfig.id).toBe('test-site-4');
    expect(publicConfig.name).toBe('Test Site 4');
    expect(publicConfig.baseUrl).toBe('https://example4.com');
    expect(publicConfig.sitemapUrl).toBe('https://example4.com/sitemap.xml');
    expect(publicConfig.schedule).toBe('0 0 * * *');
    expect(publicConfig.retentionDays).toBe(14);
    expect(publicConfig.batchSize).toBe(50);
    expect(publicConfig.urls).toEqual(['https://example4.com/page1', 'https://example4.com/page2']);
    expect(publicConfig.changeThreshold).toEqual({ minChangeSize: 100, ignorePatterns: ['timestamp'] });
    expect(publicConfig.fetchOptions).toEqual({ timeout: 15000, retries: 5, concurrency: 10 });
  });
});
