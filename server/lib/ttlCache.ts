const store: Map<string, { expires: number; data: any }> = new Map()

export function makeKey(path: string, params?: Record<string, string | number>): string {
  const qs = params
    ? Object.entries(params)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join('&')
    : ''
  return qs ? `${path}?${qs}` : path
}

export function ttlGet<T = any>(key: string): T | undefined {
  const hit = store.get(key)
  if (!hit) return undefined
  if (Date.now() >= hit.expires) {
    store.delete(key)
    return undefined
  }
  return hit.data as T
}

export function ttlSet<T = any>(key: string, data: T, ttlMs: number): void {
  store.set(key, { data, expires: Date.now() + Math.max(0, ttlMs) })
}


