# Example Site Configurations

This directory contains example site configurations that you can use as templates for setting up your own website backups.

## Configuration Examples

### 1. Example.com Production
- **Type**: Production website with sitemap
- **Schedule**: Daily at 2 AM UTC
- **Features**: Slack notifications, change thresholds, ignore patterns

### 2. Personal Blog
- **Type**: Blog with explicit URL list
- **Schedule**: Daily at 4 AM UTC
- **Features**: Longer retention, minimal change detection

### 3. Corporate Site
- **Type**: Large corporate website
- **Schedule**: Daily at 1 AM UTC
- **Features**: High concurrency, longer retention, custom Slack channel

### 4. API Documentation
- **Type**: Documentation site
- **Schedule**: Monday, Wednesday, Friday at 3 AM UTC
- **Features**: Extended timeout, frequent updates detection

### 5. E-commerce Store
- **Type**: E-commerce storefront
- **Schedule**: Daily at 5 AM UTC
- **Features**: Short retention, explicit URL list for key pages

### 6. News Portal
- **Type**: Frequently updated news site
- **Schedule**: Every 30 minutes
- **Features**: Minimal timeout, high concurrency, low change threshold

## Loading Examples

To load these example configurations into your deployed worker:

```bash
# After deployment, run the setup script with examples
./setup.sh --load-examples

# Or manually using curl
curl -X POST https://your-worker.your-subdomain.workers.dev/api/sites \
  -H "Content-Type: application/json" \
  -d @example-configurations.json
```

## Customization Guidelines

### For High-Traffic Sites
- Increase `concurrency` to 8-10
- Reduce `timeout` to 5000-8000ms
- Set `retries` to 1-2
- Use explicit `urls` array for critical pages only

### For Large Sites (1000+ URLs)
- Consider splitting into multiple configurations
- Use longer `retentionDays` cautiously
- Monitor KV storage usage
- Set lower `concurrency` to avoid rate limits

### For API-heavy Sites
- Increase `timeout` to 15000-20000ms
- Set higher `retries` to 3-4
- Add API-specific ignore patterns
- Consider separate configuration for API docs

### For Development/Staging
- Use short `retentionDays` (1-3)
- Set lower `minChangeSize` to catch all changes
- Use separate Slack channels
- Schedule during off-peak hours

## Scheduling Best Practices

### Stagger Schedules
Distribute your sites across available cron triggers:
- `0 1 * * *` - Low priority sites
- `0 3 * * *` - Normal priority sites  
- `0 5 * * *` - High priority sites
- `0 7 * * *` - Critical production sites

### Business Hours Avoidance
For production sites, avoid business hours:
- Use early morning hours (1-5 AM UTC)
- Consider time zone differences
- Weekend schedules for non-critical sites

### Frequency Guidelines
- **News/Blogs**: Every 30 minutes to 2 hours
- **Corporate Sites**: Daily
- **E-commerce**: 2-4 times per day
- **Documentation**: Weekly or every few days
- **API Docs**: When versions are released

## Change Threshold Recommendations

### Sensitive Sites
- `minChangeSize`: 10-50 bytes
- Monitor all changes
- Include timestamp ignore patterns

### Dynamic Sites
- `minChangeSize`: 100-500 bytes
- Ignore more dynamic elements
- Focus on structural changes

### Static Sites
- `minChangeSize`: 0 bytes
- Alert on any change
- Minimal ignore patterns

## Ignore Patterns Examples

### Common Dynamic Elements
```json
"ignorePatterns": [
  "\\b\\d{4}-\\d{2}-\\d{2}\\b",     // Dates
  "\\b\\d{2}:\\d{2}:\\d{2}\\b",     // Times
  "\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b", // UUIDs
  "timestamp",                     // Timestamp fields
  "csrf-token",                    // CSRF tokens
  "nonce",                          // Nonce values
  "data-testid",                    // Test attributes
  "\\bv?\\d+\\.\\d+\\.\\d+\\b"       // Version numbers
]
```

### Framework-Specific Patterns
```json
// React apps
"ignorePatterns": [
  "data-reactroot",
  "data-reactid",
  "__reactFiber"
]

// Vue apps  
"ignorePatterns": [
  "data-v-",
  "__vue"
]

// Angular apps
"ignorePatterns": [
  "ng-",
  "_ngcontent"
]
```

## Monitoring and Alerts

### Recommended Slack Channels
- `#backup-alerts-prod` - Production sites
- `#backup-alerts-dev` - Development sites
- `#backup-alerts-critical` - Critical production issues

### Alert Scenarios
1. **Change Detection**: When content changes exceed threshold
2. **Failed Backups**: When sites become unreachable
3. **Performance Issues**: When execution time exceeds limits
4. **Storage Warnings**: When KV storage approaches limits

## Troubleshooting Examples

### Common Issues and Solutions

#### 1. Timeout Errors
**Problem**: Sites not responding within timeout period
**Solution**: Increase `timeout` in `fetchOptions` or reduce `concurrency`

#### 2. 429 Rate Limiting
**Problem**: Too many requests to target site
**Solution**: Reduce `concurrency`, add delays between batches

#### 3. Large Content Size
**Problem**: Individual pages exceeding KV size limits
**Solution**: Add size-based filtering in URL list

#### 4. False Positives
**Problem**: Too many meaningless change notifications
**Solution**: Add specific ignore patterns for dynamic content

#### 5. SSL/TLS Issues
**Problem**: Certificate errors or HTTPS issues
**Solution**: Verify site SSL configuration, consider HTTP fallback

## Advanced Configuration

### Conditional Backups
Use multiple configurations for the same site with different schedules:

```json
{
  "id": "site-homepage",
  "name": "Site Homepage Only",
  "urls": ["https://example.com/"],
  "schedule": "*/30 * * * *"
}

{
  "id": "site-full", 
  "name": "Site Full Backup",
  "sitemapUrl": "https://example.com/sitemap.xml",
  "schedule": "0 2 * * *"
}
```

### Environment-Specific Settings
Deploy to multiple environments with different configurations:

```bash
# Development
wrangler deploy --env development

# Production  
wrangler deploy --env production
```

### Custom Headers for Authentication
For sites requiring authentication:

```json
"fetchOptions": {
  "headers": {
    "Authorization": "Bearer your-token",
    "X-API-Key": "your-api-key"
  }
}
```

## Performance Optimization

### Batch Processing
- Group similar sites together
- Use consistent scheduling
- Monitor execution times

### Storage Efficiency
- Set appropriate `retentionDays`
- Monitor KV usage regularly
- Consider cleanup policies

### Network Efficiency
- Use geographically close Workers
- Optimize concurrency per site type
- Implement retry delays