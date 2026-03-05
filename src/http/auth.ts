export interface ApiAuthEnv {
  ADMIN_API_TOKEN?: string;
}

const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1']);
const PUBLIC_PATHS = new Set(['/diff/viewer', '/backup/viewer']);

function jsonResponse(body: Record<string, string>, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders
    }
  });
}

function getProvidedToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim();
  }

  return request.headers.get('x-api-key');
}

export function requireApiAuth(request: Request, env: ApiAuthEnv): Response | null {
  const requestUrl = new URL(request.url);

  if (PUBLIC_PATHS.has(requestUrl.pathname)) {
    return null;
  }

  if (!env.ADMIN_API_TOKEN) {
    if (LOCAL_DEV_HOSTS.has(requestUrl.hostname)) {
      return null;
    }

    return jsonResponse(
      { error: 'ADMIN_API_TOKEN is not configured for this deployment.' },
      503
    );
  }

  const providedToken = getProvidedToken(request);
  if (!providedToken || providedToken !== env.ADMIN_API_TOKEN) {
    return jsonResponse(
      { error: 'Unauthorized' },
      401,
      { 'WWW-Authenticate': 'Bearer' }
    );
  }

  return null;
}
