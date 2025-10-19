// Binance API Cache Layer with TTL-based expiration
// Optimizes API calls by caching responses for configurable durations

type CacheEntry<T> = {
  data: T
  timestamp: number
  expiresAt: number
}

type CacheStats = {
  hits: number
  misses: number
  evictions: number
  size: number
  hitRate: number
}

export class BinanceAPICache {
  private cache = new Map<string, CacheEntry<any>>()
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0
  }

  // TTL configuration per endpoint (in milliseconds)
  private ttlConfig: Record<string, number> = {
    '/fapi/v2/positionRisk': 5000,      // 5s - real-time positions
    '/fapi/v1/openOrders': 5000,        // 5s - real-time orders
    '/fapi/v1/premiumIndex': 10000,     // 10s - mark price
    '/fapi/v1/klines': 30000,           // 30s - chart data
    '/fapi/v1/ticker/24hr': 120000,     // 2min - volume rankings
    '/fapi/v1/ticker/bookTicker': 5000, // 5s - best bid/ask
    '/fapi/v1/depth': 5000,             // 5s - orderbook
    '/fapi/v1/exchangeInfo': 3600000,   // 1h - symbol filters (rarely change)
    '/fapi/v1/fundingRate': 3600000,    // 1h - funding rate (changes every 8h)
    '/fapi/v1/openInterest': 60000,     // 1min - open interest
    '/futures/data/openInterestHist': 120000, // 2min - OI history
    '/fapi/v1/time': 300000             // 5min - server time sync
  }

  // Get TTL for a specific endpoint (with fallback)
  private getTTL(path: string): number {
    // Exact match
    if (this.ttlConfig[path]) return this.ttlConfig[path]
    
    // Partial match (e.g. /fapi/v1/klines matches any klines call)
    for (const [key, ttl] of Object.entries(this.ttlConfig)) {
      if (path.includes(key)) return ttl
    }
    
    // Default: 10s for unknown endpoints
    return 10000
  }

  // Get cached data if valid, otherwise return null
  get<T>(key: string): T | null {
    const entry = this.cache.get(key)
    
    if (!entry) {
      this.stats.misses++
      return null
    }
    
    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      this.stats.misses++
      this.stats.evictions++
      return null
    }
    
    this.stats.hits++
    return entry.data as T
  }

  // Store data in cache with TTL
  set<T>(key: string, data: T, path: string): void {
    const ttl = this.getTTL(path)
    const now = Date.now()
    
    this.cache.set(key, {
      data,
      timestamp: now,
      expiresAt: now + ttl
    })
  }

  // Invalidate specific cache entry
  invalidate(key: string): boolean {
    return this.cache.delete(key)
  }

  // Invalidate all entries matching a pattern
  invalidatePattern(pattern: string): number {
    let count = 0
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key)
        count++
      }
    }
    return count
  }

  // Clear all cache
  clear(): void {
    this.cache.clear()
    this.stats = { hits: 0, misses: 0, evictions: 0 }
  }

  // Get cache statistics
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses
    const hitRate = total > 0 ? (this.stats.hits / total) * 100 : 0
    
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      size: this.cache.size,
      hitRate: Math.round(hitRate * 10) / 10
    }
  }

  // Periodic cleanup of expired entries
  cleanup(): number {
    const now = Date.now()
    let removed = 0
    
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key)
        removed++
      }
    }
    
    if (removed > 0) {
      console.log(`[CACHE_CLEANUP] Removed ${removed} expired entries`)
    }
    
    return removed
  }
}

// Global singleton instance
export const binanceCache = new BinanceAPICache()

// Auto-cleanup every 5 minutes
setInterval(() => {
  try {
    binanceCache.cleanup()
  } catch (e) {
    console.error('[CACHE_CLEANUP_ERROR]', e)
  }
}, 5 * 60 * 1000)

