import { SiteConfig, SiteBackupResult } from '../types/site';
import { ContentComparer } from '../diff/comparer';
import { ContentChange, StyleChange, StructureChange } from '../types/diff';

export class SlackNotifier {
  private kv: KVNamespace;
  private defaultWebhook: string;
  private publicBaseUrl?: string;

  constructor(kv: KVNamespace, defaultWebhook?: string, publicBaseUrl?: string) {
    this.kv = kv;
    this.defaultWebhook = defaultWebhook || '';
    this.publicBaseUrl = publicBaseUrl;
  }

  async sendChangeNotification(
    siteConfig: SiteConfig,
    backupResult: SiteBackupResult
  ): Promise<boolean> {
    try {
      const webhookUrl = siteConfig.slackWebhook || this.defaultWebhook;
      
      if (!webhookUrl) {
        console.log(`No webhook configured for site ${siteConfig.id}, skipping Slack notification`);
        return false;
      }

      const message = await this.buildChangeMessage(siteConfig, backupResult);
      
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Slack notification failed: ${response.status} - ${errorText}`);
        return false;
      }

      console.log(`Slack notification sent successfully for site ${siteConfig.id}`);
      return true;
    } catch (error) {
      console.error(`Failed to send Slack notification for site ${siteConfig.id}:`, error);
      return false;
    }
  }

  async sendErrorNotification(
    siteConfig: SiteConfig,
    error: string,
    context?: any
  ): Promise<boolean> {
    try {
      const webhookUrl = siteConfig.slackWebhook || this.defaultWebhook;
      
      if (!webhookUrl) {
        return false;
      }

      const message = this.buildErrorMessage(siteConfig, error, context);
      
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message)
      });

      return response.ok;
    } catch (error) {
      console.error(`Failed to send error notification for site ${siteConfig.id}:`, error);
      return false;
    }
  }

  async sendSummaryNotification(
    date: string,
    globalResults: Array<{
      siteConfig: SiteConfig;
      backupResult: SiteBackupResult;
    }>
  ): Promise<boolean> {
    try {
      if (!this.defaultWebhook) {
        console.log('No default webhook configured, skipping summary notification');
        return false;
      }

      const message = this.buildSummaryMessage(date, globalResults);
      
      const response = await fetch(this.defaultWebhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message)
      });

      return response.ok;
    } catch (error) {
      console.error('Failed to send summary notification:', error);
      return false;
    }
  }

  private async buildChangeMessage(
    siteConfig: SiteConfig,
    backupResult: SiteBackupResult
  ): Promise<any> {
    const date = new Date().toISOString().split('T')[0];
    const executionTimeSeconds = (backupResult.executionTime / 1000).toFixed(2);
    const baseUrl = this.getPublicBaseUrl();
    const processed = backupResult.successfulBackups + backupResult.failedBackups;
    const storedSuffix = backupResult.failedStores > 0 ? ` (store fails: ${backupResult.failedStores})` : '';

    // Only include detailed diffs for a few URLs to keep the Slack payload small.
    const maxUrlsWithDiffs = 3;
    const urlsForDiffs = backupResult.changedUrls.slice(0, maxUrlsWithDiffs);
    const hasMoreChanges = backupResult.changedUrls.length > maxUrlsWithDiffs;

    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `Changes detected: ${siteConfig.name}`, emoji: true }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `*Date:* ${date}\n` +
            `*Changed URLs:* ${backupResult.changedUrls.length}\n` +
            `*Processed:* ${processed}/${backupResult.totalUrls}\n` +
            `*Stored:* ${backupResult.storedBackups}/${backupResult.successfulBackups}${storedSuffix}\n` +
            `*Time:* ${executionTimeSeconds}s`
        }
      }
    ];

    if (baseUrl) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View diff viewer' },
            url: `${baseUrl}/diff/viewer?siteId=${encodeURIComponent(siteConfig.id)}&date=${encodeURIComponent(date)}`
          }
        ]
      });
    }

    blocks.push({ type: 'divider' });

    for (const changedUrl of urlsForDiffs) {
      const urlResult = backupResult.results.find(r => r.url === changedUrl);
      const currentContent = urlResult?.content;
      const currentMeta = urlResult?.metadata;

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: this.buildUrlHeader(siteConfig.id, changedUrl, date)
        }
      });

      if (!currentContent || !currentMeta) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '_No current content available to generate a diff._' }]
        });
        blocks.push({ type: 'divider' });
        continue;
      }

      const diffText = await this.buildUrlDiffSummary(siteConfig.id, changedUrl, date, currentContent, currentMeta.hash);

      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: diffText }
      });

      blocks.push({ type: 'divider' });
    }

    if (hasMoreChanges) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `… and *${backupResult.changedUrls.length - maxUrlsWithDiffs}* more changed URLs.`
        }
      });
    }

    if (backupResult.errors.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `*Errors*\n` +
            backupResult.errors.slice(0, 3).map(e => `- ${this.truncateText(e, 200)}`).join('\n') +
            (backupResult.errors.length > 3 ? `\n… and ${backupResult.errors.length - 3} more.` : '')
        }
      });
    }

    const message: any = {
      username: 'Website Backup Monitor',
      icon_emoji: ':mag:',
      text: `Changes detected for ${siteConfig.name}`,
      blocks
    };

    // Keep existing channel behavior (some webhooks ignore/override this)
    const channel = this.getChannelName(siteConfig);
    if (channel) message.channel = channel;

    return message;
  }

  private getPublicBaseUrl(): string | undefined {
    return this.publicBaseUrl;
  }

  private truncateUrl(url: string, maxLength: number = 90): string {
    if (url.length <= maxLength) return url;
    return url.substring(0, maxLength - 3) + '...';
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }

  private buildUrlHeader(siteId: string, url: string, date: string): string {
    const baseUrl = this.getPublicBaseUrl();
    const truncatedUrl = this.truncateUrl(url);

    if (!baseUrl) {
      return `*${truncatedUrl}*`;
    }

    const viewerUrl = `${baseUrl}/diff/viewer?siteId=${encodeURIComponent(siteId)}&date=${encodeURIComponent(date)}`;
    return `*<${url}|${truncatedUrl}>*  •  <${viewerUrl}|Open in diff viewer>`;
  }

  private escapeSlackText(text: string): string {
    return text.replace(/[&<>]/g, (char) => {
      switch (char) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        default:
          return char;
      }
    });
  }

  private formatSnippet(text?: string, maxLength: number = 140): string {
    if (!text) return '_empty_';

    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return '_empty_';
    return this.escapeSlackText(this.truncateText(normalized, maxLength));
  }

  private formatBeforeAfter(label: string, before?: string, after?: string, context?: string): string {
    const beforeText = this.formatSnippet(before);
    const afterText = this.formatSnippet(after);
    const contextText = context ? `\n  _${this.escapeSlackText(this.truncateText(context, 120))}_` : '';

    if (before && after) {
      return `• *${label}*\n  Before: \`${beforeText}\`\n  After: \`${afterText}\`${contextText}`;
    }

    if (after) {
      return `• *${label}* added\n  After: \`${afterText}\`${contextText}`;
    }

    if (before) {
      return `• *${label}* removed\n  Before: \`${beforeText}\`${contextText}`;
    }

    return `• *${label}* changed${contextText}`;
  }

  private formatContentChanges(changes: ContentChange[]): string[] {
    return changes.map((change) =>
      this.formatBeforeAfter(change.element, change.before, change.after, change.context)
    );
  }

  private formatStyleChanges(changes: StyleChange[]): string[] {
    return changes.map((change) => {
      const label = `${change.element}${change.attribute ? `.${change.attribute}` : ''}`;
      return this.formatBeforeAfter(label, change.before, change.after);
    });
  }

  private formatStructureChanges(changes: StructureChange[]): string[] {
    return changes.map((change) => {
      const attributes = change.attributes
        ? ` (${Object.entries(change.attributes)
            .slice(0, 3)
            .map(([key, value]) => `${key}=${this.truncateText(value, 24)}`)
            .join(', ')})`
        : '';
      return `• *${change.element}* ${change.change}${attributes}`;
    });
  }

  private async buildUrlDiffSummary(
    siteId: string,
    url: string,
    date: string,
    currentContent: string,
    currentHash: string
  ): Promise<string> {
    const urlHash = await this.getUrlHash(url);
    const prevLatestKey = `prev_latest:${siteId}:${urlHash}`;
    const prevMetaRaw = await this.kv.get(prevLatestKey);

    if (!prevMetaRaw) {
      return `_No previous version found (first time seen or first run)._`;
    }

    let prevMeta: { timestamp?: string; hash?: string } | null = null;
    try {
      prevMeta = JSON.parse(prevMetaRaw);
    } catch {
      prevMeta = null;
    }

    const prevDate = prevMeta?.timestamp?.split('T')[0];
    const prevHash = prevMeta?.hash;

    if (!prevDate || !prevHash) {
      return `_Previous metadata missing; cannot generate diff summary._`;
    }

    const prevContentKey = `backup:${siteId}:${prevDate}:${urlHash}`;
    const prevContent = await this.kv.get(prevContentKey, 'text');

    if (!prevContent) {
      return `_Previous content not found (possibly expired due to retention)._`;
    }

    const detailed = await ContentComparer.classifyChanges(
      url,
      prevContent,
      currentContent,
      prevHash,
      currentHash,
      date
    );

    const contentChanges = detailed.classification.content.slice(0, 3);
    const styleChanges = detailed.classification.style.slice(0, 2);
    const structureChanges = detailed.classification.structure.slice(0, 2);

    const parts: string[] = [];
    parts.push(
      `*Summary:* ${detailed.summary.contentChanges} content, ${detailed.summary.styleChanges} style, ${detailed.summary.structureChanges} structure`
    );

    if (contentChanges.length > 0) {
      parts.push(`*Content*`);
      parts.push(...this.formatContentChanges(contentChanges));
    }

    if (styleChanges.length > 0) {
      parts.push(`*Style*`);
      parts.push(...this.formatStyleChanges(styleChanges));
    }

    if (structureChanges.length > 0) {
      parts.push(`*Structure*`);
      parts.push(...this.formatStructureChanges(structureChanges));
    }

    return parts.join('\n');
  }

  private async getUrlHash(url: string): Promise<string> {
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .substring(0, 16);
  }

  private buildErrorMessage(
    siteConfig: SiteConfig,
    error: string,
    context?: any
  ): any {
    const fields = [
      {
        title: 'Site',
        value: siteConfig.name,
        short: true
      },
      {
        title: 'Time',
        value: new Date().toISOString(),
        short: true
      },
      {
        title: 'Error',
        value: error.length > 500 ? error.substring(0, 497) + '...' : error,
        short: false
      }
    ];

    if (context) {
      fields.push({
        title: 'Context',
        value: JSON.stringify(context, null, 2),
        short: false
      });
    }

    return {
      username: 'Website Backup Monitor',
      icon_emoji: ':x:',
      channel: this.getChannelName(siteConfig),
      text: `🚨 Backup failed for ${siteConfig.name}`,
      attachments: [
        {
          color: 'danger',
          fields
        }
      ]
    };
  }

  private buildSummaryMessage(
    date: string,
    globalResults: Array<{
      siteConfig: SiteConfig;
      backupResult: SiteBackupResult;
    }>
  ): any {
    const totalSites = globalResults.length;
    const successfulSites = globalResults.filter(r => r.backupResult.failedBackups === 0).length;
    const totalUrls = globalResults.reduce((sum, r) => sum + r.backupResult.totalUrls, 0);
    const totalChanges = globalResults.reduce((sum, r) => sum + r.backupResult.changedUrls.length, 0);
    const totalErrors = globalResults.reduce((sum, r) => sum + r.backupResult.errors.length, 0);

    const siteStatuses = globalResults.map(result => ({
      name: result.siteConfig.name,
      status: result.backupResult.failedBackups === 0 ? '✅ Success' : '❌ Failed',
      changes: result.backupResult.changedUrls.length,
      url: result.siteConfig.baseUrl
    }));

    return {
      username: 'Website Backup Monitor',
      icon_emoji: ':bar_chart:',
      text: `📊 Daily Backup Summary - ${date}`,
      attachments: [
        {
          color: totalErrors > 0 ? 'warning' : 'good',
          fields: [
            {
              title: 'Overall Status',
              value: `${successfulSites}/${totalSites} sites successful`,
              short: true
            },
            {
              title: 'Total URLs',
              value: totalUrls.toString(),
              short: true
            },
            {
              title: 'Total Changes',
              value: totalChanges.toString(),
              short: true
            },
            {
              title: 'Total Errors',
              value: totalErrors.toString(),
              short: true
            }
          ]
        },
        {
          title: 'Site Status',
          text: siteStatuses.map(site => 
            `${site.status} ${site.name} (${site.changes} changes) - <${site.url}|Visit>`
          ).join('\n'),
          mrkdwn_in: ['text']
        }
      ]
    };
  }

  private getChannelName(siteConfig: SiteConfig): string {
    return siteConfig.id.includes('prod') || siteConfig.id.includes('production') 
      ? '#backup-alerts-prod' 
      : '#backup-alerts';
  }

  async sendTestNotification(webhookUrl?: string): Promise<boolean> {
    try {
      const targetWebhook = webhookUrl || this.defaultWebhook;
      
      if (!targetWebhook) {
        throw new Error('No webhook URL provided');
      }

      const message = {
        username: 'Website Backup Monitor',
        icon_emoji: ':test_tube:',
        text: '🧪 Test notification from Multi-Site Backup System',
        attachments: [
          {
            color: 'good',
            fields: [
              {
                title: 'Status',
                value: 'Connection successful',
                short: true
              },
              {
                title: 'Timestamp',
                value: new Date().toISOString(),
                short: true
              }
            ]
          }
        ]
      };

      const response = await fetch(targetWebhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      console.log('Test notification sent successfully');
      return true;
    } catch (error) {
      console.error('Test notification failed:', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async validateWebhook(webhookUrl: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: 'Webhook Validation',
          text: 'Validating webhook configuration'
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          valid: false,
          error: `HTTP ${response.status}: ${errorText}`
        };
      }

      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}