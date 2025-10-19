// Health Monitor - Worker
// Main orchestrator for periodic health checks

import type { HealthWorkerEntry } from './types'
import { 
  TICK_INTERVAL_MS, 
  JITTER_MIN_MS, 
  JITTER_MAX_MS,
  CHECK_INTERVAL_MS 
} from './types'
import {
  setWorkerEntry,
  getWorkerEntry,
  removeWorkerEntry,
  getAllWorkerEntries,
  getDueWorkerEntries,
  buildWorkerKey,
  storeHealthOutput
} from './store'
import { buildMarketRawSnapshot } from '../../server/fetcher/binance'
import { buildHealthPayload, buildHealthPayloadForPendingOrder, validatePayload, normalizeSymbolForMarketData } from './payload_builder'
import { calculateHealth } from './calculator'
import { runHealthMonitorGPT } from './health_monitor_gpt'
import { validateAndSanitize } from './validator'
import { 
  auditWorkerEvent, 
  auditWorkerSync, 
  auditBatchStart, 
  auditBatchComplete,
  auditHealthCheck,
  auditHealthError,
  auditHealthSyncTrigger
} from './audit'
import { getPositionsInMemory, getOpenOrdersInMemory } from '../exchange/binance/userDataWs'

// Worker state
let workerEnabled = false
let checkInterval: NodeJS.Timeout | null = null
let syncInterval: NodeJS.Timeout | null = null

/**
 * Generate jitter for next run scheduling
 */
function generateJitter(): number {
  return Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS + 1)) + JITTER_MIN_MS
}

/**
 * Start health monitor worker
 */
export function startHealthMonitorWorker(): void {
  if (workerEnabled) {
    console.warn('[HEALTH_WORKER] Already running')
    return
  }
  
  const provider = process.env.HEALTH_MONITOR_PROVIDER || 'server'
  const model = provider === 'gpt' 
    ? (process.env.HEALTH_MONITOR_MODEL || 'gpt-4o-mini')
    : 'server_calculator'
  
  console.info('[HEALTH_INIT]', {
    provider,
    model,
    tick_interval_ms: TICK_INTERVAL_MS,
    jitter_range_ms: [JITTER_MIN_MS, JITTER_MAX_MS],
    check_interval_ms: CHECK_INTERVAL_MS
  })
  
  workerEnabled = true
  auditWorkerEvent('start', { provider, model })
  
  // Initial sync
  syncWithOpenPositions('initial').catch(e => {
    console.error('[HEALTH_WORKER_SYNC_ERR]', (e as any)?.message || e)
  })
  
  // Periodic sync every 30 seconds (backup mechanism)
  syncInterval = setInterval(() => {
    if (!workerEnabled) return
    syncWithOpenPositions('periodic').catch(e => {
      console.error('[HEALTH_WORKER_PERIODIC_SYNC_ERR]', (e as any)?.message || e)
    })
  }, 30_000) // 30 seconds
  
  // Periodic check for due entries
  checkInterval = setInterval(() => {
    if (!workerEnabled) return
    processDueHealthChecks().catch(e => {
      console.error('[HEALTH_WORKER_CHECK_ERR]', (e as any)?.message || e)
    })
  }, CHECK_INTERVAL_MS)
}

/**
 * Stop health monitor worker
 */
export function stopHealthMonitorWorker(): void {
  if (!workerEnabled) return
  
  workerEnabled = false
  
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
  
  if (syncInterval) {
    clearInterval(syncInterval)
    syncInterval = null
  }
  
  auditWorkerEvent('stop')
  console.info('[HEALTH_WORKER_STOP]')
}

/**
 * Check if worker is enabled
 */
export function isHealthMonitorEnabled(): boolean {
  return workerEnabled
}

/**
 * Sync worker registry with open positions and pending orders
 */
export async function syncWithOpenPositions(source?: 'websocket' | 'periodic' | 'rehydrate' | 'initial'): Promise<void> {
  try {
    // Fetch open positions
    const positions = getPositionsInMemory()
    const openPositions = positions.filter(p => {
      const size = Math.abs(Number(p?.positionAmt || 0))
      return size > 0
    })
    
    // Fetch ALL SELL entry orders from Binance (not just Entry Updater tracked)
    const allOpenOrders = getOpenOrdersInMemory()
    const pendingOrders = allOpenOrders.filter(o => {
      const side = String(o?.side || '').toUpperCase()
      const reduceOnly = Boolean(o?.reduceOnly)
      const closePosition = Boolean(o?.closePosition)
      const orderId = Number(o?.orderId)
      
      // SELL entry orders only (SHORT system)
      return side === 'SELL' && !reduceOnly && !closePosition && orderId > 0
    })
    
    console.info('[HEALTH_WORKER_SYNC]', { 
      open_positions: openPositions.length,
      positions: openPositions.map(p => p.symbol),
      sell_entry_orders: pendingOrders.length,
      orders: pendingOrders.map(o => ({ symbol: o.symbol, orderId: o.orderId, type: o.type }))
    })
    
    const existingKeys = new Set(getAllWorkerEntries().map(e => 
      buildWorkerKey(e.type, e.symbol, e.orderId || undefined)
    ))
    
    const validKeys = new Set<string>()
    
    // Register positions
    for (const pos of openPositions) {
      const symbol = String(pos?.symbol || '')
      if (!symbol) continue
      
      const key = buildWorkerKey('position', symbol)
      validKeys.add(key)
      
      const existing = getWorkerEntry(key)
      if (!existing) {
        // New position - create worker entry
        const jitter = generateJitter()
        const entry: HealthWorkerEntry = {
          symbol,
          side: 'SHORT',
          status: 'waiting',
          nextRunAt: new Date(Date.now() + jitter).toISOString(),
          lastRunAt: null,
          lastOutput: null,
          lastError: null,
          tickCount: 0,
          type: 'position',
          orderId: null
        }
        setWorkerEntry(key, entry)
        console.info('[HEALTH_WORKER_REG_POS]', { symbol, nextRunIn: `${(jitter / 1000).toFixed(0)}s` })
      }
    }
    
    // Register pending orders
    for (const order of pendingOrders) {
      const symbol = String(order?.symbol || '')
      const orderId = Number(order?.orderId)
      if (!symbol || !orderId) continue
      
      const key = buildWorkerKey('pending_order', symbol, orderId)
      validKeys.add(key)
      
      const existing = getWorkerEntry(key)
      if (!existing) {
        // New pending order - create worker entry
        const jitter = generateJitter()
        
        // Extract entry price from order (limit price or stop price)
        const limitPrice = Number(order?.price)
        const stopPrice = Number(order?.stopPrice)
        const entryPrice = Number.isFinite(limitPrice) && limitPrice > 0 
          ? limitPrice 
          : (Number.isFinite(stopPrice) && stopPrice > 0 ? stopPrice : 0)
        
        const entry: HealthWorkerEntry = {
          symbol,
          side: 'SHORT', // system always trades SHORT
          status: 'waiting',
          nextRunAt: new Date(Date.now() + jitter).toISOString(),
          lastRunAt: null,
          lastOutput: null,
          lastError: null,
          tickCount: 0,
          type: 'pending_order',
          orderId
        }
        setWorkerEntry(key, entry)
        console.info('[HEALTH_WORKER_REG_ORDER]', { 
          symbol, 
          orderId,
          key,
          entryPrice,
          nextRunIn: `${(jitter / 1000).toFixed(0)}s` 
        })
      }
    }
    
    // Cleanup closed positions/orders
    for (const key of existingKeys) {
      if (!validKeys.has(key)) {
        removeWorkerEntry(key)
        console.info('[HEALTH_WORKER_CLEANUP]', { key })
      }
    }
    
    auditWorkerSync(openPositions.length, pendingOrders.length, validKeys.size)
    
    // Audit sync trigger if source is specified
    if (source && source !== 'initial') {
      auditHealthSyncTrigger(source, pendingOrders.length)
    }
    
  } catch (e) {
    console.error('[HEALTH_WORKER_SYNC_ERR]', (e as any)?.message || e)
  }
}

/**
 * Process all due health checks (batch)
 */
// Track last sync time to throttle periodic resyncs
let lastPeriodicSync = 0
const PERIODIC_SYNC_INTERVAL_MS = 30_000 // 30 seconds

async function processDueHealthChecks(): Promise<void> {
  try {
    const dueEntries = getDueWorkerEntries()
    
    if (dueEntries.length === 0) {
      // Periodic resync every 30 seconds to catch new positions
      const now = Date.now()
      if (now - lastPeriodicSync >= PERIODIC_SYNC_INTERVAL_MS) {
        lastPeriodicSync = now
        console.info('[HEALTH_WORKER_PERIODIC_SYNC] Syncing to catch new positions...')
        syncWithOpenPositions().catch(() => {})
      }
      return
    }
    
    console.info('[HEALTH_WORKER_DUE]', { count: dueEntries.length })
    
    // Process in batch
    await processBatchHealthChecks(dueEntries)
    
    // Periodic resync after processing to catch new positions (throttled)
    const now = Date.now()
    if (now - lastPeriodicSync >= PERIODIC_SYNC_INTERVAL_MS) {
      lastPeriodicSync = now
      console.info('[HEALTH_WORKER_PERIODIC_SYNC] Syncing to catch new positions...')
      syncWithOpenPositions().catch(() => {})
    }
    
  } catch (e) {
    console.error('[HEALTH_WORKER_DUE_ERR]', (e as any)?.message || e)
  }
}

/**
 * Process health checks in batch (shared market data fetch)
 */
async function processBatchHealthChecks(entries: HealthWorkerEntry[]): Promise<void> {
  const t0 = performance.now()
  
  try {
    // Extract unique symbols (normalize quarterly contracts)
    const symbols = Array.from(new Set(
      entries.map(e => normalizeSymbolForMarketData(e.symbol))
    ))
    
    auditBatchStart(symbols)
    
    // SINGLE API CALL for all symbols
    const snapshot = await buildMarketRawSnapshot({
      includeSymbols: symbols,
      fresh: true,
      allowPartial: true,
      desiredTopN: 20
    })
    
    let successCount = 0
    let errorCount = 0
    
    // Process each entry with shared snapshot
    for (const entry of entries) {
      try {
        await processSingleHealthCheckWithData(entry, snapshot)
        successCount++
      } catch (e) {
        console.error('[HEALTH_SINGLE_ERR]', {
          symbol: entry.symbol,
          type: entry.type,
          error: (e as any)?.message || e
        })
        errorCount++
        
        // Update entry with error
        const key = buildWorkerKey(entry.type, entry.symbol, entry.orderId || undefined)
        const updated = getWorkerEntry(key)
        if (updated) {
          updated.lastError = String((e as any)?.message || e)
          updated.status = 'waiting'
          updated.nextRunAt = new Date(Date.now() + TICK_INTERVAL_MS + generateJitter()).toISOString()
          setWorkerEntry(key, updated)
        }
      }
    }
    
    const totalMs = Math.round(performance.now() - t0)
    auditBatchComplete(successCount, errorCount, totalMs)
    
  } catch (e) {
    const totalMs = Math.round(performance.now() - t0)
    console.error('[HEALTH_BATCH_ERR]', {
      error: (e as any)?.message || e,
      total_ms: totalMs
    })
  }
}

/**
 * Process single health check with pre-fetched market data
 */
async function processSingleHealthCheckWithData(
  entry: HealthWorkerEntry,
  snapshot: any
): Promise<void> {
  const t0 = performance.now()
  const { symbol, type } = entry
  const key = buildWorkerKey(type, symbol, entry.orderId || undefined)
  
  try {
    // Mark as processing
    entry.status = 'processing'
    setWorkerEntry(key, entry)
    
    // Calculate health (different logic for pending orders vs positions)
    const provider = process.env.HEALTH_MONITOR_PROVIDER || 'server'
    let healthOutput
    
    if (type === 'pending_order' && entry.orderId) {
      // ============================================
      // PENDING ORDER BRANCH
      // ============================================
      
      // 1. Find order in Binance open orders snapshot (not Entry Updater!)
      const allOpenOrders = getOpenOrdersInMemory()
      const order = allOpenOrders.find(o => Number(o.orderId) === entry.orderId)
      
      if (!order) {
        throw new Error('pending_order_not_found_in_binance')
      }
      
      // 2. Extract entry price from order
      const limitPrice = Number(order?.price)
      const stopPrice = Number(order?.stopPrice)
      const entryPrice = Number.isFinite(limitPrice) && limitPrice > 0 
        ? limitPrice 
        : (Number.isFinite(stopPrice) && stopPrice > 0 ? stopPrice : 0)
      
      if (!entryPrice || entryPrice <= 0) {
        throw new Error('invalid_entry_price')
      }
      
      // 3. Get planned TP from waiting_tp.json (if exists)
      let plannedTP: number | null = null
      try {
        const tradingModule = await import('../trading/binance_futures')
        if (tradingModule && typeof tradingModule.getWaitingTpList === 'function') {
          const waitingList = tradingModule.getWaitingTpList()
          const waitingTp = waitingList.find((w: any) => w.symbol === symbol)
          plannedTP = waitingTp?.tp || null
        }
      } catch (e) {
        // Waiting TP not available - continue without it
        console.debug('[HEALTH_WORKER_PENDING] No waiting_tp for', symbol, (e as any)?.message)
      }
      
      // 4. Build pending-specific payload
      const pendingPayload = buildHealthPayloadForPendingOrder(
        snapshot,
        symbol,
        entryPrice,
        plannedTP
      )
      
      validatePayload(pendingPayload)
      
      // 5. Calculate with pending context
      if (provider === 'gpt') {
        // GPT doesn't support pending context yet - use standard calculation
        healthOutput = await runHealthMonitorGPT(pendingPayload)
      } else {
        healthOutput = calculateHealth(pendingPayload, {
          isPendingOrder: true,
          orderPrice: entryPrice,
          plannedTP
        })
      }
      
    } else {
      // ============================================
      // POSITION BRANCH (existing logic)
      // ============================================
      
      // Build payload
      const payload = buildHealthPayload(snapshot, symbol)
      validatePayload(payload)
      
      // Calculate health
      if (provider === 'gpt') {
        healthOutput = await runHealthMonitorGPT(payload)
      } else {
        healthOutput = calculateHealth(payload)
      }
    }
    
    // Validate
    const validated = validateAndSanitize(healthOutput)
    
    // Store in ring buffer
    storeHealthOutput(validated)
    
    // Update worker entry
    const latency = Math.round(performance.now() - t0)
    entry.status = 'waiting'
    entry.lastRunAt = new Date().toISOString()
    entry.nextRunAt = new Date(Date.now() + TICK_INTERVAL_MS + generateJitter()).toISOString()
    entry.lastOutput = validated
    entry.lastError = null
    entry.tickCount++
    setWorkerEntry(key, entry)
    
    // Audit
    auditHealthCheck(validated, latency, provider === 'gpt' ? 'gpt' : 'server')
    
    console.info('[HEALTH_CHECK_DONE]', {
      symbol,
      type,
      health: validated.health_pct,
      success: validated.success_prob_pct,
      latency_ms: latency,
      status: 'OK'
    })
    
  } catch (e) {
    const latency = Math.round(performance.now() - t0)
    const errorMsg = String((e as any)?.message || e)
    
    auditHealthError(symbol, errorMsg, latency, process.env.HEALTH_MONITOR_PROVIDER as any)
    
    // Update entry
    entry.status = 'waiting'
    entry.lastError = errorMsg
    entry.nextRunAt = new Date(Date.now() + TICK_INTERVAL_MS + generateJitter()).toISOString()
    setWorkerEntry(key, entry)
    
    throw e
  }
}

