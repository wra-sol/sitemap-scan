import { describe, it, expect } from 'vitest';
import {
  encodeBackupContent,
  decodeBackupContent,
  IDENTITY_CONTENT_ENCODING,
  GZIP_BASE64_CONTENT_ENCODING,
} from './content-storage';

describe('content-storage', () => {
  describe('encodeBackupContent', () => {
    it('encodes content with gzip-base64 encoding for non-empty input', async () => {
      const content = '<html><body>Hello World</body></html>';
      const result = await encodeBackupContent(content);
      expect(result.encoding).toBe(GZIP_BASE64_CONTENT_ENCODING);
      expect(result.storedContent).toBeTruthy();
      expect(result.storedContent).not.toBe(content);
    });

    it('produces different output for different content', async () => {
      const content1 = '<html><body>Content A</body></html>';
      const content2 = '<html><body>Content B</body></html>';
      const result1 = await encodeBackupContent(content1);
      const result2 = await encodeBackupContent(content2);
      expect(result1.storedContent).not.toBe(result2.storedContent);
    });

    it('roundtrips content correctly through encode/decode', async () => {
      const content = '<html><body>Test content with special chars: àéïõü &amp; "quotes"</body></html>';
      const encoded = await encodeBackupContent(content);
      expect(encoded.encoding).toBe(GZIP_BASE64_CONTENT_ENCODING);

      const decoded = await decodeBackupContent(encoded.storedContent, encoded.encoding);
      expect(decoded).toBe(content);
    });

    it('handles large content with compression', async () => {
      const largeContent = '<html>' + '<div>Repeated content block</div>'.repeat(500);
      const result = await encodeBackupContent(largeContent);
      expect(result.encoding).toBe(GZIP_BASE64_CONTENT_ENCODING);
      expect(result.storedContent).toBeTruthy();

      // Verify roundtrip
      const decoded = await decodeBackupContent(result.storedContent, result.encoding);
      expect(decoded).toBe(largeContent);
    });

    it('handles unicode content', async () => {
      const unicodeContent = '<html><body>Unicode: 你好世界 🌍 日本語</body></html>';
      const result = await encodeBackupContent(unicodeContent);
      expect(result.encoding).toBe(GZIP_BASE64_CONTENT_ENCODING);

      const decoded = await decodeBackupContent(result.storedContent, result.encoding);
      expect(decoded).toBe(unicodeContent);
    });
  });

  describe('decodeBackupContent', () => {
    it('returns raw content when encoding is undefined', async () => {
      const content = '<html>raw content</html>';
      const result = await decodeBackupContent(content, undefined);
      expect(result).toBe(content);
    });

    it('returns raw content when encoding is identity', async () => {
      const content = '<html>raw content</html>';
      const result = await decodeBackupContent(content, IDENTITY_CONTENT_ENCODING);
      expect(result).toBe(content);
    });

    it('returns raw content when encoding is unknown', async () => {
      const content = '<html>raw content</html>';
      const result = await decodeBackupContent(content, 'unknown-encoding');
      expect(result).toBe(content);
    });

    it('decodes gzip-base64 encoded content correctly', async () => {
      const originalContent = '<html><body>Decode test</body></html>';
      const encoded = await encodeBackupContent(originalContent);

      const decoded = await decodeBackupContent(encoded.storedContent, encoded.encoding);
      expect(decoded).toBe(originalContent);
    });

    it('returns original content on decode error (graceful fallback)', async () => {
      // Corrupted base64 data that will fail decompression
      const corruptedData = 'not-valid-base64-gzip-data!!!';
      const result = await decodeBackupContent(corruptedData, GZIP_BASE64_CONTENT_ENCODING);
      expect(result).toBe(corruptedData);
    });
  });

  describe('roundtrip integrity', () => {
    const testCases = [
      { name: 'simple HTML', content: '<html><body>Simple</body></html>' },
      { name: 'HTML with attributes', content: '<a href="https://example.com" class="link">Click</a>' },
      { name: 'HTML with script', content: '<script>const x = 1;</script><body>Content</body>' },
      { name: 'very long single word', content: '<html><body>' + 'a'.repeat(10000) + '</body></html>' },
    ];

    for (const { name, content } of testCases) {
      it(`preserves ${name} through encode/decode cycle`, async () => {
        const encoded = await encodeBackupContent(content);
        const decoded = await decodeBackupContent(encoded.storedContent, encoded.encoding);
        expect(decoded).toBe(content);
      });
    }
  });
});