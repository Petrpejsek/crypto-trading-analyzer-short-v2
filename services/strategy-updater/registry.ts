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
const UPDATE_DELAY_MS = 5 * 60 * 1000 // 5 minutes (subsequent updates)

// Track orderIds created by Strategy Updater so UI can highlight them reliably
const strategyUpdaterOrderIds = new Set<number>()
export function markStrategyOrders(orderIds: Array<number | undefined | null>): void {
  try {
    for (const id of orderIds) {
      const n = Number(id)
      if (Number.isFinite(n) && n > 0) strategyUpdaterOrderIds.add(n)
    }
  } catch {}
}
export function isStrategyOrderId(orderId: number | string | undefined | null): boolean {
  try {
    const n = Number(orderId)
    return Number.isFinite(n) && strategyUpdaterOrderIds.has(n)
  } catch { return false }
}

function persistRegistry(): void {
  try {
    if (!fs.existsSync(REGISTRY_DIR)) fs.mkdirSync(REGISTRY_DIR, { recursive: true })
    const payload = Object.values(strategyUpdaterBySymbol)
      .filter(entry => entry.status === 'waiting')
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
  currentTP: number | null
): void {
  try {
    const now = new Date()
    // First-run policy: if either SL or TP chybí, udělej první průchod okamžitě (1s)
    const initialDelayMs = (currentSL == null || currentTP == null) ? 1000 : UPDATE_DELAY_MS
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

// Force an entry to be due immediately (set triggerAt to now - 1s)
export function forceDueNow(symbol: string): boolean {
  try {
    const entry = strategyUpdaterBySymbol[symbol]
    if (!entry) return false
    entry.triggerAt = new Date(Date.now() - 1000).toISOString()
    persistRegistry()
    console.info('[STRATEGY_UPDATER_FORCE_DUE]', { symbol, triggerAt: entry.triggerAt })
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

