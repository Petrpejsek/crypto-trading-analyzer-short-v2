/**
 * Freshness Guard - Validate snapshot timestamp freshness
 * 
 * Ensures AI assistants receive fresh market data by validating
 * snapshot timestamps against current time.
 */

export type FreshnessResult = {
  ok: boolean
  age_ms: number
  age_seconds: number
  error?: string
}

/**
 * Validate snapshot freshness
 * 
 * @param snapshot - Object with timestamp field (ISO string or Unix ms)
 * @param maxAgeMs - Maximum allowed age in milliseconds (default: 60s)
 * @returns Validation result with age and error if stale
 */
export function validateSnapshotFreshness(
  snapshot: { timestamp: string | number } | null | undefined,
  maxAgeMs: number = 60000 // default 60s
): FreshnessResult {
  if (!snapshot || !snapshot.timestamp) {
    return {
      ok: false,
      age_ms: -1,
      age_seconds: -1,
      error: 'Snapshot missing or no timestamp field'
    }
  }

  const now = Date.now()
  
  // Handle both ISO string and Unix timestamp
  let snapTime: number
  if (typeof snapshot.timestamp === 'string') {
    snapTime = new Date(snapshot.timestamp).getTime()
  } else {
    snapTime = snapshot.timestamp > 1e12 ? snapshot.timestamp : snapshot.timestamp * 1000
  }

  // Validate timestamp is valid
  if (!Number.isFinite(snapTime) || snapTime <= 0) {
    return {
      ok: false,
      age_ms: -1,
      age_seconds: -1,
      error: `Invalid timestamp: ${snapshot.timestamp}`
    }
  }

  const age = now - snapTime
  
  // Check for future timestamps (clock skew)
  if (age < 0) {
    return {
      ok: false,
      age_ms: age,
      age_seconds: age / 1000,
      error: `Timestamp is in the future (clock skew: ${(-age / 1000).toFixed(1)}s)`
    }
  }

  if (age > maxAgeMs) {
    return {
      ok: false,
      age_ms: age,
      age_seconds: age / 1000,
      error: `Snapshot too stale: ${(age / 1000).toFixed(0)}s old (max ${maxAgeMs / 1000}s)`
    }
  }

  return {
    ok: true,
    age_ms: age,
    age_seconds: age / 1000
  }
}

/**
 * Validate candle freshness
 * 
 * @param lastCandle - Last candle with closeTime
 * @param maxAgeMs - Maximum allowed age (default: 5 minutes for M5 candles)
 * @returns Validation result
 */
export function validateCandleFreshness(
  lastCandle: { closeTime: string | number } | null | undefined,
  maxAgeMs: number = 300000 // default 5 minutes
): FreshnessResult {
  if (!lastCandle || !lastCandle.closeTime) {
    return {
      ok: false,
      age_ms: -1,
      age_seconds: -1,
      error: 'Last candle missing or no closeTime'
    }
  }

  const now = Date.now()
  
  // Handle both ISO string and Unix timestamp
  let closeTime: number
  if (typeof lastCandle.closeTime === 'string') {
    closeTime = new Date(lastCandle.closeTime).getTime()
  } else {
    closeTime = lastCandle.closeTime > 1e12 ? lastCandle.closeTime : lastCandle.closeTime * 1000
  }

  if (!Number.isFinite(closeTime) || closeTime <= 0) {
    return {
      ok: false,
      age_ms: -1,
      age_seconds: -1,
      error: `Invalid closeTime: ${lastCandle.closeTime}`
    }
  }

  const age = now - closeTime

  if (age < 0) {
    return {
      ok: false,
      age_ms: age,
      age_seconds: age / 1000,
      error: `Candle closeTime is in the future (clock skew: ${(-age / 1000).toFixed(1)}s)`
    }
  }

  if (age > maxAgeMs) {
    return {
      ok: false,
      age_ms: age,
      age_seconds: age / 1000,
      error: `Last candle too stale: ${(age / 1000).toFixed(0)}s old (max ${maxAgeMs / 1000}s)`
    }
  }

  return {
    ok: true,
    age_ms: age,
    age_seconds: age / 1000
  }
}

