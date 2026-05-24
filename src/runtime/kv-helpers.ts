import { KVListKey, KVListResult } from './kv-types';

/**
 * Lists all KV key info objects matching a prefix, automatically paginating
 * through multiple list() calls. Returns the full key objects so callers can
 * access metadata such as `expiration`.
 */
export async function listKeyInfosWithPrefix(kv: KVNamespace, prefix: string): Promise<KVListKey[]> {
  const keys: KVListKey[] = [];
  let cursor: string | undefined;

  do {
    const list = await kv.list({
      prefix,
      limit: 1000,
      cursor
    }) as KVListResult;

    for (const key of list.keys) {
      keys.push(key);
    }

    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  return keys;
}

/**
 * Lists all KV key names matching a prefix, automatically paginating through
 * multiple list() calls. This prevents silent truncation when the number
 * of matching keys exceeds a single page limit.
 */
export async function listKeysWithPrefix(kv: KVNamespace, prefix: string): Promise<string[]> {
  const keyInfos = await listKeyInfosWithPrefix(kv, prefix);
  return keyInfos.map((k) => k.name);
}
