export class SlackTemplates {
  static createChangeBlock(
    siteName: string,
    changedUrl: string,
    changeType: string,
    url?: string
  ): Record<string, unknown> {
    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${siteName}*\n${changeType} detected\n<${changedUrl}|${this.truncateUrl(changedUrl)}>`
      },
      ...(url && {
        accessory: {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'View Changes'
          },
          url
        }
      })
    };
  }

  static createSummaryBlock(
    title: string,
    totalSites: number,
    successfulSites: number,
    totalChanges: number,
    totalErrors: number
  ): Record<string, unknown> {
    const successRate = ((successfulSites / totalSites) * 100).toFixed(1);

    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${title}*\n\n` +
          `📊 *Summary*\n` +
          `• Sites: ${successfulSites}/${totalSites} (${successRate}% success)\n` +
          `• Changes: ${totalChanges} total\n` +
          `• Errors: ${totalErrors}`
      },
      accessory: {
        type: 'image',
        image_url: this.getStatusIcon(totalErrors === 0 ? 'success' : totalErrors > 5 ? 'error' : 'warning'),
        alt_text: 'Status'
      }
    };
  }

  static createSiteStatusBlock(
    siteName: string,
    status: 'success' | 'error' | 'warning',
    changesCount: number,
    url: string,
    executionTime?: number
  ): Record<string, unknown> {
    const statusEmoji = status === 'success' ? '✅' : status === 'error' ? '❌' : '⚠️';
    const executionTimeText = executionTime ? ` (${(executionTime / 1000).toFixed(2)}s)` : '';

    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${statusEmoji} *${siteName}*${executionTimeText}\n` +
          `${changesCount} changes • <${url}|View Site>`
      }
    };
  }

  static createErrorBlock(
    siteName: string,
    error: string,
    timestamp?: string
  ): Record<string, unknown> {
    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🚨 *Error: ${siteName}*\n` +
          `${this.truncateText(error, 300)}\n` +
          `*Time:* ${timestamp || new Date().toISOString()}`
      }
    };
  }

  static createDividerBlock(): Record<string, unknown> {
    return { type: 'divider' };
  }

  static createHeaderBlock(text: string): Record<string, unknown> {
    return {
      type: 'header',
      text: {
        type: 'plain_text',
        text,
        emoji: true
      }
    };
  }

  static createContextBlock(elements: string[]): Record<string, unknown> {
    return {
      type: 'context',
      elements: elements.map(text => ({
        type: 'mrkdwn',
        text
      }))
    };
  }

  static buildBlocksMessage(blocks: Record<string, unknown>[]): Record<string, unknown> {
    return {
      username: 'Website Backup Monitor',
      icon_emoji: ':mag:',
      blocks
    };
  }

  static buildAttachmentMessage(
    text: string,
    color: 'good' | 'warning' | 'danger',
    fields?: Array<{ title: string; value: string; short?: boolean }>
  ): Record<string, unknown> {
    return {
      username: 'Website Backup Monitor',
      icon_emoji: ':mag:',
      text,
      attachments: [
        {
          color,
          fields: fields || []
        }
      ]
    };
  }

  static createDetailedChangeReport(
    siteName: string,
    changes: Array<{
      url: string;
      type: string;
      size: number;
    }>,
    executionTime: number
  ): Record<string, unknown>[] {
    const blocks = [
      this.createHeaderBlock(`🔍 ${siteName} - Detailed Change Report`),
      this.createDividerBlock(),
      this.createContextBlock([
        `🕒 Execution Time: ${(executionTime / 1000).toFixed(2)}s`,
        `📊 Changes: ${changes.length} URLs`,
        `📅 Generated: ${new Date().toLocaleString()}`
      ]),
      this.createDividerBlock()
    ];

    const sortedChanges = changes.sort((a, b) => b.size - a.size);
    
    for (const change of sortedChanges.slice(0, 10)) {
      blocks.push(this.createChangeBlock(
        siteName,
        change.url,
        change.type,
        `${change.url}?diff=true`
      ));
      
      blocks.push(this.createContextBlock([
        `Change Type: ${change.type}`,
        `Size: ${this.formatBytes(change.size)}`
      ]));
      
      blocks.push(this.createDividerBlock());
    }

    if (changes.length > 10) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `... and ${changes.length - 10} more changes`
        }
      });
    }

    return blocks;
  }

  static createWeeklySummary(
    weekStats: Array<{
      siteName: string;
      dailyChanges: number[];
      totalChanges: number;
      successRate: number;
    }>
  ): Record<string, unknown> {
    const totalSites = weekStats.length;
    const totalChanges = weekStats.reduce((sum, stat) => sum + stat.totalChanges, 0);
    const avgSuccessRate = weekStats.reduce((sum, stat) => sum + stat.successRate, 0) / totalSites;

    const blocks = [
      this.createHeaderBlock('📈 Weekly Backup Summary'),
      this.createDividerBlock(),
      this.createSummaryBlock(
        'This Week\'s Performance',
        totalSites,
        Math.round((avgSuccessRate / 100) * totalSites),
        totalChanges,
        totalSites - Math.round((avgSuccessRate / 100) * totalSites)
      ),
      this.createDividerBlock()
    ];

    const topPerformers = weekStats
      .filter(stat => stat.successRate === 100)
      .slice(0, 3);

    if (topPerformers.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*🏆 Top Performers (100% Success Rate)*\n' +
            topPerformers.map(stat => `• ${stat.siteName}`).join('\n')
        }
      });
      blocks.push(this.createDividerBlock());
    }

    const mostChanged = weekStats
      .sort((a, b) => b.totalChanges - a.totalChanges)
      .slice(0, 5);

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*🔄 Most Active Sites*\n' +
          mostChanged.map(stat => `• ${stat.siteName}: ${stat.totalChanges} changes`).join('\n')
      }
    });

    return this.buildBlocksMessage(blocks);
  }

  private static truncateUrl(url: string, maxLength: number = 50): string {
    const displayUrl = url.split('/').pop() || url;
    return displayUrl.length > maxLength 
      ? displayUrl.substring(0, maxLength - 3) + '...'
      : displayUrl;
  }

  private static truncateText(text: string, maxLength: number): string {
    return text.length > maxLength 
      ? text.substring(0, maxLength - 3) + '...'
      : text;
  }

  private static formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  private static getStatusIcon(status: 'success' | 'error' | 'warning'): string {
    const icons = {
      success: 'https://cdn-icons-png.flaticon.com/512/190/190411.png',
      error: 'https://cdn-icons-png.flaticon.com/512/753/753345.png',
      warning: 'https://cdn-icons-png.flaticon.com/512/1827/1827425.png'
    };
    return icons[status];
  }

  static createQuickActions(
    siteName: string,
    baseUrl: string,
    managementUrl?: string
  ): Record<string, unknown> {
    return {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Visit Site'
          },
          url: baseUrl,
          style: 'primary'
        },
        ...(managementUrl ? [{
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Manage'
          },
          url: managementUrl
        }] : []),
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'View Reports'
          },
          url: `${baseUrl}/backup-reports`
        }
      ]
    };
  }
}