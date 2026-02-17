# Multi-Site Backup System for Cloudflare Workers

A comprehensive backup utility for monitoring multiple websites, detecting changes, and sending Slack notifications when content changes are detected.

## Features

- **Multi-site Support**: Manage backup configurations for multiple websites independently
- **Sitemap-driven**: Automatically discovers URLs from sitemap.xml or use explicit URL lists
- **Change Detection**: Intelligent content normalization and diffing with configurable thresholds
- **Slack Integration**: Per-site or aggregated notifications with rich formatting
- **Staggered Scheduling**: Distribute backup jobs across multiple time windows
- **KV Storage**: Efficient storage with automatic cleanup based on retention policies
- **Error Handling**: Comprehensive retry logic and error reporting
- **API Management**: RESTful API for site management and monitoring

## Architecture

### Core Components

- **Scheduler Dispatcher**: Manages cron-based job execution with staggered scheduling
- **Site Manager**: Handles site configuration storage and validation
- **Backup Fetcher**: Fetches website content with retry logic and rate limiting
- **Content Comparer**: Normalizes content and detects meaningful changes
- **Slack Notifier**: Sends formatted notifications with change summaries
- **Storage Manager**: Manages KV storage with compression and cleanup

### Data Model

- **Site Configuration**: Per-site settings stored in `site_config:{siteId}` keys
- **Backup Content**: Compressed content stored in `backup:{siteId}:{date}:{urlHash}` keys
- **Metadata**: Backup metadata in `meta:{siteId}:{date}:{urlHash}` keys
- **Latest Pointers**: Quick access to latest backup via `latest:{siteId}:{urlHash}` keys
- **Job Queue**: Scheduled jobs managed in `scheduler:queue` key

## Installation

### Prerequisites

- Node.js 18+
- Cloudflare account with Workers and KV enabled
- Wrangler CLI installed

### Setup

1. **Clone and Install**:
   ```bash
   npm install
   ```

2. **Configure KV Namespace**:
   ```bash
   wrangler kv:namespace create "BACKUP_KV"
   wrangler kv:namespace create "BACKUP_KV" --preview
   ```

3. **Update wrangler.toml**:
   Replace the placeholder KV namespace IDs with your actual IDs.

4. **Set Slack Webhook**:
   ```bash
   wrangler secret put DEFAULT_SLACK_WEBHOOK
   # Enter your Slack webhook URL when prompted
   ```

5. **Set your Worker public URL (for Slack links)**:
   Update `PUBLIC_BASE_URL` in `wrangler.toml` to match your deployed Worker URL.

6. **Deploy**:
   ```bash
   wrangler deploy
   ```

## Configuration

### Site Configuration Format

```json
{
  "id": "example-com",
  "name": "Example.com",
  "baseUrl": "https://example.com",
  "sitemapUrl": "https://example.com/sitemap.xml",
  "retentionDays": 7,
  "schedule": "0 2 * * *",
  "slackWebhook": "https://hooks.slack.com/services/YOUR/WEBHOOK",
  "fetchOptions": {
    "timeout": 10000,
    "retries": 3,
    "concurrency": 5
  },
  "changeThreshold": {
    "minChangeSize": 100,
    "ignorePatterns": ["\\b\\d{4}-\\d{2}-\\d{2}\\b"]
  }
}
```

### Configuration Fields

- **id**: Unique identifier for the site (alphanumeric, underscores, hyphens only)
- **name**: Human-readable site name
- **baseUrl**: Primary URL for the site
- **sitemapUrl**: URL to sitemap.xml (optional, use `urls` array instead)
- **urls**: Explicit array of URLs to backup (alternative to sitemap)
- **retentionDays**: Number of days to retain backup history (1-365)
- **schedule**: Cron expression for when to run backups
- **slackWebhook**: Site-specific Slack webhook (optional)
- **fetchOptions**: Timeout, retry, and concurrency settings
- **changeThreshold**: Minimum change size and ignore patterns

## API Endpoints

### Site Management

- `GET /api/sites` - List all sites
- `GET /api/sites?siteId={id}` - Get specific site
- `POST /api/sites` - Create new site
- `PUT /api/sites?siteId={id}` - Update site
- `DELETE /api/sites?siteId={id}` - Delete site

### Monitoring

- `GET /api/sites/health` - Check site health
- `GET /api/sites/metrics?siteId={id}&days=7` - Get site metrics
- `GET /api/status` - Get scheduler status

### Operations

- `POST /api/backup/trigger` - Trigger manual backup
- `POST /api/slack/test` - Test Slack notification

## Usage Examples

### Adding a New Site

```bash
curl -X POST https://your-worker.your-subdomain.workers.dev/api/sites \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-website",
    "name": "My Website",
    "baseUrl": "https://mywebsite.com",
    "sitemapUrl": "https://mywebsite.com/sitemap.xml",
    "retentionDays": 7,
    "schedule": "0 3 * * *",
    "fetchOptions": {
      "timeout": 15000,
      "retries": 2,
      "concurrency": 8
    },
    "changeThreshold": {
      "minChangeSize": 50,
      "ignorePatterns": ["timestamp", "csrf-token"]
    }
  }'
```

### Checking Site Health

```bash
curl https://your-worker.your-subdomain.workers.dev/api/sites/health?siteId=my-website
```

### Triggering Manual Backup

```bash
curl -X POST https://your-worker.your-subdomain.workers.dev/api/backup/trigger \
  -H "Content-Type: application/json" \
  -d '{"siteId": "my-website"}'
```

## Scheduling

The system uses staggered scheduling across multiple cron triggers:

- `0 1 * * *` - 1 AM UTC (Group A)
- `0 3 * * *` - 3 AM UTC (Group B)
- `0 5 * * *` - 5 AM UTC (Group C)
- `0 7 * * *` - 7 AM UTC (Group D)
- `0 9 * * *` - 9 AM UTC (Group E)

Sites are automatically distributed across these groups based on their schedule configuration.

## Change Detection

The system normalizes content to ignore:

- Timestamps and dates
- Session IDs and CSRF tokens
- Dynamic attributes (data-testid, nonce)
- Random UUIDs
- Version numbers
- Whitespace variations

Custom ignore patterns can be configured per site using regular expressions.

## Error Handling

- **Retries**: Automatic exponential backoff (up to 3 attempts by default)
- **Rate Limiting**: Configurable concurrency limits per site
- **Timeout**: Default 10-second timeout per request
- **Health Monitoring**: Regular site health checks with Slack alerts
- **Graceful Degradation**: Failed sites don't affect other sites

## Storage Optimization

- **Compression**: Content is gzip-compressed before KV storage
- **Hash-based Keys**: SHA-256 hashes for efficient lookups
- **Automatic Cleanup**: Old backups automatically removed based on retention policy
- **Metadata Separation**: Content and metadata stored separately for efficiency

## Monitoring and Observability

### Built-in Metrics

- Success/failure rates per site
- Execution timing statistics
- Change frequency analysis
- Storage usage tracking
- Error categorization

### Slack Notifications

Notifications include:

- Site name and timestamp
- Change count and URLs affected
- Success/failure summary
- Execution timing
- Quick actions (view site, manage configuration)

## Security Considerations

- **Secrets Management**: Slack webhooks stored as Workers secrets
- **Input Validation**: All API inputs validated against schema
- **Rate Limiting**: Configurable concurrency prevents abuse
- **HTTPS Only**: All communications over HTTPS
- **CORS Headers**: Proper CORS configuration for web clients

## Performance Tuning

### For High-Traffic Sites

- Increase `concurrency` in `fetchOptions`
- Reduce `timeout` for faster failure detection
- Use explicit `urls` array instead of sitemap for known pages
- Consider per-site Slack webhooks to avoid rate limits

### For Large Sites (500+ URLs)

- Split across multiple site configurations
- Use longer retention periods cautiously
- Monitor KV storage usage
- Consider R2 for very large content storage

## Troubleshooting

### Common Issues

1. **KV Namespace Errors**: Ensure KV namespace IDs are correctly set in wrangler.toml
2. **Slack Failures**: Verify webhook URLs and check rate limits
3. **Timeout Errors**: Increase timeout values for slow sites
4. **Memory Issues**: Reduce concurrency for memory-constrained Workers

### Debug Mode

Enable detailed logging by setting environment variables:

```bash
wrangler secret put LOG_LEVEL
# Enter "debug" when prompted
```

### Health Checks

Regular health checks run automatically. Monitor:
- Site accessibility
- Sitemap validity
- Slack webhook connectivity
- KV storage availability

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Submit a pull request with description

## License

MIT License - see LICENSE file for details.

## Support

For issues and questions:

- Check the troubleshooting section
- Review Cloudflare Workers documentation
- Create an issue in the repository
- Contact support if enterprise deployment

## Version History

- **v1.0.0**: Initial release with multi-site support
- **v1.1.0**: Added enhanced content normalization
- **v1.2.0**: Improved error handling and retries
- **v1.3.0**: Added REST API for site management
- **v2.0.0**: Complete rewrite with TypeScript and modular architecture