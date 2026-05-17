export interface RateLimitEnv {
  BACKUP_KV: KVNamespace;
  RATE_LIMIT_REQUESTS?: string;
  RATE_LIMIT_WINDOW_MS?: string;
}

const PUBLIC_PATHS = new Set(['/', '/app', '/diff/viewer', '/backup/viewer']);
const DEFAULT_MAX_REQUESTS = 100;
const DEFAULT_WINDOW_MS = 60_000;

function getClientId(request: Request): string {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for');
  if (ip) {
    return ip.split(',')[0].trim();
  }

  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    return `token:${auth.slice('Bearer '.length).trim()}`;
  }

  const apiKey = request.headers.get('x-api-key');
  if (apiKey) {
    return `token:${apiKey.trim()}`;
  }

  return 'anonymous';
}

function getWindowStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

function jsonResponse(body: Record<string, unknown>, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders
    }
  });
}

export async function applyRateLimit(request: Request, env: RateLimitEnv): Promise<Response | null> {
  const url = new URL(request.url);

  if (PUBLIC_PATHS.has(url.pathname)) {
    return null;
  }

  const maxRequests = env.RATE_LIMIT_REQUESTS ? Number.parseInt(env.RATE_LIMIT_REQUESTS, 10) : DEFAULT_MAX_REQUESTS;
  const windowMs = env.RATE_LIMIT_WINDOW_MS ? Number.parseInt(env.RATE_LIMIT_WINDOW_MS, 10) : DEFAULT_WINDOW_MS;

  if (!Number.isFinite(maxRequests) || maxRequests <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    return null;
  }

  const clientId = getClientId(request);
  const now = Date.now();
  const windowStart = getWindowStart(now, windowMs);
  const key = `rate_limit:${clientId}:${windowStart}`;

  let count = 0;
  try {
    const raw = await env.BACKUP_KV.get(key);
    count = raw ? Number.parseInt(raw, 10) : 0;
    if (!Number.isFinite(count)) count = 0;
  } catch {
    // If KV read fails, allow the request through rather than hard-failing
    return null;
  }

  if (count >= maxRequests) {
    const retryAfterSeconds = Math.ceil((windowStart + windowMs - now) / 1000);
    return jsonResponse(
      { error: 'Too many requests', retryAfter: retryAfterSeconds },
      429,
      { 'Retry-After': String(Math.max(1, retryAfterSeconds)) }
    );
  }

  try {
    await env.BACKUP_KV.put(key, String(count + 1), { expirationTtl: Math.ceil(windowMs / 1000) });
  } catch {
    // If KV write fails, allow the request through
  }

  return null;
}
