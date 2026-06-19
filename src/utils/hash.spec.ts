import { describe, it, expect } from 'vitest';
import { getUrlHash } from './hash';

describe('getUrlHash', () => {
  it('returns a 16-character hex string', async () => {
    const hash = await getUrlHash('https://example.com');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same URL', async () => {
    const hash1 = await getUrlHash('https://example.com/page');
    const hash2 = await getUrlHash('https://example.com/page');
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different URLs', async () => {
    const hash1 = await getUrlHash('https://example.com/page1');
    const hash2 = await getUrlHash('https://example.com/page2');
    expect(hash1).not.toBe(hash2);
  });

  it('handles empty string', async () => {
    const hash = await getUrlHash('');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
