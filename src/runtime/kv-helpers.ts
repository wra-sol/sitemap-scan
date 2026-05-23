import { KVListResult } from './kv-types';

/**
 * Lists all KV keys matching a prefix, automatically paginating through
 * multiple list() calls. This prevents silent truncation when the number
 * of matching keys exceeds a single page limit.
 */
export async function listKeysWithPrefix(kv: KVNamespace, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const list = await kv.list({
      prefix,
      limit: 1000,
      cursor
    }) as KVListResult;

    for (const key of list.keys) {
      keys.push(key.name);
    }

    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  return keys;
}
