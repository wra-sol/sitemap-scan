export interface KVListKey {
  name: string;
  expiration?: number;
}

export interface KVListResult {
  keys: KVListKey[];
  list_complete: boolean;
  cursor?: string;
}
