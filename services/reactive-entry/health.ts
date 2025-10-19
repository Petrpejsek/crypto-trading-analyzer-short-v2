import { loadConfig } from './config'
import { getRateLimitStatus } from './rate_limiter'

export type HealthCheckResult = {
  ok: boolean
  config_loaded: boolean
  openai_key_exists: boolean
  rate_limit_status: {
    remaining: number
    resetMs: number
  }
  version: string
}

/**
 * Health check for Reactive Entry system
 */
export function getHealthStatus(): HealthCheckResult {
  let configLoaded = false
  let openaiKeyExists = false
  
  try {
    loadConfig()
    configLoaded = true
  } catch {}
  
  try {
    openaiKeyExists = Boolean(process.env.OPENAI_API_KEY && String(process.env.OPENAI_API_KEY).startsWith('sk-'))
  } catch {}
  
  const rateLimitStatus = getRateLimitStatus('_health_check')
  
  return {
    ok: configLoaded && openaiKeyExists,
    config_loaded: configLoaded,
    openai_key_exists: openaiKeyExists,
    rate_limit_status: rateLimitStatus,
    version: '1.0.0'
  }
}

