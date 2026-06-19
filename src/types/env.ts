export interface Env {
  BACKUP_KV: KVNamespace;
  ADMIN_API_TOKEN?: string;
  DEFAULT_SLACK_WEBHOOK?: string;
  PUBLIC_BASE_URL?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_SCRAPE_API_TOKEN?: string;
  CLOUDFLARE_SCRAPE_CACHE_TTL?: string;
  RATE_LIMIT_REQUESTS?: string;
  RATE_LIMIT_WINDOW_MS?: string;
}