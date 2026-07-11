/**
 * Redis cache — read-through helper for hot, low-write catalog/metadata reads.
 *
 * Fully OPTIONAL and graceful: if Redis is unavailable (no container, tests, CI),
 * every operation becomes a no-op and the app falls back to the database. Nothing
 * throws, so correctness never depends on the cache — only latency.
 *
 * Keys are tenant-scoped; invalidation is by prefix on catalog/source mutations.
 */
import Redis from 'ioredis';

let client: Redis | null = null;
let enabled = false;

export function initCache(): void {
  if (process.env.CACHE_DISABLED === 'true') {
    console.log('[Cache] disabled via CACHE_DISABLED');
    return;
  }
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  try {
    client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null, // do not spin retrying if Redis is absent
    });
    client.on('error', () => { enabled = false; });
    client
      .connect()
      .then(() => { enabled = true; console.log(`[Cache] Redis connected at ${url}`); })
      .catch(() => { enabled = false; console.warn('[Cache] Redis unavailable — caching disabled (DB fallback).'); });
  } catch {
    enabled = false;
  }
}

export function cacheEnabled(): boolean {
  return enabled && !!client;
}

export async function cacheGet<T = any>(key: string): Promise<T | null> {
  if (!cacheEnabled()) return null;
  try {
    const v = await client!.get(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: any, ttlSeconds = 30): Promise<void> {
  if (!cacheEnabled()) return;
  try {
    await client!.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    /* ignore cache write failures */
  }
}

/** Delete all keys matching a glob pattern (e.g. `meta:tenant_A:*`). */
export async function cacheInvalidate(pattern: string): Promise<void> {
  if (!cacheEnabled()) return;
  try {
    const keys = await client!.keys(pattern);
    if (keys.length) await client!.del(keys);
  } catch {
    /* ignore */
  }
}

/** Read-through: return cached value or run producer(), caching its result. */
export async function cached<T>(key: string, ttlSeconds: number, producer: () => Promise<T>): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;
  const value = await producer();
  await cacheSet(key, value, ttlSeconds);
  return value;
}

/** Convenience: invalidate every cached read for a tenant's catalog/metadata. */
export async function invalidateTenant(tenantId: string): Promise<void> {
  await cacheInvalidate(`meta:${tenantId}:*`);
}
