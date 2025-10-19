// Health Monitor - In-Memory Ring Buffer Store
// Stores health history (max 50 samples per symbol) and worker registry

import type { HealthOutput, HealthWorkerEntry } from './types'
import { MAX_SAMPLES_PER_SYMBOL } from './types'

// Ring buffer: symbol → array of HealthOutput (max 50)
const healthHistory = new Map<string, HealthOutput[]>()

// Worker registry: key → WorkerEntry
// Key format: 
//   - Positions: "symbol" (e.g. "BTCUSDT")
//   - Pending orders: "symbol:orderId" (e.g. "ETHUSDT:12345678")
const workerRegistry = new Map<string, HealthWorkerEntry>()

/**
 * Store health output in ring buffer
 * Auto-cleanup: keep max 50 samples per symbol
 */
export function storeHealthOutput(output: HealthOutput): void {
  try {
    const { symbol } = output
    if (!symbol) return

    const history = healthHistory.get(symbol) || []
    history.push(output)

    // Ring buffer: keep only last MAX_SAMPLES_PER_SYMBOL
    if (history.length > MAX_SAMPLES_PER_SYMBOL) {
      history.splice(0, history.length - MAX_SAMPLES_PER_SYMBOL)
    }

    healthHistory.set(symbol, history)
  } catch (e) {
    console.error('[HEALTH_STORE_ERR]', (e as any)?.message || e)
  }
}

/**
 * Get latest health output for symbol
 */
export function getLatestHealth(symbol: string): HealthOutput | null {
  try {
    const history = healthHistory.get(symbol)
    if (!history || history.length === 0) return null
    return history[history.length - 1]
  } catch {
    return null
  }
}

/**
 * Get full health history for symbol
 */
export function getHealthHistory(symbol: string): HealthOutput[] {
  try {
    return healthHistory.get(symbol) || []
  } catch {
    return []
  }
}

/**
 * Clear health history for symbol
 */
export function clearHealthHistory(symbol: string): void {
  try {
    healthHistory.delete(symbol)
  } catch {}
}

/**
 * Get all symbols with health data
 */
export function getAllSymbolsWithHealth(): string[] {
  try {
    return Array.from(healthHistory.keys())
  } catch {
    return []
  }
}

// ============================================
// Worker Registry
// ============================================

/**
 * Register or update worker entry
 */
export function setWorkerEntry(key: string, entry: HealthWorkerEntry): void {
  try {
    workerRegistry.set(key, entry)
  } catch (e) {
    console.error('[HEALTH_WORKER_REGISTRY_SET_ERR]', (e as any)?.message || e)
  }
}

/**
 * Get worker entry by key
 */
export function getWorkerEntry(key: string): HealthWorkerEntry | null {
  try {
    return workerRegistry.get(key) || null
  } catch {
    return null
  }
}

/**
 * Remove worker entry
 */
export function removeWorkerEntry(key: string): void {
  try {
    workerRegistry.delete(key)
  } catch {}
}

/**
 * Get all worker entries
 */
export function getAllWorkerEntries(): HealthWorkerEntry[] {
  try {
    return Array.from(workerRegistry.values())
  } catch {
    return []
  }
}

/**
 * Get worker entries that are due for health check
 */
export function getDueWorkerEntries(): HealthWorkerEntry[] {
  try {
    const now = Date.now()
    return Array.from(workerRegistry.values()).filter((entry) => {
      const nextRun = new Date(entry.nextRunAt).getTime()
      return nextRun <= now && entry.status === 'waiting'
    })
  } catch {
    return []
  }
}

/**
 * Clear all worker entries
 */
export function clearWorkerRegistry(): void {
  try {
    workerRegistry.clear()
  } catch {}
}

/**
 * Get worker entry by symbol (for positions)
 */
export function getWorkerEntryBySymbol(symbol: string): HealthWorkerEntry | null {
  try {
    return workerRegistry.get(symbol) || null
  } catch {
    return null
  }
}

/**
 * Get worker entry by symbol and orderId (for pending orders)
 */
export function getWorkerEntryByOrder(symbol: string, orderId: number): HealthWorkerEntry | null {
  try {
    const key = `${symbol}:${orderId}`
    return workerRegistry.get(key) || null
  } catch {
    return null
  }
}

/**
 * Build worker registry key
 */
export function buildWorkerKey(type: 'position' | 'pending_order', symbol: string, orderId?: number): string {
  if (type === 'pending_order' && orderId) {
    return `${symbol}:${orderId}`
  }
  return symbol
}

