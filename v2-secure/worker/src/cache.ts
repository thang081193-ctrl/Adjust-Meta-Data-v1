// KV-backed cache for Adjust responses. Keyed by SHA-256 of (user|endpoint|params)
// so users with different `allowed_apps` scopes don't collide. TTL matches the
// extension's old in-storage 5-min freshness rule, so swapping clients is a no-op
// for the user-perceived sync cadence.
//
// Cache write uses ctx.waitUntil so the response returns immediately while the
// KV PUT lands in the background — 50-80ms saved per cache miss.

const DEFAULT_TTL_SECONDS = 5 * 60;

export async function getOrFetch<T>(
  ctx: ExecutionContext,
  cache: KVNamespace,
  keyParts: string[],
  fetchFn: () => Promise<T>,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<{ data: T; fromCache: boolean }> {
  const key = await sha256(keyParts.join('|'));
  const cached = await cache.get(key);
  if (cached) {
    try {
      return { data: JSON.parse(cached) as T, fromCache: true };
    } catch {
      // Bad cache entry; fall through to refetch.
    }
  }
  const fresh = await fetchFn();
  ctx.waitUntil(cache.put(key, JSON.stringify(fresh), { expirationTtl: ttlSeconds }));
  return { data: fresh, fromCache: false };
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
