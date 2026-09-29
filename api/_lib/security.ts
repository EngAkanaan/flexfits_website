import { randomUUID } from 'crypto';

type RateLimitState = {
  count: number;
  resetAt: number;
};

const rateLimitBuckets = new Map<string, RateLimitState>();

export function createRequestId(): string {
  return randomUUID();
}

export function getClientIp(req: any): string {
  const forwardedFor = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0]?.trim();
  const realIp = String(req?.headers?.['x-real-ip'] || '').trim();
  const socketIp = String(req?.socket?.remoteAddress || '').trim();
  return forwardedFor || realIp || socketIp || 'unknown';
}

export function normalizeText(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, maxLength);
}

export function normalizeEmail(value: unknown, maxLength = 320): string {
  return normalizeText(value, maxLength).toLowerCase();
}

export function normalizeUrl(value: unknown, maxLength = 2048): string {
  const candidate = normalizeText(value, maxLength);
  if (!candidate) return '';

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

export function normalizePlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function assertAllowedKeys(value: Record<string, unknown>, allowedKeys: string[]): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Unexpected request field.');
  }
}

export async function readJsonBody(req: any, maxBytes: number): Promise<unknown> {
  if (typeof req?.body === 'string') {
    if (Buffer.byteLength(req.body, 'utf8') > maxBytes) {
      throw new Error('Request body too large.');
    }
    return JSON.parse(req.body);
  }

  if (req?.body && typeof req.body === 'object') {
    if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > maxBytes) {
      throw new Error('Request body too large.');
    }
    return req.body;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new Error('Request body too large.');
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

export function sendJson(res: any, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

export function allowMethod(req: any, res: any, methods: string[]): boolean {
  const method = String(req?.method || 'GET').toUpperCase();
  if (methods.includes(method)) return true;
  res.setHeader('Allow', methods.join(', '));
  sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
  return false;
}

export function rateLimit(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const bucketKey = key || 'unknown';
  const current = rateLimitBuckets.get(bucketKey);

  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: Math.ceil(windowMs / 1000) };
  }

  current.count += 1;
  rateLimitBuckets.set(bucketKey, current);
  const allowed = current.count <= limit;
  return {
    allowed,
    retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
