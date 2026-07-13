import { describe, it, expect } from 'vitest';
import { jsonResponse } from './responses';

describe('jsonResponse', () => {
  it('returns 200 with JSON body by default', async () => {
    const response = jsonResponse({ message: 'hello' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    const body = await response.json() as { message: string };
    expect(body.message).toBe('hello');
  });

  it('uses custom status code', () => {
    const response = jsonResponse({ error: 'not found' }, 404);
    expect(response.status).toBe(404);
  });

  it('includes extra headers', () => {
    const response = jsonResponse({ ok: true }, 200, { 'X-Custom': 'value' });
    expect(response.headers.get('X-Custom')).toBe('value');
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });

  it('returns empty object', async () => {
    const response = jsonResponse({});
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body)).toHaveLength(0);
  });
});
