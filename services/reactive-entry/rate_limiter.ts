import { loadConfig } from './config'

type RateLimitEntry = {
  count: number
  windowStart: number
}

const store: Map<string, RateLimitEntry> = new Map()

/**
 * Simple in-memory rate limiter
 * Returns true if request is allowed, false if rate limit exceeded
 */
export function checkRateLimit(key: string): boolean {
  const config = loadConfig()
  const limit = config.rate_limit_per_minute
  const windowMs = 60_000 // 1 minute
  
  const now = Date.now()
  const entry = store.get(key)
  
  if (!entry || now - entry.windowStart >= windowMs) {
    // New window
    store.set(key, { count: 1, windowStart: now })
    return true
  }
  
  if (entry.count >= limit) {
    return false // Rate limit exceeded
  }
  
  entry.count++
  return true
}

/**
 * Get current rate limit status for a key
 */
export function getRateLimitStatus(key: string): { remaining: number; resetMs: number } {
  const config = loadConfig()
  const limit = config.rate_limit_per_minute
  const windowMs = 60_000
  
  const now = Date.now()
  const entry = store.get(key)
  
  if (!entry || now - entry.windowStart >= windowMs) {
    return { remaining: limit, resetMs: 0 }
  }
  
  const remaining = Math.max(0, limit - entry.count)
  const resetMs = windowMs - (now - entry.windowStart)
  
  return { remaining, resetMs }
}

/**
 * Clear all rate limit entries (for testing)
 */
export function clearRateLimits(): void {
  store.clear()
}

