import { describe, it, expect } from 'vitest';
import { serveOperatorConsole } from './operator-console';

describe('operator-console', () => {
  describe('serveOperatorConsole', () => {
    it('returns HTML response with correct content type', () => {
      const response = serveOperatorConsole();
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    });

    it('returns non-empty body', async () => {
      const response = serveOperatorConsole();
      const text = await response.text();
      expect(text.length).toBeGreaterThan(0);
    });
  });
});
