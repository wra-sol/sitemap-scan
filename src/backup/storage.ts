import { BackupMetadata } from '../types/site';

export class StorageManager {
  private kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async storeBackup(
    siteId: string,
    date: string,
    urlHash: string,
    content: string,
    metadata: BackupMetadata
  ): Promise<boolean> {
    try {
      const contentKey = `backup:${siteId}:${date}:${urlHash}`;
      const metadataKey = `meta:${siteId}:${date}:${urlHash}`;
      const latestKey = `latest:${siteId}:${urlHash}`;

      const compressedContent = await this.compressContent(content);

      await Promise.all([
        this.kv.put(contentKey, compressedContent),
        this.kv.put(metadataKey, JSON.stringify(metadata)),
        this.kv.put(latestKey, JSON.stringify(metadata))
      ]);

      return true;
    } catch (error) {
      console.error(`Failed to store backup for ${siteId}:`, error);
      return false;
    }
  }

  async getBackup(
    siteId: string,
    date: string,
    urlHash: string
  ): Promise<{ content: string; metadata: BackupMetadata } | null> {
    try {
      const contentKey = `backup:${siteId}:${date}:${urlHash}`;
      const metadataKey = `meta:${siteId}:${date}:${urlHash}`;

      const [contentData, metadataData] = await Promise.all([
        this.kv.get(contentKey),
        this.kv.get(metadataKey)
      ]);

      if (!contentData || !metadataData) {
        return null;
      }

      const decompressedContent = await this.decompressContent(contentData);
      const metadata = JSON.parse(metadataData) as BackupMetadata;

      return {
        content: decompressedContent,
        metadata
      };
    } catch (error) {
      console.error(`Failed to get backup for ${siteId}:`, error);
      return null;
    }
  }

  async getLatestBackup(
    siteId: string,
    urlHash: string
  ): Promise<{ content: string; metadata: BackupMetadata; date: string } | null> {
    try {
      const latestKey = `latest:${siteId}:${urlHash}`;
      const latestData = await this.kv.get(latestKey);

      if (!latestData) {
        return null;
      }

      const metadata = JSON.parse(latestData) as BackupMetadata;
      const date = metadata.timestamp.split('T')[0];

      const backup = await this.getBackup(siteId, date, urlHash);
      if (!backup) {
        return null;
      }

      return {
        ...backup,
        date
      };
    } catch (error) {
      console.error(`Failed to get latest backup for ${siteId}:`, error);
      return null;
    }
  }

  async getBackupHistory(
    siteId: string,
    urlHash: string,
    limit: number = 30
  ): Promise<Array<{ date: string; metadata: BackupMetadata }>> {
    try {
      const list = await this.kv.list({
        prefix: `meta:${siteId}:`,
        limit: limit * 2
      });

      const backupHistory: Array<{ date: string; metadata: BackupMetadata }> = [];

      for (const key of list.keys) {
        const keyParts = key.name.split(':');
        if (keyParts.length >= 4 && keyParts[3] === urlHash) {
          const date = keyParts[2];
          const metadataData = await this.kv.get(key.name);
          
          if (metadataData) {
            try {
              const metadata = JSON.parse(metadataData) as BackupMetadata;
              backupHistory.push({ date, metadata });
            } catch (error) {
              console.error(`Failed to parse metadata for ${key.name}:`, error);
            }
          }
        }
      }

      return backupHistory
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, limit);
    } catch (error) {
      console.error(`Failed to get backup history for ${siteId}:`, error);
      return [];
    }
  }

  async deleteBackupsBefore(siteId: string, cutoffDate: string): Promise<number> {
    try {
      const list = await this.kv.list({
        prefix: `backup:${siteId}:`,
        limit: 1000
      });

      const keysToDelete: string[] = [];
      const cutoff = new Date(cutoffDate);

      for (const key of list.keys) {
        const keyParts = key.name.split(':');
        if (keyParts.length >= 4) {
          const date = keyParts[2];
          if (new Date(date) < cutoff) {
            keysToDelete.push(key.name);
            
            const metadataKey = key.name.replace('backup:', 'meta:');
            keysToDelete.push(metadataKey);
          }
        }
      }

      for (const key of keysToDelete) {
        await this.kv.delete(key);
      }

      console.log(`Deleted ${keysToDelete.length} backup entries for ${siteId} before ${cutoffDate}`);
      return keysToDelete.length;
    } catch (error) {
      console.error(`Failed to delete old backups for ${siteId}:`, error);
      return 0;
    }
  }

  async getStorageStats(siteId: string): Promise<{
    totalBackups: number;
    totalSizeEstimate: number;
    oldestBackup: string | null;
    newestBackup: string | null;
  }> {
    try {
      const list = await this.kv.list({
        prefix: `backup:${siteId}:`,
        limit: 100
      });

      const dates: string[] = [];
      let sizeEstimate = 0;

      for (const key of list.keys) {
        const keyParts = key.name.split(':');
        if (keyParts.length >= 4) {
          dates.push(keyParts[2]);
          sizeEstimate += key.expiration ? 1024 : 2048;
        }
      }

      const uniqueDates = [...new Set(dates)].sort();

      return {
        totalBackups: list.keys.length,
        totalSizeEstimate: sizeEstimate,
        oldestBackup: uniqueDates[0] || null,
        newestBackup: uniqueDates[uniqueDates.length - 1] || null
      };
    } catch (error) {
      console.error(`Failed to get storage stats for ${siteId}:`, error);
      return {
        totalBackups: 0,
        totalSizeEstimate: 0,
        oldestBackup: null,
        newestBackup: null
      };
    }
  }

  async listAllUrls(siteId: string): Promise<string[]> {
    try {
      const list = await this.kv.list({
        prefix: `latest:${siteId}:`,
        limit: 1000
      });

      const urls: string[] = [];

      for (const key of list.keys) {
        const latestData = await this.kv.get(key.name);
        if (latestData) {
          try {
            const metadata = JSON.parse(latestData) as BackupMetadata;
            urls.push(metadata.url);
          } catch (error) {
            console.error(`Failed to parse latest data for ${key.name}:`, error);
          }
        }
      }

      return urls.sort();
    } catch (error) {
      console.error(`Failed to list URLs for ${siteId}:`, error);
      return [];
    }
  }

  private async compressContent(content: string): Promise<string> {
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(content);
      const compressed = await this.gzipCompress(data);
      const decoder = new TextDecoder();
      return decoder.decode(compressed);
    } catch (error) {
      console.error('Failed to compress content:', error);
      return content;
    }
  }

  private async decompressContent(compressedContent: string): Promise<string> {
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(compressedContent);
      const decompressed = await this.gzipDecompress(data);
      const decoder = new TextDecoder();
      return decoder.decode(decompressed);
    } catch (error) {
      console.error('Failed to decompress content:', error);
      return compressedContent;
    }
  }

  private async gzipCompress(data: Uint8Array): Promise<Uint8Array> {
    const stream = new CompressionStream('gzip');
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();

    writer.write(data);
    writer.close();

    const chunks: Uint8Array[] = [];
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) {
        chunks.push(value);
      }
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }

  private async gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
    const stream = new DecompressionStream('gzip');
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();

    writer.write(data);
    writer.close();

    const chunks: Uint8Array[] = [];
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) {
        chunks.push(value);
      }
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }

  async getUrlHash(url: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(url);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
  }
}