import { SiteConfig } from '../types/site';

export class SiteValidator {
  static validateId(id: string): boolean {
    return /^[a-zA-Z0-9_-]+$/.test(id) && id.length > 0 && id.length <= 50;
  }

  static validateSchedule(schedule: string): boolean {
    const cronRegex = /^(\*|([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])|\*\/([0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])) (\*|([0-9]|1[0-9]|2[0-3])|\*\/([0-9]|1[0-9]|2[0-3])) (\*|([1-9]|1[0-9]|2[0-9]|3[0-1])|\*\/([1-9]|1[0-9]|2[0-9]|3[0-1])) (\*|([1-9]|1[0-2])|\*\/([1-9]|1[0-2])) (\*|([0-6])|\*\/([0-6]))$/;
    return cronRegex.test(schedule);
  }

  static validateUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  }

  static validateUrls(urls: string[]): { valid: boolean; invalidUrls: string[] } {
    const invalidUrls: string[] = [];
    
    for (const url of urls) {
      if (!this.validateUrl(url)) {
        invalidUrls.push(url);
      }
    }

    return {
      valid: invalidUrls.length === 0,
      invalidUrls
    };
  }

  static validateFetchOptions(options: SiteConfig['fetchOptions']): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (options.timeout < 1000 || options.timeout > 30000) {
      errors.push('Timeout must be between 1000ms and 30000ms');
    }

    if (options.retries < 0 || options.retries > 5) {
      errors.push('Retries must be between 0 and 5');
    }

    if (options.concurrency < 1 || options.concurrency > 20) {
      errors.push('Concurrency must be between 1 and 20');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  static validateChangeThreshold(threshold: SiteConfig['changeThreshold']): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (threshold.minChangeSize !== undefined) {
      if (threshold.minChangeSize < 0 || threshold.minChangeSize > 1000000) {
        errors.push('Minimum change size must be between 0 and 1000000 bytes');
      }
    }

    if (threshold.ignorePatterns) {
      for (const pattern of threshold.ignorePatterns) {
        try {
          new RegExp(pattern);
        } catch {
          errors.push(`Invalid ignore pattern: ${pattern}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  static async validateFullConfig(config: SiteConfig): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (!this.validateId(config.id)) {
      errors.push('Site ID must contain only letters, numbers, underscores, and hyphens (max 50 chars)');
    }

    if (!config.name || config.name.trim().length === 0 || config.name.length > 100) {
      errors.push('Site name must be 1-100 characters');
    }

    if (!this.validateUrl(config.baseUrl)) {
      errors.push('Base URL must be a valid HTTP/HTTPS URL');
    }

    if (config.sitemapUrl && !this.validateUrl(config.sitemapUrl)) {
      errors.push('Sitemap URL must be a valid HTTP/HTTPS URL');
    }

    if (config.urls) {
      const urlValidation = this.validateUrls(config.urls);
      if (!urlValidation.valid) {
        errors.push(`Invalid URLs: ${urlValidation.invalidUrls.join(', ')}`);
      }
    }

    if (!config.sitemapUrl && (!config.urls || config.urls.length === 0)) {
      errors.push('Either sitemapUrl or urls must be provided');
    }

    if (!this.validateSchedule(config.schedule)) {
      errors.push('Invalid cron schedule format');
    }

    if (config.retentionDays < 1 || config.retentionDays > 365) {
      errors.push('Retention days must be between 1 and 365');
    }

    const fetchValidation = this.validateFetchOptions(config.fetchOptions);
    if (!fetchValidation.valid) {
      errors.push(...fetchValidation.errors);
    }

    const thresholdValidation = this.validateChangeThreshold(config.changeThreshold);
    if (!thresholdValidation.valid) {
      errors.push(...thresholdValidation.errors);
    }

    if (config.slackWebhook) {
      try {
        const webhookUrl = new URL(config.slackWebhook);
        if (!webhookUrl.hostname.includes('hooks.slack.com')) {
          errors.push('Slack webhook must be a valid Slack webhook URL');
        }
      } catch {
        errors.push('Invalid Slack webhook URL format');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  static sanitizeConfig(config: Partial<SiteConfig>): SiteConfig {
    return {
      id: config.id || 'default-site',
      name: config.name || 'Unnamed Site',
      baseUrl: config.baseUrl || 'https://example.com',
      retentionDays: config.retentionDays || 7,
      schedule: config.schedule || '0 2 * * *',
      fetchOptions: {
        timeout: config.fetchOptions?.timeout || 10000,
        retries: config.fetchOptions?.retries || 3,
        concurrency: config.fetchOptions?.concurrency || 5
      },
      changeThreshold: {
        minChangeSize: config.changeThreshold?.minChangeSize || 0,
        ignorePatterns: config.changeThreshold?.ignorePatterns || []
      },
      ...(config.sitemapUrl && { sitemapUrl: config.sitemapUrl }),
      ...(config.urls && { urls: config.urls }),
      ...(config.slackWebhook && { slackWebhook: config.slackWebhook })
    };
  }
}