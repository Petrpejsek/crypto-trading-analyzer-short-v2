// Health Monitor - React Hook
// Polling hook for real-time health data with jitter

import { useState, useEffect, useRef, useCallback } from 'react'

type HealthOutput = {
  version: string
  symbol: string
  health_pct: number
  success_prob_pct: number
  tp_hit_probs_pct: {
    tp1: number
    tp2: number
    tp3: number
  }
  sl_touch_prob_pct: number
  segments: {
    green_pct: number
    orange_pct: number
    red_pct: number
  }
  bias_score: number
  momentum_score: number
  bias_label: string
  momentum_label: string
  reasons: string[]
  hard_fail: boolean
  updated_at_utc: string
}

type UseHealthMonitorReturn = {
  health: number | null
  lastUpdated: string | null
  isStale: boolean
  staleReason: string | undefined
  fullOutput: HealthOutput | null
  refresh: () => void
}

const POLL_INTERVAL_MS = 60_000 // 60 seconds
const JITTER_MIN_MS = 5_000 // 5 seconds
const JITTER_MAX_MS = 15_000 // 15 seconds

function generateJitter(): number {
  return Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS + 1)) + JITTER_MIN_MS
}

/**
 * Hook for polling health monitor data
 * Automatically polls every 60s + jitter (5-15s)
 * Fail-closed: on error, keeps last valid state + STALE flag
 */
export function useHealthMonitor(symbol: string): UseHealthMonitorReturn {
  const [health, setHealth] = useState<number | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const [isStale, setIsStale] = useState(false)
  const [staleReason, setStaleReason] = useState<string | undefined>(undefined)
  const [fullOutput, setFullOutput] = useState<HealthOutput | null>(null)
  
  const abortControllerRef = useRef<AbortController | null>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const isMountedRef = useRef(true)

  const fetchHealth = useCallback(async () => {
    if (!symbol) return
    
    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    
    const controller = new AbortController()
    abortControllerRef.current = controller
    
    try {
      const response = await fetch('/api/health_monitor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        },
        body: JSON.stringify({ symbol }),
        signal: controller.signal
      })
      
      if (response.status === 204) {
        // No health data yet
        if (isMountedRef.current) {
          setIsStale(true)
          setStaleReason('No health data available yet')
        }
        return
      }
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      
      const data: HealthOutput = await response.json()
      
      if (isMountedRef.current) {
        setHealth(data.health_pct)
        setFullOutput(data)
        setLastUpdated(data.updated_at_utc)
        setIsStale(false)
        setStaleReason(undefined)
      }
      
    } catch (error: any) {
      // Ignore abort errors
      if (error.name === 'AbortError') return
      
      // On error, keep last data but mark as stale
      if (isMountedRef.current) {
        setIsStale(true)
        setStaleReason(error?.message || 'Fetch error')
        console.error('[HEALTH_MONITOR_HOOK_ERR]', { symbol, error: error?.message })
      }
    }
  }, [symbol])

  const refresh = useCallback(() => {
    fetchHealth()
  }, [fetchHealth])

  useEffect(() => {
    isMountedRef.current = true
    
    if (!symbol) return
    
    // Initial fetch with jitter
    const initialJitter = generateJitter()
    const initialTimer = window.setTimeout(() => {
      fetchHealth()
    }, initialJitter)
    
    // Schedule periodic polling
    const scheduleNext = () => {
      const nextInterval = POLL_INTERVAL_MS + generateJitter()
      timerRef.current = window.setTimeout(() => {
        fetchHealth()
        scheduleNext() // Re-schedule next
      }, nextInterval)
    }
    
    // Start periodic polling after initial fetch
    const startPollingTimer = window.setTimeout(() => {
      scheduleNext()
    }, initialJitter + 100) // Small buffer after initial fetch
    
    return () => {
      isMountedRef.current = false
      
      // Cleanup timers
      if (initialTimer) clearTimeout(initialTimer)
      if (startPollingTimer) clearTimeout(startPollingTimer)
      if (timerRef.current) clearTimeout(timerRef.current)
      
      // Abort pending request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [symbol, fetchHealth])

  return {
    health,
    lastUpdated,
    isStale,
    staleReason,
    fullOutput,
    refresh
  }
}

