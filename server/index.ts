import { Agent, setGlobalDispatcher, request as undiciRequest } from 'undici'
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { buildMarketRawSnapshot } from './fetcher/binance'
import { performance } from 'node:perf_hooks'
import http from 'node:http'
import { decideMarketStrict } from '../services/decider/market_decider_gpt'
import { runFinalPicker as runFinalPickerServer } from '../services/decider/final_picker_gpt'
import { runHotScreener } from '../services/decider/hot_screener_gpt'
import { runEntryStrategy } from '../services/decider/entry_strategy_gpt'
import { runEntryRisk } from '../services/decider/entry_risk_gpt'
import { executeHotTradingOrders, type PlaceOrdersRequest, fetchMarkPrice, fetchLastTradePrice, fetchAllOpenOrders, fetchPositions, cancelOrder, getBinanceAPI, getWaitingTpList, cleanupWaitingTpForSymbol, waitingTpProcessPassFromPositions, rehydrateWaitingFromDiskOnce } from '../services/trading/binance_futures'
import { ttlGet, ttlSet, makeKey } from './lib/ttlCache'
import { preflightCompact } from '../services/decider/market_compact'
import deciderCfg from '../config/decider.json'
import tradingCfg from '../config/trading.json'
import { calculateKlineChangePercent, calculateRegime } from './lib/calculations'
import { startBinanceUserDataWs, getPositionsInMemory, getOpenOrdersInMemory, isUserDataReady, rehydrateOpenOrdersFromRest, forgetUnknownOrdersUsingRest } from '../services/exchange/binance/userDataWs'
import { getLimitsSnapshot, setBanUntilMs } from './lib/rateLimits'
import { binanceCache } from './lib/apiCache'
import { requestCoalescer } from './lib/requestCoalescer'
import { startHealthMonitorWorker, isHealthMonitorEnabled, syncWithOpenPositions as healthSyncPositions } from '../services/health-monitor/worker'
import { getLatestHealth } from '../services/health-monitor/store'
import { getAllWorkerEntries as getHealthWorkerEntries } from '../services/health-monitor/store'
import { runReactiveEntryDecision } from '../services/reactive-entry/decision'
import { getHealthStatus } from '../services/reactive-entry/health'
import { checkRateLimit } from '../services/reactive-entry/rate_limiter'
import { roundToTick, edgeFromCurrentBps, findNearestResistance, round } from '../services/reactive-entry/utils'
import { ema, rsi, atrPctFromBars, vwapFromBars } from '../services/lib/indicators'
import type { ReactiveEntryInput } from '../services/reactive-entry/types'
import { loadConfig as loadReactiveConfig } from '../services/reactive-entry/config'
import { acquireLock } from './lib/processLock'
import { initCooldownsFromDisk, isCooldownActive, notePositionClosedFromIncomes, notePositionOpened, getActiveCooldowns, clearCooldown } from '../services/risk/cooldown'
 

// Load env from .env.local and .env even in production
try {
  const tryLoad = (p: string) => { if (fs.existsSync(p)) dotenv.config({ path: p }) }
  tryLoad(path.resolve(process.cwd(), '.env.local'))
  tryLoad(path.resolve(process.cwd(), '.env'))
  // Explicit SHORT v2 env files (development/production)
  const shortEnv = process.env.NODE_ENV === 'production'
    ? '.env.production.short.v2'
    : '.env.development.short.v2'
  tryLoad(path.resolve(process.cwd(), shortEnv))
} catch {}

// ========================================
// CRITICAL: STRICT BAN on port 7800 (LONG instance)
// ========================================
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || ''
if (TEMPORAL_ADDRESS.includes(':7800')) {
  console.error('')
  console.error('🚨🚨🚨 FATAL ERROR 🚨🚨🚨')
  console.error('')
  console.error('❌ PORT 7800 IS STRICTLY FORBIDDEN!')
  console.error('   Port 7800 is reserved for LONG trading instance')
  console.error('   This is SHORT instance - MUST use port 7500')
  console.error('')
  console.error(`   Current: TEMPORAL_ADDRESS=${TEMPORAL_ADDRESS}`)
  console.error('   Required: TEMPORAL_ADDRESS=127.0.0.1:7500')
  console.error('')
  console.error('🚨 Fix .env.local and restart!')
  console.error('')
  process.exit(1)
}

// ========================================
// PROCESS LOCK: Prevent duplicate instances
// ========================================
try {
  acquireLock('backend')
} catch (e: any) {
  console.error('[FATAL]', e?.message || e)
  process.exit(1)
}

setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 60_000, pipelining: 10 }))

// Basic warning if API key is missing/invalid
try {
  if (!process.env.OPENAI_API_KEY || !String(process.env.OPENAI_API_KEY).startsWith('sk-')) {
    // eslint-disable-next-line no-console
    console.error('OPENAI_API_KEY missing/invalid')
  }
} catch {}

// Global log prefix wrapper to distinguish SHORT instances in logs
try {
  const SIDE = (process.env.TRADE_SIDE || 'SHORT').toUpperCase()
  const NAME = process.env.PM2_NAME || 'trader-short-v2'
  const ENV = process.env.NODE_ENV || 'development'
  const P = process.env.PORT || '8789'
  const prefix = `[${SIDE}] [${NAME}] [PORT:${P}] [NODE_ENV:${ENV}]`
  const wrap = <T extends (...args: any[]) => any>(fn: T): T => ((...args: any[]) => fn(prefix, ...args)) as T
  console.log = wrap(console.log)
  console.info = wrap(console.info)
  console.warn = wrap(console.warn)
  console.error = wrap(console.error)
} catch {}

// Enforce explicit SHORT environment marker in this clone
try {
  const TRADE_SIDE = String(process.env.TRADE_SIDE || '')
  if (TRADE_SIDE !== 'SHORT') {
    // eslint-disable-next-line no-console
    console.error('[CONFIG_WARNING] Expected TRADE_SIDE=SHORT for short-v2 environment')
  }
  if (process.env.PM2_NAME) {
    // eslint-disable-next-line no-console
    console.error('[PM2_NAME]', process.env.PM2_NAME)
  }
} catch {}

const PORT = process.env.PORT ? Number(process.env.PORT) : 8789
// WS market collector disabled – REST-only mode for klines

// Helper: Parse JSON body from HTTP request
async function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const ch of req) chunks.push(ch as Buffer)
  const bodyStr = Buffer.concat(chunks).toString('utf8')
  return bodyStr ? JSON.parse(bodyStr) : null
}

// Ephemeral in-memory store of last place_orders request/response for diagnostics
let __lastPlaceOrders: { request: any; result: any } | null = null
// In-memory hints per symbol: last requested amount/leverage (survives across UI polls)
const __lastPlannedBySymbol: Record<string, { amount?: number | null; leverage?: number | null; ts: string }> = {}
const __lastEntryBySymbol: Record<string, { input: any; output: any }> = {}
// Simple batch mutex to ensure /api/place_orders do not overlap
let __batchBusy: boolean = false
const acquireBatch = async (): Promise<void> => {
  const start = Date.now()
  while (__batchBusy) {
    await new Promise(r => setTimeout(r, 25))
    if (Date.now() - start > 10000) break
  }
  __batchBusy = true
  try { console.error('[BATCH_MUTEX_ACQUIRE]', { ts: new Date().toISOString(), pid: process.pid }) } catch {}
}
const releaseBatch = (): void => {
  __batchBusy = false
  try { console.error('[BATCH_MUTEX_RELEASE]', { ts: new Date().toISOString(), pid: process.pid }) } catch {}
}

// Trading settings (in-memory) with simple file persist
let __pendingCancelAgeMin: number = 0 // minutes; 0 = Off
const SETTINGS_FILE = path.resolve(process.cwd(), 'runtime', 'settings.json')
function loadSettings(): void {
  try {
    const dir = path.dirname(SETTINGS_FILE)
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }) } catch {}
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8')
      const j = JSON.parse(raw)
      const v = Number(j?.pending_cancel_age_min)
      if (Number.isFinite(v) && v >= 0) __pendingCancelAgeMin = Math.floor(v)
    }
    // eslint-disable-next-line no-console
    console.error('[SETTINGS_LOADED]', { pending_cancel_age_min: __pendingCancelAgeMin })
  } catch {}
}
function saveSettings(): void {
  try {
    const dir = path.dirname(SETTINGS_FILE)
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }) } catch {}
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ pending_cancel_age_min: __pendingCancelAgeMin }), 'utf8')
  } catch {}
}
let __sweeperDidAutoCancel: boolean = false // one-shot client handshake flag
// In-memory cancel/filled audit log for UI footer
type AuditEvent = { ts: string; type: 'cancel' | 'filled'; source: 'server' | 'sweeper' | 'binance_ws'; symbol: string; orderId?: number; reason?: string | null }
const __auditEvents: AuditEvent[] = []
function pushAudit(evt: AuditEvent): void {
  try {
    __auditEvents.push(evt)
    if (__auditEvents.length > 1000) __auditEvents.splice(0, __auditEvents.length - 1000)
  } catch {}
}
let __sweeperRunning = false
let __sweeperTimer: NodeJS.Timeout | null = null
// Global backoff when Binance returns -1003 (temporary ban)
let __binanceBackoffUntilMs: number = 0

function hasRealBinanceKeysGlobal(): boolean {
  try {
    const k = String(process.env.BINANCE_API_KEY || '')
    const s = String(process.env.BINANCE_SECRET_KEY || '')
    if (!k || !s) return false
    if (k.includes('mock') || s.includes('mock')) return false
    return true
  } catch { return false }
}

async function sweepStaleOrdersOnce(): Promise<number> {
  if (__sweeperRunning) return
  if (!hasRealBinanceKeysGlobal()) return
  if (!Number.isFinite(__pendingCancelAgeMin) || __pendingCancelAgeMin <= 0) return
  // During Binance backoff window, do not hit REST at all
  if (Number(__binanceBackoffUntilMs) > Date.now()) return
  __sweeperRunning = true
  try {
    const now = Date.now()
    const ageMs = __pendingCancelAgeMin * 60 * 1000
    const raw = await fetchAllOpenOrders()
    // Positions snapshot pro bezpečnou detekci osiřelých exitů
    let positionsForSweep: any[] = []
    try { positionsForSweep = await fetchPositions() } catch {}
    const posSizeBySym = new Map<string, number>()
    try {
      for (const p of (Array.isArray(positionsForSweep) ? positionsForSweep : [])) {
        const sym = String((p as any)?.symbol || '')
        // KRITICKÁ OPRAVA: API vrací "size" ne "positionAmt"!
        const amt = Number((p as any)?.size || (p as any)?.positionAmt || 0)
        const size = Number.isFinite(amt) ? Math.abs(amt) : 0
        if (sym && size > 0) {
          posSizeBySym.set(sym, size)
          console.info('[SWEEPER_POSITION_DETECTED]', { symbol: sym, size })
        }
      }
    } catch {}
    // Strict: mazat pouze ENTRY BUY LIMIT bez reduceOnly/closePosition; nikdy ne EXITy (STOP/TP)
    // Age-based entry cancellation
    const entryCandidates = (Array.isArray(raw) ? raw : [])
      .filter((o: any) => {
        try {
          const side = String(o?.side || '').toUpperCase()
          const type = String(o?.type || '').toUpperCase()
          const reduceOnly = Boolean(o?.reduceOnly)
          const closePosition = Boolean(o?.closePosition)
          return side === 'SELL' && type === 'LIMIT' && !reduceOnly && !closePosition
        } catch { return false }
      })
      .map((o: any) => ({
        symbol: String(o?.symbol || ''),
        orderId: Number(o?.orderId ?? o?.orderID ?? 0) || 0,
        createdAtMs: (() => { const t = Number((o as any)?.time); return Number.isFinite(t) && t > 0 ? t : null })()
      }))
      .filter(o => o.symbol && o.orderId && Number.isFinite(o.createdAtMs as any))
      .filter(o => (now - (o.createdAtMs as number)) > ageMs)

    // Delta-based entry cancellation: Δ% ≥ 7% (price moved too far from entry)
    let markBySymbol: Record<string, number> = {}
    try {
      const markPrices = await Promise.all(
        Array.from(new Set((Array.isArray(raw) ? raw : []).map((o: any) => String(o?.symbol || '')).filter(Boolean)))
          .map(async (sym: string) => {
            try {
              const mark = await fetchMarkPrice(sym)
              return { sym, mark: Number(mark) }
            } catch { return { sym, mark: NaN } }
          })
      )
      for (const { sym, mark } of markPrices) {
        if (Number.isFinite(mark) && mark > 0) markBySymbol[sym] = mark
      }
    } catch {}

    const ENTRY_DELTA_CANCEL_PCT = await (async () => {
      try {
        const cfg = JSON.parse(await fs.promises.readFile(
          path.join(process.cwd(), 'config/trading.json'), 'utf8'
        ))
        return Number(cfg.ENTRY_DELTA_CANCEL_PCT) || 3.5
      } catch { 
        return 3.5 
      }
    })()
    const entryOrders = (Array.isArray(raw) ? raw : [])
      .filter((o: any) => {
        try {
          const side = String(o?.side || '').toUpperCase()
          const type = String(o?.type || '').toUpperCase()
          const reduceOnly = Boolean(o?.reduceOnly)
          const closePosition = Boolean(o?.closePosition)
          return side === 'SELL' && type === 'LIMIT' && !reduceOnly && !closePosition
        } catch { return false }
      })

    const entryDeltaCandidates = entryOrders
      .map((o: any) => {
        try {
          const sym = String(o?.symbol || '')
          const price = Number(o?.price)
          const mark = Number(markBySymbol[sym])
          const pct = (Number.isFinite(price) && price > 0 && Number.isFinite(mark) && mark > 0)
            ? Math.abs((price - mark) / mark) * 100
            : null
          return { symbol: sym, orderId: Number(o?.orderId ?? o?.orderID ?? 0) || 0, deltaPct: pct, price, mark }
        } catch { return { symbol: '', orderId: 0, deltaPct: null as any, price: 0, mark: 0 } }
      })
      .filter(o => o.symbol && o.orderId)
      .filter(o => Number.isFinite(o.deltaPct as any) && (o.deltaPct as number) >= ENTRY_DELTA_CANCEL_PCT)

    // Combine age-based and delta-based candidates for cancellation
    const allEntryCandidates = [...entryCandidates, ...entryDeltaCandidates]
    const uniqueEntryCandidates = Array.from(new Map(allEntryCandidates.map(c => [c.orderId, c])).values())

    // KRITICKÁ OPRAVA: SL ordery NIKDY nesmí být rušeny automaticky!
    // Pouze TP ordery mohou být rušeny jako "orphan exits" 
    const entrySymbols = new Set<string>((Array.isArray(raw) ? raw : [])
      .filter((o: any) => {
        try {
          return String(o?.side||'').toUpperCase()==='SELL' && String(o?.type||'').toUpperCase()==='LIMIT' && !(o?.reduceOnly||o?.closePosition)
        } catch { return false }
      })
      .map((o: any) => String(o?.symbol || '')).filter(Boolean))

    const orphanExitCandidates = (Array.isArray(raw) ? raw : [])
      .filter((o: any) => {
        try {
          const side = String(o?.side||'').toUpperCase()
          const type = String(o?.type||'').toUpperCase()
          const reduceOnly = Boolean(o?.reduceOnly)
          const closePosition = Boolean(o?.closePosition)
          const sym = String(o?.symbol||'')
          const clientId = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
          const isExitType = type.includes('STOP') || type.includes('TAKE_PROFIT') // SL i TP
          const isTpType = type.includes('TAKE_PROFIT')
          const isSlType = type.includes('STOP')
          const isInternalTp = clientId ? /^x_tp_/.test(clientId) : false
          const isInternalSl = clientId ? /^x_sl_/.test(clientId) : false
          const hasPos = (Number(posSizeBySym.get(sym)||0) > 0)
          const noEntryOpen = !entrySymbols.has(sym)
          
          // KRITICKÁ OCHRANA: Pokud máme pozici, NIKDY neruš SL ani TP!
          if (hasPos && (isExitType || isInternalTp)) {
            console.warn('[SWEEPER_POSITION_PROTECTION]', { symbol: sym, orderId: o?.orderId, type, reason: 'position_exists_never_cancel_exits' })
            return false
          }
          
          // Pokud není pozice a není otevřen ENTRY, lze bezpečně mazat:
          if (!hasPos && noEntryOpen) {
            // A) Interní TP/SL (x_tp_* / x_sl_*) – i bez reduceOnly/closePosition
            if (isTpType && isInternalTp) return true
            if (isSlType && isInternalSl) return true
            // B) Původní pravidlo pro orphan exity se "stop" nebo "take_profit" s exit flagy
            return side==='SELL' && isExitType && (reduceOnly || closePosition)
          }
          return false
        } catch { return false }
      })
      .map((o: any) => ({
        symbol: String(o?.symbol || ''),
        orderId: Number(o?.orderId ?? o?.orderID ?? 0) || 0,
        createdAtMs: (() => { const t = Number((o as any)?.time); return Number.isFinite(t) && t > 0 ? t : null })()
      }))
      .filter(o => o.symbol && o.orderId && Number.isFinite(o.createdAtMs as any))
      .filter(o => (now - (o.createdAtMs as number)) > ageMs)

    if (uniqueEntryCandidates.length === 0 && orphanExitCandidates.length === 0) return 0

    let cancelled = 0
    const maxParallel = 4
    const all = uniqueEntryCandidates.concat(orphanExitCandidates)
    
    // Trackuj úspěšně smazané entry ordery pro cleanup SL/TP
    const cancelledEntriesBySymbol = new Map<string, number>()
    
    for (let i = 0; i < all.length; i += maxParallel) {
      const batch = all.slice(i, i + maxParallel)
      const res = await Promise.allSettled(batch.map(async (c: any) => {
        const reason = (c.deltaPct !== undefined && Number.isFinite(c.deltaPct)) 
          ? `delta_${c.deltaPct.toFixed(2)}%_exceeds_7%`
          : 'stale_auto_cancel'
        
        if (c.deltaPct !== undefined) {
          console.info('[SWEEPER_DELTA_CANCEL]', { 
            symbol: c.symbol, 
            orderId: c.orderId, 
            deltaPct: c.deltaPct.toFixed(2), 
            price: c.price, 
            mark: c.mark 
          })
        }
        
        const r = await cancelOrder(c.symbol, c.orderId)
        pushAudit({ ts: new Date().toISOString(), type: 'cancel', source: 'sweeper', symbol: c.symbol, orderId: c.orderId, reason })
        return { success: true, symbol: c.symbol }
      }))
      for (let j = 0; j < res.length; j++) {
        if (res[j].status === 'fulfilled') {
          cancelled++
          // Trackuj pouze entry ordery (ne orphan exits)
          const batchIndex = i + j
          if (batchIndex < uniqueEntryCandidates.length) {
            const symbol = batch[j].symbol
            cancelledEntriesBySymbol.set(symbol, (cancelledEntriesBySymbol.get(symbol) || 0) + 1)
          }
        }
      }
    }
    if (cancelled > 0) {
      __sweeperDidAutoCancel = true
      try { ttlSet(makeKey('/api/open_orders'), null as any, 1) } catch {}
    }

    // KRITICKÁ OPRAVA: Po smazání entry orderů okamžitě smazat i přidružené SL/TP ordery
    // (pokud není pozice) - nemůžeme čekat na age-based orphan cleanup
    let cleanupCancelled = 0
    try {
      // Shromáždi symboly, kde byly smazány entry ordery
      const entryCancelledSymbols = Array.from(cancelledEntriesBySymbol.keys())

      if (entryCancelledSymbols.length > 0) {
        console.info('[SWEEPER_CLEANUP_SL_START]', { 
          symbols: entryCancelledSymbols 
        })

        // Pro každý symbol zkontroluj pozici a smaž SL/TP pokud není pozice
        for (const symbol of entryCancelledSymbols) {
          try {
            const hasPosition = Number(posSizeBySym.get(symbol) || 0) > 0
            
            if (hasPosition) {
              console.warn('[SWEEPER_CLEANUP_SKIP_HAS_POSITION]', { symbol })
              continue
            }

            // Najdi všechny SL/TP ordery pro tento symbol
            const slTpOrders = (Array.isArray(raw) ? raw : [])
              .filter((o: any) => {
                try {
                  const sym = String(o?.symbol || '')
                  const type = String(o?.type || '').toUpperCase()
                  const clientId = String(o?.clientOrderId || '')
                  const isExitType = type.includes('STOP') || type.includes('TAKE_PROFIT')
                  const isInternalExit = /^x_(sl_|tp_)/.test(clientId)
                  return sym === symbol && (isExitType || isInternalExit)
                } catch { return false }
              })
              .map((o: any) => ({
                symbol: String(o?.symbol || ''),
                orderId: Number(o?.orderId || 0),
                type: String(o?.type || ''),
                clientOrderId: String(o?.clientOrderId || '')
              }))
              .filter(o => o.orderId > 0)

            // Smaž všechny SL/TP ordery pro tento symbol
            for (const order of slTpOrders) {
              try {
                await cancelOrder(order.symbol, order.orderId)
                pushAudit({ 
                  ts: new Date().toISOString(), 
                  type: 'cancel', 
                  source: 'sweeper_cleanup', 
                  symbol: order.symbol, 
                  orderId: order.orderId, 
                  reason: 'entry_cancelled_cleanup_sl_tp' 
                })
                cleanupCancelled++
                console.info('[SWEEPER_CLEANUP_SL_SUCCESS]', { 
                  symbol: order.symbol, 
                  orderId: order.orderId,
                  type: order.type 
                })
              } catch (cleanupErr: any) {
                console.error('[SWEEPER_CLEANUP_SL_ERROR]', {
                  symbol: order.symbol,
                  orderId: order.orderId,
                  error: cleanupErr?.message || cleanupErr
                })
              }
            }

            // Vyčisti waiting TP registry
            try { cleanupWaitingTpForSymbol(symbol) } catch {}

          } catch (symErr: any) {
            console.error('[SWEEPER_CLEANUP_SYMBOL_ERROR]', {
              symbol,
              error: symErr?.message || symErr
            })
          }
        }
      }
    } catch (cleanupErr: any) {
      console.error('[SWEEPER_CLEANUP_ERROR]', {
        error: cleanupErr?.message || cleanupErr
      })
    }

    try { console.error('[SWEEPER_PASS]', { 
      age_min: __pendingCancelAgeMin, 
      cancelled, 
      cleanup_sl_tp: cleanupCancelled,
      entries_age: entryCandidates.length, 
      entries_delta: entryDeltaCandidates.length,
      orphan_exits: orphanExitCandidates.length 
    }) } catch {}
    return cancelled
  } catch (e) {
    try { console.error('[SWEEPER_ERROR]', (e as any)?.message || e) } catch {}
    return 0
  } finally {
    __sweeperRunning = false
  }
}

function startOrderSweeper(): void {
  if (__sweeperTimer) return
  const ms = Number((tradingCfg as any)?.OPEN_ORDERS_SWEEP_MS ?? 10000)
  __sweeperTimer = setInterval(() => { sweepStaleOrdersOnce().catch(()=>{}) }, ms)
}

// KRITICKÁ OCHRANA: Continuous SL monitoring
let __slMonitorTimer: NodeJS.Timeout | null = null
async function slProtectionMonitor(): Promise<void> {
  try {
    if (!hasRealBinanceKeysGlobal()) return
    console.info('[SL_MONITOR_PASS]')
    
    const [positions, orders] = await Promise.all([fetchPositions(), fetchAllOpenOrders()])
    const posList = Array.isArray(positions) ? positions : []
    const ordersList = Array.isArray(orders) ? orders : []
    
    for (const pos of posList) {
      try {
        const symbol = String(pos?.symbol || '')
        const size = Math.abs(Number(pos?.positionAmt || 0))
        if (!symbol || size === 0) continue
        
        const slOrders = ordersList.filter(o => 
          String(o?.symbol) === symbol && 
          String(o?.side) === 'SELL' && 
          String(o?.type).includes('STOP')
        )
        
        if (slOrders.length === 0) {
          console.error('[CRITICAL_NO_SL_FOR_POSITION]', { 
            symbol, 
            positionSize: size, 
            entryPrice: pos?.entryPrice,
            unrealizedPnl: pos?.unRealizedProfit 
          })
          // TODO: Auto-create emergency SL based on position entry price - 5%
          // Pro NMR: pokud entry ~19, emergency SL na 18.05 (5% ztráta)
        }
      } catch (e: any) {
        console.error('[SL_MONITOR_ERR]', { symbol: pos?.symbol, error: e?.message })
      }
    }
  } catch (e: any) {
    console.error('[SL_MONITOR_GLOBAL_ERR]', e?.message)
  }
}

function startSlProtectionMonitor(): void {
  if (__slMonitorTimer) return
  __slMonitorTimer = setInterval(() => { slProtectionMonitor().catch(()=>{}) }, 30_000) // every 30s
}

// BACKGROUND AUTOPILOT - běží identicky jako UI pipeline podle posledních UI kritérií
let __backgroundTimer: NodeJS.Timeout | null = null
let __lastSuccessfulTradingParams: any = null // ponecháno pro budoucí diagnostiku

type SnapshotCriteria = { universe: 'gainers' | 'volume'; topN: number | null; fresh: boolean }
const CRITERIA_FILE = path.resolve(process.cwd(), 'runtime', 'background_criteria.json')
const PARAMS_FILE = path.resolve(process.cwd(), 'runtime', 'background_trading.json')

function persistBackgroundSettings(params: any): void {
  try {
    const dir = path.dirname(PARAMS_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(PARAMS_FILE, JSON.stringify({ 
      enabled: true,
      last_params: params,
      saved_at: new Date().toISOString()
    }, null, 2))
    console.info('[BACKGROUND_PERSIST]', { symbols: params?.orders?.length || 0 })
  } catch {}
}

let __lastSnapshotCriteria: SnapshotCriteria | null = null
function persistBackgroundCriteria(criteria: SnapshotCriteria): void {
  try {
    const dir = path.dirname(CRITERIA_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(CRITERIA_FILE, JSON.stringify({ 
      enabled: true,
      last_criteria: criteria,
      saved_at: new Date().toISOString()
    }, null, 2))
    __lastSnapshotCriteria = criteria
    console.info('[BACKGROUND_CRITERIA_SAVED]', criteria)
  } catch {}
}
function loadBackgroundCriteria(): void {
  try {
    if (!fs.existsSync(CRITERIA_FILE)) return
    const raw = fs.readFileSync(CRITERIA_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed?.enabled && parsed?.last_criteria) {
      __lastSnapshotCriteria = parsed.last_criteria as SnapshotCriteria
      console.info('[BACKGROUND_CRITERIA_LOADED]', __lastSnapshotCriteria)
    }
  } catch {}
}

async function backgroundTradingCycle(): Promise<void> {
  try {
    if (!hasRealBinanceKeysGlobal()) return
    const criteria = __lastSnapshotCriteria
    if (!criteria) {
      console.info('[BACKGROUND_PIPELINE_SKIP]', { reason: 'no_criteria' })
      return
    }

    console.info('[BACKGROUND_PIPELINE_START]', { criteria })

    // 1) Snapshot přes API se stejnými parametry jako v UI
    const params = new URLSearchParams({ universe: criteria.universe, fresh: criteria.fresh ? '1' : '0' })
    if (Number.isFinite(criteria.topN as any) && (criteria.topN as any) > 0) params.set('topN', String(criteria.topN))
    const snapRes = await fetch(`http://127.0.0.1:${PORT}/api/snapshot?${params.toString()}`)
    if (!snapRes.ok) { console.info('[BACKGROUND_PIPELINE_SKIP]', { reason: `snapshot_failed_${snapRes.status}` }); return }
    const snapshot = await snapRes.json() as any

    // 2) Compute features
    const { computeFeatures } = await import('../services/features/compute')
    const features = computeFeatures(snapshot)

    // 3) Build compact
    const { buildMarketCompact } = await import('../services/decider/market_compact')
    const compact = buildMarketCompact(features, snapshot)

    // 4) Decision (API stejně jako UI)
    const decisionRes = await fetch(`http://127.0.0.1:${PORT}/api/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(compact) })
    if (!decisionRes.ok) { console.info('[BACKGROUND_PIPELINE_SKIP]', { reason: `decision_failed_${decisionRes.status}` }); return }
    const decision = await decisionRes.json() as any
    if (!decision?.flag || decision.flag === 'NO-TRADE') { console.info('[BACKGROUND_PIPELINE_SKIP]', { reason: decision?.flag || 'no_decision' }); return }

    // 5) Kandidáti (stejná logika jako UI)
    const { selectCandidates } = await import('../services/signals/candidate_selector')
    const signalsCfg = await import('../config/signals.json').then(m => (m as any).default ?? m)
    const candLimit = (signalsCfg as any)?.max_setups ?? 3
    const candidates = selectCandidates(features, snapshot, {
      decisionFlag: decision.flag,
      allowWhenNoTrade: false,
      limit: candLimit,
      cfg: { 
        atr_pct_min: (signalsCfg as any).atr_pct_min, 
        atr_pct_max: (signalsCfg as any).atr_pct_max, 
        min_liquidity_usdt: (signalsCfg as any).min_liquidity_usdt 
      },
      canComputeSimPreview: false,
      finalPickerStatus: 'idle'
    })
    if (!Array.isArray(candidates) || candidates.length === 0) { console.info('[BACKGROUND_PIPELINE_SKIP]', { reason: 'no_candidates' }); return }

    // 6) Final picker (GPT stejně jako UI)
    const { buildFinalPickerCandidates } = await import('../services/decider/build_final_picker_candidates')
    const finalCandidates = buildFinalPickerCandidates(candidates)
    const finalResp = await runFinalPickerServer(finalCandidates, decision)
    if (!finalResp?.ok || !Array.isArray(finalResp?.data?.picks) || finalResp.data.picks.length === 0) { console.info('[BACKGROUND_PIPELINE_SKIP]', { reason: 'no_final_picks' }); return }

    // 7) Spuštění objednávek
    const orderReq = { orders: finalResp.data.picks }
    const tradingResult = await executeHotTradingOrders(orderReq)
    console.info('[BACKGROUND_PIPELINE_SUCCESS]', { 
      decision_flag: decision.flag,
      picks_count: finalResp.data.picks.length,
      success: (tradingResult as any)?.success,
      executed_orders: (tradingResult as any)?.orders?.length || 0
    })

  } catch (e: any) {
    console.error('[BACKGROUND_PIPELINE_ERROR]', e?.message || 'unknown')
  }
}

function startBackgroundTrading(): void {
  // Nepoužívá pevný interval! Načte uživatelské nastavení z runtime (bude se ukládat po UI runu)
  const intervalMs = __lastUiAutoCopyInterval
  if (!intervalMs || intervalMs <= 0) {
    console.info('[BACKGROUND_DISABLED]', { reason: 'no_ui_auto_copy_interval' })
    return
  }
  if (__backgroundTimer) return
  console.info('[BACKGROUND_START]', { interval_ms: intervalMs, source: 'ui_auto_copy_settings' })
  __backgroundTimer = setInterval(() => { backgroundTradingCycle().catch(()=>{}) }, intervalMs)
}

let __lastUiAutoCopyInterval: number | null = null

function persistUiSettings(settings: { auto_copy_enabled: boolean; auto_copy_minutes: number }): void {
  try {
    if (!settings.auto_copy_enabled || settings.auto_copy_minutes <= 0) {
      __lastUiAutoCopyInterval = null
      if (__backgroundTimer) { clearInterval(__backgroundTimer); __backgroundTimer = null }
      console.info('[BACKGROUND_STOP]', { reason: 'auto_copy_disabled_or_zero' })
      return
    }
    const intervalMs = settings.auto_copy_minutes * 60 * 1000
    __lastUiAutoCopyInterval = intervalMs
    console.info('[UI_SETTINGS_PERSIST]', { auto_copy_minutes: settings.auto_copy_minutes, interval_ms: intervalMs })
    
    // Restart timer s novým intervalem
    if (__backgroundTimer) { clearInterval(__backgroundTimer); __backgroundTimer = null }
    startBackgroundTrading()
  } catch {}
}

function loadBackgroundSettings(): void {
  try {
    const file = PARAMS_FILE
    if (!fs.existsSync(file)) return
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed?.enabled && parsed?.last_params) {
      __lastSuccessfulTradingParams = parsed.last_params
      console.info('[BACKGROUND_LOADED]', { orders: parsed.last_params?.orders?.length || 0 })
    }
  } catch {}
}

// Rehydrate waiting TP list from disk (if any) early during startup
try { rehydrateWaitingFromDiskOnce().catch(()=>{}) } catch {}
// Rehydrate strategy updater registry from disk
try {
  (async () => {
    const { rehydrateStrategyUpdaterFromDisk } = await import('../services/strategy-updater/registry')
    await rehydrateStrategyUpdaterFromDisk()
  })().catch(()=>{})
} catch {}
// Load persisted settings on startup
try { loadSettings() } catch {}
try { loadBackgroundSettings() } catch {}

// Strategy Updater separate timer (every 30 seconds, not on every UI poll)
let __strategyUpdaterTimer: NodeJS.Timeout | null = null
const startStrategyUpdaterTimer = () => {
  if (__strategyUpdaterTimer) clearInterval(__strategyUpdaterTimer)
  __strategyUpdaterTimer = setInterval(async () => {
    try {
      const { processDueStrategyUpdates } = await import('../services/strategy-updater/trigger')
      processDueStrategyUpdates().catch(()=>{})
    } catch {}
  }, 30000) // Every 30 seconds
}
try { startStrategyUpdaterTimer() } catch {}

// Start Binance user-data WS to capture cancel/filled events into audit log
try {
  startBinanceUserDataWs({
    audit: async (evt) => {
      try {
        pushAudit({
          ts: new Date().toISOString(),
          type: evt.type === 'filled' ? 'filled' : 'cancel',
          source: 'binance_ws',
          symbol: String(evt.symbol || ''),
          orderId: (Number(evt.orderId) || undefined) as any,
          reason: (evt as any)?.reason || null
        })
      } catch {}
      // Bezpečný okamžitý úklid interních TP po uzavření pozice (pos->0) s debounce
      try {
        if (evt.type === 'filled' && evt.symbol) {
          const sym = String(evt.symbol)
          setTimeout(async () => {
            try {
              const api = getBinanceAPI() as any
              const [orders, positions] = await Promise.all([
                api.getOpenOrders(sym),
                api.getPositions()
              ])
              const pos = (Array.isArray(positions) ? positions : []).find((p: any) => String(p?.symbol) === sym)
              const size = (() => { try { const n = Number(pos?.size ?? pos?.positionAmt ?? 0); return Number.isFinite(n) ? Math.abs(n) : 0 } catch { return 0 } })()
              const hasPos = size > 0
              const noEntryOpen = (() => {
                try {
                  return !(Array.isArray(orders) ? orders : []).some((o: any) => {
                    const side = String(o?.side || '').toUpperCase()
                    const type = String(o?.type || '').toUpperCase()
                    const reduceOnly = Boolean(o?.reduceOnly)
                    const closePosition = Boolean(o?.closePosition)
                    const clientId = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
                    const isInternalEntry = /^e_l_/.test(clientId)
                    return isInternalEntry && side === 'BUY' && type === 'LIMIT' && !(reduceOnly || closePosition)
                  })
                } catch { return true }
              })()

              if (!hasPos && noEntryOpen) {
                // Zruš interní TP/SL (x_tp_* / x_sl_*) pro daný symbol, max 3 kusy, audituj
                const internalExits = (Array.isArray(orders) ? orders : []).filter((o: any) => {
                  try {
                    const cid = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
                    const type = String(o?.type || '').toUpperCase()
                    const isExit = type.includes('TAKE_PROFIT') || type.includes('STOP')
                    const isInternal = /^x_tp_|^x_sl_/.test(cid)
                    return String(o?.symbol) === sym && isExit && isInternal
                  } catch { return false }
                }).slice(0, 3)

                for (const o of internalExits) {
                  try {
                    await cancelOrder(sym, Number(o?.orderId))
                    try { pushAudit({ ts: new Date().toISOString(), type: 'cancel', source: 'server', symbol: sym, orderId: Number(o?.orderId)||undefined, reason: 'cleanup_on_pos_close_internal_exit' }) } catch {}
                  } catch (e) {
                    try { console.error('[CLEANUP_ON_CLOSE_ERR]', { symbol: sym, orderId: o?.orderId, error: (e as any)?.message || e }) } catch {}
                  }
                }
              }
            } catch {}
          }, 700)
        }
      } catch {}
      // Trigger immediate waiting TP processing on fill without waiting for HTTP poll
      try {
        if (evt.type === 'filled' && evt.symbol) {
          const api = getBinanceAPI() as any
          const positions = await api.getPositions()
          waitingTpProcessPassFromPositions(positions).catch(()=>{})
        }
      } catch {}
      // Strategy updater: trigger pouze na WebSocket filled events (izolovaně od waiting TP systému)
      try {
        if (evt.type === 'filled' && evt.symbol) {
          // Malé zpoždění aby se WebSocket data mohla aktualizovat
          setTimeout(async () => {
            try {
              const api = getBinanceAPI() as any
              const [orders, positions] = await Promise.all([
                api.getOpenOrders(),
                api.getPositions()
              ])
              const { detectInternalPositionOpened } = await import('../services/strategy-updater/trigger')
              detectInternalPositionOpened(orders, positions, {
                type: evt.type,
                symbol: String(evt.symbol || ''),
                orderId: Number(evt.orderId) || 0
              })
              // SU: No immediate force; first run waits 1 minute by design
            } catch (triggerError) {
              console.error('[STRATEGY_UPDATER_TRIGGER_ERR]', triggerError)
            }
          }, 1000) // 1 sekunda delay pro stabilitu
        }
      } catch {}
      
      // Health monitor sync: trigger při order změnách (filled/cancel)
      try {
        if (evt.type === 'filled' || evt.type === 'cancel') {
          // Malé zpoždění pro stabilizaci WebSocket dat
          setTimeout(() => {
            healthSyncPositions('websocket').catch(err => {
              console.error('[HEALTH_SYNC_TRIGGER_ERR]', err)
            })
          }, 500)
        }
      } catch {}
    }
  })
} catch (e) {
  try { console.error('[USERDATA_WS_ERROR]', (e as any)?.message || e) } catch {}
}

// Start Health Monitor Worker (delayed to allow UserDataWS to initialize)
try {
  setTimeout(() => {
    console.info('[SERVER] Starting Health Monitor Worker...')
    startHealthMonitorWorker()
  }, 3000) // 3 second delay to allow UserDataWS to load positions
} catch (e) {
  try { console.error('[HEALTH_MONITOR_START_ERR]', (e as any)?.message || e) } catch {}
}

function isDebugApi(): boolean {
  try { const v = String(process.env.DEBUG_API || '').toLowerCase(); return v === 'true' || v === '1' || v === 'yes'; } catch { return false }
}

const server = http.createServer(async (req, res) => {
  try {
    // Basic CORS for dev/prod – no caching
    try {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With')
    } catch {}
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }
    const url = new URL(req.url || '/', 'http://localhost')
    // Long-lived auth endpoint for proxy integration. Allows setting 30-day cookie after Basic login.
    if (url.pathname === '/__auth') {
      try {
        const parseCookies = (h: any): Record<string, string> => {
          try {
            const raw = String(h?.cookie || '')
            const out: Record<string, string> = {}
            if (!raw) return out
            for (const p of raw.split(';')) {
              const [k, ...rest] = p.split('=')
              if (!k) continue
              const key = decodeURIComponent(k.trim())
              const val = decodeURIComponent(rest.join('=')?.trim() || '')
              out[key] = val
            }
            return out
          } catch { return {} }
        }
        const cookies = parseCookies(req.headers)
        // Accept existing cookie as already authenticated
        if (cookies['trader_auth'] === '1') { res.statusCode = 204; res.end(); return }
        // Validate Basic header against expected credentials
        const user = String(process.env.BASIC_USER || 'trader')
        const pass = String(process.env.BASIC_PASS || 'Orchid-Falcon-Quasar-73!X')
        const expected = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
        const got = String(req.headers['authorization'] || '')
        if (got === expected) {
          res.statusCode = 204
          // 30 days cookie, secure/lax
          res.setHeader('Set-Cookie', 'trader_auth=1; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax')
          res.end()
          return
        }
        res.statusCode = 401
        res.setHeader('WWW-Authenticate', 'Basic realm="Restricted"')
        res.end()
      } catch {
        res.statusCode = 500
        res.end()
      }
      return
    }
    const hasRealBinanceKeys = (): boolean => {
    // Static UI (serve built frontend from dist/)
    try {
      const distDir = path.resolve(process.cwd(), 'dist')
      const serveFile = (p: string, type: string) => {
        try {
          const buf = fs.readFileSync(p)
          res.statusCode = 200
          res.setHeader('content-type', type)
          res.setHeader('Cache-Control', 'no-cache')
          res.end(buf)
          return true
        } catch { return false }
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const idx = path.join(distDir, 'index.html')
        if (fs.existsSync(idx)) { if (serveFile(idx, 'text/html; charset=utf-8')) return }
      }
      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
        const rel = url.pathname.replace(/^\/+/, '') // strip leading slashes
        const filePath = path.join(distDir, rel)
        if (fs.existsSync(filePath)) {
          const ext = path.extname(filePath).toLowerCase()
          const type = ext === '.js' ? 'text/javascript; charset=utf-8'
            : ext === '.css' ? 'text/css; charset=utf-8'
            : ext === '.map' ? 'application/json; charset=utf-8'
            : ext === '.svg' ? 'image/svg+xml'
            : ext === '.png' ? 'image/png'
            : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
            : 'application/octet-stream'
          if (serveFile(filePath, type)) return
        }
      }
    } catch {}

      try {
        const k = String(process.env.BINANCE_API_KEY || '')
        const s = String(process.env.BINANCE_SECRET_KEY || '')
        if (!k || !s) return false
        if (k.includes('mock') || s.includes('mock')) return false
        return true
      } catch { return false }
    }
    if (url.pathname === '/api/mark' && req.method === 'GET') {
      try {
        const sym = String(url.searchParams.get('symbol') || '')
        if (!sym) { res.statusCode = 400; res.end(JSON.stringify({ error: 'missing_symbol' })); return }
        const normalizeSymbol = (s: string): string => {
          let v = String(s || '').trim().toUpperCase()
          if (!v) return ''
          if (v.includes('/')) v = v.replace('/', '')
          if (!v.endsWith('USDT')) v = `${v}USDT`
          return v
        }
        const symbol = normalizeSymbol(sym)
        if (Number(__binanceBackoffUntilMs) > Date.now()) {
          const waitSec = Math.ceil((__binanceBackoffUntilMs - Date.now())/1000)
          res.statusCode = 429
          res.setHeader('Retry-After', String(Math.max(1, waitSec)))
          res.end(JSON.stringify({ error: 'banned_until', until: __binanceBackoffUntilMs }))
          return
        }
        const [mark, last] = await Promise.all([fetchMarkPrice(symbol), fetchLastTradePrice(symbol)])
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ symbol, mark, last }))
      } catch (e: any) {
        const msg = String(e?.message || '')
        // Detect Binance -1003 ban and expose structured backoff for UI
        const bannedMatch = msg.match(/banned\s+until\s+(\d{10,})/i)
        if (bannedMatch && bannedMatch[1]) {
          __binanceBackoffUntilMs = Number(bannedMatch[1])
          res.statusCode = 429
          const waitSec = Math.ceil((__binanceBackoffUntilMs - Date.now())/1000)
          res.setHeader('Retry-After', String(Math.max(1, waitSec)))
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'banned_until', until: __binanceBackoffUntilMs }))
          return
        }
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: msg || 'unknown' }))
      }
      return
    }

    // 🚀 CRITICAL: Ultra-fast position close endpoint
    if (url.pathname === '/__proxy/binance/flatten' && req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        console.log('[FLATTEN_ENDPOINT_HIT]', { method: req.method, url: req.url })
        
        if (!hasRealBinanceKeysGlobal()) {
          console.error('[FLATTEN_ERROR] Missing Binance keys')
          res.statusCode = 403
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'missing_binance_keys' }))
          return
        }

        const symbolRaw = url.searchParams.get('symbol')
        const sideRaw = url.searchParams.get('side')
        
        console.log('[FLATTEN_PARAMS]', { symbolRaw, sideRaw })

        if (!symbolRaw || !sideRaw) {
          console.error('[FLATTEN_ERROR] Missing params', { symbolRaw, sideRaw })
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'missing_symbol_or_side' }))
          return
        }

        const normalizeSymbol = (s: string): string => {
          let v = String(s || '').trim().toUpperCase()
          if (!v) return ''
          if (v.includes('/')) v = v.replace('/', '')
          if (!v.endsWith('USDT')) v = `${v}USDT`
          return v
        }

        const symbol = normalizeSymbol(symbolRaw)
        const side = String(sideRaw).toUpperCase() // 'LONG' or 'SHORT'

        if (!symbol) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'invalid_symbol' }))
          return
        }

        if (side !== 'LONG' && side !== 'SHORT') {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'invalid_side_must_be_LONG_or_SHORT' }))
          return
        }

        // 🚀 ULTRA-FAST: Use WebSocket cache (0ms) instead of REST API (~100ms)
        const api = getBinanceAPI() as any
        let positions: any[] = []
        const wsReady = isUserDataReady()
        
        if (wsReady) {
          positions = getPositionsInMemory() // 0ms - instant WebSocket cache
          console.log('[FLATTEN_WS_CACHE]', { wsPositions: positions.length, symbols: positions.map(p => p.symbol) })
        }
        
        // If WS cache is empty or not ready, use REST API
        if (positions.length === 0) {
          positions = await fetchPositions() // ~100ms - REST API fallback
          console.log('[FLATTEN_REST_API]', { restPositions: positions.length })
        }
        
        // Find position
        const position = positions.find((p: any) => 
          String(p?.symbol || '').toUpperCase() === symbol &&
          String(p?.positionSide || '').toUpperCase() === side &&
          Math.abs(Number(p?.positionAmt || 0)) > 0
        )

        if (!position) throw new Error(`Position not found: ${symbol} ${side}`)
        
        const positionSize = Math.abs(Number(position.positionAmt || 0))
        if (positionSize <= 0) throw new Error(`Invalid position size: ${positionSize}`)

        // For closing: LONG position -> SELL order, SHORT position -> BUY order
        const orderSide = side === 'LONG' ? 'SELL' : 'BUY'

        const orderParams: any = {
          symbol,
          side: orderSide,
          type: 'MARKET',
          quantity: String(positionSize),
          positionSide: side, // SHORT-only = always hedge mode
          newOrderRespType: 'RESULT',
          __engine: 'flatten_endpoint'
        }

        console.log('[FLATTEN_POSITION]', { 
          symbol, 
          positionSide: side, 
          orderSide,
          quantity: positionSize,
          wsCache: wsReady
        })

        // 🚀 Send order immediately to exchange for maximum speed
        const t0 = performance.now()
        const result = await api.placeOrder(orderParams)
        const latencyMs = Math.round(performance.now() - t0)

        console.log('[FLATTEN_SUCCESS]', { 
          symbol, 
          latencyMs, 
          orderId: result?.orderId,
          executedQty: result?.executedQty 
        })

        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ 
          ok: true, 
          result, 
          latencyMs,
          message: `Position ${symbol} ${side} closed successfully`
        }))

      } catch (e: any) {
        console.error('[FLATTEN_ERROR]', { error: e?.message, stack: e?.stack })
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }
    
    if (url.pathname === '/api/trading/settings' && req.method === 'PUT') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        const chunks: Buffer[] = []
        for await (const ch of req) chunks.push(ch as Buffer)
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        let parsed: any = null
        try { parsed = bodyStr ? JSON.parse(bodyStr) : null } catch { parsed = null }
        const vRaw = parsed?.pending_cancel_age_min
        const vNum = Number(vRaw)
        if (!Number.isFinite(vNum) || vNum < 0) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'bad_pending_cancel_age_min' }))
          return
        }
        __pendingCancelAgeMin = Math.floor(vNum)
        try { saveSettings() } catch {}
        // If client acknowledged and disabled, clear handshake flag
        if (__pendingCancelAgeMin === 0) __sweeperDidAutoCancel = false
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, pending_cancel_age_min: __pendingCancelAgeMin }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }
    if (url.pathname === '/api/order' && req.method === 'DELETE') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        if (!hasRealBinanceKeysGlobal()) {
          // Avoid 401 to prevent browser Basic Auth re-prompt under reverse proxy
          res.statusCode = 403
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'missing_binance_keys' }))
          return
        }
        const symbolRaw = url.searchParams.get('symbol')
        const orderIdRaw = url.searchParams.get('orderId')
        if (!symbolRaw || !orderIdRaw) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'missing_symbol_or_orderId' }))
          return
        }
        const symbol = String(symbolRaw).toUpperCase()
        const orderId = Number(orderIdRaw)
        if (!Number.isFinite(orderId) || orderId <= 0) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'bad_orderId' }))
          return
        }
        const r = await cancelOrder(symbol, orderId)
        // Remove from in-memory snapshot immediately to keep /api/orders_console fresh
        try {
          const map: any = (global as any).openOrdersById || undefined
          if (map && typeof map.delete === 'function') {
            map.delete(orderId)
          }
        } catch {}
        try { pushAudit({ ts: new Date().toISOString(), type: 'cancel', source: 'server', symbol, orderId, reason: 'manual_delete' }) } catch {}
        
        // Auto-cleanup waiting TP on manual ENTRY delete (safe housekeeping only)
        try { const { cleanupWaitingTpForSymbol } = await import('../services/trading/binance_futures'); cleanupWaitingTpForSymbol(symbol) } catch {}
        
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, result: r }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }
    if (url.pathname === '/api/debug/cancel_audit' && req.method === 'GET') {
      try {
        const last = Number(url.searchParams.get('last') || '0')
        const list = Array.isArray(__auditEvents) ? __auditEvents : []
        const events = last > 0 ? list.slice(Math.max(0, list.length - last)) : list
        // eslint-disable-next-line no-console
        try { console.info('[AUDIT_API]', { path: '/api/debug/cancel_audit', q: req.url?.includes('?') ? req.url?.split('?')[1] : '' }) } catch {}
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, events }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }
    if (url.pathname === '/api/debug/rehydrate_orders' && req.method === 'POST') {
      try {
        const n = await rehydrateOpenOrdersFromRest()
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, count: n }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }
    if (url.pathname === '/api/debug/forget_unknown_orders' && req.method === 'POST') {
      try {
        const r = await forgetUnknownOrdersUsingRest()
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, ...r }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }
    if (url.pathname === '/api/open_orders' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        if (!hasRealBinanceKeys()) {
          // 403 instead of 401 to avoid Basic Auth modal on periodic polls
          res.statusCode = 403
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'missing_binance_keys' }))
          return
        }
        // If WS user-data not ready, return 200 with empty list (no REST fallback, but no hard error)
        if (!isUserDataReady('orders')) {
          const waiting = getWaitingTpList()
          const response = { ok: true, count: 0, orders: [], waiting: Array.isArray(waiting) ? waiting : [] }
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(response))
          return
        }
        const raw = getOpenOrdersInMemory()
        const orders = Array.isArray(raw) ? raw.map((o: any) => ({
          orderId: Number(o?.orderId ?? o?.orderID ?? 0) || 0,
          symbol: String(o?.symbol || ''),
          side: String(o?.side || ''),
          type: String(o?.type || ''),
          qty: (() => { const n = Number(o?.origQty ?? o?.quantity ?? o?.qty); return Number.isFinite(n) ? n : null })(),
          price: (() => { const n = Number(o?.price); return Number.isFinite(n) && n > 0 ? n : null })(),
          stopPrice: (() => { const n = Number(o?.stopPrice); return Number.isFinite(n) && n > 0 ? n : null })(),
          timeInForce: o?.timeInForce ? String(o.timeInForce) : null,
          reduceOnly: Boolean(o?.reduceOnly ?? false),
          closePosition: Boolean(o?.closePosition ?? false),
          positionSide: (typeof o?.positionSide === 'string' && o.positionSide) ? String(o.positionSide) : null,
          clientOrderId: ((): string | null => { const id = String((o as any)?.C || (o as any)?.c || (o as any)?.clientOrderId || ''); return id || null })(),
          // Treat any internal client IDs as non-external, including strategy-updater generated ones.
          // Also mark as internal if the orderId is known to be created by the updater.
          // CRITICAL: SHORT-only system - ALL LONG positions are EXTERNAL (but not BUY exits for SHORT!)
          isExternal: ((): boolean => {
            try {
              // SHORT-only system: LONG position orders are automatically external
              // But BUY orders can be our SHORT exits (TP/SL), so check by positionSide only
              const posSide = String((o as any)?.positionSide || '').toUpperCase()
              if (posSide === 'LONG') return true
              
              const idStr = String((o as any)?.C || (o as any)?.c || (o as any)?.clientOrderId || '')
              const idIsInternal = idStr ? /^(sv2_)?(e_l_|x_sl_|x_tp_|x_ai_)/.test(idStr) : false
              if (idIsInternal) return false
              
              // Check if it's an AI order by pattern (avoid require cache)
              if (idStr.includes('x_ai_sl_') || idStr.includes('x_ai_tp_')) return false
              
              const n = Number(o?.orderId ?? 0)
              const { isStrategyOrderId } = require('../services/strategy-updater/registry')
              if (Number.isFinite(n) && isStrategyOrderId(n)) return false
              return true
            } catch { return true }
          })(),
          createdAt: (() => { const t = Number((o as any)?.time); return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null })(),
          updatedAt: (() => { const t = Number(o?.updateTime); return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null })()
        })) : []
        const response = { ok: true, count: orders.length, orders, auto_cancelled_due_to_age: __sweeperDidAutoCancel }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        try {
          // Attach waiting TP list to response for UI "Waiting orders"
          const waiting = getWaitingTpList()
          ;(response as any).waiting = Array.isArray(waiting) ? waiting : []
        } catch {}
        res.end(JSON.stringify(response))
      } catch (e: any) {
        const msg = String(e?.message || 'binance_error')
        const isRateLimit = /code\":-?1003|too\s+many\s+requests|status:\s*418|banned\s+until/i.test(msg)
        if (isRateLimit) {
          res.statusCode = 429
          res.setHeader('Retry-After', '60')
        } else {
          res.statusCode = 500
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: msg }))
      }
      return
    }
    if (url.pathname === '/api/trading/settings' && req.method === 'GET') {
      try {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, pending_cancel_age_min: __pendingCancelAgeMin }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }
    // GET /api/config/trading - vrátí trading config
    if (url.pathname === '/api/config/trading' && req.method === 'GET') {
      try {
        const cfg = JSON.parse(await fs.promises.readFile(
          path.join(process.cwd(), 'config/trading.json'), 'utf8'
        ))
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(cfg))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'Failed to read config' }))
      }
      return
    }
    // POST /api/config/trading - uloží partial update trading configu
    if (url.pathname === '/api/config/trading' && req.method === 'POST') {
      try {
        let body = ''
        req.on('data', chunk => body += chunk.toString())
        await new Promise<void>((resolve, reject) => {
          req.on('end', async () => {
            try {
              const update = JSON.parse(body)
              const cfgPath = path.join(process.cwd(), 'config/trading.json')
              const current = JSON.parse(await fs.promises.readFile(cfgPath, 'utf8'))
              
              // Validace ENTRY_DELTA_CANCEL_PCT
              if (update.ENTRY_DELTA_CANCEL_PCT !== undefined) {
                const val = Number(update.ENTRY_DELTA_CANCEL_PCT)
                if (!Number.isFinite(val) || val < 0 || val > 10) {
                  res.statusCode = 400
                  res.setHeader('content-type', 'application/json')
                  res.end(JSON.stringify({ error: 'ENTRY_DELTA_CANCEL_PCT must be 0-10' }))
                  resolve()
                  return
                }
                current.ENTRY_DELTA_CANCEL_PCT = val
              }
              
              await fs.promises.writeFile(cfgPath, JSON.stringify(current, null, 2))
              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify(current))
              resolve()
            } catch (e: any) {
              reject(e)
            }
          })
          req.on('error', reject)
        })
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'Failed to update config' }))
      }
      return
    }
    // Manual trigger to run background pipeline once (useful for validation/tests)
    if (url.pathname === '/api/background/run_once' && req.method === 'POST') {
      try {
        backgroundTradingCycle().catch(()=>{})
        res.statusCode = 202
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }
    // UI nastavení Auto Copy - přijme nastavení z UI a nastaví background timer
    if (url.pathname === '/api/ui/auto_copy' && req.method === 'POST') {
      try {
        const chunks: Buffer[] = []
        for await (const ch of req) chunks.push(ch as Buffer)
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        const parsed = bodyStr ? JSON.parse(bodyStr) : null
        if (parsed && typeof parsed === 'object' && typeof parsed.auto_copy_enabled === 'boolean' && typeof parsed.auto_copy_minutes === 'number') {
          persistUiSettings(parsed)
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, interval_ms: __lastUiAutoCopyInterval }))
        } else {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'invalid_settings' }))
        }
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }
    if (url.pathname === '/api/positions' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        if (!hasRealBinanceKeys()) {
          // 403 instead of 401 to avoid Basic Auth modal on periodic polls
          res.statusCode = 403
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'missing_binance_keys' }))
          return
        }
        // ALWAYS use REST API (no WebSocket dependency)
        // WebSocket can be used as cache optimization later, but REST is authoritative
        let raw: any[] = []
        const wsReady = isUserDataReady('positions')
        
        if (wsReady && getPositionsInMemory().length > 0) {
          // Use WebSocket cache if available and has data
          raw = getPositionsInMemory()
          console.info('[API_POSITIONS_WS_CACHE]', { count: raw.length })
        } else {
          // Always fallback to REST API (primary source)
          console.info('[API_POSITIONS_REST_PRIMARY]', { ws_ready: wsReady })
          try {
            const { getBinanceAPI } = await import('../services/trading/binance_futures.js')
            const api = getBinanceAPI()
            raw = await api.getPositions()
            console.info('[API_POSITIONS_REST_OK]', { count: Array.isArray(raw) ? raw.length : 0 })
          } catch (restErr: any) {
            console.error('[API_POSITIONS_REST_ERR]', restErr?.message || String(restErr))
            // If REST fails, return error (no fake data)
            const response = { ok: false, error: restErr?.message || 'Failed to fetch positions', positions: [] }
            res.statusCode = 500
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(response))
            return
          }
        }
        const positionsRaw = Array.isArray(raw) ? raw : []
        const positions = positionsRaw
          .map((p: any) => {
            const amt = Number(p?.positionAmt)
            const size = Number.isFinite(amt) ? Math.abs(amt) : 0
            const entry = Number(p?.entryPrice)
            const mark = Number((p as any)?.markPrice)
            const pnl = Number(p?.unRealizedProfit ?? p?.unrealizedPnl)
            const lev = Number(p?.leverage)
            const side = (typeof p?.positionSide === 'string' && p.positionSide) ? String(p.positionSide) : (Number.isFinite(amt) ? (amt >= 0 ? 'LONG' : 'SHORT') : '')
            const upd = Number(p?.updateTime)
            return {
              symbol: String(p?.symbol || ''),
              positionSide: side || null,
              size: Number.isFinite(size) ? size : 0,
              entryPrice: Number.isFinite(entry) ? entry : null,
              markPrice: Number.isFinite(mark) ? mark : null,
              unrealizedPnl: Number.isFinite(pnl) ? pnl : null,
              leverage: Number.isFinite(lev) ? lev : null,
              updatedAt: Number.isFinite(upd) && upd > 0 ? new Date(upd).toISOString() : (Number.isFinite((p as any)?.updatedAt) ? new Date((p as any).updatedAt).toISOString() : null)
            }
          })
          .filter((p: any) => Number.isFinite(p.size) && p.size > 0)
        // Spustit waiting TP processing pass s již získanými pozicemi (sníží duplicitní poll na Binance)
        try { waitingTpProcessPassFromPositions(raw).catch(()=>{}) } catch {}
        const body = { ok: true, count: positions.length, positions }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body))
      } catch (e: any) {
        const msg = String(e?.message || 'binance_error')
        const isRateLimit = /code\":-?1003|too\s+many\s+requests|status:\s*418|banned\s+until/i.test(msg)
        if (isRateLimit) {
          res.statusCode = 429
          res.setHeader('Retry-After', '60')
        } else {
          res.statusCode = 500
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: msg }))
      }
      return
    }
    if (url.pathname === '/api/health') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
      return
    }
    
    // GET /api/system_status - diagnostic endpoint for WebSocket and API health
    if (url.pathname === '/api/system_status' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('content-type', 'application/json')
      
      try {
        const wsReadyPositions = isUserDataReady('positions')
        const wsReadyOrders = isUserDataReady('orders')
        const wsReadyAny = isUserDataReady('any')
        const memoryPositions = getPositionsInMemory()
        const memoryOrders = getOpenOrdersInMemory()
        
        // Try REST API call
        let restHealthy = false
        let restError: string | null = null
        let restPositionsCount = 0
        try {
          const { getBinanceAPI } = await import('../services/trading/binance_futures.js')
          const api = getBinanceAPI()
          const positions = await api.getPositions()
          restHealthy = true
          restPositionsCount = (Array.isArray(positions) ? positions : []).filter((p: any) => {
            const amt = Number(p?.positionAmt || 0)
            return Math.abs(amt) > 0
          }).length
        } catch (e: any) {
          restError = e?.message || String(e)
        }
        
        const status = {
          ok: true,
          timestamp: new Date().toISOString(),
          websocket: {
            positions_ready: wsReadyPositions,
            orders_ready: wsReadyOrders,
            any_ready: wsReadyAny,
            memory_positions_count: memoryPositions.length,
            memory_orders_count: memoryOrders.length
          },
          rest_api: {
            healthy: restHealthy,
            error: restError,
            positions_count: restPositionsCount
          },
          diagnosis: (() => {
            if (!wsReadyPositions && !restHealthy) {
              return '❌ CRITICAL: WebSocket not ready AND REST API failed - check Binance API keys'
            }
            if (!wsReadyPositions && restHealthy) {
              return '⚠️ WARNING: WebSocket not ready but REST API works - fallback active'
            }
            if (wsReadyPositions && !restHealthy) {
              return '⚠️ WARNING: WebSocket ready but REST API failed - possible rate limit'
            }
            if (wsReadyPositions && memoryPositions.length === 0 && restPositionsCount > 0) {
              return '⚠️ WARNING: WebSocket ready but in-memory positions empty while REST shows positions'
            }
            return '✅ OK: WebSocket and REST API both healthy'
          })()
        }
        
        res.statusCode = 200
        res.end(JSON.stringify(status, null, 2))
      } catch (e: any) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: e?.message || 'Internal error' }))
      }
      return
    }

    // Temporal worker connection info (used by UI widget). No fallbacks.
    if (url.pathname === '/api/temporal/worker/info' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        const { execSync } = await import('node:child_process')
        const address = String(process.env.TEMPORAL_ADDRESS || '')
        const namespace = String(process.env.TEMPORAL_NAMESPACE || 'default')
        const taskQueue = String(process.env.TASK_QUEUE || '')
        const taskQueueOpenai = String(process.env.TASK_QUEUE_OPENAI || '')
        const taskQueueBinance = String(process.env.TASK_QUEUE_BINANCE || '')
        const tradeSide = String(process.env.TRADE_SIDE || 'SHORT').toUpperCase()
        
        // Extract configured port from TEMPORAL_ADDRESS (no hard-coded defaults)
        const configuredPort = (() => {
          try {
            const match = address.match(/:(\d+)$/);
            return match ? match[1] : '';
          } catch {
            return '';
          }
        })()

        // Check connection to configured port only
        const connectedPorts: string[] = []
        if (configuredPort) {
          try {
            // Find worker process (runs via tsx in dev mode)
            const findCmd = `ps aux | grep "temporal/worker.ts" | grep "trader-short-v2" | grep -v grep | awk '{print $2}' | head -1 || true`
            const workerPid = execSync(findCmd, { encoding: 'utf8', timeout: 2000 }).trim()
            if (workerPid && /^\d+$/.test(workerPid)) {
              // Check for connection (-P forces numeric ports instead of service names)
              const cmd = `lsof -P -p ${workerPid} -a -i TCP 2>/dev/null | grep ESTABLISHED | grep ":${configuredPort}" || true`
              const out = execSync(cmd, { encoding: 'utf8', timeout: 2000 })
              if (out && out.trim().length > 0) {
                connectedPorts.push(configuredPort)
              }
            }
          } catch {}
        }

        // OPTIONAL: Check for connections to forbidden ports (for UI warning)
        const connectedForbiddenPorts: string[] = []
        const forbiddenPortsEnv = process.env.FORBIDDEN_TEMPORAL_PORTS;
        if (forbiddenPortsEnv) {
          const forbiddenPorts = forbiddenPortsEnv.split(',').map(p => p.trim()).filter(Boolean);
          for (const port of forbiddenPorts) {
            try {
              // Find worker process (runs via tsx in dev mode)
              const findCmd = `ps aux | grep "temporal/worker.ts" | grep "trader-short-v2" | grep -v grep | awk '{print $2}' | head -1 || true`
              const workerPid = execSync(findCmd, { encoding: 'utf8', timeout: 2000 }).trim()
              if (workerPid && /^\d+$/.test(workerPid)) {
                // Check for connection (-P forces numeric ports instead of service names)
                const cmd = `lsof -P -p ${workerPid} -a -i TCP 2>/dev/null | grep ESTABLISHED | grep ":${port}" || true`
                const out = execSync(cmd, { encoding: 'utf8', timeout: 2000 })
                if (out && out.trim().length > 0) connectedForbiddenPorts.push(port)
              }
            } catch {}
          }
        }

        const workerCount = connectedPorts.length
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ 
          ok: true, 
          address, 
          namespace, 
          taskQueue, 
          taskQueueOpenai, 
          taskQueueBinance, 
          tradeSide, 
          configuredPort, 
          connectedPorts, 
          connectedForbiddenPorts,
          workerCount 
        }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }
    if (url.pathname === '/api/limits' && req.method === 'GET') {
      try {
        const snap = getLimitsSnapshot()
        if (Number.isFinite((snap?.backoff?.untilMs as any))) {
          const until = Number(snap.backoff.untilMs)
          if (until > Date.now()) {
            __binanceBackoffUntilMs = until
          }
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, limits: snap }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }
    
    // Cache statistics endpoint
    if (url.pathname === '/api/cache_stats' && req.method === 'GET') {
      try {
        const cacheStats = binanceCache.getStats()
        const coalescerStats = requestCoalescer.getStats()
        
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          ok: true,
          cache: cacheStats,
          coalescer: coalescerStats,
          timestamp: new Date().toISOString()
        }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }
    
    if (url.pathname === '/api/ws/health') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, connected: false, streams: 0, lastClosedAgeMsByKey: {}, altH1Subscribed: 0, altH1Ready: 0, includedSymbols: 0, lastBackfillCount: 0, drops_noH1: [] }))
      return
    }

    // Fear & Greed Index (alternative.me) with 20m TTL cache
    if (url.pathname === '/api/fear_greed' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        const key = makeKey('/api/fear_greed')
        const cached = ttlGet<any>(key)
        if (cached) {
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(cached))
          return
        }
        const r = await undiciRequest('https://api.alternative.me/fng/?limit=1&format=json', { method: 'GET', headers: { 'accept': 'application/json' } })
        const body = await r.body.text()
        if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}`)
        let value: number | null = null
        let classification: string | null = null
        let updatedAt: string | null = null
        try {
          const j = JSON.parse(body)
          const d = Array.isArray(j?.data) && j.data.length > 0 ? j.data[0] : null
          value = Number(d?.value)
          classification = (d?.value_classification ? String(d.value_classification) : null)
          updatedAt = (d?.timestamp ? new Date(Number(d.timestamp) * 1000).toISOString() : null)
        } catch {}
        const out = { value: Number.isFinite(value) ? value : null, classification, updated_at: updatedAt, fetched_at: new Date().toISOString() }
        ttlSet(key, out, 20 * 60) // 20 minutes cache
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(out))
      } catch (e: any) {
        // On error, return last cached value if present
        try {
          const cached = ttlGet<any>(makeKey('/api/fear_greed'))
          if (cached) {
            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(cached))
            return
          }
        } catch {}
        res.statusCode = 502
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'fetch_failed' }))
      }
      return
    }

    if (url.pathname === '/api/orders_console' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        if (!hasRealBinanceKeys()) { res.statusCode = 403; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'missing_binance_keys' })); return }
        // PERMANENT FIX: Use REST API for positions (WebSocket unreliable)
        let positionsRaw: any[] = []
        let ordersRaw = getOpenOrdersInMemory()
        try {
          positionsRaw = await fetchPositions() // Always use REST API
          console.info('[POSITIONS_REST_API]', { count: positionsRaw.length })
        } catch (e) {
          console.error('[POSITIONS_REST_API_ERR]', (e as any)?.message)
          positionsRaw = [] // Fail safe
        }
        const ordersReady = isUserDataReady('orders')
        const positionsReady = isUserDataReady('positions')
        // Strict mode: žádné REST seedování – pouze aktuální WS data
        // Fast-path auto-clean čekajících TP jen pokud jsou WS data READY (jinak hrozí falešné mazání)
        try {
          if (ordersReady && positionsReady) {
            const hasEntry = (o: any): boolean => {
              const clientId = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
              const internal = /^(e_l_|x_sl_|x_tp_tm_|x_tp_l_)/.test(clientId)
              return internal && String(o?.side) === 'BUY' && String(o?.type) === 'LIMIT' && !(o?.reduceOnly || o?.closePosition)
            }
            const entrySymbols = new Set<string>()
            for (const o of (Array.isArray(ordersRaw) ? ordersRaw : [])) {
              try { if (hasEntry(o)) entrySymbols.add(String(o?.symbol || '')) } catch {}
            }
            const posSizeBySym = new Map<string, number>()
            for (const p of (Array.isArray(positionsRaw) ? positionsRaw : [])) {
              try {
                const sym = String(p?.symbol || '')
                const amt = Number(p?.positionAmt)
                const size = Number.isFinite(amt) ? Math.abs(amt) : 0
                if (sym) posSizeBySym.set(sym, size)
              } catch {}
            }
            const pending = getWaitingTpList()
            // Grace window to avoid premature cleanup right after ENTRY fill before position snapshot catches up
            const nowMs = Date.now()
            const graceMsRaw = Number((process as any)?.env?.WAITING_TP_CLEANUP_GRACE_MS)
            const graceMs = (Number.isFinite(graceMsRaw) && graceMsRaw >= 0) ? graceMsRaw : 15000
            for (const w of (Array.isArray(pending) ? pending : [])) {
              try {
                const sym = String(w?.symbol || '')
                if (!sym) continue
                const size = Number(posSizeBySym.get(sym) || 0)
                // DEBUG: Log cleanup decision
                const hasEntry = entrySymbols.has(sym)
                const hasPosition = size > 0
                const sinceMs = (() => { try { return new Date(String((w as any)?.since || Date.now())).getTime() } catch { return 0 } })()
                const ageMs = Math.max(0, nowMs - sinceMs)
                const willCleanup = (!hasEntry && !hasPosition && ageMs > graceMs)
                console.debug('[WAITING_CLEANUP_DEBUG]', {
                  symbol: sym,
                  hasEntry,
                  hasPosition,
                  ageMs,
                  graceMs,
                  willCleanup,
                  entrySymbols: Array.from(entrySymbols)
                })
                // Do NOT auto-clean waiting TP here; keep until sent or explicitly cancelled
                console.info('[WAITING_KEEP_DECISION]', { symbol: sym, hasEntry, hasPosition })
              } catch {}
            }
          }
        } catch {}
        // Strict režim: ŽÁDNÉ REST refresh fallbacky uvnitř orders_console – pouze aktuální WS snapshoty

        // Spusť waiting TP processing pass na základě pozic (bez dalšího dodatečného REST čtení)
        try { waitingTpProcessPassFromPositions(positionsRaw).catch(()=>{}) } catch {}
        
        // Strategy updater: Auto-detect missing positions and trigger countdown
        try {
          const { detectInternalPositionOpened } = await import('../services/strategy-updater/trigger')
          detectInternalPositionOpened(ordersRaw, positionsRaw)
        } catch {}
        
        // Build marks map via REST for a SMALL prioritized set to avoid rate limits
        const marks: Record<string, number> = {}
        try {
          if (Number(__binanceBackoffUntilMs) > Date.now()) { throw new Error(`banned until ${__binanceBackoffUntilMs}`) }
          // 1) ENTRY orders (BUY LIMIT, not reduceOnly/closePosition)
          const entrySymbols: string[] = []
          try {
            for (const o of (Array.isArray(ordersRaw) ? ordersRaw : [])) {
              try {
                const clientId = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
                const internal = /^(e_l_|x_sl_|x_tp_tm_|x_tp_l_)/.test(clientId)
                const isEntry = internal && String(o?.side) === 'BUY' && String(o?.type) === 'LIMIT' && !(o?.reduceOnly || o?.closePosition)
                if (isEntry) entrySymbols.push(String(o?.symbol || ''))
              } catch {}
            }
          } catch {}
          // 2) Non-zero positions only
          const posSymbols: string[] = []
          try {
            for (const p of (Array.isArray(positionsRaw) ? positionsRaw : [])) {
              try {
                const sym = String(p?.symbol || '')
                const amt = Number(p?.positionAmt)
                if (sym && Number.isFinite(amt) && Math.abs(amt) > 0) posSymbols.push(sym)
              } catch {}
            }
          } catch {}
          // 3) Waiting TP symbols
          const waitingListSafe = (()=>{ try { return getWaitingTpList() } catch { return [] } })()
          const waitingSymbols: string[] = (Array.isArray(waitingListSafe) ? waitingListSafe : []).map((w:any)=>String(w?.symbol||'')).filter(Boolean)
          // Priority: waiting -> entries -> positions, unique and hard cap
          const ordered: string[] = []
          const pushUniq = (s: string) => { const v = String(s||''); if (v && !ordered.includes(v)) ordered.push(v) }
          for (const s of waitingSymbols) pushUniq(s)
          for (const s of entrySymbols) pushUniq(s)
          for (const s of posSymbols) pushUniq(s)
          const MAX_MARKS = 24
          const arr = ordered.slice(0, MAX_MARKS)
          if (arr.length > 0) {
            const limit = 4
            for (let i = 0; i < arr.length; i += limit) {
              const batch = arr.slice(i, i + limit)
              const settled = await Promise.allSettled(batch.map(async (s)=>({ s, m: await fetchMarkPrice(String(s)) })))
              for (const r of settled) {
                if (r.status === 'fulfilled') {
                  const { s, m } = r.value as any
                  if (Number.isFinite(m)) marks[s] = Number(m)
                } else {
                  try {
                    const msg = String(((r as any)?.reason?.message) || (r as any)?.reason || '')
                    const bannedMatch = msg.match(/banned\s+until\s+(\d{10,})/i)
                    if (bannedMatch && bannedMatch[1]) {
                      __binanceBackoffUntilMs = Number(bannedMatch[1])
                    }
                  } catch {}
                }
              }
            }
          }
        } catch {}

        // Delta-based cleanup: cancel internal ENTRY orders far from mark (Δ% >= 10)
        // and remove related internal exits (x_tp_*, x_sl_*), including waiting TP.
        // No additional REST reads are performed beyond what's already used above.
        try {
          const DELTA_THRESHOLD = 10
          // Build quick map of current position sizes per symbol (>= 0)
          const posSizeBySym: Map<string, number> = new Map()
          try {
            for (const p of (Array.isArray(positionsRaw) ? positionsRaw : [])) {
              try {
                const sym = String((p as any)?.symbol || '')
                if (!sym) continue
                const amt = Number((p as any)?.positionAmt ?? (p as any)?.size ?? 0)
                const size = Number.isFinite(amt) ? Math.abs(amt) : 0
                posSizeBySym.set(sym, size)
              } catch {}
            }
          } catch {}

          // Identify symbols whose internal ENTRY (e_l_*) have Δ% >= 10 and no open position
          const qualifiedSymbols: Set<string> = new Set()
          try {
            for (const o of (Array.isArray(ordersRaw) ? ordersRaw : [])) {
              try {
                const side = String((o as any)?.side || '').toUpperCase()
                const type = String((o as any)?.type || '').toUpperCase()
                const reduceOnly = Boolean((o as any)?.reduceOnly)
                const closePosition = Boolean((o as any)?.closePosition)
                const clientId = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
                const isInternalEntry = /^e_l_/.test(clientId) && side === 'BUY' && type === 'LIMIT' && !reduceOnly && !closePosition
                if (!isInternalEntry) continue
                const sym = String((o as any)?.symbol || '')
                if (!sym) continue
                const mark = Number((marks as any)?.[sym])
                const s1 = Number((o as any)?.stopPrice)
                const s2 = Number((o as any)?.price)
                const target = Number.isFinite(s1) && s1 > 0 ? s1 : (Number.isFinite(s2) && s2 > 0 ? s2 : NaN)
                if (!Number.isFinite(mark) || !(mark > 0) || !Number.isFinite(target)) continue
                const delta = Math.abs((target - (mark as number)) / (mark as number)) * 100
                const posSize = Number(posSizeBySym.get(sym) || 0)
                if (delta >= DELTA_THRESHOLD && posSize <= 0) {
                  qualifiedSymbols.add(sym)
                }
              } catch {}
            }
          } catch {}

          if (qualifiedSymbols.size > 0) {
            // Collect cancellations: internal entries and internal exits (x_tp_*, x_sl_)
            const toCancel: Array<{ symbol: string; orderId: number }> = []
            const seen = new Set<string>()
            try {
              for (const o of (Array.isArray(ordersRaw) ? ordersRaw : [])) {
                try {
                  const sym = String((o as any)?.symbol || '')
                  if (!sym || !qualifiedSymbols.has(sym)) continue
                  const orderId = Number((o as any)?.orderId ?? (o as any)?.orderID ?? 0) || 0
                  if (!orderId) continue
                  const side = String((o as any)?.side || '').toUpperCase()
                  const type = String((o as any)?.type || '').toUpperCase()
                  const reduceOnly = Boolean((o as any)?.reduceOnly)
                  const closePosition = Boolean((o as any)?.closePosition)
                  const clientId = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
                  const isInternalEntry = /^e_l_/.test(clientId) && side === 'BUY' && type === 'LIMIT' && !reduceOnly && !closePosition
                  const isInternalTp = /^x_tp_/.test(clientId)
                  const isInternalSl = /^x_sl_/.test(clientId)
                  if (isInternalEntry || isInternalTp || isInternalSl) {
                    const key = `${sym}:${orderId}`
                    if (!seen.has(key)) { seen.add(key); toCancel.push({ symbol: sym, orderId }) }
                  }
                } catch {}
              }
            } catch {}

            if (toCancel.length > 0) {
              const maxParallel = 4
              for (let i = 0; i < toCancel.length; i += maxParallel) {
                const batch = toCancel.slice(i, i + maxParallel)
                const settled = await Promise.allSettled(batch.map(async (c) => {
                  const r = await cancelOrder(c.symbol, c.orderId)
                  try { pushAudit({ ts: new Date().toISOString(), type: 'cancel', source: 'sweeper', symbol: c.symbol, orderId: c.orderId, reason: 'delta10_auto_cancel' }) } catch {}
                  return r
                }))
                void settled
              }
            }

            // Clean waiting TP registry for affected symbols
            try {
              for (const sym of Array.from(qualifiedSymbols)) {
                try { cleanupWaitingTpForSymbol(sym) } catch {}
              }
            } catch {}

            try { console.error('[SWEEPER_DELTA10]', { symbols: Array.from(qualifiedSymbols), cancelled: toCancel.length }) } catch {}
          }
        } catch {}

        // No-entry cleanup: remove internal exits if no ENTRY and no position (create-then-clean)
        try {
          if (ordersReady && positionsReady) {
            const nowMs = Date.now()
            const graceMsRaw = Number((process as any)?.env?.NO_ENTRY_CLEANUP_GRACE_MS)
            const graceMs = (Number.isFinite(graceMsRaw) && graceMsRaw >= 0) ? graceMsRaw : 60000 // default 1 minute
            const hasInternalEntry = (o: any): boolean => {
              try {
                const clientId = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
                const side = String((o as any)?.side || '').toUpperCase()
                const type = String((o as any)?.type || '').toUpperCase()
                const reduceOnly = Boolean((o as any)?.reduceOnly)
                const closePosition = Boolean((o as any)?.closePosition)
                return /^e_l_/.test(clientId) && side === 'BUY' && type === 'LIMIT' && !reduceOnly && !closePosition
              } catch { return false }
            }
            const isInternalExit = (o: any): boolean => {
              try {
                const cid = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
                return /^x_sl_/.test(cid) || /^x_tp_/.test(cid)
              } catch { return false }
            }

            const entryBySym = new Set<string>()
            try {
              for (const o of (Array.isArray(ordersRaw) ? ordersRaw : [])) {
                try { if (hasInternalEntry(o)) entryBySym.add(String((o as any)?.symbol || '')) } catch {}
              }
            } catch {}

            const posSizeBySym: Map<string, number> = new Map()
            try {
              for (const p of (Array.isArray(positionsRaw) ? positionsRaw : [])) {
                try {
                  const sym = String((p as any)?.symbol || '')
                  if (!sym) continue
                  const amt = Number((p as any)?.positionAmt ?? (p as any)?.size ?? 0)
                  const size = Number.isFinite(amt) ? Math.abs(amt) : 0
                  posSizeBySym.set(sym, size)
                } catch {}
              }
            } catch {}

            const toCancel: Array<{ symbol: string; orderId: number }> = []
            const affectedSymbols: Set<string> = new Set()
            try {
              for (const o of (Array.isArray(ordersRaw) ? ordersRaw : [])) {
                try {
                  if (!isInternalExit(o)) continue
                  const sym = String((o as any)?.symbol || '')
                  if (!sym) continue
                  const hasPos = (Number(posSizeBySym.get(sym) || 0) > 0)
                  if (hasPos) continue // Never cancel exits when a position exists
                  const hasEntry = entryBySym.has(sym)
                  if (hasEntry) continue // Keep exits if there is an internal entry open
                  const createdAtMs = (() => { const t = Number((o as any)?.time); return Number.isFinite(t) && t > 0 ? t : null })()
                  if (!Number.isFinite(createdAtMs as any)) continue
                  const ageMs = nowMs - (createdAtMs as number)
                  if (ageMs < graceMs) continue // Respect grace window to avoid races
                  const orderId = Number((o as any)?.orderId ?? (o as any)?.orderID ?? 0) || 0
                  if (!orderId) continue
                  toCancel.push({ symbol: sym, orderId })
                  affectedSymbols.add(sym)
                } catch {}
              }
            } catch {}

            if (toCancel.length > 0) {
              const maxParallel = 4
              for (let i = 0; i < toCancel.length; i += maxParallel) {
                const batch = toCancel.slice(i, i + maxParallel)
                const settled = await Promise.allSettled(batch.map(async (c) => {
                  const r = await cancelOrder(c.symbol, c.orderId)
                  try { pushAudit({ ts: new Date().toISOString(), type: 'cancel', source: 'sweeper', symbol: c.symbol, orderId: c.orderId, reason: 'no_entry_auto_cancel' }) } catch {}
                  return r
                }))
                void settled
              }
              // Clean waiting TP registry for affected symbols
              try {
                for (const sym of Array.from(affectedSymbols)) {
                  try { cleanupWaitingTpForSymbol(sym) } catch {}
                }
              } catch {}
              try { console.error('[NO_ENTRY_CLEANUP]', { symbols: Array.from(affectedSymbols), cancelled: toCancel.length, grace_ms: graceMs }) } catch {}
            }
          }
        } catch {}

        const waiting = getWaitingTpList()
        const last = __lastPlaceOrders ? { request: __lastPlaceOrders.request, result: __lastPlaceOrders.result } : null
        // Augment last_planned_by_symbol from last place_orders request if available (no extra calls)
        try {
          const reqOrders = (last?.request && Array.isArray((last as any).request?.orders)) ? (last as any).request.orders : []
          for (const o of reqOrders) {
            try {
              const sym = String((o as any)?.symbol || '')
              if (!sym) continue
              const amt = Number((o as any)?.amount)
              const lev = Number((o as any)?.leverage)
              if (!__lastPlannedBySymbol[sym]) {
                __lastPlannedBySymbol[sym] = {
                  amount: Number.isFinite(amt) && amt > 0 ? amt : null,
                  leverage: Number.isFinite(lev) && lev > 0 ? Math.floor(lev) : null,
                  ts: nowIso
                }
              }
            } catch {}
          }
        } catch {}
        // Build leverage map for ALL symbols (even zero-size) from raw positions (fallback for UI)
        const levBySymbol: Record<string, number> = {}
        try {
          for (const p of (Array.isArray(positionsRaw) ? positionsRaw : [])) {
            try {
              const sym = String((p as any)?.symbol || '')
              const lev = Number((p as any)?.leverage)
              if (sym && Number.isFinite(lev) && lev > 0) levBySymbol[sym] = Math.floor(lev)
            } catch {}
          }
        } catch {}

        // Normalize open orders to UI shape (consistent with /api/open_orders)
        let openOrdersUi = (Array.isArray(ordersRaw) ? ordersRaw : []).map((o: any) => ({
          orderId: Number(o?.orderId ?? o?.orderID ?? 0) || 0,
          symbol: String(o?.symbol || ''),
          side: String(o?.side || ''),
          type: String(o?.type || ''),
          qty: (() => { const n = Number(o?.origQty ?? o?.quantity ?? o?.qty); return Number.isFinite(n) ? n : null })(),
          price: (() => { const n = Number(o?.price); return Number.isFinite(n) && n > 0 ? n : null })(),
          stopPrice: (() => { const n = Number(o?.stopPrice); return Number.isFinite(n) && n > 0 ? n : null })(),
          timeInForce: o?.timeInForce ? String(o.timeInForce) : null,
          reduceOnly: Boolean(o?.reduceOnly ?? false),
          closePosition: Boolean(o?.closePosition ?? false),
          positionSide: (typeof o?.positionSide === 'string' && o.positionSide) ? String(o.positionSide) : null,
          clientOrderId: ((): string | null => { const id = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || ''); return id || null })(),
          // Mark strategy-updater TP/SL (x_tp_*/x_sl_*) and internal entries (e_l_) as internal or by known orderId set
          // CRITICAL: SHORT-only system - ALL LONG positions are EXTERNAL (but not BUY exits for SHORT!)
          isExternal: ((): boolean => {
            try {
              // SHORT-only system: LONG position orders are automatically external
              // But BUY orders can be our SHORT exits (TP/SL), so check by positionSide only
              const posSide = String((o as any)?.positionSide || '').toUpperCase()
              if (posSide === 'LONG') return true
              
              const idStr = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
              const idIsInternal = idStr ? /^(sv2_)?(e_l_|x_sl_|x_tp_|x_ai_)/.test(idStr) : false
              if (idIsInternal) return false
              
              // Check if it's an AI order by pattern (avoid require cache)
              if (idStr.includes('x_ai_sl_') || idStr.includes('x_ai_tp_')) return false
              
              const n = Number(o?.orderId ?? 0)
              const { isStrategyOrderId } = require('../services/strategy-updater/registry')
              if (Number.isFinite(n) && isStrategyOrderId(n)) return false
              return true
            } catch { return true }
          })(),
          // Mark orders created by Strategy Updater for green highlight
          isStrategyUpdater: ((): boolean => {
            try {
              const n = Number(o?.orderId ?? 0)
              if (!Number.isFinite(n) || n <= 0) return false
              
              // CRITICAL FIX: Import fresh registry instead of using cached require()
              // require() caches the module, so Set updates aren't reflected
              // Use dynamic import OR check both registry AND clientOrderId pattern
              const cid = String(o?.clientOrderId || '')
              const isAiPattern = cid.includes('x_ai_sl_') || cid.includes('x_ai_tp_')
              
              // If clientOrderId matches AI pattern, mark as AI order
              if (isAiPattern) {
                // Debug: Log AI TP orders
                if (String(o?.type || '').includes('TAKE_PROFIT')) {
                  console.log('[SERVER_ORDER_FLAG] AI TP order (by clientOrderId):', {
                    orderId: n,
                    symbol: o?.symbol,
                    clientOrderId: cid,
                    type: o?.type,
                    price: o?.price || o?.stopPrice,
                    isStrategyUpdater: true
                  })
                }
                return true
              }
              
              // Fallback: check registry (but this may be cached)
              const { isStrategyOrderId } = require('../services/strategy-updater/registry')
              const result = isStrategyOrderId(n)
              if (result && String(o?.type || '').includes('TAKE_PROFIT')) {
                console.log('[SERVER_ORDER_FLAG] AI TP order (by registry):', {
                  orderId: n,
                  symbol: o?.symbol,
                  clientOrderId: cid,
                  type: o?.type,
                  price: o?.price || o?.stopPrice,
                  isStrategyUpdater: true
                })
              }
              return result
            } catch { return false }
          })(),
          createdAt: (() => {
            if (typeof (o as any)?.createdAt === 'string') return String((o as any).createdAt)
            const t = Number((o as any)?.time)
            return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null
          })(),
          updatedAt: (() => {
            if (typeof (o as any)?.updatedAt === 'string') return String((o as any).updatedAt)
            const tu = Number((o as any)?.updateTime)
            if (Number.isFinite(tu) && tu > 0) return new Date(tu).toISOString()
            const tt = Number((o as any)?.time)
            return Number.isFinite(tt) && tt > 0 ? new Date(tt).toISOString() : null
          })()
        }))
        
        // CRITICAL DEBUG: Log AI TP orders being sent to UI
        const aiTpOrders = openOrdersUi.filter((o: any) => 
          o.isStrategyUpdater && String(o.type || '').includes('TAKE_PROFIT')
        )
        if (aiTpOrders.length > 0) {
          console.log('[API_ORDERS_AI_TP] Sending', aiTpOrders.length, 'AI TP orders to UI:', 
            aiTpOrders.map((o: any) => ({
              orderId: o.orderId,
              symbol: o.symbol,
              clientOrderId: o.clientOrderId,
              price: o.price || o.stopPrice,
              isStrategyUpdater: o.isStrategyUpdater
            }))
          )
        }
        
        // Attach leverage and investedUsd per order for complete UI rendering (no extra calls)
        try {
          openOrdersUi = openOrdersUi.map((o: any) => {
            const planned = __lastPlannedBySymbol[o.symbol]
            const levFromPos = Number(levBySymbol[o.symbol])
            const levFromPlanned = Number(planned?.leverage)
            const leverage = Number.isFinite(levFromPos) && levFromPos > 0
              ? Math.floor(levFromPos)
              : (Number.isFinite(levFromPlanned) && levFromPlanned > 0 ? Math.floor(levFromPlanned) : null)
            let investedUsd: number | null = null
            try {
              const isEntry = String(o.side || '').toUpperCase() === 'BUY' && !(o.reduceOnly || o.closePosition)
              // Compute investedUsd only for internal entries
              const internal = /^(e_l_|x_sl_|x_tp_tm_|x_tp_l_)/.test(String(o.clientOrderId || ''))
              if (isEntry && internal) {
                // Prefer planned amount if available (exact UI input)
                const amt = Number(planned?.amount)
                if (Number.isFinite(amt) && amt > 0) investedUsd = amt
                if (investedUsd == null) {
                  const px = Number(o.price)
                  const qty = Number(o.qty)
                  if (Number.isFinite(px) && px > 0 && Number.isFinite(qty) && qty > 0 && Number.isFinite(leverage as any) && (leverage as number) > 0) {
                    investedUsd = (px * qty) / (leverage as number)
                  }
                }
              }
            } catch {}
            const isExternal = (() => {
              // SHORT-only system: LONG position orders are automatically external
              // But BUY orders can be our SHORT exits (TP/SL), so check by positionSide only
              const posSide = String(o?.positionSide || '').toUpperCase()
              if (posSide === 'LONG') return true
              
              const id = String(o.clientOrderId || '')
              return id ? !/^(sv2_)?(e_l_|x_sl_|x_tp_tm_|x_tp_l_)/.test(id) : true
            })()
            return { ...o, leverage, investedUsd, isExternal }
          })
        } catch {}
        // Normalize positions and filter zero-size entries (match /api/positions)
        const positionsUi = (Array.isArray(positionsRaw) ? positionsRaw : [])
          .map((p: any) => {
            const amt = Number(p?.positionAmt || p?.size || 0)
            const size = Number.isFinite(amt) ? Math.abs(amt) : 0
            const entry = Number(p?.entryPrice)
            const markMem = Number((p as any)?.markPrice)
            const markFromMem = Number.isFinite(markMem) && markMem > 0 ? markMem : Number((marks as any)?.[String(p?.symbol||'')])
            const mark = Number.isFinite(markFromMem) && markFromMem > 0 ? markFromMem : null
            const pnl = Number(p?.unRealizedProfit ?? p?.unrealizedPnl)
            // Leverage: prefer direct value; fallback to map from raw positions snapshot
            let lev: number | null = null
            try {
              const lv = Number((p as any)?.leverage)
              if (Number.isFinite(lv) && lv > 0) lev = lv
              else {
                const fm = Number(levBySymbol[String(p?.symbol || '')])
                if (Number.isFinite(fm) && fm > 0) lev = fm
              }
            } catch {}
            const side = (typeof p?.positionSide === 'string' && p.positionSide) ? String(p.positionSide) : (Number.isFinite(amt) ? (amt >= 0 ? 'LONG' : 'SHORT') : '')
            const upd = Number(p?.updateTime)
            // SHORT-only system: LONG positions are external
            const isExternal = side === 'LONG'
            return {
              symbol: String(p?.symbol || ''),
              positionSide: side || null,
              size: Number.isFinite(size) ? size : 0,
              entryPrice: Number.isFinite(entry) ? entry : null,
              markPrice: mark,
              unrealizedPnl: Number.isFinite(pnl) ? pnl : null,
              leverage: lev,
              updatedAt: Number.isFinite(upd) && upd > 0 ? new Date(upd).toISOString() : (Number.isFinite((p as any)?.updatedAt) ? new Date((p as any).updatedAt).toISOString() : null),
              isExternal
            }
          })
          .filter((p: any) => Number.isFinite(p.size) && p.size > 0)
        // Timestamps overview for UI (diagnostic and clarity)
        const nowIso = new Date().toISOString()
        const maxIso = (arr: any[], key: string): string | null => {
          try {
            let best: number = 0
            for (const x of (Array.isArray(arr) ? arr : [])) {
              const v = String((x as any)?.[key] || '')
              const t = v ? Date.parse(v) : 0
              if (Number.isFinite(t) && t > best) best = t
            }
            return best > 0 ? new Date(best).toISOString() : null
          } catch { return null }
        }
        const updated_at = {
          orders: maxIso(openOrdersUi, 'updatedAt'),
          positions: maxIso(positionsUi, 'updatedAt'),
          marks: Object.keys(marks || {}).length > 0 ? nowIso : null
        }
        // Attach Binance rate-limit usage snapshot (no extra calls) – for UI mini-badge
        const limits = getLimitsSnapshot()
        const WEIGHT_LIMIT = (() => {
          const cfg = Number((tradingCfg as any)?.BINANCE_WEIGHT_LIMIT_1M)
          if (Number.isFinite(cfg) && cfg > 0) return Math.floor(cfg)
          const env = Number(process.env.BINANCE_WEIGHT_LIMIT_1M)
          if (Number.isFinite(env) && env > 0) return Math.floor(env)
          return 1200
        })()
        const wUsedNum = Number(limits?.maxUsedWeight1mLast60s ?? limits?.lastUsedWeight1m)
        const pct = Number.isFinite(wUsedNum) && wUsedNum >= 0 ? Math.min(999, Math.round((wUsedNum / WEIGHT_LIMIT) * 100)) : null
        const binance_usage = {
          weight1m_used: Number.isFinite(wUsedNum) ? wUsedNum : null,
          weight1m_limit: WEIGHT_LIMIT,
          orderCount10s: limits?.lastOrderCount10s ?? null,
          orderCount1m: limits?.lastOrderCount1m ?? null,
          percent: pct,
          callRate: limits?.callRate ?? null,
          risk: limits?.risk ?? 'normal',
          backoff_active: Boolean(limits?.backoff),
          backoff_remaining_sec: limits?.backoff?.remainingSec ?? null
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, positions: positionsUi, open_orders: openOrdersUi, marks, waiting, last_place: last, server_time: nowIso, updated_at, aux: { last_planned_by_symbol: __lastPlannedBySymbol, leverage_by_symbol: levBySymbol }, binance_usage }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }
    if (url.pathname === '/api/snapshot') {
      res.setHeader('Cache-Control', 'no-store')
      const t0 = performance.now()
      try {
        // universeStrategy: volume (default) | gainers via query ?universe=gainers
        const uniParam = String(url.searchParams.get('universe') || '').toLowerCase()
        const universeStrategy = (['gainers', 'losers', 'volume', 'overheat'].includes(uniParam) ? uniParam : 'losers') as 'gainers'|'losers'|'volume'|'overheat'
        const fresh = String(url.searchParams.get('fresh') || '1') === '1'
        const topN = Number(url.searchParams.get('topN') || '')
        // Persist poslední UI snapshot kritéria pro background autopilot
        try {
          persistBackgroundCriteria({ universe: universeStrategy as any, topN: Number.isFinite(topN) ? topN : null, fresh })
        } catch {}
        const snapshot = await buildMarketRawSnapshot({ universeStrategy, desiredTopN: Number.isFinite(topN) ? topN : undefined, fresh, allowPartial: true })
        ;(snapshot as any).duration_ms = Math.round(performance.now() - t0)
        delete (snapshot as any).latency_ms
        const body = JSON.stringify(snapshot)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(body)
      } catch (err: any) {
        const stage = String(err?.stage || '').toLowerCase()
        const isUniverseIncomplete = stage === 'universe_incomplete' || /universe\s*incomplete/i.test(String(err?.message||''))
        if (isUniverseIncomplete) {
          const out = {
            timestamp: new Date().toISOString(),
            exchange: 'Binance',
            market_type: 'perp',
            feeds_ok: false,
            data_warnings: ['universe_incomplete'],
            btc: { klines: {} },
            eth: { klines: {} },
            universe: [],
            policy: { max_hold_minutes: null, risk_per_trade_pct: null, risk_per_trade_pct_flat: null, max_leverage: null }
          }
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(out))
          return
        }
        res.statusCode = 500
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: err?.message || 'INTERNAL_ERROR' }))
      }
      return
    }

    if (url.pathname === '/api/snapshot_light' || url.pathname === '/api/snapshot_pro') {
      res.setHeader('Cache-Control', 'no-store')
      const pro = url.pathname === '/api/snapshot_pro'
      try {
        const uniParam = String(url.searchParams.get('universe') || '').toLowerCase()
        const universeStrategy = (['gainers', 'losers', 'volume', 'overheat'].includes(uniParam) ? uniParam : 'losers') as 'gainers'|'losers'|'volume'|'overheat'
        const fresh = String(url.searchParams.get('fresh') || '1') === '1'
        const topN = Number(url.searchParams.get('topN') || '')
        // If a symbol is requested, force-include it in the universe build so it can't be dropped
        const includeSymbols = (() => {
          const s = url.searchParams.get('symbol')
          if (!s) return undefined
          const v = String(s).toUpperCase()
          return [v]
        })()
        const snap = await buildMarketRawSnapshot({ universeStrategy, desiredTopN: Number.isFinite(topN) ? topN : undefined, includeSymbols, fresh, allowPartial: true })
        type K = { time: string; open: number; high: number; low: number; close: number; volume: number }
        const toBars = (arr: any[], keep: number): K[] => {
          if (!Array.isArray(arr)) return []
          const sliced = arr.slice(-keep)
          // ensure ascending (Binance returns ascending already)
          return sliced.map((k: any) => ({ time: String(k.openTime), open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close), volume: Number(k.volume) }))
        }
        const symbols = (snap.universe || []).map((u: any) => {
          const H1 = toBars(u.klines?.H1 || [], 24)
          const M15 = toBars(u.klines?.M15 || [], 96)
          const base: any = {
            symbol: u.symbol,
            price: Number(u.price ?? (H1.length ? H1[H1.length-1].close : null)),
            ohlcv: { h1: H1, m15: M15 },
            indicators: {
              atr_h1: u.atr_h1 ?? null,
              atr_m15: u.atr_m15 ?? null,
              ema_h1: { 20: u.ema20_H1 ?? null, 50: u.ema50_H1 ?? null, 200: u.ema200_H1 ?? null },
              ema_m15: { 20: u.ema20_M15 ?? null, 50: u.ema50_M15 ?? null, 200: u.ema200_M15 ?? null },
              rsi_h1: u.rsi_H1 ?? null,
              rsi_m15: u.rsi_M15 ?? null,
              vwap_today: u.vwap_today ?? u.vwap_daily ?? null
            },
            levels: {
              support: Array.isArray(u.support) ? u.support.slice(0,4) : [],
              resistance: Array.isArray(u.resistance) ? u.resistance.slice(0,4) : []
            },
            market: {
              spread_bps: u.spread_bps ?? null,
              liquidity_usd: (u.liquidity_usd ?? ((u.liquidity_usd_0_5pct?.bids||0)+(u.liquidity_usd_0_5pct?.asks||0)+(u.liquidity_usd_1pct?.bids||0)+(u.liquidity_usd_1pct?.asks||0))) || null,
              volume_24h: u.volume24h_usd ?? null,
              oi_change_1h_pct: u.oi_change_1h_pct ?? null,
              funding_8h_pct: u.funding_8h_pct ?? null
            }
          }
          return base
        })
        const h1Change = (kl: any[]): number | null => {
          try { const a = kl.slice(-2); return (a.length===2 && Number.isFinite(a[0]?.close) && Number.isFinite(a[1]?.close)) ? (((a[1].close / a[0].close) - 1) * 100) : null } catch { return null }
        }
        const m15Change = (kl: any[]): number | null => {
          try { const a = kl.slice(-5); return (a.length>=2 && Number.isFinite(a[a.length-2]?.close) && Number.isFinite(a[a.length-1]?.close)) ? (((a[a.length-1].close / a[a.length-2].close) - 1) * 100) : null } catch { return null }
        }
        const regime = {
          BTCUSDT: { h1_change_pct: h1Change((snap as any)?.btc?.klines?.H1 || []), m15_change_pct: m15Change((snap as any)?.btc?.klines?.M15 || []) },
          ETHUSDT: { h1_change_pct: h1Change((snap as any)?.eth?.klines?.H1 || []), m15_change_pct: m15Change((snap as any)?.eth?.klines?.M15 || []) }
        }
        const policy = {
          max_hold_minutes: (snap as any)?.policy?.max_hold_minutes ?? null,
          risk_per_trade_pct: ((snap as any)?.policy?.risk_per_trade_pct_flat ?? (snap as any)?.policy?.risk_per_trade_pct?.OK) ?? null,
          max_leverage: (snap as any)?.policy?.max_leverage ?? null
        }
        const out: any = {
          timestamp: snap.timestamp,
          exchange: (snap as any)?.exchange || 'Binance',
          market_type: (snap as any)?.market_type || 'perp',
          policy,
          symbols
        }
        out.regime = regime
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(out))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: e?.message || 'unknown' }))
      }
      return
    }

    if (url.pathname === '/api/intraday_any' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        const symbolRaw = url.searchParams.get('symbol')
        if (!symbolRaw) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'Missing symbol parameter' }))
          return
        }
        const normalizeSymbol = (s: string): string => {
          let v = String(s || '').trim().toUpperCase()
          if (!v) return ''
          if (v.includes('/')) v = v.replace('/', '')
          if (!v.endsWith('USDT')) v = `${v}USDT`
          return v
        }
        const symbol = normalizeSymbol(symbolRaw)
        
        // Fetch data for any symbol directly - use minimal universe to avoid UNIVERSE_INCOMPLETE
        const { buildMarketRawSnapshot } = await import('./fetcher/binance')
        // Retry wrapper pro občasné Abort/timeout chyby
        const retry = async <T>(fn: ()=>Promise<T>, attempts=2): Promise<T> => {
          let lastErr: any
          for (let i=0;i<=attempts;i++) {
            try { return await fn() } catch (e:any) {
              lastErr = e
              const name = String(e?.name||'').toLowerCase()
              const msg = String(e?.message||'').toLowerCase()
              const abortLike = name.includes('abort') || msg.includes('abort') || msg.includes('timeout')
              if (!abortLike || i===attempts) throw e
            }
          }
          throw lastErr
        }
        const snap = await retry(() => buildMarketRawSnapshot({ universeStrategy: 'volume', desiredTopN: 1, includeSymbols: [symbol], fresh: true }))
        
        // Find the symbol in universe or btc/eth
        let targetItem: any = null
        if (symbol === 'BTCUSDT') targetItem = (snap as any)?.btc
        else if (symbol === 'ETHUSDT') targetItem = (snap as any)?.eth
        else targetItem = (snap.universe || []).find((u: any) => u.symbol === symbol)
        
        if (!targetItem) {
          res.statusCode = 404
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'SYMBOL_NOT_SUPPORTED', symbol }))
          return
        }
        
        const toIsoNoMs = (isoLike: string): string => {
          const s = String(isoLike || '')
          if (s.endsWith('Z')) return s.replace(/\.\d{1,3}Z$/, 'Z')
          const z = s.replace(/\.\d{1,3}$/,'')
          return z.endsWith('Z') ? z : `${z}Z`
        }
        const toBars = (arr: any[], keep: number) => {
          if (!Array.isArray(arr)) return []
          const slice = arr.slice(-keep)
          return slice.map((k: any) => ({
            time: toIsoNoMs(k.openTime),
            open: Number(k.open),
            high: Number(k.high),
            low: Number(k.low),
            close: Number(k.close),
            volume: Number(k.volume)
          }))
        }
        
        const h1 = toBars(targetItem.klines?.H1 || [], 24)
        const m15 = toBars(targetItem.klines?.M15 || [], 40)
        
        // ENRICHMENT: Add raw klines for pattern recognition (keep more candles for AI analysis)
        const rawKlines = {
          M5: Array.isArray(targetItem.klines?.M5) ? targetItem.klines.M5.slice(-60).map((k: any) => ({
            openTime: toIsoNoMs(k.openTime),
            open: Number(k.open),
            high: Number(k.high),
            low: Number(k.low),
            close: Number(k.close),
            volume: Number(k.volume),
            closeTime: toIsoNoMs(k.closeTime)
          })) : [],
          M15: Array.isArray(targetItem.klines?.M15) ? targetItem.klines.M15.slice(-96).map((k: any) => ({
            openTime: toIsoNoMs(k.openTime),
            open: Number(k.open),
            high: Number(k.high),
            low: Number(k.low),
            close: Number(k.close),
            volume: Number(k.volume),
            closeTime: toIsoNoMs(k.closeTime)
          })) : [],
          H1: Array.isArray(targetItem.klines?.H1) ? targetItem.klines.H1.slice(-48).map((k: any) => ({
            openTime: toIsoNoMs(k.openTime),
            open: Number(k.open),
            high: Number(k.high),
            low: Number(k.low),
            close: Number(k.close),
            volume: Number(k.volume),
            closeTime: toIsoNoMs(k.closeTime)
          })) : []
        }
        
        const asset = {
          symbol: targetItem.symbol,
          timestamp: toIsoNoMs((snap as any)?.timestamp || new Date().toISOString()),
          price: Number(targetItem.price ?? (h1.length ? h1[h1.length-1].close : null)),
          ohlcv: { h1, m15 },
          klines: rawKlines, // NEW: Raw klines for AI pattern recognition
          indicators: {
            atr_h1: targetItem.atr_h1 ?? null,
            atr_m15: targetItem.atr_m15 ?? null,
            atr_pct_h1: targetItem.atr_pct_H1 ?? null,
            atr_pct_m15: targetItem.atr_pct_M15 ?? null,
            ema_h1: { 20: targetItem.ema20_H1 ?? null, 50: targetItem.ema50_H1 ?? null, 200: targetItem.ema200_H1 ?? null },
            ema_m15: { 20: targetItem.ema20_M15 ?? null, 50: targetItem.ema50_M15 ?? null, 200: targetItem.ema200_M15 ?? null },
            rsi_h1: targetItem.rsi_H1 ?? null,
            rsi_m15: targetItem.rsi_M15 ?? null,
            vwap_today: targetItem.vwap_today ?? targetItem.vwap_daily ?? null
          },
          levels: {
            support: Array.isArray(targetItem.support) ? targetItem.support.slice(0,4) : [],
            resistance: Array.isArray(targetItem.resistance) ? targetItem.resistance.slice(0,4) : []
          },
          market: {
            spread_bps: targetItem.spread_bps ?? null,
            liquidity_usd: targetItem.liquidity_usd ?? null,
            volume_24h: targetItem.volume24h_usd ?? null,
            oi_change_1h_pct: targetItem.oi_change_1h_pct ?? null,
            funding_8h_pct: targetItem.funding_8h_pct ?? null
          }
        }
        
        const out = {
          timestamp: toIsoNoMs((snap as any)?.timestamp || new Date().toISOString()),
          exchange: 'Binance',
          market_type: 'perp',
          assets: [asset]
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(out))
      } catch (e: any) {
        const name = String(e?.name||'').toLowerCase()
        const msg = String(e?.message||'').toLowerCase()
        const abortLike = name.includes('abort') || msg.includes('abort') || msg.includes('timeout')
        res.statusCode = abortLike ? 503 : 500
        if (abortLike) res.setHeader('Retry-After', '1')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: abortLike ? 'UNAVAILABLE_TEMPORARILY' : (e?.message || 'unknown') }))
      }
      return
    }

    if (url.pathname === '/api/intraday') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        const uniParam = String(url.searchParams.get('universe') || '').toLowerCase()
        const universeStrategy = (['gainers', 'losers', 'volume', 'overheat'].includes(uniParam) ? uniParam : 'losers') as 'gainers'|'losers'|'volume'|'overheat'
        const topN = Number(url.searchParams.get('topN') || '')
        const fresh = String(url.searchParams.get('fresh') || '1') === '1'
        const snap = await buildMarketRawSnapshot({ universeStrategy, desiredTopN: Number.isFinite(topN) ? topN : undefined, fresh })
        type Bar = { time: string; open: number; high: number; low: number; close: number; volume: number }
        const toIsoNoMs = (isoLike: string): string => {
          const s = String(isoLike || '')
          // Ensure Z-suffix and drop milliseconds if present
          if (s.endsWith('Z')) return s.replace(/\.\d{1,3}Z$/, 'Z')
          // If missing Z but looks like ISO, append Z
          const z = s.replace(/\.\d{1,3}$/,'')
          return z.endsWith('Z') ? z : `${z}Z`
        }
        const normalizeSymbol = (s: string): string => {
          let v = String(s || '').trim().toUpperCase()
          if (!v) return ''
          if (v.includes('/')) v = v.replace('/', '')
          if (!v.endsWith('USDT')) v = `${v}USDT`
          return v
        }
        const toBars = (arr: any[], keep: number): Bar[] => {
          if (!Array.isArray(arr)) return []
          const slice = arr.slice(-keep)
          return slice.map((k: any) => ({
            time: toIsoNoMs(k.openTime),
            open: Number(k.open),
            high: Number(k.high),
            low: Number(k.low),
            close: Number(k.close),
            volume: Number(k.volume)
          }))
        }
        let assets = (snap.universe || []).map((u: any) => {
          const h1 = toBars(u.klines?.H1 || [], 24)
          const m15 = toBars(u.klines?.M15 || [], 40)
          return {
            symbol: u.symbol,
            price: Number(u.price ?? (h1.length ? h1[h1.length-1].close : null)),
            ohlcv: { h1, m15 },
            indicators: {
              atr_h1: u.atr_h1 ?? null,
              atr_m15: u.atr_m15 ?? null,
              ema_h1: { 20: u.ema20_H1 ?? null, 50: u.ema50_H1 ?? null, 200: u.ema200_H1 ?? null },
              ema_m15: { 20: u.ema20_M15 ?? null, 50: u.ema50_M15 ?? null, 200: u.ema200_M15 ?? null },
              rsi_h1: u.rsi_H1 ?? null,
              rsi_m15: u.rsi_M15 ?? null,
              vwap_today: u.vwap_today ?? u.vwap_daily ?? null
            },
            levels: {
              support: Array.isArray(u.support) ? u.support.slice(0,4) : [],
              resistance: Array.isArray(u.resistance) ? u.resistance.slice(0,4) : []
            },
            market: {
              spread_bps: u.spread_bps ?? null,
              liquidity_usd: (u.liquidity_usd ?? ((u.liquidity_usd_0_5pct?.bids||0)+(u.liquidity_usd_0_5pct?.asks||0)+(u.liquidity_usd_1pct?.bids||0)+(u.liquidity_usd_1pct?.asks||0))) || null,
              volume_24h: u.volume24h_usd ?? null,
              oi_change_1h_pct: u.oi_change_1h_pct ?? null,
              funding_8h_pct: u.funding_8h_pct ?? null
            }
          }
        })
        const onlySymbolRaw = url.searchParams.get('symbol')
        if (onlySymbolRaw) {
          const onlySymbol = normalizeSymbol(onlySymbolRaw)
          assets = assets.filter(a => a.symbol === onlySymbol)
          if (assets.length === 0) {
            // Try to generate data for symbol not in universe
            try {
              const expandedSnap = await buildMarketRawSnapshot({ universeStrategy, desiredTopN: Number.isFinite(topN) ? topN : undefined, includeSymbols: [onlySymbol] })
              const expandedAsset = (expandedSnap.universe || []).find((u: any) => u.symbol === onlySymbol)
              if (expandedAsset) {
                const h1 = toBars(expandedAsset.klines?.H1 || [], 24)
                const m15 = toBars(expandedAsset.klines?.M15 || [], 40)
                const generatedAsset = {
                  symbol: expandedAsset.symbol,
                  price: Number(expandedAsset.price ?? (h1.length ? h1[h1.length-1].close : null)),
                  ohlcv: { h1, m15 },
                  indicators: {
                    atr_h1: expandedAsset.atr_h1 ?? null,
                    atr_m15: expandedAsset.atr_m15 ?? null,
                    ema_h1: { 20: expandedAsset.ema20_H1 ?? null, 50: expandedAsset.ema50_H1 ?? null, 200: expandedAsset.ema200_H1 ?? null },
                    ema_m15: { 20: expandedAsset.ema20_M15 ?? null, 50: expandedAsset.ema50_M15 ?? null, 200: expandedAsset.ema200_M15 ?? null },
                    rsi_h1: expandedAsset.rsi_H1 ?? null,
                    rsi_m15: expandedAsset.rsi_M15 ?? null,
                    vwap_today: expandedAsset.vwap_today ?? expandedAsset.vwap_daily ?? null
                  },
                  levels: {
                    support: Array.isArray(expandedAsset.support) ? expandedAsset.support.slice(0,4) : [],
                    resistance: Array.isArray(expandedAsset.resistance) ? expandedAsset.resistance.slice(0,4) : []
                  },
                  market: {
                    spread_bps: expandedAsset.spread_bps ?? null,
                    liquidity_usd: expandedAsset.liquidity_usd ?? null,
                    volume_24h: expandedAsset.volume24h_usd ?? null,
                    oi_change_1h_pct: expandedAsset.oi_change_1h_pct ?? null,
                    funding_8h_pct: expandedAsset.funding_8h_pct ?? null
                  }
                }
                assets = [generatedAsset]
              } else {
                res.statusCode = 404
                res.setHeader('content-type', 'application/json')
                res.end(JSON.stringify({ error: 'SYMBOL_NOT_FOUND', symbol: onlySymbol, available_count: (snap.universe || []).length }))
                return
              }
            } catch (e: any) {
              res.statusCode = 404
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ error: 'SYMBOL_NOT_FOUND', symbol: onlySymbol, expand_error: e?.message || 'unknown' }))
              return
            }
          }
        }
        // OPRAVA: Použití konzistentní výpočetní funkce
        const regime = {
          BTCUSDT: { 
            h1_change_pct: calculateKlineChangePercent((snap as any)?.btc?.klines?.H1 || [], 2), 
            m15_change_pct: calculateKlineChangePercent((snap as any)?.btc?.klines?.M15 || [], 2) 
          },
          ETHUSDT: { 
            h1_change_pct: calculateKlineChangePercent((snap as any)?.eth?.klines?.H1 || [], 2), 
            m15_change_pct: calculateKlineChangePercent((snap as any)?.eth?.klines?.M15 || [], 2) 
          }
        }
        const out = {
          timestamp: toIsoNoMs((snap as any)?.timestamp || new Date().toISOString()),
          exchange: (snap as any)?.exchange || 'Binance',
          market_type: (snap as any)?.market_type || 'perp',
          policy: {
            max_hold_minutes: (snap as any)?.policy?.max_hold_minutes ?? null,
            risk_per_trade_pct: (snap as any)?.policy?.risk_per_trade_pct_flat ?? null,
            max_leverage: (snap as any)?.policy?.max_leverage ?? null
          },
          regime,
          assets
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(out))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: e?.message || 'unknown' }))
      }
      return
    }
    
    if (url.pathname === '/api/metrics') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        const uniParam = String(url.searchParams.get('universe') || '').toLowerCase()
        const universeStrategy = (['gainers', 'losers', 'volume', 'overheat'].includes(uniParam) ? uniParam : 'losers') as 'gainers'|'losers'|'volume'|'overheat'
        const topN = Number(url.searchParams.get('topN') || '')
        const sideParam = String(url.searchParams.get('side') || url.searchParams.get('bias') || '').toLowerCase()
        const side: 'short'|'long'|null = sideParam === 'short' ? 'short' : (sideParam === 'long' ? 'long' : null)
        // Retry wrapper pro dočasné chyby (Abort/timeout)
        const retry = async <T>(fn: ()=>Promise<T>, attempts=2): Promise<T> => {
          let lastErr: any
          for (let i=0; i<=attempts; i++) {
            try { return await fn() } catch (e:any) {
              lastErr = e
              const name = String(e?.name||'').toLowerCase()
              const msg = String(e?.message||'').toLowerCase()
              const abortLike = name.includes('abort') || msg.includes('abort') || msg.includes('timeout')
              if (!abortLike || i===attempts) throw e
            }
          }
          throw lastErr
        }
        const snap = await retry(() => buildMarketRawSnapshot({ universeStrategy, desiredTopN: Number.isFinite(topN) ? topN : undefined, fresh: true, allowPartial: true }))
        type Bar = { time: string; open: number; high: number; low: number; close: number; volume: number }
        const toIsoNoMs = (isoLike: string): string => {
          const s = String(isoLike || '')
          if (s.endsWith('Z')) return s.replace(/\.\d{1,3}Z$/, 'Z')
          const z = s.replace(/\.\d{1,3}$/,'')
          return z.endsWith('Z') ? z : `${z}Z`
        }
        const lastClose = (arr: any[]): number | null => {
          try { const a = Array.isArray(arr) ? arr : []; return a.length ? Number(a[a.length-1]?.close) : null } catch { return null }
        }
        // OPRAVA: Odstraněn duplicitní changePct - použije se importovaná funkce
        const mapItem = (u: any): any => {
          const h1 = Array.isArray(u.klines?.H1) ? u.klines.H1 : []
          return {
            symbol: u.symbol,
            price: Number(u.price ?? lastClose(h1) ?? null),
            volume_24h: u.volume24h_usd ?? null,
            spread_bps: u.spread_bps ?? null,
            liquidity_usd: u.liquidity_usd ?? null,
            rsi: { h1: u.rsi_H1 ?? null, m15: u.rsi_M15 ?? null },
            ema: {
              h1: { 20: u.ema20_H1 ?? null, 50: u.ema50_H1 ?? null, 200: u.ema200_H1 ?? null },
              m15: { 20: u.ema20_M15 ?? null, 50: u.ema50_M15 ?? null, 200: u.ema200_M15 ?? null }
            },
            atr: { h1: u.atr_h1 ?? null, m15: u.atr_m15 ?? null },
            vwap_today: u.vwap_today ?? u.vwap_daily ?? null,
            support: Array.isArray(u.support) ? u.support.slice(0,4) : [],
            resistance: Array.isArray(u.resistance) ? u.resistance.slice(0,4) : [],
            oi_change_1h_pct: u.oi_change_1h_pct ?? null,
            funding_8h_pct: u.funding_8h_pct ?? null
          }
        }
        // OPRAVA: Respektuj universe strategy - pro gainers nevkládej BTC/ETH pokud nejsou top gainers
        let coins: any[] = []
        const universeCoins = (snap.universe || []).map(mapItem)
        
        if (universeStrategy === 'gainers' || universeStrategy === 'overheat') {
          // Pro gainers a overheat pouze actual gainers z universe, bez vynuceného BTC/ETH
          coins = universeCoins
        } else {
          // Pro volume zachovat původní logiku s BTC/ETH na začátku
          const coinsCore: any[] = []
          const btc = (snap as any)?.btc
          const eth = (snap as any)?.eth
          if (btc && btc.klines) coinsCore.push(mapItem({ ...btc, symbol: 'BTCUSDT' }))
          if (eth && eth.klines) coinsCore.push(mapItem({ ...eth, symbol: 'ETHUSDT' }))
          coins = coinsCore.concat(universeCoins)
        }
        // OPRAVA: Použití konzistentní výpočetní funkce pro /api/metrics
        const regime = {
          BTCUSDT: { 
            h1_change_pct: calculateKlineChangePercent((snap as any)?.btc?.klines?.H1 || [], 2), 
            m15_change_pct: calculateKlineChangePercent((snap as any)?.btc?.klines?.M15 || [], 2) 
          },
          ETHUSDT: { 
            h1_change_pct: calculateKlineChangePercent((snap as any)?.eth?.klines?.H1 || [], 2), 
            m15_change_pct: calculateKlineChangePercent((snap as any)?.eth?.klines?.M15 || [], 2) 
          }
        }
        // Deduplicate coins by symbol while preserving order (first occurrence wins)
        const seen = new Set<string>()
        const dedupCoins = coins.filter((c: any) => {
          const sym = String(c?.symbol || '')
          if (!sym) return false
          if (seen.has(sym)) return false
          seen.add(sym)
          return true
        })

        // No pre-filtering - Hot Screener has its own comprehensive fail-fast filters
        // Let GPT analyze the full universe and apply its own selection criteria
        const filteredCoins = dedupCoins

        // STRICT: Validace snapshot metadata - žádné fallbacky
        const exchange = (snap as any)?.exchange
        const market_type = (snap as any)?.market_type
        const timestamp = (snap as any)?.timestamp
        
        if (!exchange || typeof exchange !== 'string') {
          throw new Error('Missing or invalid exchange in snapshot')
        }
        if (!market_type || typeof market_type !== 'string') {
          throw new Error('Missing or invalid market_type in snapshot')
        }
        if (!timestamp || typeof timestamp !== 'string') {
          throw new Error('Missing or invalid timestamp in snapshot')
        }

        const out = {
          policy: {
            max_hold_minutes: (snap as any)?.policy?.max_hold_minutes ?? null,
            risk_per_trade_pct: (snap as any)?.policy?.risk_per_trade_pct_flat ?? null,
            max_leverage: (snap as any)?.policy?.max_leverage ?? null
          },
          exchange,
          market_type,
          regime,
          timestamp: toIsoNoMs(timestamp),
          coins: filteredCoins
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(out))
      } catch (e: any) {
        try {
          console.error('[METRICS_ERROR]', {
            message: e?.message || String(e),
            name: e?.name || null,
            stack: e?.stack || null
          })
        } catch {}
        const name = String(e?.name||'').toLowerCase()
        const msg = String(e?.message||'').toLowerCase()
        const abortLike = name.includes('abort') || msg.includes('abort') || msg.includes('timeout')
        const isUniverseIncomplete = /universe_incomplete|universe\s*incomplete/i.test(String(e?.message||'')) || String((e as any)?.stage||'') === 'universe_incomplete'
        
        // STRICT: Žádné fallbacky - všechny chyby včetně universe_incomplete vracejí error
        res.statusCode = abortLike ? 503 : (isUniverseIncomplete ? 503 : 500)
        if (abortLike) res.setHeader('Retry-After', '1')
        res.setHeader('content-type', 'application/json')
        
        const errorCode = isUniverseIncomplete ? 'UNIVERSE_INCOMPLETE' : (abortLike ? 'UNAVAILABLE_TEMPORARILY' : 'INTERNAL_ERROR')
        res.end(JSON.stringify({ error: errorCode, message: e?.message || 'unknown' }))
      }
      return
    }

    if (url.pathname === '/api/place_orders' && req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store')
      await acquireBatch()
      try {
        const chunks: Buffer[] = []
        for await (const ch of req) chunks.push(ch as Buffer)
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        const parsed = (bodyStr ? JSON.parse(bodyStr) : null) as PlaceOrdersRequest
        
        // Validate input
        if (!parsed.orders || !Array.isArray(parsed.orders) || parsed.orders.length === 0) {
          throw new Error('Missing or invalid orders array')
        }
        
        // Validate each order
        for (const order of parsed.orders) {
          if (!order.symbol || typeof order.symbol !== 'string') {
            throw new Error('Missing or invalid symbol in order')
          }
          if (!order.side || !['LONG','SHORT'].includes(order.side as any)) {
            throw new Error('Invalid side - must be LONG or SHORT')
          }
          if (!order.strategy || !['conservative', 'aggressive'].includes(order.strategy)) {
            throw new Error('Invalid strategy - must be conservative or aggressive')
          }
          if (!order.tpLevel || !['tp1', 'tp2', 'tp3'].includes(order.tpLevel)) {
            throw new Error('Invalid tpLevel - must be tp1, tp2, or tp3')
          }
          if (!order.amount || typeof order.amount !== 'number' || order.amount <= 0) {
            throw new Error('Invalid amount - must be positive number')
          }
          if (!order.leverage || typeof order.leverage !== 'number' || order.leverage < 1 || order.leverage > 125) {
            throw new Error('Invalid leverage - must be between 1 and 125')
          }
          if (typeof (order as any).sl !== 'number' || !Number.isFinite((order as any).sl) || (order as any).sl <= 0) {
            throw new Error('Missing or invalid SL')
          }
          if (typeof (order as any).tp !== 'number' || !Number.isFinite((order as any).tp) || (order as any).tp <= 0) {
            throw new Error('Missing or invalid TP')
          }
        }
        
        // Deduplicate by symbol – server-side safety
        const seen = new Set<string>()
        parsed.orders = parsed.orders.filter((o:any)=>{
          const sym = String(o?.symbol||'')
          if (!sym || seen.has(sym)) return false
          seen.add(sym)
          return true
        })
        console.log(`[PLACE_ORDERS] Processing ${parsed.orders.length} orders`)
        try {
          console.info('[PLACE_ORDERS_REQ]', { sample: parsed.orders.slice(0,3) })
          // Explicit trace: UI -> server mapping for each order (STRICT 1:1)
          for (const o of parsed.orders) {
            try {
              console.info('[PLACE_ORDERS_MAP]', {
                symbol: String((o as any)?.symbol || ''),
                side: String((o as any)?.side || ''),
                strategy: String((o as any)?.strategy || ''),
                tpLevel: String((o as any)?.tpLevel || ''),
                entry: Number((o as any)?.entry ?? 0),
                sl: Number((o as any)?.sl ?? 0),
                tp: Number((o as any)?.tp ?? 0)
              })
            } catch {}
          }
        } catch {}
        // Cross-request throttle: prevent duplicate ENTRY submissions per symbol for a short window
        try {
          const memOrders = isUserDataReady('orders') ? getOpenOrdersInMemory() : []
          const hasEntryOpen = (sym: string): boolean => {
            try {
              return (Array.isArray(memOrders) ? memOrders : []).some((o: any) => (
                String(o?.symbol || '') === sym &&
                String(o?.side || '').toUpperCase() === 'BUY' &&
                String(o?.type || '').toUpperCase() === 'LIMIT' &&
                !(o?.reduceOnly || o?.closePosition)
              ))
            } catch { return false }
          }
          const THROTTLE_MS = 8000
          const filtered: PlaceOrdersRequest['orders'] = [] as any
          const exitsForSkipped: Array<{ symbol: string; sl: number; tp: number }> = []
          for (const o of parsed.orders) {
            const sym = String((o as any)?.symbol || '')
            if (!sym) continue
            const key = makeKey('entry_throttle', sym)
            const recent = ttlGet(key)
            if (recent != null) { try { console.error('[ENTRY_THROTTLED_RECENT]', { symbol: sym }) } catch {} ; continue }
            if (hasEntryOpen(sym)) {
              try { console.error('[ENTRY_THROTTLED_OPEN]', { symbol: sym }) } catch {}
              try { ttlSet(key, Date.now(), Math.ceil(THROTTLE_MS/1000)) } catch {}
              // Schedule exits for this symbol (no duplicate entry)
              const sl = Number((o as any)?.sl)
              const tp = Number((o as any)?.tp)
              if (Number.isFinite(sl) || Number.isFinite(tp)) exitsForSkipped.push({ symbol: sym, sl, tp })
              continue
            }
            filtered.push(o)
            try { ttlSet(key, Date.now(), Math.ceil(THROTTLE_MS/1000)) } catch {}
          }
          parsed.orders = filtered
          // Fire-and-forget exits for skipped symbols (no REST reads, direct orders)
          if (exitsForSkipped.length > 0) {
            const api = getBinanceAPI() as any
            const workingType = String((tradingCfg as any)?.EXIT_WORKING_TYPE || 'MARK_PRICE') as 'MARK_PRICE' | 'CONTRACT_PRICE'
            let isHedge = false
            try { isHedge = Boolean(await api.getHedgeMode()) } catch {}
            const tasks = exitsForSkipped.map(async (x) => {
              try {
                if (Number.isFinite(x.sl)) {
                  const slParams: any = isHedge
                    ? { symbol: x.symbol, side: 'BUY', type: 'STOP_MARKET', stopPrice: String(x.sl), closePosition: true, workingType, positionSide: 'SHORT', newOrderRespType: 'RESULT' }
                    : { symbol: x.symbol, side: 'BUY', type: 'STOP_MARKET', stopPrice: String(x.sl), closePosition: true, workingType, newOrderRespType: 'RESULT' }
                  await api.placeOrder(slParams)
                }
                if (Number.isFinite(x.tp)) {
                  const tpParams: any = isHedge
                    ? { symbol: x.symbol, side: 'BUY', type: 'TAKE_PROFIT_MARKET', stopPrice: String(x.tp), closePosition: true, workingType, positionSide: 'SHORT', newOrderRespType: 'RESULT' }
                    : { symbol: x.symbol, side: 'BUY', type: 'TAKE_PROFIT_MARKET', stopPrice: String(x.tp), closePosition: true, workingType, newOrderRespType: 'RESULT' }
                  await api.placeOrder(tpParams)
                }
                try { console.info('[EXITS_FOR_SKIPPED_SENT]', { symbol: x.symbol }) } catch {}
              } catch (e:any) {
                try { console.error('[EXITS_FOR_SKIPPED_ERR]', { symbol: x.symbol, error: e?.message || e }) } catch {}
              }
            })
            Promise.allSettled(tasks).catch(()=>{})
          }
          if (parsed.orders.length === 0 && exitsForSkipped.length > 0) {
            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ success: true, orders: [], exits_only: true }))
            return
          } else if (parsed.orders.length === 0) {
            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ success: true, orders: [], throttled: true }))
            return
          }
        } catch {}

        const tStart = Date.now()
        try { console.error('[BATCH_START]', { ts: new Date().toISOString(), count: parsed.orders.length }) } catch {}
        const result = await executeHotTradingOrders(parsed)
        try { console.error('[BATCH_DONE]', { ts: new Date().toISOString(), dur_ms: Date.now() - tStart, success: !!(result as any)?.success }) } catch {}
        
        // Po úspěšném volání z UI → uložit pro background repeat
        if (result?.success && Array.isArray(parsed?.orders) && parsed.orders.length > 0) {
          __lastSuccessfulTradingParams = parsed
          persistBackgroundSettings(parsed)
          console.info('[UI_PARAMS_SAVED]', { orders: parsed.orders.length, for_background_repeat: true })
        }
        
        try {
          __lastPlaceOrders = { request: parsed, result }
          // Populate per-symbol planned amount/leverage hints for UI completeness
          try {
            const orders = Array.isArray(parsed?.orders) ? parsed.orders : []
            for (const o of orders) {
              const sym = String((o as any)?.symbol || '')
              if (!sym) continue
              const amount = Number((o as any)?.amount)
              const leverage = Number((o as any)?.leverage)
              __lastPlannedBySymbol[sym] = {
                amount: Number.isFinite(amount) && amount > 0 ? amount : null,
                leverage: Number.isFinite(leverage) && leverage > 0 ? Math.floor(leverage) : null,
                ts: new Date().toISOString()
              }
            }
          } catch {}
        } catch {}
        if (!result?.success) {
          try {
            const firstErr = Array.isArray((result as any)?.orders)
              ? (result as any).orders.find((o: any) => o?.status === 'error')
              : null
            ;(result as any).error = firstErr?.error || 'order_error'
          } catch {}
        }
        try { console.info('[PLACE_ORDERS_RES]', { success: (result as any)?.success, count: Array.isArray((result as any)?.orders) ? (result as any).orders.length : null }) } catch {}
        
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(result))
      } catch (e: any) {
        console.error('[PLACE_ORDERS_ERROR]', e.message)
        try { __lastPlaceOrders = { request: null, result: { success: false, error: e?.message || 'unknown' } } } catch {}
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      } finally { releaseBatch() }
      return
    }

    // Test-only: place a small MARKET order to force a position (dev utility)
    if (url.pathname === '/api/test/market_fill' && req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        if (!hasRealBinanceKeysGlobal()) { res.statusCode = 403; res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ok:false, error:'missing_binance_keys' })); return }
        const chunks: Buffer[] = []
        for await (const ch of req) chunks.push(ch as Buffer)
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        const input = bodyStr ? JSON.parse(bodyStr) : null
        const symbolRaw = String(input?.symbol || '')
        const sideRaw = String(input?.side || 'SELL').toUpperCase()
        const qtyRaw = input?.quantity
        if (!symbolRaw || !qtyRaw) { res.statusCode = 400; res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ok:false, error:'missing_symbol_or_quantity' })); return }
        const symbol = symbolRaw.toUpperCase().endsWith('USDT') ? symbolRaw.toUpperCase() : `${symbolRaw.toUpperCase()}USDT`
        const side = sideRaw === 'BUY' ? 'BUY' : 'SELL'
        const api = getBinanceAPI() as any
        // Detect hedge mode and fetch stepSize for qty quantization
        let isHedgeMode = false
        try { isHedgeMode = Boolean(await (api as any).getHedgeMode()) } catch {}
        let stepSize: number | null = null
        try {
          const info = await api.getSymbolInfo(symbol)
          const lf = (info?.filters || []).find((f: any) => f?.filterType === 'LOT_SIZE')
          stepSize = lf ? Number(lf.stepSize) : null
        } catch {}
        const quantizeFloor = (value: number, step: number): number => {
          const s = String(step)
          const idx = s.indexOf('.')
          const decimals = idx >= 0 ? (s.length - idx - 1) : 0
          const factor = Math.pow(10, decimals)
          const v = Math.round(value * factor)
          const st = Math.round(step * factor)
          return Math.floor(v / st) * st / factor
        }
        const qtyNumIn = Number(qtyRaw)
        if (!Number.isFinite(qtyNumIn) || qtyNumIn <= 0) { res.statusCode = 400; res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ok:false, error:'bad_quantity' })); return }
        const qtyNum = (Number.isFinite(stepSize as any) && (stepSize as number) > 0) ? quantizeFloor(qtyNumIn, stepSize as number) : qtyNumIn
        const quantity = String(qtyNum)
        const baseParams: any = { symbol, side, type: 'MARKET', quantity, newOrderRespType: 'RESULT' }
        if (isHedgeMode) baseParams.positionSide = side === 'BUY' ? 'LONG' : 'SHORT'
        try { console.info('[TEST_MARKET_FILL_REQ]', params) } catch {}
        const r = await api.placeOrder(baseParams)
        try { console.info('[TEST_MARKET_FILL_RES]', { symbol, orderId: (r as any)?.orderId ?? null }) } catch {}
        res.statusCode = 200
        res.setHeader('content-type','application/json')
        res.end(JSON.stringify({ ok: true, result: r }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type','application/json')
        res.end(JSON.stringify({ ok:false, error: e?.message || 'unknown' }))
      }
      return
    }

    // Trading Chart System: Klines Batch Endpoint
    if (url.pathname === '/api/klines_batch' && req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        const chunks: Buffer[] = []
        for await (const ch of req) chunks.push(ch as Buffer)
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        const input = bodyStr ? JSON.parse(bodyStr) : null
        
        const symbols: string[] = Array.isArray(input?.symbols) ? input.symbols : []
        const interval = String(input?.interval || '1m')
        const limit = Number(input?.limit) || 500
        
        if (symbols.length === 0) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'symbols array required' }))
          return
        }
        
        // Validate interval
        const validIntervals = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d']
        if (!validIntervals.includes(interval)) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: `invalid interval, must be one of: ${validIntervals.join(', ')}` }))
          return
        }
        
        // Import getKlines from fetcher
        const { getKlines } = await import('./fetcher/binance')
        
        // Parallel fetch with Promise.allSettled
        const tasks = symbols.map(async (symbol) => {
          try {
            const klines = await getKlines(symbol, interval, limit, false)
            // Transform to numeric format (Binance returns strings)
            const transformed = klines.map((k: any) => ({
              openTime: new Date(k.openTime).getTime(),
              open: String(k.open),
              high: String(k.high),
              low: String(k.low),
              close: String(k.close),
              volume: String(k.volume),
              closeTime: new Date(k.closeTime).getTime()
            }))
            return { symbol, ok: true, klines: transformed }
          } catch (e: any) {
            return { symbol, ok: false, error: e?.message || 'unknown' }
          }
        })
        
        const results = await Promise.allSettled(tasks)
        
        // Build response object
        const response: any = { ok: true, results: {} }
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) {
            response.results[r.value.symbol] = {
              ok: r.value.ok,
              klines: r.value.ok ? r.value.klines : undefined,
              error: r.value.ok ? undefined : r.value.error
            }
          }
        }
        
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(response))
      } catch (e: any) {
        console.error('[KLINES_BATCH_ERROR]', e.message)
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }

    // Trading Chart System: Manual SL Change
    if (url.pathname === '/api/manual_sl' && req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        if (!hasRealBinanceKeysGlobal()) {
          res.statusCode = 403
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'missing_binance_keys' }))
          return
        }
        
        const chunks: Buffer[] = []
        for await (const ch of req) chunks.push(ch as Buffer)
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        const input = bodyStr ? JSON.parse(bodyStr) : null
        
        const symbol = String(input?.symbol || '')
        const slPrice = Number(input?.slPrice)
        
        if (!symbol || !Number.isFinite(slPrice) || slPrice <= 0) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'invalid_params: symbol and valid slPrice required' }))
          return
        }
        
        const api = getBinanceAPI() as any
        
        // 1. Validate position exists
        const positions = await api.getPositions()
        const position = (Array.isArray(positions) ? positions : []).find((p: any) => String(p?.symbol) === symbol)
        // KRITICKÁ OPRAVA: API vrací "size" ne "positionAmt"!
        const positionAmt = Number(position?.size || position?.positionAmt || 0)
        
        console.info('[MANUAL_SL_POSITION_CHECK]', { 
          symbol, 
          position: position ? { size: position.size, positionAmt: position.positionAmt } : null,
          positionAmt 
        })
        
        if (Math.abs(positionAmt) === 0) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: `no_position: Position for ${symbol} is not open` }))
          return
        }
        
        // 2. Get tick size for price rounding
        const symbolInfo = await api.getSymbolInfo(symbol)
        const priceFilter = (symbolInfo?.filters || []).find((f: any) => f?.filterType === 'PRICE_FILTER')
        const tickSize = priceFilter ? Number(priceFilter.tickSize) : 0.01
        
        // Round to tick size
        const roundToTick = (price: number, tick: number): number => {
          const s = String(tick)
          const idx = s.indexOf('.')
          const decimals = idx >= 0 ? (s.length - idx - 1) : 0
          return Number((Math.round(price / tick) * tick).toFixed(decimals))
        }
        
        const slRounded = roundToTick(slPrice, tickSize)
        
        // 3. Detect hedge mode
        const isHedgeMode = await api.getHedgeMode()
        const workingType = 'MARK_PRICE'
        
        // 4. Create NEW SL order (SHORT system: BUY to close)
        const slParams: any = {
          symbol,
          side: 'BUY',
          type: 'STOP_MARKET',
          stopPrice: String(slRounded),
          closePosition: true,
          workingType,
          newOrderRespType: 'RESULT',
          newClientOrderId: `manual_sl_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`
        }
        
        if (isHedgeMode) {
          slParams.positionSide = 'SHORT'
        }
        
        console.info('[MANUAL_SL_CREATE]', { symbol, slPrice: slRounded, isHedgeMode })
        const newOrder = await api.placeOrder(slParams)
        const newOrderId = Number(newOrder?.orderId || 0)
        
        // 5. Cancel all old SL orders EXCEPT the new one
        const openOrders = await api.getOpenOrders(symbol)
        const oldSlOrders = (Array.isArray(openOrders) ? openOrders : []).filter((o: any) => {
          const type = String(o?.type || '')
          const closePos = Boolean(o?.closePosition)
          const orderId = Number(o?.orderId || 0)
          return type === 'STOP_MARKET' && closePos && orderId !== newOrderId
        })
        
        const canceledIds: number[] = []
        for (const oldOrder of oldSlOrders) {
          try {
            await api.cancelOrder(symbol, oldOrder.orderId)
            canceledIds.push(Number(oldOrder.orderId))
            console.info('[MANUAL_SL_CANCELED]', { symbol, orderId: oldOrder.orderId })
          } catch (e: any) {
            console.warn('[MANUAL_SL_CANCEL_FAILED]', { symbol, orderId: oldOrder.orderId, error: e?.message })
          }
        }
        
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          ok: true,
          newOrderId,
          stopPrice: String(slRounded),
          canceledOrders: canceledIds
        }))
      } catch (e: any) {
        console.error('[MANUAL_SL_ERROR]', e.message)
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }

    // Trading Chart System: Manual TP Change
    if (url.pathname === '/api/manual_tp' && req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        if (!hasRealBinanceKeysGlobal()) {
          res.statusCode = 403
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'missing_binance_keys' }))
          return
        }
        
        const chunks: Buffer[] = []
        for await (const ch of req) chunks.push(ch as Buffer)
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        const input = bodyStr ? JSON.parse(bodyStr) : null
        
        const symbol = String(input?.symbol || '')
        const tpPrice = Number(input?.tpPrice)
        
        if (!symbol || !Number.isFinite(tpPrice) || tpPrice <= 0) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'invalid_params: symbol and valid tpPrice required' }))
          return
        }
        
        const api = getBinanceAPI() as any
        
        // 1. Validate position exists
        const positions = await api.getPositions()
        const position = (Array.isArray(positions) ? positions : []).find((p: any) => String(p?.symbol) === symbol)
        // KRITICKÁ OPRAVA: API vrací "size" ne "positionAmt"!
        const positionAmt = Number(position?.size || position?.positionAmt || 0)
        
        console.info('[MANUAL_TP_POSITION_CHECK]', { 
          symbol, 
          position: position ? { size: position.size, positionAmt: position.positionAmt } : null,
          positionAmt 
        })
        
        if (Math.abs(positionAmt) === 0) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: `no_position: Position for ${symbol} is not open` }))
          return
        }
        
        // 2. Get tick size for price rounding
        const symbolInfo = await api.getSymbolInfo(symbol)
        const priceFilter = (symbolInfo?.filters || []).find((f: any) => f?.filterType === 'PRICE_FILTER')
        const tickSize = priceFilter ? Number(priceFilter.tickSize) : 0.01
        
        // Round to tick size
        const roundToTick = (price: number, tick: number): number => {
          const s = String(tick)
          const idx = s.indexOf('.')
          const decimals = idx >= 0 ? (s.length - idx - 1) : 0
          return Number((Math.round(price / tick) * tick).toFixed(decimals))
        }
        
        const tpRounded = roundToTick(tpPrice, tickSize)
        
        // 3. Detect hedge mode
        const isHedgeMode = await api.getHedgeMode()
        const workingType = 'MARK_PRICE'
        
        // 4. Create NEW TP order (SHORT system: BUY to close)
        const tpParams: any = {
          symbol,
          side: 'BUY',
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: String(tpRounded),
          closePosition: true,
          workingType,
          newOrderRespType: 'RESULT',
          newClientOrderId: `manual_tp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`
        }
        
        if (isHedgeMode) {
          tpParams.positionSide = 'SHORT'
        }
        
        console.info('[MANUAL_TP_CREATE]', { symbol, tpPrice: tpRounded, isHedgeMode })
        const newOrder = await api.placeOrder(tpParams)
        const newOrderId = Number(newOrder?.orderId || 0)
        
        // 5. Cancel all old TP orders EXCEPT the new one
        const openOrders = await api.getOpenOrders(symbol)
        const oldTpOrders = (Array.isArray(openOrders) ? openOrders : []).filter((o: any) => {
          const type = String(o?.type || '')
          const closePos = Boolean(o?.closePosition)
          const orderId = Number(o?.orderId || 0)
          return type.includes('TAKE_PROFIT') && closePos && orderId !== newOrderId
        })
        
        const canceledIds: number[] = []
        for (const oldOrder of oldTpOrders) {
          try {
            await api.cancelOrder(symbol, oldOrder.orderId)
            canceledIds.push(Number(oldOrder.orderId))
            console.info('[MANUAL_TP_CANCELED]', { symbol, orderId: oldOrder.orderId })
          } catch (e: any) {
            console.warn('[MANUAL_TP_CANCEL_FAILED]', { symbol, orderId: oldOrder.orderId, error: e?.message })
          }
        }
        
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          ok: true,
          newOrderId,
          stopPrice: String(tpRounded),
          canceledOrders: canceledIds
        }))
      } catch (e: any) {
        console.error('[MANUAL_TP_ERROR]', e.message)
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }

    // New: Place only exits (SL/TP) for an existing or soon-to-exist position
    if (url.pathname === '/api/place_exits' && req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        const chunks: Buffer[] = []
        for await (const ch of req) chunks.push(ch as Buffer)
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        const input = bodyStr ? JSON.parse(bodyStr) : null
        if (!input || typeof input !== 'object') {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'bad_request' }))
          return
        }
        const symbolRaw = String(input.symbol || '')
        if (!symbolRaw) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'missing_symbol' }))
          return
        }
        const normalizeSymbol = (s: string): string => {
          let v = String(s || '').trim().toUpperCase()
          if (!v) return ''
          if (v.includes('/')) v = v.replace('/', '')
          if (!v.endsWith('USDT')) v = `${v}USDT`
          return v
        }
        const symbol = normalizeSymbol(symbolRaw)
        const sl = Number(input.sl)
        const tp = Number(input.tp)
        const forceTpLimitRO = Boolean(input.limit_reduce_only === true)
        const forceTpLimitNoRO = Boolean(input.limit_no_ro === true)
        if (!Number.isFinite(sl) && !Number.isFinite(tp)) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'missing_sl_or_tp' }))
          return
        }

        const api = getBinanceAPI() as any
        // Hedge mode detection
        // Detect account mode: one-way vs hedge
        let isHedgeMode = false
        try { isHedgeMode = Boolean(await (getBinanceAPI() as any).getHedgeMode()) } catch {}

        // RAW passthrough: pokud je zapnuto, neposouvej ceny na tick – použij přesně vstup
        const rawMode = ((tradingCfg as any)?.RAW_PASSTHROUGH === true)
        // Obtain filters for rounding and step for qty
        let tickSize: number | null = null
        let stepSize: number | null = null
        try {
          const info = await api.getSymbolInfo(symbol)
          const pf = (info?.filters || []).find((f: any) => f?.filterType === 'PRICE_FILTER')
          const lf = (info?.filters || []).find((f: any) => f?.filterType === 'LOT_SIZE')
          tickSize = pf ? Number(pf.tickSize) : null
          stepSize = lf ? Number(lf.stepSize) : null
        } catch {}
        if (!rawMode) {
          if (!Number.isFinite(tickSize) || (tickSize as number) <= 0) {
            res.statusCode = 422
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: 'missing_price_filter' }))
            return
          }
        }
        const quantize = (value: number, step: number): number => {
          const s = String(step)
          const idx = s.indexOf('.')
          const decimals = idx >= 0 ? (s.length - idx - 1) : 0
          const factor = Math.pow(10, decimals)
          return Math.round(value * factor) / factor
        }
        const quantizeFloor = (value: number, step: number): number => {
          const s = String(step)
          const idx = s.indexOf('.')
          const decimals = idx >= 0 ? (s.length - idx - 1) : 0
          const factor = Math.pow(10, decimals)
          const v = Math.round(value * factor)
          const st = Math.round(step * factor)
          return Math.floor(v / st) * st / factor
        }
        const slRounded = Number.isFinite(sl) ? (rawMode ? sl : quantize(sl, tickSize as number)) : null
        const tpRounded = Number.isFinite(tp) ? (rawMode ? tp : quantize(tp, (tickSize as number))) : null

        // Determine current position size
        let positionQty: string | null = null
        try {
          const pos = await api.getPositions()
          const p = (Array.isArray(pos) ? pos : []).find((x: any) => String(x?.symbol) === symbol)
          const amt = Number(p?.positionAmt)
          if (Number.isFinite(amt) && Math.abs(amt) > 0) positionQty = String(Math.abs(amt))
        } catch {}

        const workingType = String((tradingCfg as any)?.EXIT_WORKING_TYPE || 'MARK_PRICE') as 'MARK_PRICE' | 'CONTRACT_PRICE'

        const out: any = { ok: true, symbol, sl: null as any, tp: null as any }

        if (Number.isFinite(slRounded as any)) {
          const slParams: any = isHedgeMode
            ? { symbol, side: 'BUY', type: 'STOP_MARKET', stopPrice: String(slRounded), closePosition: true, workingType, positionSide: 'SHORT', newOrderRespType: 'RESULT' }
            : { symbol, side: 'BUY', type: 'STOP_MARKET', stopPrice: String(slRounded), closePosition: true, workingType, newOrderRespType: 'RESULT' }
          out.sl = await api.placeOrder(slParams)
        }
        if (Number.isFinite(tpRounded as any)) {
          if (forceTpLimitRO || forceTpLimitNoRO) {
            if (!Number.isFinite(stepSize as any) || (stepSize as number) <= 0) {
              res.statusCode = 422
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok: false, error: 'missing_step_size' }))
              return
            }
            if (!positionQty) {
              res.statusCode = 422
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok: false, error: 'no_position_for_limit_tp' }))
              return
            }
            const qtyNum = quantizeFloor(Number(positionQty), stepSize as number)
            const qtyStr = String(qtyNum)
            const baseLimit = { symbol, side: 'BUY', type: 'TAKE_PROFIT', price: String(tpRounded), stopPrice: String(tpRounded), timeInForce: 'GTC', quantity: qtyStr, workingType, newOrderRespType: 'RESULT' }
            const tpParams: any = isHedgeMode ? { ...baseLimit, positionSide: 'SHORT' } : baseLimit
            if (forceTpLimitRO) tpParams.reduceOnly = true
            out.tp = await api.placeOrder(tpParams)
          } else {
            // TP MARKET: v hedge módu musí být uveden positionSide, jinak -4061
            const tpParams: any = isHedgeMode
              ? { symbol, side: 'BUY', type: 'TAKE_PROFIT_MARKET', stopPrice: String(tpRounded), closePosition: true, workingType, positionSide: 'SHORT', newOrderRespType: 'RESULT' }
              : { symbol, side: 'BUY', type: 'TAKE_PROFIT_MARKET', stopPrice: String(tpRounded), closePosition: true, workingType, newOrderRespType: 'RESULT' }
            out.tp = await api.placeOrder(tpParams)
          }
        }

        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(out))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }

    // Ephemeral debug: return last place_orders request/response
    if (url.pathname === '/api/debug/last_place_orders' && req.method === 'GET') {
      const out = __lastPlaceOrders ? { ok: true, ...__lastPlaceOrders } : { ok: false, message: 'none' }
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(out))
      return
    }
    // Debug: report hedge mode (dualSidePosition)
    if (url.pathname === '/api/debug/hedge_mode' && req.method === 'GET') {
      try {
        const api = getBinanceAPI() as any
        const dual = Boolean(await api.getHedgeMode())
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, hedge: dual }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }
    
    if (url.pathname === '/api/m3/min' && req.method === 'GET') {
      if (!isDebugApi()) { res.statusCode = 404; res.end('Not found'); return }
      try {
        const compact = { timestamp: new Date().toISOString(), feeds_ok: true, breadth: { pct_above_EMA50_H1: 55 }, avg_volume24h_topN: 1234567,
          btc: { H1: { vwap_rel: 1.0, ema20: 1, ema50: 1, ema200: 1, rsi: 50, atr_pct: 1.2 }, H4: { ema50_gt_200: true } },
          eth: { H1: { vwap_rel: 1.0, ema20: 1, ema50: 1, ema200: 1, rsi: 50, atr_pct: 1.1 }, H4: { ema50_gt_200: true } },
          data_warnings: [] }
        const r = await decideMarketStrict({ mode: 'gpt' as any, compact: compact as any, features: {} as any, timeoutMs: 5000 })
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(r))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }

    if (url.pathname === '/api/gpt/health' && req.method === 'GET') {
      try {
        const { default: OpenAI } = await import('openai')
        const o: any = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, organization: process.env.OPENAI_ORG_ID, project: (process as any)?.env?.OPENAI_PROJECT })
        const model = (deciderCfg as any)?.m3?.model || 'gpt-4o'
        const schema = { type: 'object', properties: { ping: { type: 'string' } }, required: ['ping'], additionalProperties: false }
        const r: any = await o.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: 'Reply with JSON only. No prose.' },
            { role: 'user', content: JSON.stringify({ ping: 'health' }) }
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'health', schema, strict: true }
          },
          max_completion_tokens: 64
        })
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, model, output_text: !!(r as any)?.choices?.[0]?.message?.content }))
      } catch (e: any) {
        res.statusCode = e?.status || 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, status: e?.status ?? null, message: (e?.response && e.response?.data?.error?.message) ? e.response.data.error.message : (e?.message ?? 'unknown') }))
      }
      return
    }

    if (url.pathname === '/api/gpt/models' && req.method === 'GET') {
      if (!isDebugApi()) { res.statusCode = 404; res.end('Not found'); return }
      try {
        const { default: OpenAI } = await import('openai')
        const o: any = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, organization: process.env.OPENAI_ORG_ID, project: (process as any)?.env?.OPENAI_PROJECT })
        const list = await o.models.list()
        const ids = (list?.data || []).map((m: any) => m.id).sort()
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, ids }))
      } catch (e: any) {
        res.statusCode = e?.status || 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, status: e?.status ?? null, message: (e?.response && e.response?.data?.error?.message) ? e.response.data.error.message : (e?.message ?? 'unknown') }))
      }
      return
    }
    if (url.pathname === '/api/fp/min' && req.method === 'GET') {
      if (!isDebugApi()) { res.statusCode = 404; res.end('Not found'); return }
      try {
        const input = { now_ts: Date.now(), posture: 'NO-TRADE', risk_policy: { ok: 0.5, caution: 0.25, no_trade: 0 }, side_policy: 'both', settings: { max_picks: 1, expiry_minutes: [60,90], tp_r_momentum: [1.2,2.5], tp_r_reclaim: [1.0,2.0], max_leverage: 10 }, candidates: [{ symbol: 'TESTUSDT', price: 1.234567, atr_pct_h1: 2.5, vwap_m15: 1.2341, ret_m15_pct: 0.8, rvol_h1: 1.2, ret_h1_pct: 0.3, h1_range_pos_pct: 50 }] }
        const r = await runFinalPickerServer(input as any)
        res.statusCode = r.ok ? 200 : 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(r))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }

    if (url.pathname === '/api/decide' && req.method === 'POST') {
      const m = (deciderCfg as any)?.m3?.model
      if (m && !['gpt-5', 'gpt-4o', 'gpt-4', 'chatgpt-4o-latest'].includes(m)) {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'gpt5_only_policy' }))
        return
      }
      try {
        const mode = String(process.env.DECIDER_MODE || 'mock').toLowerCase()
        if (mode === 'gpt' && !process.env.OPENAI_API_KEY) {
          // 403 to avoid triggering proxy Basic Auth dialogs
          res.statusCode = 403
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'missing_openai_key' }))
          return
        }
        const chunks: Buffer[] = []
        for await (const ch of req) chunks.push(ch as Buffer)
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        const compact = bodyStr ? JSON.parse(bodyStr) : null
        if (!compact || typeof compact !== 'object') {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'bad_request' }))
          return
        }
        const pf = preflightCompact(compact)
        if (!pf.ok) {
          res.statusCode = 422
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: `invalid_compact:${pf.reason}` }))
          return
        }
        const decision = await decideMarketStrict({ mode: mode as any, compact, features: {} as any, openaiKey: process.env.OPENAI_API_KEY || '', timeoutMs: (deciderCfg as any)?.timeoutMs || 8000 })
        // Localize reasons to Czech if model returned English
        try {
          const mapReason = (s: string): string => {
            const t = String(s || '')
            const L = t.toLowerCase()
            if (/low\s+percentage\s+of\s+assets\s+above\s+ema50|low\s+breadth|weak\s+breadth/.test(L)) return 'nízká šířka trhu (málo nad EMA50 H1)'
            if (/btc\s+below\s+ema20/.test(L)) return 'BTC pod EMA20'
            if (/btc\s+below\s+ema50/.test(L)) return 'BTC pod EMA50'
            if (/eth\s+below\s+ema20/.test(L)) return 'ETH pod EMA20'
            if (/eth\s+below\s+ema50/.test(L)) return 'ETH pod EMA50'
            if (/(rsi).*(oversold)|rsi\s+below\s*30/.test(L)) return 'RSI přeprodané'
            if (/h4.*ema50.*not\s+greater\s+than\s+ema200|ema50.*<.*ema200.*h4/.test(L)) return 'H4 trend slabý (EMA50 není nad EMA200)'
            if (/high\s+vol(atility)?/.test(L)) return 'vysoká volatilita'
            if (/below\s+vwap/.test(L)) return 'pod VWAP'
            return t
          }
          if (Array.isArray((decision as any)?.reasons)) {
            ;(decision as any).reasons = (decision as any).reasons.map((r: any) => mapReason(String(r||'')))
          }
        } catch {}
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(decision))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.code || e?.name || 'internal_error' }))
      }
      return
    }

    if (url.pathname === '/api/final_picker' && req.method === 'POST') {
      const m = (deciderCfg as any)?.final_picker?.model
      if (m && !['gpt-5', 'gpt-4o', 'gpt-4', 'chatgpt-4o-latest'].includes(m)) {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, code: 'gpt5_only_policy', data: { picks: [] } }))
        return
      }
      try {
        const chunks: Buffer[] = []
        for await (const ch of req) chunks.push(ch as Buffer)
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        const input = bodyStr ? JSON.parse(bodyStr) : null
        if (!input || typeof input !== 'object') {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, code: 'bad_request', latencyMs: 0, data: { picks: [] } }))
          return
        }
        const fpRes = await runFinalPickerServer(input as any)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(fpRes))
      } catch (e: any) {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, code: 'unknown', latencyMs: 0, data: { picks: [] }, meta: { error: e?.message || 'unknown' } }))
      }
      return
    }

    if (url.pathname === '/api/hot_screener' && req.method === 'POST') {
      try {
        const chunks: Buffer[] = []
        for await (const ch of req) chunks.push(ch as Buffer)
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        const input = bodyStr ? JSON.parse(bodyStr) : null
        
        if (!input || typeof input !== 'object' || !Array.isArray(input.coins)) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, code: 'bad_request', latencyMs: 0, data: { hot_picks: [] } }))
          return
        }

        // Debug: inbound request summary
        try {
          console.info('[HS_API_REQ]', { coins: Array.isArray(input.coins) ? input.coins.length : null, strategy: input.strategy || null, bytes: Buffer.byteLength(bodyStr, 'utf8') })
        } catch {}

        // Ensure temperature override via env (default to 0.2)
        try { if (!process.env.HOT_SCREENER_TEMPERATURE) process.env.HOT_SCREENER_TEMPERATURE = '0.2' } catch {}
        const hsRes = await runHotScreener(input)

        // Debug: outbound result summary
        try {
          const meta = (hsRes as any)?.meta || {}
          const metaOut = { request_id: meta.request_id ?? null, http_status: meta.http_status ?? null, http_error: meta.http_error ?? null, prompt_hash: meta.prompt_hash ?? null, schema_version: meta.schema_version ?? null }
          const picks = Array.isArray((hsRes as any)?.data?.hot_picks) ? (hsRes as any).data.hot_picks.length : null
          console.info('[HS_API_RES]', { ok: hsRes.ok, code: hsRes.code || null, latencyMs: hsRes.latencyMs, picks, meta: metaOut })
        } catch {}

        const hsStatus = (() => {
          if (hsRes.ok) return 200
          const metaStatus = Number((hsRes as any)?.meta?.http_status)
          if (Number.isFinite(metaStatus) && metaStatus > 0) return metaStatus
          const code = (hsRes as any)?.code
          // Map validation to 422, unknown to 500
          if (code === 'schema' || code === 'invalid_json' || code === 'empty_output') return 422
          return 500
        })()
        res.statusCode = hsStatus
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(hsRes))
      } catch (e: any) {
        try { console.error('[HS_API_ERR]', { message: e?.message || 'unknown' }) } catch {}
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, code: 'unknown', latencyMs: 0, data: { hot_picks: [] }, meta: { error: e?.message || 'unknown' } }))
      }
      return
    }

    if (url.pathname === '/api/entry_strategy' && req.method === 'POST') {
      try {
        const chunks: Buffer[] = []
        for await (const ch of req) chunks.push(ch as Buffer)
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        const input = bodyStr ? JSON.parse(bodyStr) : null
        
        if (!input || typeof input !== 'object' || !input.symbol || !input.asset_data) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, code: 'bad_request', latencyMs: 0, data: null }))
          return
        }

        const esRes = await runEntryStrategy(input)
        try { if (esRes?.ok && esRes?.data?.symbol) __lastEntryBySymbol[esRes.data.symbol] = { input, output: esRes } } catch {}
        res.statusCode = esRes.ok ? 200 : 422
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(esRes))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, code: 'unknown', latencyMs: 0, data: null, meta: { error: e?.message || 'unknown' } }))
      }
      return
    }

    // Entry Risk Manager – evaluates conservative/aggressive plans; returns decision/go-no-go
    if (url.pathname === '/api/entry_risk' && req.method === 'POST') {
      try {
        const chunks: Buffer[] = []
        for await (const ch of req) chunks.push(ch as Buffer)
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        const input = bodyStr ? JSON.parse(bodyStr) : null
        if (!input || typeof input !== 'object') {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, code: 'bad_request', latencyMs: 0, data: null }))
          return
        }

        const out = await runEntryRisk(input as any)
        const status = out.ok ? 200 : (out.code === 'schema' || out.code === 'invalid_json' || out.code === 'empty_output' ? 422 : (Number((out as any)?.meta?.http_status) || 500))

        // Persist chosen_plan + posture for Strategy Updater ONLY when decision === 'enter'
        try {
          if (out && out.ok && (out as any)?.data?.decision === 'enter') {
            const sym = String((out as any)?.data?.symbol || input?.symbol || '')
            const chosen = (out as any)?.data?.chosen_plan
            const posture = (typeof input?.posture === 'string' && input.posture) ? String(input.posture) : null
            if (sym && chosen && posture) {
              const { setRiskChosenPlan } = await import('../services/strategy-updater/registry')
              const style = String(chosen?.style) === 'aggressive' ? 'aggressive' : 'conservative'
              const tps = Array.isArray(chosen?.tp_levels) ? chosen.tp_levels
                .filter((l:any)=>l && (l.tag==='tp1'||l.tag==='tp2'||l.tag==='tp3'))
                .map((l:any)=>({ tag: l.tag, price: Number(l.price), allocation_pct: Number(l.allocation_pct) })) : []
              if (tps.length >= 1) setRiskChosenPlan(sym, { style, entry: Number(chosen.entry), sl: Number(chosen.sl), tp_levels: tps, reasoning: String(chosen?.reasoning||'') }, posture as any)
            }
          }
        } catch {}

        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(out))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, code: 'unknown', latencyMs: 0, data: null, meta: { error: e?.message || 'unknown' } }))
      }
      return
    }

    if (url.pathname === '/api/debug/entry_last' && req.method === 'GET') {
      const sym = String(url.searchParams.get('symbol') || '')
      const out = sym && __lastEntryBySymbol[sym] ? { ok: true, ...__lastEntryBySymbol[sym] } : { ok: false, message: 'none' }
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(out))
      return
    }

    if (url.pathname === '/api/strategy_updater_status' && req.method === 'GET') {
      try {
        const symbol = url.searchParams.get('symbol')
        const { getStrategyUpdaterStatus } = await import('../services/strategy-updater/api')
        const result = await getStrategyUpdaterStatus(symbol || undefined)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(result))
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ 
          enabled: false, 
          entries: [], 
          error: error?.message || 'unknown' 
        }))
      }
      return
    }

    // Strategy updater audit endpoints (read-only)
    if (url.pathname === '/api/strategy_updater_audit' && req.method === 'GET') {
      try {
        const { readAuditEntries } = await import('../services/strategy-updater/audit')
        const symbol = url.searchParams.get('symbol') || undefined
        const limitParam = Number(url.searchParams.get('limit') || 50)
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(500, Math.floor(limitParam)) : 50
        const entries = await readAuditEntries(symbol, limit)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ entries }))
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ entries: [], error: error?.message || 'unknown' }))
      }
      return
    }
    if (url.pathname === '/api/strategy_updater_audit/latest' && req.method === 'GET') {
      try {
        const { readAuditLatest } = await import('../services/strategy-updater/audit')
        const symbol = url.searchParams.get('symbol') || undefined
        const entry = await readAuditLatest(symbol)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ entry }))
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ entry: null, error: error?.message || 'unknown' }))
      }
      return
    }

    if (url.pathname === '/api/strategy_updater_toggle' && (req.method === 'GET' || req.method === 'POST')) {
      try {
        if (req.method === 'POST') {
          // Update strategy updater enabled state
          const body = await new Promise<string>((resolve) => {
            let data = ''
            req.on('data', chunk => data += chunk)
            req.on('end', () => resolve(data))
          })
          
          const { enabled } = JSON.parse(body || '{}')
          const enabledBool = Boolean(enabled)
          
          // Update environment variable for current process
          process.env.STRATEGY_UPDATER_ENABLED = enabledBool ? '1' : '0'
          
          // Persist to .env.local file
          const fs = await import('node:fs')
          const path = await import('node:path')
          const envPath = path.resolve(process.cwd(), '.env.local')
          
          let envContent = ''
          try {
            if (fs.existsSync(envPath)) {
              envContent = fs.readFileSync(envPath, 'utf8')
            }
          } catch {}
          
          // Update or add STRATEGY_UPDATER_ENABLED line
          const lines = envContent.split('\n')
          let found = false
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('STRATEGY_UPDATER_ENABLED=')) {
              lines[i] = `STRATEGY_UPDATER_ENABLED=${enabledBool ? '1' : '0'}`
              found = true
              break
            }
          }
          
          if (!found) {
            lines.push(`STRATEGY_UPDATER_ENABLED=${enabledBool ? '1' : '0'}`)
          }
          
          fs.writeFileSync(envPath, lines.join('\n'), 'utf8')
          
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ enabled: enabledBool, success: true }))
        } else {
          // GET - return current state
          const enabled = process.env.STRATEGY_UPDATER_ENABLED === '1' || process.env.STRATEGY_UPDATER_ENABLED === 'true'
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ enabled }))
        }
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ 
          enabled: false, 
          success: false,
          error: error?.message || 'unknown' 
        }))
      }
      return
    }

    // Entry Updater status
    if (url.pathname === '/api/entry_updater_status' && req.method === 'GET') {
      try {
        const symbol = url.searchParams.get('symbol')
        const { getEntryUpdaterStatus } = await import('../services/entry-updater/api')
        const result = await getEntryUpdaterStatus(symbol || undefined)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(result))
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ enabled: false, entries: [], error: error?.message || 'unknown' }))
      }
      return
    }

    // Entry Updater audit endpoints
    if (url.pathname === '/api/entry_updater_audit' && req.method === 'GET') {
      try {
        const { readAuditEntries } = await import('../services/entry-updater/audit')
        const symbol = url.searchParams.get('symbol') || undefined
        const limitParam = Number(url.searchParams.get('limit') || 50)
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(500, Math.floor(limitParam)) : 50
        const entries = await readAuditEntries(symbol, limit)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ entries }))
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ entries: [], error: error?.message || 'unknown' }))
      }
      return
    }

    if (url.pathname === '/api/entry_updater_audit/latest' && req.method === 'GET') {
      try {
        const { readAuditLatest } = await import('../services/entry-updater/audit')
        const symbol = url.searchParams.get('symbol') || undefined
        const entry = await readAuditLatest(symbol)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ entry }))
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ entry: null, error: error?.message || 'unknown' }))
      }
      return
    }

    // Entry Updater toggle
    if (url.pathname === '/api/entry_updater_toggle' && (req.method === 'GET' || req.method === 'POST')) {
      try {
        if (req.method === 'POST') {
          // Update entry updater enabled state
          const body = await new Promise<string>((resolve) => {
            let data = ''
            req.on('data', chunk => data += chunk)
            req.on('end', () => resolve(data))
          })
          const { enabled } = JSON.parse(body || '{}')
          const enabledBool = Boolean(enabled)
          process.env.ENTRY_UPDATER_ENABLED = enabledBool ? '1' : '0'
          // Persist to .env.local
          const fs = await import('node:fs')
          const path = await import('node:path')
          const envPath = path.resolve(process.cwd(), '.env.local')
          try {
            const prev = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
            const lines = prev.split('\n').filter(Boolean)
            const filtered = lines.filter(l => !/^ENTRY_UPDATER_ENABLED=/.test(l))
            filtered.push(`ENTRY_UPDATER_ENABLED=${enabledBool ? '1' : '0'}`)
            fs.writeFileSync(envPath, filtered.join('\n') + '\n', 'utf8')
          } catch {}
        }
        const enabled = String(process.env.ENTRY_UPDATER_ENABLED || '').toLowerCase()
        const enabledBool = !(enabled === '0' || enabled === 'false' || enabled === 'off')
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ enabled: enabledBool }))
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ enabled: false, error: error?.message || 'unknown' }))
      }
      return
    }

    // Top-Up Watcher status
    if (url.pathname === '/api/topup_watcher_status' && req.method === 'GET') {
      try {
        const { listWatchers } = await import('../services/top-up-watcher/registry')
        const entries = listWatchers()
        let enabled = false
        try {
          const env = String(process.env.TOPUP_WATCHER_ENABLED || '').toLowerCase()
          if (env) {
            enabled = env === '1' || env === 'true'
          } else {
            const fs = await import('node:fs')
            const path = await import('node:path')
            const file = path.resolve('config/top_up_watcher.json')
            if (fs.existsSync(file)) {
              const j = JSON.parse(fs.readFileSync(file, 'utf8'))
              enabled = j?.enabled !== false
            } else {
              enabled = true
            }
          }
        } catch {
          enabled = process.env.TOPUP_WATCHER_ENABLED === '1' || process.env.TOPUP_WATCHER_ENABLED === 'true'
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ enabled, entries }))
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ enabled: false, entries: [], error: error?.message || 'unknown' }))
      }
      return
    }

    // Top-Up Watcher toggle
    if (url.pathname === '/api/topup_watcher_toggle' && (req.method === 'GET' || req.method === 'POST')) {
      try {
        if (req.method === 'POST') {
          const body = await new Promise<string>((resolve) => {
            let data = ''
            req.on('data', chunk => data += chunk)
            req.on('end', () => resolve(data))
          })
          const { enabled } = JSON.parse(body || '{}')
          const enabledBool = Boolean(enabled)
          process.env.TOPUP_WATCHER_ENABLED = enabledBool ? '1' : '0'
          const fs = await import('node:fs')
          const path = await import('node:path')
          const envPath = path.resolve(process.cwd(), '.env.local')
          let envContent = ''
          try { if (fs.existsSync(envPath)) envContent = fs.readFileSync(envPath, 'utf8') } catch {}
          const lines = envContent.split('\n')
          let found = false
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('TOPUP_WATCHER_ENABLED=')) { lines[i] = `TOPUP_WATCHER_ENABLED=${enabledBool ? '1' : '0'}`; found = true; break }
          }
          if (!found) lines.push(`TOPUP_WATCHER_ENABLED=${enabledBool ? '1' : '0'}`)
          fs.writeFileSync(envPath, lines.join('\n'), 'utf8')
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ enabled: enabledBool, success: true }))
        } else {
          const envFlag = String(process.env.TOPUP_WATCHER_ENABLED || '').toLowerCase()
          if (envFlag) {
            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ enabled: envFlag === '1' || envFlag === 'true' }))
            return
          }
          try {
            const fs = await import('node:fs')
            const path = await import('node:path')
            const file = path.resolve('config/top_up_watcher.json')
            if (fs.existsSync(file)) {
              const j = JSON.parse(fs.readFileSync(file, 'utf8'))
              const enabled = j?.enabled !== false
              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ enabled }))
            } else {
              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ enabled: true }))
            }
          } catch {
            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ enabled: true }))
          }
        }
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ enabled: false, error: error?.message || 'unknown' }))
      }
      return
    }

    // Top-Up Executor status
    if (url.pathname === '/api/top_up_executor_status' && req.method === 'GET') {
      try {
        const { getTopUpExecutorStatus } = await import('../services/top-up-executor/trigger')
        const { enabled, entries } = getTopUpExecutorStatus()
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ enabled, entries }))
      } catch (error: any) {
        // CRITICAL FIX: Vrať 200 OK i při chybě, aby UI nespamovalo retry (schema chyba není fatální)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ enabled: false, entries: [], error: error?.message || 'unknown' }))
      }
      return
    }

    // Cooldown endpoints
    if (url.pathname === '/api/cooldowns' && req.method === 'GET') {
      try {
        const active = getActiveCooldowns()
        res.statusCode = 200
        res.setHeader('content-type','application/json')
        res.end(JSON.stringify({ ok: true, active }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type','application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }

    if (url.pathname === '/api/cooldowns/clear' && req.method === 'POST') {
      try {
        const chunks: Buffer[] = []
        for await (const ch of req) chunks.push(ch as Buffer)
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        const parsed: any = bodyStr ? JSON.parse(bodyStr) : null
        const symbol = String(parsed?.symbol || '')
        if (!symbol) { res.statusCode = 400; res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ok:false, error:'missing_symbol' })); return }
        clearCooldown(symbol)
        res.statusCode = 200
        res.setHeader('content-type','application/json')
        res.end(JSON.stringify({ ok: true }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type','application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }

    if (url.pathname === '/api/strategy_updater_trigger' && req.method === 'POST') {
      try {
        const body = await new Promise<string>((resolve) => {
          let data = ''
          req.on('data', chunk => data += chunk)
          req.on('end', () => resolve(data))
        })
        
        const { symbol } = JSON.parse(body || '{}')
        if (!symbol) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ success: false, error: 'symbol required' }))
          return
        }

        // Get current positions and orders
        const api = getBinanceAPI()
        const [positions, orders] = await Promise.all([
          api.getPositions(),
          api.getOpenOrders()
        ])

        // Find the position
        const position = positions.find((pos: any) => String(pos?.symbol) === symbol)
        if (!position || Math.abs(Number(position?.positionAmt || 0)) <= 0) {
          res.statusCode = 404
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ success: false, error: 'position not found' }))
          return
        }

        // Mark existing entry as due now if exists, otherwise run detection
        try {
          const { forceDueNow } = await import('../services/strategy-updater/registry')
          const forced = forceDueNow(symbol)
          if (!forced) {
            const { detectInternalPositionOpened } = await import('../services/strategy-updater/trigger')
            detectInternalPositionOpened(orders, positions, { type: 'filled', symbol, orderId: 0 })
          }
        } catch {}

        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ success: true, symbol }))
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ 
          success: false,
          error: error?.message || 'unknown' 
        }))
      }
      return
    }

    if (url.pathname === '/api/restore_waiting_tp' && req.method === 'POST') {
      try {
        // Get current entry orders to extract TP values dynamically
        const ordersRaw = getOpenOrdersInMemory()
        const entryOrders = (Array.isArray(ordersRaw) ? ordersRaw : []).filter((o: any) => {
          const clientId = String(o?.clientOrderId || o?.C || o?.c || '')
          const isInternal = /^e_l_/.test(clientId)
          const isEntry = String(o?.side) === 'BUY' && String(o?.type) === 'LIMIT' && 
                         !(o?.reduceOnly || o?.closePosition)
          return isInternal && isEntry
        })
        
        console.info('[RESTORE_DEBUG]', { 
          totalOrders: ordersRaw.length,
          entryOrdersFound: entryOrders.length,
          symbols: entryOrders.map((o: any) => o?.symbol)
        })
        
        // Historical TP values from logs  
        const TP_VALUES: Record<string, { tp: number; qty: string }> = {
          'MYXUSDT': { tp: 13.83, qty: '31.000' },
          'WLDUSDT': { tp: 1.475, qty: '282.000' },  
          'AI16ZUSDT': { tp: 0.1195, qty: '3427.5' },
          'VIRTUALUSDT': { tp: 1.29, qty: '242.2' }
        }
        
        const { waitingTpSchedule } = await import('../services/trading/binance_futures')
        let restoredCount = 0
        
        for (const order of entryOrders) {
          try {
            const symbol = String(order?.symbol || '')
            const currentQty = String(order?.qty || '')
            
            // Use historical TP or estimate (+5% from entry price)
            let tp = 0
            let qty = currentQty
            
            if (TP_VALUES[symbol]) {
              tp = TP_VALUES[symbol].tp
              qty = TP_VALUES[symbol].qty
            } else {
              // Estimate TP as +5% from entry price
              const entryPrice = Number(order?.price || 0)
              if (entryPrice > 0) {
                tp = entryPrice * 1.05
              }
            }
            
            if (tp > 0 && symbol) {
              waitingTpSchedule(symbol, tp, qty, 'SHORT', 'MARK_PRICE')
              restoredCount++
              console.info('[RESTORED_WAITING_TP]', { symbol, tp, qty, source: TP_VALUES[symbol] ? 'historical' : 'estimated' })
            } else {
              console.warn('[SKIP_RESTORE_NO_TP]', { symbol, entryPrice: order?.price })
            }
            
          } catch (error) {
            console.error('[RESTORE_SYMBOL_ERROR]', { 
              symbol: order?.symbol, 
              error: (error as any)?.message || error 
            })
          }
        }
        
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ 
          success: true, 
          restoredCount,
          message: `Restored ${restoredCount} waiting TP orders`
        }))
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ 
          success: false, 
          error: error?.message || 'unknown' 
        }))
      }
      return
    }

    // === DEV-ONLY PROMPT MANAGEMENT API ===
    const isDevEnv = process.env.NODE_ENV !== 'production'
    const checkDevAuth = (authHeader: string | undefined): boolean => {
      if (!isDevEnv) return false
      const expected = process.env.DEV_AUTH_TOKEN || 'dev-secret-token'
      return authHeader === expected
    }
    
    if (url.pathname === '/dev/prompts' && req.method === 'GET') {
      if (!isDevEnv) { res.statusCode = 404; res.end('Not Found'); return }
      if (!checkDevAuth(req.headers['x-dev-auth'] as string)) {
        res.statusCode = 401; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'unauthorized' })); return
      }
      try {
        const { listAssistants } = await import('../services/lib/dev_prompts.js')
        res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ assistants: listAssistants() }))
      } catch (e: any) {
        res.statusCode = 500; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: e?.message || 'unknown' }))
      }
      return
    }
    
    if (url.pathname.startsWith('/dev/prompts/') && req.method === 'GET') {
      if (!isDevEnv) { res.statusCode = 404; res.end('Not Found'); return }
      if (!checkDevAuth(req.headers['x-dev-auth'] as string)) {
        res.statusCode = 401; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'unauthorized' })); return
      }
      try {
        const key = url.pathname.split('/dev/prompts/')[1]
        if (!key) { res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'missing_key' })); return }
        const { getOverlayPrompt } = await import('../services/lib/dev_prompts.js')
        const overlay = getOverlayPrompt(key)
        if (!overlay) { res.statusCode = 404; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'not_found' })); return }
        res.statusCode = 200; res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ text: overlay.text, sha256: overlay.sha256, revision: overlay.revision, updatedAt: overlay.updatedAt }))
      } catch (e: any) {
        res.statusCode = 500; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: e?.message || 'unknown' }))
      }
      return
    }
    
    if (url.pathname.startsWith('/dev/prompts/') && req.method === 'PUT') {
      if (!isDevEnv) { res.statusCode = 404; res.end('Not Found'); return }
      if (!checkDevAuth(req.headers['x-dev-auth'] as string)) {
        res.statusCode = 401; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'unauthorized' })); return
      }
      try {
        const key = url.pathname.split('/dev/prompts/')[1]
        if (!key) { res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'missing_key' })); return }
        const chunks: Buffer[] = []; for await (const ch of req) chunks.push(ch as Buffer)
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        let parsed: any = null
        try { parsed = JSON.parse(bodyStr) } catch { res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'invalid_json' })); return }
        const { text, clientSha256, ifMatchRevision } = parsed
        if (!text) { res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'missing_text' })); return }
        const { setOverlayPrompt } = await import('../services/lib/dev_prompts.js')
        const result = setOverlayPrompt(key, text, clientSha256, ifMatchRevision)
        res.statusCode = 200; res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(result))
      } catch (e: any) {
        res.statusCode = 500; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: e?.message || 'unknown' }))
      }
      return
    }
    
    // Export všech overlay promptů (podporuje oba endpointy pro kompatibilitu)
    if ((url.pathname === '/dev/prompts/export' || url.pathname === '/dev/prompts/export-all') && req.method === 'POST') {
      if (!isDevEnv) { res.statusCode = 404; res.end('Not Found'); return }
      if (!checkDevAuth(req.headers['x-dev-auth'] as string)) {
        res.statusCode = 401; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: 'unauthorized' })); return
      }
      try {
        const { exportAllOverlaysToRegistry } = await import('../services/lib/dev_prompts.js')
        const results = exportAllOverlaysToRegistry()
        
        // Formátuj odpověď pro UI
        const success = results.filter(r => r.exported).length
        const failed = results.filter(r => !r.exported).length
        const response = {
          success,
          failed,
          total: results.length,
          results
        }
        
        res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response))
      } catch (e: any) {
        res.statusCode = 500; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: e?.message || 'unknown' }))
      }
      return
    }

    // === AI OVERVIEW SSE ENDPOINT (MULTIPLEXED - ALL ASSISTANTS) ===
    if (url.pathname === '/dev/ai-stream/all' && req.method === 'GET') {
      // Allow auth via header or query param token for EventSource compatibility
      const tokenParam = String(url.searchParams.get('token') || '')
      const headerOk = checkDevAuth(req.headers['x-dev-auth'] as string)
      const expectedToken = process.env.DEV_AUTH_TOKEN || 'dev-secret-token'
      const tokenOk = tokenParam && tokenParam === expectedToken
      
      if (!(headerOk || tokenOk)) {
        res.statusCode = 403
        res.end('FORBIDDEN')
        return
      }
      
      try {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        })
        
        // Send immediate ping so client knows stream is open
        res.write(`: connected\n\n`)
        
        const { aiTap } = await import('../services/lib/ai_tap')
        const send = (e: any) => {
          try {
            res.write(`data: ${JSON.stringify(e)}\n\n`)
          } catch {}
        }
        
        // Subscribe to ALL assistants at once (multiplexed stream)
        const allAssistants = [
          'entry_strategy_conservative',
          'entry_strategy_aggressive',
          'entry_risk_manager',
          'strategy_updater',
          'hot_screener',
          'reactive_entry_assistant',
          'ai_profit_taker'
        ] as const
        
        const unsubscribers = allAssistants.map(key => aiTap.subscribe(key as any, send))
        
        // Send keep-alive every 30s
        const keepAlive = setInterval(() => {
          try {
            res.write(`: keepalive\n\n`)
          } catch {
            clearInterval(keepAlive)
          }
        }, 30000)
        
        req.on('close', () => {
          try {
            unsubscribers.forEach(unsub => unsub())
            clearInterval(keepAlive)
          } catch {}
        })
      } catch {
        try {
          res.write('event: error\n')
          res.write('data: {"error":"stream_error"}\n\n')
        } catch {}
      }
      return
    }

    // === AI OVERVIEW SSE ENDPOINT (SINGLE ASSISTANT - LEGACY) ===
    if (url.pathname.startsWith('/dev/ai-stream/') && req.method === 'GET') {
      // Allow auth via header or query param token for EventSource compatibility
      const tokenParam = String(url.searchParams.get('token') || '')
      const headerOk = checkDevAuth(req.headers['x-dev-auth'] as string)
      const expectedToken = process.env.DEV_AUTH_TOKEN || 'dev-secret-token'
      const tokenOk = tokenParam && tokenParam === expectedToken
      
      if (!(headerOk || tokenOk)) {
        res.statusCode = 403
        res.end('FORBIDDEN')
        return
      }
      
      const assistantKey = url.pathname.replace('/dev/ai-stream/', '').trim()
      const allowed = [
        'entry_strategy_conservative',
        'entry_strategy_aggressive',
        'entry_risk_manager',
        'strategy_updater',
        'hot_screener',
        'reactive_entry_assistant',
        'ai_profit_taker'
      ]
      
      if (!assistantKey || !allowed.includes(assistantKey)) {
        res.statusCode = 404
        res.end('NOT_FOUND')
        return
      }
      
      try {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        })
        
        // Send immediate ping so client knows stream is open
        res.write(`: connected\n\n`)
        
        const { aiTap } = await import('../services/lib/ai_tap')
        const send = (e: any) => {
          try {
            res.write(`data: ${JSON.stringify(e)}\n\n`)
          } catch {}
        }
        
        const unsub = aiTap.subscribe(assistantKey as any, send)
        
        // Send keep-alive every 30s
        const keepAlive = setInterval(() => {
          try {
            res.write(`: keepalive\n\n`)
          } catch {
            clearInterval(keepAlive)
          }
        }, 30000)
        
        req.on('close', () => {
          try {
            unsub()
            clearInterval(keepAlive)
          } catch {}
        })
      } catch {
        try {
          res.write('event: error\n')
          res.write('data: {"error":"stream_error"}\n\n')
        } catch {}
      }
      return
    }

    if (url.pathname === '/api/snapshot_overheat') {
      res.setHeader('Cache-Control', 'no-store')
      const t0 = performance.now()
      try {
        const fresh = String(url.searchParams.get('fresh') || '1') === '1'
        const topN = Number(url.searchParams.get('topN') || '')
        // 1) Build raw snapshot (base = gainers)
        const raw = await buildMarketRawSnapshot({ universeStrategy: 'overheat', desiredTopN: Number.isFinite(topN) ? topN : undefined, fresh, allowPartial: true })
        // 2) Compute features
        const { computeFeatures } = await import('../services/features/compute')
        const feats = computeFeatures(raw)
        // 3) Filter candidates via overheat screener
        const { selectCandidates } = await import('../services/signals/candidate_selector')
        const candidates = selectCandidates(feats, raw, {
          decisionFlag: 'OK',
          allowWhenNoTrade: false,
          limit: 50,
          cfg: { atr_pct_min: 0, atr_pct_max: 100, min_liquidity_usdt: 0 },
          universeStrategy: 'overheat'
        } as any)
        // Map back to raw entries (keep indicators)
        const selectedSet = new Set(candidates.map(c=>c.symbol))
        const universe = raw.universe.filter(u=>selectedSet.has(u.symbol))
        const body = JSON.stringify({
          timestamp: new Date().toISOString(),
          universe,
          duration_ms: Math.round(performance.now()-t0)
        })
        res.statusCode = 200
        res.setHeader('content-type','application/json')
        res.end(body)
      } catch (err:any) {
        res.statusCode = 500
        res.setHeader('content-type','application/json')
        res.end(JSON.stringify({ error: err?.message || 'INTERNAL_ERROR' }))
      }
      return
    }

    // P&L report download (Markdown)
    if (url.pathname === '/api/reports/pnl' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        const preset = (String(url.searchParams.get('preset') || 'today') as any)
        const profile = (String(url.searchParams.get('profile') || 'both') as any)
        const { buildPnlReportMarkdown, resolveRange } = await import('../services/decider/lib/pnl_report')
        const md = await buildPnlReportMarkdown({ preset, profile })
        const { startTime, endTime } = resolveRange(preset)
        const fname = `pnl_${preset}_${profile}_${new Date(startTime).toISOString().slice(0,10)}_${new Date(endTime).toISOString().slice(0,10)}.md`
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
        res.setHeader('Content-Disposition', `attachment; filename="${fname}"`)
        res.end(md)
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: error?.message || 'unknown' }))
      }
      return
    }

    // P&L report JSON (passive, for UI preview)
    if (url.pathname === '/api/reports/pnl.json' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        const preset = (String(url.searchParams.get('preset') || 'today') as any)
        const profile = (String(url.searchParams.get('profile') || 'both') as any)
        const { buildPnlReport } = await import('../services/decider/lib/pnl_report')
        const json = await buildPnlReport({ preset, profile })
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(json))
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: error?.message || 'unknown' }))
      }
      return
    }

    // Health Monitor API: Get health for symbol
    if (url.pathname === '/api/health_monitor' && req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        const body = await new Promise<string>((resolve) => {
          let data = ''
          req.on('data', chunk => { data += chunk })
          req.on('end', () => resolve(data))
        })
        
        const parsed = JSON.parse(body)
        const symbol = String(parsed?.symbol || '')
        
        if (!symbol) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'symbol_required' }))
          return
        }
        
        const health = getLatestHealth(symbol)
        
        if (!health) {
          res.statusCode = 204 // No Content
          res.end()
          return
        }
        
        // Debug mode
        const debugHeader = req.headers['x-health-debug']
        const debug = debugHeader === '1' || debugHeader === 'true'
        
        const response = debug 
          ? { ...health, debug_trace: health._debug }
          : health
        
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(response))
        
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: error?.message || 'unknown' }))
      }
      return
    }

    // Health Monitor API: Get worker status
    if (url.pathname === '/api/health_monitor_status' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        const enabled = isHealthMonitorEnabled()
        const entries = getHealthWorkerEntries()
        
        console.log('[HEALTH_MONITOR_STATUS_API]', {
          enabled,
          totalEntries: entries.length,
          pendingOrders: entries.filter(e => e.type === 'pending_order').length,
          positions: entries.filter(e => e.type === 'position').length,
          withOutput: entries.filter(e => e.lastOutput !== null).length
        })
        
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ enabled, entries }))
        
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: error?.message || 'unknown' }))
      }
      return
    }

    // Health Monitor API: Manual sync and trigger check
    if (url.pathname === '/api/health_monitor_sync' && req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        await healthSyncPositions()
        
        const enabled = isHealthMonitorEnabled()
        const entries = getHealthWorkerEntries()
        
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          success: true,
          message: 'Sync complete and health check triggered',
          status: { enabled, entries }
        }))
        
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: error?.message || 'unknown' }))
      }
      return
    }

    // =================================================================
    // REACTIVE ENTRY API (SHORT TRADING)
    // =================================================================

    // GET /api/reactive-entry/snapshot - Build market snapshot
    if (url.pathname === '/api/reactive-entry/snapshot' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store')
      const t0 = performance.now()
      
      try {
        const symbol = url.searchParams.get('symbol') || ''
        const microRange = url.searchParams.get('micro_range') === '1'
        const uiLang = (url.searchParams.get('ui_lang') || 'cs') as 'cs' | 'en'
        
        if (!symbol) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'symbol required' }))
          return
        }
        
        // Rate limiting
        const rateLimitKey = `reactive_entry_${symbol}`
        if (!checkRateLimit(rateLimitKey)) {
          res.statusCode = 429
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'rate_limit_exceeded' }))
          return
        }
        
        const api = getBinanceAPI()
        
        // 1. Fetch trading rules
        const symbolInfo = await api.getSymbolInfo(symbol)
        const filters = symbolInfo?.filters || []
        const priceFilter = filters.find((f: any) => f.filterType === 'PRICE_FILTER')
        const lotFilter = filters.find((f: any) => f.filterType === 'LOT_SIZE')
        const minNotionalFilter = filters.find((f: any) => f.filterType === 'MIN_NOTIONAL')
        
        const tickSize = Number(priceFilter?.tickSize || 0.01)
        const stepSize = Number(lotFilter?.stepSize || 0.001)
        const minNotional = Number(minNotionalFilter?.notional || 5)
        
        // 2. Fetch current prices
        const markPrice = await fetchMarkPrice(symbol)
        const lastPrice = await fetchLastTradePrice(symbol)
        
        // 3. Fetch candles (parallel)
        const baseUrl = 'https://fapi.binance.com/fapi/v1/klines'
        const fetchPromises = [
          undiciRequest(`${baseUrl}?symbol=${symbol}&interval=5m&limit=300`),
          undiciRequest(`${baseUrl}?symbol=${symbol}&interval=15m&limit=200`),
          undiciRequest(`${baseUrl}?symbol=${symbol}&interval=1h&limit=200`),
          undiciRequest(`${baseUrl}?symbol=${symbol}&interval=4h&limit=200`)
        ]
        
        if (microRange) {
          fetchPromises.unshift(undiciRequest(`${baseUrl}?symbol=${symbol}&interval=1m&limit=90`))
        }
        
        const responses = await Promise.all(fetchPromises)
        const klinesData = await Promise.all(responses.map(r => r.body.json()))
        
        const klines1m = microRange ? klinesData[0] : []
        const klines5m = microRange ? klinesData[1] : klinesData[0]
        const klines15m = microRange ? klinesData[2] : klinesData[1]
        const klines1h = microRange ? klinesData[3] : klinesData[2]
        const klines4h = microRange ? klinesData[4] : klinesData[3]
        
        // 4. Calculate indicators
        const r6 = (n: number) => round(n, 6)
        
        // EMA
        const emaResult: any = {}
        if (klines5m.length >= 50) {
          const closes5m = klines5m.map((k: any) => parseFloat(k[4]))
          emaResult.m5 = {
            '20': ema(closes5m, 20),
            '50': ema(closes5m, 50)
          }
        }
        if (klines15m.length >= 50) {
          const closes15m = klines15m.map((k: any) => parseFloat(k[4]))
          emaResult.m15 = {
            '20': ema(closes15m, 20),
            '50': ema(closes15m, 50)
          }
        }
        if (klines1h.length >= 50) {
          const closes1h = klines1h.map((k: any) => parseFloat(k[4]))
          emaResult.h1 = {
            '20': ema(closes1h, 20),
            '50': ema(closes1h, 50)
          }
        }
        
        // RSI
        const closes5m = klines5m.map((k: any) => parseFloat(k[4]))
        const closes15m = klines15m.map((k: any) => parseFloat(k[4]))
        const rsi_m5 = rsi(closes5m, 14)
        const rsi_m15 = rsi(closes15m, 14)
        
        // ATR
        const bars15m = klines15m.map((k: any) => ({
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4])
        }))
        const atrPct = atrPctFromBars(bars15m, 14)
        const lastClose = closes15m[closes15m.length - 1]
        const atrPrice = atrPct && lastClose ? (atrPct / 100) * lastClose : null
        
        // VWAP (today's session)
        const now = new Date()
        const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)
        const todayBars = klines15m
          .filter((k: any) => Number(k[0]) >= startOfDay)
          .map((k: any) => ({
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5])
          }))
        const vwap_today = vwapFromBars(todayBars)
        
        // 5. Detect RESISTANCE levels (swing highs z M5)
        const resistances: Array<{ price: number; age_mins: number }> = []
        const nowMs = Date.now()
        
        for (let i = 1; i < klines5m.length - 1; i++) {
          const prev = parseFloat(klines5m[i - 1][2]) // high
          const curr = parseFloat(klines5m[i][2])     // high
          const next = parseFloat(klines5m[i + 1][2]) // high
          
          if (curr > prev && curr > next) {
            const openTime = Number(klines5m[i][0])
            const ageMins = Math.floor((nowMs - openTime) / (60 * 1000))
            resistances.push({ price: curr, age_mins: ageMins })
          }
        }
        
        // Vybrat posledních 3-5 nejčerstvějších resistances
        const sortedResistances = resistances
          .sort((a, b) => a.age_mins - b.age_mins)
          .slice(0, 5)
        
        // 6. Calculate ranges
        const rangeResult: any = {}
        
        if (klines1h.length > 0) {
          const h1Lows = klines1h.map((k: any) => parseFloat(k[3]))
          const h1Highs = klines1h.map((k: any) => parseFloat(k[2]))
          rangeResult.h1 = {
            low: Math.min(...h1Lows),
            high: Math.max(...h1Highs)
          }
        }
        
        if (klines4h.length > 0) {
          const h4Lows = klines4h.map((k: any) => parseFloat(k[3]))
          const h4Highs = klines4h.map((k: any) => parseFloat(k[2]))
          rangeResult.h4 = {
            low: Math.min(...h4Lows),
            high: Math.max(...h4Highs)
          }
        }
        
        // Micro range
        let micro_range: any = null
        if (microRange && klines1m.length >= 30) {
          const last30 = klines1m.slice(-30)
          const lows = last30.map((k: any) => parseFloat(k[3]))
          const highs = last30.map((k: any) => parseFloat(k[2]))
          micro_range = {
            low_lookback_mins: 30,
            low: Math.min(...lows),
            high: Math.max(...highs)
          }
        } else if (klines5m.length >= 6) {
          const last6 = klines5m.slice(-6)
          const lows = last6.map((k: any) => parseFloat(k[3]))
          const highs = last6.map((k: any) => parseFloat(k[2]))
          micro_range = {
            low_lookback_mins: 30,
            low: Math.min(...lows),
            high: Math.max(...highs)
          }
        }
        
        // 7. Build OHLCV candles
        const candles: any = {}
        
        if (klines5m.length > 0) {
          candles.m5 = klines5m.slice(-300).map((k: any) => ({
            t: Number(k[0]),
            o: r6(parseFloat(k[1])),
            h: r6(parseFloat(k[2])),
            l: r6(parseFloat(k[3])),
            c: r6(parseFloat(k[4])),
            v: r6(parseFloat(k[5]))
          }))
        }
        
        if (klines15m.length > 0) {
          candles.m15 = klines15m.slice(-200).map((k: any) => ({
            t: Number(k[0]),
            o: r6(parseFloat(k[1])),
            h: r6(parseFloat(k[2])),
            l: r6(parseFloat(k[3])),
            c: r6(parseFloat(k[4])),
            v: r6(parseFloat(k[5]))
          }))
        }
        
        if (klines1h.length > 0) {
          candles.h1 = klines1h.slice(-200).map((k: any) => ({
            t: Number(k[0]),
            o: r6(parseFloat(k[1])),
            h: r6(parseFloat(k[2])),
            l: r6(parseFloat(k[3])),
            c: r6(parseFloat(k[4])),
            v: r6(parseFloat(k[5]))
          }))
        }
        
        if (klines4h.length > 0) {
          candles.h4 = klines4h.slice(-200).map((k: any) => ({
            t: Number(k[0]),
            o: r6(parseFloat(k[1])),
            h: r6(parseFloat(k[2])),
            l: r6(parseFloat(k[3])),
            c: r6(parseFloat(k[4])),
            v: r6(parseFloat(k[5]))
          }))
        }
        
        // 8. Get position data
        const positions = await fetchPositions()
        const position = positions.find((p: any) => String(p?.symbol) === symbol)
        const hasPosition = position && Math.abs(Number(position?.positionAmt || 0)) > 0
        
        const positionData = hasPosition ? {
          avg_entry_price: Number(position.entryPrice || 0),
          size: Math.abs(Number(position.positionAmt || 0)),
          unrealized_pnl: Number(position.unRealizedProfit || 0)
        } : {
          avg_entry_price: null,
          size: null,
          unrealized_pnl: null
        }
        
        // 9. Build snapshot
        const snapshot: ReactiveEntryInput = {
          ok: true,
          symbol,
          ts_utc: new Date().toISOString(),
          ui_lang: uiLang,
          tradingRules: {
            tickSize,
            stepSize,
            minNotional
          },
          prices: {
            last_trade: lastPrice,
            current: markPrice,
            vwap_today: vwap_today || undefined
          },
          ema: Object.keys(emaResult).length > 0 ? emaResult : undefined,
          momentum: {
            rsi_m5,
            rsi_m15,
            atr_m15: atrPct,
            atr_m15_bps: atrPct ? atrPct * 100 : null,
            atr_m15_price: atrPrice
          },
          range: Object.keys(rangeResult).length > 0 ? rangeResult : undefined,
          micro_range: micro_range || undefined,
          resistances: sortedResistances.length > 0 ? sortedResistances : undefined,
          position: positionData,
          bars_meta: {
            m5: candles.m5?.length || 0,
            m15: candles.m15?.length || 0,
            h1: candles.h1?.length || 0
          },
          candles: Object.keys(candles).length > 0 ? candles : undefined
        }
        
        // CANDLES VALIDATION: Check minimum counts (recommended: 300 M5, 200 M15, 200 H1)
        const candlesValidation = {
          m5_count: candles.m5?.length || 0,
          m15_count: candles.m15?.length || 0,
          h1_count: candles.h1?.length || 0,
          m5_ok: (candles.m5?.length || 0) >= 200,  // Relaxed from 300 to 200 for practicality
          m15_ok: (candles.m15?.length || 0) >= 100, // Relaxed from 200 to 100
          h1_ok: (candles.h1?.length || 0) >= 100    // Relaxed from 200 to 100
        }
        
        console.info('[REACTIVE_ENTRY_CANDLES_VALIDATION]', {
          symbol,
          ...candlesValidation,
          sufficient_context: candlesValidation.m5_ok && candlesValidation.m15_ok
        })
        
        if (!candlesValidation.m5_ok || !candlesValidation.m15_ok) {
          console.warn('[REACTIVE_ENTRY_INSUFFICIENT_CONTEXT]', {
            symbol,
            m5: candlesValidation.m5_count,
            m15: candlesValidation.m15_count,
            h1: candlesValidation.h1_count,
            m5_required: 200,
            m15_required: 100,
            recommendation: 'AI may have limited context for pattern recognition'
          })
        }
        
        const latencyMs = Math.round(performance.now() - t0)
        console.log('[REACTIVE_ENTRY_SNAPSHOT]', { symbol, latencyMs, bars: snapshot.bars_meta })
        
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(snapshot))
        
      } catch (error: any) {
        console.error('[REACTIVE_ENTRY_SNAPSHOT_ERR]', error)
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: error?.message || 'unknown' }))
      }
      return
    }

    // POST /api/ai_profit_taker - manual AI profit taker trigger
    if (url.pathname === '/api/ai_profit_taker' && req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Type', 'application/json')
      
      try {
        const body = await parseJsonBody(req)
        const symbol = String(body?.symbol || '')
        
        if (!symbol) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'Missing symbol' }))
          return
        }
        
        // Import dynamically
        const { runAIProfitTaker } = await import('../services/ai-profit-taker/decision.js')
        
        const result = await runAIProfitTaker(symbol)
        
        // Emit to aiTap for DevAiOverview
        if (result.ok && result.data) {
          const { aiTap } = await import('../services/lib/ai_tap.js')
          aiTap.emit('ai_profit_taker', {
            symbol,
            raw_request: result.data.input,
            raw_response: result.data.decision
          })
        }
        
        res.statusCode = 200
        res.end(JSON.stringify(result))
      } catch (e: any) {
        console.error('[AI_PROFIT_TAKER_ERR]', e)
        res.statusCode = 500
        res.end(JSON.stringify({ error: e?.message || 'Internal error' }))
      }
      return
    }

    // POST /api/reactive-entry/analyze - AI decision
    if (url.pathname === '/api/reactive-entry/analyze' && req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store')
      const t0 = performance.now()
      
      try {
        const body = await new Promise<string>((resolve) => {
          let data = ''
          req.on('data', chunk => { data += chunk })
          req.on('end', () => resolve(data))
        })
        
        const snapshot = JSON.parse(body) as ReactiveEntryInput
        
        if (!snapshot.symbol) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'symbol required' }))
          return
        }
        
        // Rate limiting
        const rateLimitKey = `reactive_entry_analyze_${snapshot.symbol}`
        if (!checkRateLimit(rateLimitKey)) {
          res.statusCode = 429
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'rate_limit_exceeded' }))
          return
        }
        
        // Call AI decision
        const decision = await runReactiveEntryDecision(snapshot)
        
        if (!decision.ok || !decision.data) {
          res.statusCode = decision.code === 'no_api_key' ? 401 : 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            ok: false,
            error: decision.code || 'decision_failed',
            meta: decision.meta
          }))
          return
        }
        
        // Server-side post-processing (SHORT logic!)
        let finalDecision = { ...decision.data }
        const currentPrice = snapshot.prices?.current || 0
        const tickSize = snapshot.tradingRules?.tickSize || 0.00001
        const atrBps = snapshot.momentum?.atr_m15_bps ?? 150
        
        // Calculate minimal edge requirements
        const edgeMinBps = Math.max(15, Math.min(25, Math.round(0.6 * atrBps)))
        const minEdgeAbs = Math.max(5 * tickSize, currentPrice * (edgeMinBps / 10000))
        const minEdgePrice = roundToTick(currentPrice + minEdgeAbs, tickSize) // SHORT: entry >= current
        
        // Get nearest fresh resistance (age <= 30 min)
        const nearestResistance = findNearestResistance(
          snapshot.resistances || [],
          currentPrice,
          30
        )
        
        // Calculate proper entry based on resistance - ATR buffer
        const atrPrice = snapshot.momentum?.atr_m15_price ?? (currentPrice * 0.015)
        const atrBuffer = 0.25 * atrPrice
        
        // For SHORT: Find nearest resistance >= current, subtract buffer
        let properEntryPrice = currentPrice + minEdgeAbs // default
        if (nearestResistance && nearestResistance.price >= currentPrice) {
          properEntryPrice = roundToTick(nearestResistance.price - atrBuffer, tickSize)
          console.log('[REACTIVE_ENTRY_RESISTANCE_BASED]', {
            symbol: snapshot.symbol,
            resistance: nearestResistance.price,
            atrBuffer,
            entry: properEntryPrice
          })
        }
        
        // Store ATR info in decision
        finalDecision.atr_info = {
          atr_price: atrPrice,
          atr_buffer: atrBuffer,
          resistance_used: nearestResistance?.price ?? null,
          proper_entry: properEntryPrice
        }
        
        // Validate ENTRY decision (SHORT: entry >= current)
        if (finalDecision.decision === 'entry') {
          const edgeBps = finalDecision.entry?.price 
            ? edgeFromCurrentBps(finalDecision.entry.price, currentPrice) 
            : 0
          const violatesChase = finalDecision.entry?.price 
            ? (finalDecision.entry.price < currentPrice) // SHORT: nesmíme chase dolů!
            : false
          const violatesEdge = finalDecision.entry?.price 
            ? (edgeBps < edgeMinBps || (finalDecision.entry.price - currentPrice) < 5 * tickSize)
            : true
          
          const probOk = finalDecision.class === 'scout'
            ? (finalDecision.confidence >= 0.60 && edgeBps >= edgeMinBps && atrBps >= 90)
            : (finalDecision.confidence >= 0.75)
          
          if (violatesChase || violatesEdge || !probOk) {
            console.warn('[REACTIVE_ENTRY_VALIDATION_FAIL]', {
              symbol: snapshot.symbol,
              violatesChase,
              violatesEdge,
              probOk,
              confidence: finalDecision.confidence,
              edgeBps: edgeBps.toFixed(2),
              edgeMinBps
            })
            
            // Force SKIP
            finalDecision.decision = 'skip'
            finalDecision.entry = null
            finalDecision.mode = 'none'
            finalDecision.class = 'none'
            finalDecision.size_hint_pct = 0
            
            const uiLang = snapshot.ui_lang || 'cs'
            finalDecision.reasoning = uiLang === 'cs'
              ? `Server validation failed: ${violatesChase ? 'chasing' : violatesEdge ? 'edge' : 'confidence'}`
              : `Server validation failed: ${violatesChase ? 'chasing' : violatesEdge ? 'edge' : 'confidence'}`
          }
        }
        
        const latencyMs = Math.round(performance.now() - t0)
        console.log('[REACTIVE_ENTRY_ANALYZE]', { 
          symbol: snapshot.symbol, 
          decision: finalDecision.decision,
          latencyMs,
          aiLatencyMs: decision.latencyMs
        })
        
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          ok: true,
          ...finalDecision,
          latencyMs: decision.latencyMs,
          raw_request: decision.raw_request,
          raw_response: decision.raw_response
        }))
        
      } catch (error: any) {
        console.error('[REACTIVE_ENTRY_ANALYZE_ERR]', error)
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: error?.message || 'unknown' }))
      }
      return
    }

    // GET /api/reactive-entry/health - Health check
    if (url.pathname === '/api/reactive-entry/health' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        const health = getHealthStatus()
        
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(health))
        
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: error?.message || 'unknown' }))
      }
      return
    }

    res.statusCode = 404
    res.end('Not found')
  } catch (e: any) {
    res.statusCode = 500
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: e?.message ?? 'Internal error' }))
  }
})

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`)
  try { startOrderSweeper() } catch (e) { console.error('[SWEEPER_START_ERR]', (e as any)?.message || e) }
  try { startSlProtectionMonitor() } catch (e) { console.error('[SL_MONITOR_START_ERR]', (e as any)?.message || e) }
  try { loadBackgroundCriteria() } catch {}
  try { startBackgroundTrading() } catch (e) { console.error('[BACKGROUND_START_ERR]', (e as any)?.message || e) }
})


