async function listKeysWithPrefix(kv: KVNamespace, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const list = await kv.list({
      prefix,
      limit: 1000,
      cursor
    }) as KVNamespaceListResult<unknown, string>;

    for (const key of list.keys) {
      keys.push(key.name);
    }

    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  return keys;
}

async function deleteKeys(kv: KVNamespace, keys: string[]): Promise<number> {
  let deleted = 0;

  for (const key of keys) {
    await kv.delete(key);
    deleted++;
  }

  return deleted;
}

export class SiteDataService {
  private kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async deleteSiteData(siteId: string): Promise<number> {
    const exactKeys = [
      `site_config:${siteId}`,
      `batch_progress:${siteId}`,
      `full_scan:${siteId}`,
      `sitemap_listener:${siteId}`,
      `sitemap_pending:${siteId}`,
      `sitemap_listener_cursor:${siteId}`,
      `run:latest:${siteId}`
    ];

    const prefixKeys = await Promise.all([
      listKeysWithPrefix(this.kv, `backup:${siteId}:`),
      listKeysWithPrefix(this.kv, `meta:${siteId}:`),
      listKeysWithPrefix(this.kv, `latest:${siteId}:`),
      listKeysWithPrefix(this.kv, `prev_latest:${siteId}:`),
      listKeysWithPrefix(this.kv, `stats:${siteId}:`),
      listKeysWithPrefix(this.kv, `urls_cache:${siteId}:`),
      listKeysWithPrefix(this.kv, `sitemap_snapshot:${siteId}`),
      listKeysWithPrefix(this.kv, `diff:${siteId}:`),
      listKeysWithPrefix(this.kv, `run_site:${siteId}:`)
    ]);
    const globalRunKeys = (await listKeysWithPrefix(this.kv, 'run_log:'))
      .filter((key) => key.includes(`:${siteId}:`));

    const allKeys = Array.from(
      new Set([
        ...exactKeys,
        ...prefixKeys.flat(),
        ...globalRunKeys
      ])
    );

    const sitesListRaw = await this.kv.get('sites:list');
    if (sitesListRaw) {
      try {
        const siteIds = JSON.parse(sitesListRaw) as string[];
        const updatedSiteIds = siteIds.filter((currentSiteId) => currentSiteId !== siteId);
        await this.kv.put('sites:list', JSON.stringify(updatedSiteIds));
      } catch (error) {
        console.error('Failed to update sites:list during site deletion:', error);
      }
    }

    return deleteKeys(this.kv, allKeys);
  }
}
