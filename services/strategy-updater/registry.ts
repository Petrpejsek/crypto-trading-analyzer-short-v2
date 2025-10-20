import fs from 'node:fs'
import path from 'node:path'

// Strategy Updater Registry - tracks 5min timers for internal positions
export type StrategyUpdaterEntry = {
  symbol: string
  side: 'LONG' | 'SHORT'
  entryPrice: number
  positionSize: number
  currentSL: number | null
  currentTP: number | null
  triggerAt: string  // ISO timestamp when update should trigger
  since: string      // ISO timestamp when position was first detected
  lastCheck: string | null
  checks: number
  status: 'waiting' | 'processing' | 'completed'
  lastError?: string | null
  lastErrorAt?: string | null
}

const strategyUpdaterBySymbol: Record<string, StrategyUpdaterEntry> = {}
const REGISTRY_DIR = path.resolve(process.cwd(), 'runtime')
const REGISTRY_FILE = path.resolve(REGISTRY_DIR, 'strategy_updater.json')
const ORDERS_FILE = path.resolve(REGISTRY_DIR, 'strategy_updater_orders.json')
const UPDATE_DELAY_MS = 3 * 60 * 1000 // 3 minutes between checks
const INITIAL_DELAY_MS = 2 * 60 * 1000 // first run 2 minutes after detection (can be overridden)

// Track orderIds created by Strategy Updater so UI can highlight them reliably
const strategyUpdaterOrderIds = new Set<number>()

// CRITICAL: Persist order IDs to disk so they survive server restarts
function persistOrderIds(): void {
  try {
    if (!fs.existsSync(REGISTRY_DIR)) fs.mkdirSync(REGISTRY_DIR, { recursive: true })
    fs.writeFileSync(ORDERS_FILE, JSON.stringify({
      ts: new Date().toISOString(),
      orderIds: Array.from(strategyUpdaterOrderIds)
    }, null, 2), 'utf8')
  } catch (e) {
    console.error('[STRATEGY_UPDATER_PERSIST_ORDERS_ERR]', (e as any)?.message || e)
  }
}

export function markStrategyOrders(orderIds: Array<number | undefined | null>): void {
  try {
    let changed = false
    for (const id of orderIds) {
      const n = Number(id)
      if (Number.isFinite(n) && n > 0 && !strategyUpdaterOrderIds.has(n)) {
        strategyUpdaterOrderIds.add(n)
        changed = true
      }
    }
    if (changed) persistOrderIds()
  } catch {}
}

export function isStrategyOrderId(orderId: number | string | undefined | null): boolean {
  try {
    const n = Number(orderId)
    return Number.isFinite(n) && strategyUpdaterOrderIds.has(n)
  } catch { return false }
}

// --- Shared chosen plan from Entry Risk (GO/NO-GO) ---
type RiskStyle = 'conservative' | 'aggressive'
export type RiskTpLevel = { tag: 'tp1' | 'tp2' | 'tp3'; price: number; allocation_pct: number }
export type RiskChosenPlan = {
  style: RiskStyle
  entry: number
  sl: number
  tp_levels: RiskTpLevel[]
  reasoning?: string
}
export type RiskPlanRecord = { plan: RiskChosenPlan; posture: 'OK' | 'CAUTION' | 'NO-TRADE'; ts: number }
const RISK_TTL_MS = 30 * 60 * 1000
const riskPlanBySymbol: Record<string, RiskPlanRecord> = {}

export function setRiskChosenPlan(symbol: string, plan: RiskChosenPlan, posture: 'OK' | 'CAUTION' | 'NO-TRADE'): void {
  try {
    if (!symbol || !plan || !posture) return
    const sym = String(symbol).toUpperCase()
    // Minimal validation (strict numbers, no fallbacks)
    const numsOk = Number.isFinite(plan.entry) && plan.entry > 0 && Number.isFinite(plan.sl) && plan.sl > 0 && Array.isArray(plan.tp_levels) && plan.tp_levels.length >= 1
    if (!numsOk) return
    riskPlanBySymbol[sym] = { plan: { style: plan.style, entry: Number(plan.entry), sl: Number(plan.sl), tp_levels: plan.tp_levels.map(l => ({ tag: l.tag, price: Number(l.price), allocation_pct: Number(l.allocation_pct) })), reasoning: plan.reasoning }, posture, ts: Date.now() }
  } catch {}
}

export function getRiskChosenPlan(symbol: string): RiskPlanRecord | null {
  try {
    const sym = String(symbol || '').toUpperCase()
    const rec = riskPlanBySymbol[sym]
    if (!rec) return null
    if ((Date.now() - rec.ts) > RISK_TTL_MS) {
      try { delete riskPlanBySymbol[sym] } catch {}
      return null
    }
    return rec
  } catch { return null }
}

function persistRegistry(): void {
  try {
    if (!fs.existsSync(REGISTRY_DIR)) fs.mkdirSync(REGISTRY_DIR, { recursive: true })
    // CRITICAL FIX: Persist both 'waiting' AND 'processing' entries (not just 'waiting')
    // Otherwise, entries in 'processing' state are lost on server restart
    const payload = Object.values(strategyUpdaterBySymbol)
      .filter(entry => entry.status === 'waiting' || entry.status === 'processing')
      .sort((a, b) => new Date(a.since).getTime() - new Date(b.since).getTime())
    
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({
      ts: new Date().toISOString(),
      entries: payload
    }, null, 2), 'utf8')
  } catch (e) {
    console.error('[STRATEGY_UPDATER_PERSIST_ERR]', (e as any)?.message || e)
  }
}

export function getStrategyUpdaterList(): StrategyUpdaterEntry[] {
  try {
    return Object.values(strategyUpdaterBySymbol).filter(entry => entry.status === 'waiting' || entry.status === 'processing')
  } catch {
    return []
  }
}

export function scheduleStrategyUpdate(
  symbol: string,
  side: 'LONG' | 'SHORT',
  entryPrice: number,
  positionSize: number,
  currentSL: number | null,
  currentTP: number | null,
  options?: { initialDelayMs?: number }
): void {
  try {
    const existing = strategyUpdaterBySymbol[symbol]
    const now = new Date()
    const initialDelayMs = Number(options?.initialDelayMs ?? INITIAL_DELAY_MS)

    // If entry already exists (waiting/processing), update mutable fields only,
    // DO NOT reset triggerAt/since – prevents countdown resets on every poll.
    if (existing && (existing.status === 'waiting' || existing.status === 'processing')) {
      existing.side = side
      existing.entryPrice = entryPrice
      existing.positionSize = positionSize
      existing.currentSL = currentSL
      existing.currentTP = currentTP
      // Keep existing.triggerAt and existing.since intact
      persistRegistry()
      console.info('[STRATEGY_UPDATER_UPSERT_NO_RESET]', {
        symbol,
        triggerAt: existing.triggerAt,
        status: existing.status
      })
      return
    }

    // Fresh schedule
    const triggerAt = new Date(now.getTime() + initialDelayMs)
    strategyUpdaterBySymbol[symbol] = {
      symbol,
      side,
      entryPrice,
      positionSize,
      currentSL,
      currentTP,
      triggerAt: triggerAt.toISOString(),
      since: now.toISOString(),
      lastCheck: null,
      checks: 0,
      status: 'waiting',
      lastError: null,
      lastErrorAt: null
    }
    persistRegistry()
    console.info('[STRATEGY_UPDATER_SCHEDULED]', {
      symbol,
      side,
      entryPrice,
      triggerAt: triggerAt.toISOString(),
      initialDelayMs
    })
  } catch (e) {
    console.error('[STRATEGY_UPDATER_SCHEDULE_ERR]', (e as any)?.message || e)
  }
}

export function markStrategyUpdateCompleted(symbol: string): void {
  try {
    if (strategyUpdaterBySymbol[symbol]) {
      delete strategyUpdaterBySymbol[symbol]
      persistRegistry()
      console.info('[STRATEGY_UPDATER_COMPLETED]', { symbol })
    }
  } catch (e) {
    console.error('[STRATEGY_UPDATER_COMPLETE_ERR]', (e as any)?.message || e)
  }
}

export function markStrategyUpdateError(symbol: string, error: string): void {
  try {
    const entry = strategyUpdaterBySymbol[symbol]
    if (entry) {
      entry.lastError = error
      entry.lastErrorAt = new Date().toISOString()
      entry.checks += 1
      
      // Reschedule for next 5min cycle on error
      const nextTrigger = new Date(Date.now() + UPDATE_DELAY_MS)
      entry.triggerAt = nextTrigger.toISOString()
      entry.status = 'waiting'
      
      persistRegistry()
      console.error('[STRATEGY_UPDATER_ERROR]', { symbol, error, nextTrigger: nextTrigger.toISOString() })
    }
  } catch (e) {
    console.error('[STRATEGY_UPDATER_ERROR_MARK_ERR]', (e as any)?.message || e)
  }
}

export function markStrategyUpdateProcessing(symbol: string): void {
  try {
    const entry = strategyUpdaterBySymbol[symbol]
    if (entry) {
      entry.status = 'processing'
      entry.lastCheck = new Date().toISOString()
      persistRegistry()
      console.info('[STRATEGY_UPDATER_MARK_PROCESSING]', { symbol })
    }
  } catch (e) {
    console.error('[STRATEGY_UPDATER_MARK_PROCESSING_ERR]', (e as any)?.message || e)
  }
}

// Reschedule existing entry for the next cycle (default 5 minutes)
export function rescheduleStrategyUpdate(symbol: string, delayMs: number = UPDATE_DELAY_MS): void {
  try {
    const entry = strategyUpdaterBySymbol[symbol]
    if (!entry) return
    const nextTrigger = new Date(Date.now() + delayMs)
    entry.triggerAt = nextTrigger.toISOString()
    entry.status = 'waiting'
    persistRegistry()
    console.info('[STRATEGY_UPDATER_RESCHEDULED]', { symbol, nextTrigger: entry.triggerAt, delayMs })
  } catch (e) {
    console.error('[STRATEGY_UPDATER_RESCHEDULE_ERR]', (e as any)?.message || e)
  }
}

// Force an entry to be due immediately (set triggerAt to now - 1s)
export function forceDueNow(symbol: string): boolean {
  try {
    const entry = strategyUpdaterBySymbol[symbol]
    if (!entry) return false
    entry.triggerAt = new Date(Date.now() - 1000).toISOString()
    entry.status = 'waiting' // Ensure it's waiting
    persistRegistry()
    console.info('[STRATEGY_UPDATER_FORCE_DUE]', { symbol, triggerAt: entry.triggerAt, status: entry.status })
    return true
  } catch (e) {
    console.error('[STRATEGY_UPDATER_FORCE_DUE_ERR]', (e as any)?.message || e)
    return false
  }
}

export function getDueUpdates(): StrategyUpdaterEntry[] {
  try {
    const now = Date.now()
    return Object.values(strategyUpdaterBySymbol)
      .filter(entry => 
        entry.status === 'waiting' && 
        new Date(entry.triggerAt).getTime() <= now
      )
  } catch {
    return []
  }
}

export function updateEntryCheck(symbol: string): void {
  try {
    const entry = strategyUpdaterBySymbol[symbol]
    if (entry) {
      entry.lastCheck = new Date().toISOString()
      entry.checks += 1
      persistRegistry()
    }
  } catch (e) {
    console.error('[STRATEGY_UPDATER_CHECK_ERR]', (e as any)?.message || e)
  }
}

// Cleanup entries for symbols with no position
export function cleanupStrategyUpdaterForSymbol(symbol: string): void {
  try {
    if (strategyUpdaterBySymbol[symbol]) {
      delete strategyUpdaterBySymbol[symbol]
      persistRegistry()
      console.info('[STRATEGY_UPDATER_CLEANUP]', { symbol })
    }
  } catch (e) {
    console.error('[STRATEGY_UPDATER_CLEANUP_ERR]', (e as any)?.message || e)
  }
}

// Rehydrate from disk on server startup
let __rehydrateStarted = false
export async function rehydrateStrategyUpdaterFromDisk(): Promise<void> {
  if (__rehydrateStarted) return
  __rehydrateStarted = true
  
  try {
    // CRITICAL: Rehydrate order IDs FIRST so they're available immediately
    if (fs.existsSync(ORDERS_FILE)) {
      try {
        const ordersRaw = fs.readFileSync(ORDERS_FILE, 'utf8')
        const ordersParsed = JSON.parse(ordersRaw)
        const orderIds: number[] = Array.isArray(ordersParsed?.orderIds) ? ordersParsed.orderIds : []
        
        for (const id of orderIds) {
          const n = Number(id)
          if (Number.isFinite(n) && n > 0) {
            strategyUpdaterOrderIds.add(n)
          }
        }
        
        console.info('[STRATEGY_UPDATER_REHYDRATE_ORDERS]', { 
          count: strategyUpdaterOrderIds.size,
          orderIds: Array.from(strategyUpdaterOrderIds).slice(0, 10) // Log first 10
        })
      } catch (e) {
        console.error('[STRATEGY_UPDATER_REHYDRATE_ORDERS_ERR]', (e as any)?.message || e)
      }
    }
    
    // Then rehydrate entries
    if (!fs.existsSync(REGISTRY_FILE)) return
    
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const entries: StrategyUpdaterEntry[] = Array.isArray(parsed?.entries) ? parsed.entries : []
    
    if (!entries.length) return
    
    console.info('[STRATEGY_UPDATER_REHYDRATE]', { count: entries.length })
    
    // Restore in-memory registry
    for (const entry of entries) {
      try {
        // Only rehydrate if entry is still relevant (has recent trigger time)
        const triggerTime = new Date(entry.triggerAt).getTime()
        const now = Date.now()
        const maxAge = 60 * 60 * 1000 // 1 hour max age
        
        if (now - triggerTime < maxAge) {
          strategyUpdaterBySymbol[entry.symbol] = { ...entry, status: 'waiting' }
          console.info('[STRATEGY_UPDATER_REHYDRATE_KEEP]', { 
            symbol: entry.symbol, 
            triggerAt: entry.triggerAt 
          })
        } else {
          console.info('[STRATEGY_UPDATER_REHYDRATE_DROP]', { 
            symbol: entry.symbol, 
            reason: 'too_old' 
          })
        }
      } catch (e) {
        console.error('[STRATEGY_UPDATER_REHYDRATE_ENTRY_ERR]', (e as any)?.message || e)
      }
    }
    
    persistRegistry()
  } catch (e) {
    console.error('[STRATEGY_UPDATER_REHYDRATE_ERR]', (e as any)?.message || e)
  }
}

