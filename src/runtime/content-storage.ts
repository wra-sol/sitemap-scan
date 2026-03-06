import { BackupMetadata } from '../types/site';

export const IDENTITY_CONTENT_ENCODING = 'identity';
export const GZIP_BASE64_CONTENT_ENCODING = 'gzip-base64';

export type StoredContentEncoding =
  | typeof IDENTITY_CONTENT_ENCODING
  | typeof GZIP_BASE64_CONTENT_ENCODING;

function isStoredContentEncoding(value: unknown): value is StoredContentEncoding {
  return value === IDENTITY_CONTENT_ENCODING || value === GZIP_BASE64_CONTENT_ENCODING;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  let done = false;

  try {
    while (!done) {
      const result = await reader.read();
      done = result.done;
      const value = result.value;

      if (value) {
        chunks.push(value);
        totalLength += value.length;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return combined;
}

async function gzipCompress(content: string): Promise<string> {
  const stream = new CompressionStream('gzip');
  const writer = stream.writable.getWriter();

  try {
    await writer.write(new TextEncoder().encode(content));
  } finally {
    await writer.close();
  }

  const compressed = await collectStream(stream.readable);
  return bytesToBase64(compressed);
}

async function gzipDecompress(encoded: string): Promise<string> {
  const stream = new DecompressionStream('gzip');
  const writer = stream.writable.getWriter();

  try {
    await writer.write(base64ToBytes(encoded));
  } finally {
    await writer.close();
  }

  const decompressed = await collectStream(stream.readable);
  return new TextDecoder().decode(decompressed);
}

export async function encodeBackupContent(content: string): Promise<{
  storedContent: string;
  encoding: StoredContentEncoding;
}> {
  try {
    return {
      storedContent: await gzipCompress(content),
      encoding: GZIP_BASE64_CONTENT_ENCODING
    };
  } catch (error) {
    console.error('Failed to compress backup content, storing raw HTML instead:', error);
    return {
      storedContent: content,
      encoding: IDENTITY_CONTENT_ENCODING
    };
  }
}

export async function decodeBackupContent(
  storedContent: string,
  encoding?: string
): Promise<string> {
  if (!encoding || encoding === IDENTITY_CONTENT_ENCODING) {
    return storedContent;
  }

  if (!isStoredContentEncoding(encoding)) {
    return storedContent;
  }

  try {
    switch (encoding) {
      case GZIP_BASE64_CONTENT_ENCODING:
        return await gzipDecompress(storedContent);
      case IDENTITY_CONTENT_ENCODING:
        return storedContent;
      default: {
        const exhaustiveCheck: never = encoding;
        return exhaustiveCheck;
      }
    }
  } catch (error) {
    console.error(`Failed to decode backup content with encoding ${encoding}:`, error);
    return storedContent;
  }
}

export async function readBackupContent(
  kv: KVNamespace,
  siteId: string,
  date: string,
  urlHash: string,
  metadata?: Partial<BackupMetadata> | null
): Promise<string | null> {
  const contentKey = `backup:${siteId}:${date}:${urlHash}`;
  const storedContent = await kv.get(contentKey, 'text');

  if (storedContent === null) {
    return null;
  }

  return decodeBackupContent(storedContent, metadata?.contentEncoding);
}
