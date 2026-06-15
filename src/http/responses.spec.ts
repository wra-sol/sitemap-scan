import { describe, it, expect } from 'vitest';
import { jsonResponse } from './responses';

describe('jsonResponse', () => {
  it('returns a JSON response with default status 200', () => {
    const response = jsonResponse({ message: 'Hello' });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });

  it('returns a JSON response with custom status', () => {
    const response = jsonResponse({ error: 'Not found' }, 404);

    expect(response.status).toBe(404);
  });

  it('includes extra headers when provided', () => {
    const response = jsonResponse({ data: 'test' }, 200, {
      'X-Custom-Header': 'custom-value',
      'Cache-Control': 'no-cache',
    });

    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('X-Custom-Header')).toBe('custom-value');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('serializes the body as JSON', async () => {
    const body = { nested: { key: 'value' }, array: [1, 2, 3] };
    const response = jsonResponse(body);

    const text = await response.text();
    expect(text).toBe(JSON.stringify(body));
  });

  it('handles null body', async () => {
    const response = jsonResponse(null, 200);

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe('null');
  });
});
