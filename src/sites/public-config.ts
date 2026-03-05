import { PublicSiteConfig, SiteConfig } from '../types/site';

export function toPublicSiteConfig(siteConfig: SiteConfig): PublicSiteConfig {
  const { slackWebhook, ...rest } = siteConfig;

  return {
    ...rest,
    hasSlackWebhook: Boolean(slackWebhook)
  };
}
