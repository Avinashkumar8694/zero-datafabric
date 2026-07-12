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

/**
 * Initialize the module-level Redis client (lazy-connect, no retry storm).
 * Safe to call once at app startup. If `CACHE_DISABLED=true`, or if the
 * connection attempt fails/errors, caching is simply left/marked disabled —
 * this function never throws, so a missing Redis instance cannot crash startup.
 * @returns Nothing; connection success/failure is reflected asynchronously via (@link cacheEnabled).
 */
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

/**
 * Report whether the Redis cache is currently usable.
 * @returns `true` only if a client exists and successfully connected; `false` in every degraded/disabled case.
 */
export function cacheEnabled(): boolean {
  return enabled && !!client;
}

/**
 * Read and JSON-parse a cached value. Never throws: a missing/disabled cache,
 * a lookup miss, or a Redis error are all treated identically as a cache miss.
 * @param key - The cache key to read.
 * @returns The parsed value if present, or `null` on a miss, disabled cache, or error.
 */
export async function cacheGet<T = any>(key: string): Promise<T | null> {
  if (!cacheEnabled()) return null;
  try {
    const v = await client!.get(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

/**
 * JSON-serialize and store a value with a TTL. A no-op (not an error) when
 * the cache is disabled/unavailable, and write failures are swallowed —
 * caching is a latency optimization, never a correctness dependency.
 * @param key - The cache key to write.
 * @param value - The value to serialize (via `JSON.stringify`) and store.
 * @param ttlSeconds - Expiry in seconds; defaults to 30.
 * @returns Resolves once the write attempt completes (success or swallowed failure).
 */
export async function cacheSet(key: string, value: any, ttlSeconds = 30): Promise<void> {
  if (!cacheEnabled()) return;
  try {
    await client!.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    /* ignore cache write failures */
  }
}

/**
 * Delete all keys matching a glob pattern (e.g. `meta:tenant_A:*`). A no-op
 * when the cache is disabled/unavailable; errors are swallowed.
 * @param pattern - A Redis `KEYS`-style glob pattern.
 * @returns Resolves once matching keys (if any) are deleted.
 */
export async function cacheInvalidate(pattern: string): Promise<void> {
  if (!cacheEnabled()) return;
  try {
    const keys = await client!.keys(pattern);
    if (keys.length) await client!.del(keys);
  } catch {
    /* ignore */
  }
}

/**
 * Read-through cache helper: return the cached value for `key` if present,
 * otherwise call `producer()`, cache its result, and return it. When the
 * cache is disabled, this degrades to always calling `producer()`.
 * @param key - The cache key.
 * @param ttlSeconds - Expiry in seconds for a freshly-produced value.
 * @param producer - Async function that computes the value on a cache miss.
 * @returns The cached or freshly-produced value.
 */
export async function cached<T>(key: string, ttlSeconds: number, producer: () => Promise<T>): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;
  const value = await producer();
  await cacheSet(key, value, ttlSeconds);
  return value;
}

/**
 * Convenience wrapper: invalidate every cached read for a tenant's
 * catalog/metadata (all keys under the `meta:<tenantId>:*` prefix).
 * @param tenantId - The tenant whose cached reads should be invalidated.
 * @returns Resolves once matching keys are deleted.
 */
export async function invalidateTenant(tenantId: string): Promise<void> {
  await cacheInvalidate(`meta:${tenantId}:*`);
}
