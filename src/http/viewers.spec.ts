import { describe, it, expect } from 'vitest';
import { serveDiffViewer, serveBackupViewer } from './viewers';

describe('viewers', () => {
  describe('serveDiffViewer', () => {
    it('returns HTML response with correct content type', async () => {
      const response = await serveDiffViewer();
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      const text = await response.text();
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe('serveBackupViewer', () => {
    it('returns HTML response with correct content type', async () => {
      const response = await serveBackupViewer();
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      const text = await response.text();
      expect(text.length).toBeGreaterThan(0);
    });
  });
});
