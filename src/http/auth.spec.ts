import { describe, expect, it } from 'vitest';
import { requireApiAuth } from './auth';

describe('requireApiAuth', () => {
  it('allows localhost requests when the admin token is unset', () => {
    const request = new Request('http://localhost:8787/api/sites');

    expect(requireApiAuth(request, {})).toBeNull();
  });

  it('rejects non-local requests when the admin token is unset', async () => {
    const request = new Request('https://example.workers.dev/api/sites');
    const response = requireApiAuth(request, {});

    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({
      error: 'ADMIN_API_TOKEN is not configured for this deployment.'
    });
  });

  it('accepts a matching bearer token', () => {
    const request = new Request('https://example.workers.dev/api/sites', {
      headers: {
        Authorization: 'Bearer top-secret'
      }
    });

    expect(requireApiAuth(request, { ADMIN_API_TOKEN: 'top-secret' })).toBeNull();
  });

  it('accepts a matching x-api-key token', () => {
    const request = new Request('https://example.workers.dev/api/sites', {
      headers: {
        'x-api-key': 'top-secret'
      }
    });

    expect(requireApiAuth(request, { ADMIN_API_TOKEN: 'top-secret' })).toBeNull();
  });

  it('rejects incorrect tokens', () => {
    const request = new Request('https://example.workers.dev/api/sites', {
      headers: {
        Authorization: 'Bearer wrong-token'
      }
    });

    const response = requireApiAuth(request, { ADMIN_API_TOKEN: 'top-secret' });
    expect(response?.status).toBe(401);
    expect(response?.headers.get('WWW-Authenticate')).toBe('Bearer');
  });
});
