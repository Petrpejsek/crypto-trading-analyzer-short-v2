import { Agent, setGlobalDispatcher } from 'undici'
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { buildMarketRawSnapshot } from './fetcher/binance'
import { performance } from 'node:perf_hooks'
import http from 'node:http'
import { decideMarketStrict } from '../services/decider/market_decider_gpt'
import { ema as emaShared, rsi as rsiShared, atrPctFromBars } from '../services/lib/indicators'
import { runFinalPicker as runFinalPickerServer } from '../services/decider/final_picker_gpt'
import { runHotScreener } from '../services/decider/hot_screener_gpt'
import { request as undiciRequest } from 'undici'
import { runEntryStrategy } from '../services/decider/entry_strategy_gpt'
import { runEntryRisk } from '../services/decider/entry_risk_gpt'
import { executeHotTradingOrders, type PlaceOrdersRequest, fetchMarkPrice, fetchLastTradePrice, fetchAllOpenOrders, fetchPositions, cancelOrder, getBinanceAPI, getWaitingTpList, cleanupWaitingTpForSymbol, waitingTpProcessPassFromPositions, rehydrateWaitingFromDiskOnce, makeId } from '../services/trading/binance_futures'
import { ttlGet, ttlSet, makeKey } from './lib/ttlCache'
import { preflightCompact } from '../services/decider/market_compact'
import deciderCfg from '../config/decider.json'
import tradingCfg from '../config/trading.json'
import { calculateKlineChangePercent, calculateRegime } from './lib/calculations'
import { startBinanceUserDataWs, getPositionsInMemory, getOpenOrdersInMemory, isUserDataReady } from '../services/exchange/binance/userDataWs'
import { initCooldownsFromDisk, isCooldownActive, notePositionClosedFromIncomes, notePositionOpened, getActiveCooldowns, clearCooldown } from '../services/risk/cooldown'
import { getLimitsSnapshot, setBanUntilMs } from './lib/rateLimits'
import { startTopUpWatcher, syncWatcherEnabledFromEnv, setWatcherEnabled } from '../services/top-up-watcher/watchdog'
import { listWatchers, getWatcher, removeWatcher } from '../services/top-up-watcher/registry'
import { readLatestEvent, readAuditEntries } from '../services/top-up-watcher/events'
import { scheduleTopUpWatchers } from '../services/top-up-watcher/utils'
import { processDueTopUpExecutors, enqueueFromWatcher, getTopUpExecutorStatus } from '../services/top-up-executor/trigger'

// Load env from .env.local and .env even in production
try {
  const tryLoad = (p: string) => { if (fs.existsSync(p)) dotenv.config({ path: p }) }
  tryLoad(path.resolve(process.cwd(), '.env.local'))
  tryLoad(path.resolve(process.cwd(), '.env'))
} catch {}

// Ensure Strategy Updater loop aligns with toggle
async function ensureStrategyUpdaterLoop(enabled: boolean): Promise<{ started?: boolean; terminated?: boolean; id?: string }> {
  try {
    const address = process.env.TEMPORAL_ADDRESS
    const taskQueue = process.env.TASK_QUEUE
    if (!address || !taskQueue) return {}
    const { Connection, Client } = await import('@temporalio/client')
    const connection = await Connection.connect({ address })
    const client = new Client({ connection })
    const wfId = 'strategy-updater-loop'
    if (enabled) {
      try {
        await client.workflow.start('StrategyUpdaterWorkflow', {
          taskQueue,
          workflowId: wfId,
          args: [{ runOnce: false }],
          workflowIdReusePolicy: 'WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE'
        })
        return { started: true, id: wfId }
      } catch {
        return { started: false, id: wfId }
      }
    } else {
      try { const h = client.workflow.getHandle(wfId); await h.terminate('disabled'); return { terminated: true, id: wfId } } catch { return { terminated: false, id: wfId } }
    }
  } catch { return {} }
}

// Autostart loop on boot when enabled
try { if (process.env.STRATEGY_UPDATER_ENABLED === '1' || String(process.env.STRATEGY_UPDATER_ENABLED).toLowerCase() === 'true') setTimeout(()=>{ ensureStrategyUpdaterLoop(true).catch(()=>{}) }, 0) } catch {}

// Temporal env se načítá primárně z .env.local; fallback není žádoucí

setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 60_000, pipelining: 10 }))

// Basic warning if API key is missing/invalid
try {
  if (!process.env.OPENAI_API_KEY || !String(process.env.OPENAI_API_KEY).startsWith('sk-')) {
    // eslint-disable-next-line no-console
    console.error('OPENAI_API_KEY missing/invalid')
  }
} catch {}

const PORT = process.env.PORT ? Number(process.env.PORT) : 8789
// WS market collector disabled – REST-only mode for klines

// Ephemeral in-memory store of last place_orders request/response for diagnostics
let __lastPlaceOrders: { request: any; result: any } | null = null
// In-memory hints per symbol: last requested amount/leverage/sl/tp (survives across UI polls)
const __lastPlannedBySymbol: Record<string, { amount?: number | null; leverage?: number | null; sl?: number | null; tp?: number | null; ts: string }> = {}
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
// Strict threshold: cancel entry orders when their target deviates from mark by ≥ this percent
const ENTRY_DELTA_CANCEL_PCT = 7
// Grace window for cancelling orphan SL orders (no position, no entry)
const ORPHAN_SL_GRACE_MS = Number((process as any)?.env?.ORPHAN_SL_GRACE_MS ?? 5000)
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
  // During Binance backoff window, do not hit REST at all
  if (Number(__binanceBackoffUntilMs) > Date.now()) return
  __sweeperRunning = true
  try {
    const now = Date.now()
    const ageEnabled = Number.isFinite(__pendingCancelAgeMin) && __pendingCancelAgeMin > 0
    const ageMs = ageEnabled ? (__pendingCancelAgeMin * 60 * 1000) : 0
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
    // Strict: mazat pouze ENTRY BUY (LIMIT/STOP/STOP_MARKET) bez reduceOnly/closePosition; nikdy ne EXITy (SL/TP)
    const entryOrders = (Array.isArray(raw) ? raw : [])
      .filter((o: any) => {
        try {
          const side = String(o?.side || '').toUpperCase()
          const type = String(o?.type || '').toUpperCase()
          const reduceOnly = Boolean(o?.reduceOnly)
          const closePosition = Boolean(o?.closePosition)
          const isEntryType = (type === 'LIMIT' || type === 'STOP' || type === 'STOP_MARKET')
          return side === 'BUY' && isEntryType && !reduceOnly && !closePosition
        } catch { return false }
      })
    const entryCandidates = entryOrders
      .map((o: any) => ({
        symbol: String(o?.symbol || ''),
        orderId: Number(o?.orderId ?? o?.orderID ?? 0) || 0,
        createdAtMs: (() => { const t = Number((o as any)?.time); return Number.isFinite(t) && t > 0 ? t : null })()
      }))
      .filter(o => o.symbol && o.orderId && Number.isFinite(o.createdAtMs as any))
      .filter(o => (ageEnabled) && (now - (o.createdAtMs as number)) > ageMs)

    // Δ% based cleanup: if entry target deviates from current mark by ≥ ENTRY_DELTA_CANCEL_PCT
    // Compute mark per symbol once
    const uniqueEntrySymbols = Array.from(new Set(entryOrders.map((o: any) => String(o?.symbol || '')).filter(Boolean)))
    const markBySymbol: Record<string, number> = {}
    try {
      const chunkSize = 6
      for (let i = 0; i < uniqueEntrySymbols.length; i += chunkSize) {
        const chunk = uniqueEntrySymbols.slice(i, i + chunkSize)
        const res = await Promise.allSettled(chunk.map(sym => fetchMarkPrice(sym)))
        res.forEach((r, idx) => {
          const sym = chunk[idx]
          if (r.status === 'fulfilled') {
            const v = Number(r.value)
            if (Number.isFinite(v) && v > 0) markBySymbol[sym] = v
          }
        })
      }
    } catch {}

    const entryDeltaCandidates = (Array.isArray(entryOrders) ? entryOrders : [])
      .map((o: any) => {
        try {
          const sym = String(o?.symbol || '')
          const type = String(o?.type || '').toUpperCase()
          const price = Number(o?.price)
          const stopPrice = Number((o as any)?.stopPrice)
          const tgt = type === 'LIMIT' ? price : (type === 'STOP' || type === 'STOP_MARKET' || type === 'STOP_LIMIT' ? stopPrice : NaN)
          const mark = Number(markBySymbol[sym])
          const pct = (Number.isFinite(tgt) && tgt > 0 && Number.isFinite(mark) && mark > 0)
            ? Math.abs((tgt - mark) / mark) * 100
            : null
          return { symbol: sym, orderId: Number(o?.orderId ?? o?.orderID ?? 0) || 0, deltaPct: pct }
        } catch { return { symbol: '', orderId: 0, deltaPct: null as any } }
      })
      .filter(o => o.symbol && o.orderId)
      .filter(o => Number.isFinite(o.deltaPct as any) && (o.deltaPct as number) >= ENTRY_DELTA_CANCEL_PCT)

    // Age-based cancellation for ALL orders except: exits (SL/TP) for symbols with an open position
    const ageAllCandidates = (Array.isArray(raw) ? raw : [])
      .map((o: any) => {
        try {
          const sym = String(o?.symbol || '')
          const orderId = Number(o?.orderId ?? o?.orderID ?? 0) || 0
          const createdAtMs = (() => { const t = Number((o as any)?.time); return Number.isFinite(t) && t > 0 ? t : null })()
          const side = String(o?.side || '').toUpperCase()
          const type = String(o?.type || '').toUpperCase()
          const reduceOnly = Boolean(o?.reduceOnly)
          const closePosition = Boolean(o?.closePosition)
          const cid = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
          const hasPos = Number(posSizeBySym.get(sym) || 0) > 0
          const isStopOrTp = type.includes('STOP') || type.includes('TAKE_PROFIT')
          const isInternalExit = cid ? (/^x_tp_|^x_sl_/.test(cid)) : false
          const isExitForPosition = hasPos && isStopOrTp && (reduceOnly || closePosition || isInternalExit)
          return { sym, orderId, createdAtMs, isExitForPosition }
        } catch { return { sym: '', orderId: 0, createdAtMs: null as any, isExitForPosition: false } }
      })
      .filter(o => o.sym && o.orderId && Number.isFinite(o.createdAtMs as any))
      .filter(o => ageEnabled && (now - (o.createdAtMs as number)) > ageMs)
      .filter(o => !o.isExitForPosition)
      .map(o => ({ symbol: o.sym, orderId: o.orderId }))

    // KRITICKÁ OPRAVA: SL ordery NIKDY nesmí být rušeny automaticky!
    // Pouze TP ordery mohou být rušeny jako "orphan exits" 
    const entrySymbols = new Set<string>((Array.isArray(raw) ? raw : [])
      .filter((o: any) => {
        try {
          const side = String(o?.side||'').toUpperCase()
          const type = String(o?.type||'').toUpperCase()
          const reduceOnly = Boolean(o?.reduceOnly)
          const closePosition = Boolean(o?.closePosition)
          const isEntryType = (type === 'LIMIT' || type === 'STOP' || type === 'STOP_MARKET')
          return side === 'BUY' && isEntryType && !(reduceOnly||closePosition)
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

          // If we have a position, never cancel exits (SL/TP)
          if (hasPos && (isExitType || isInternalTp || isInternalSl)) {
            try { console.warn('[SWEEPER_POSITION_PROTECTION]', { symbol: sym, orderId: o?.orderId, type, reason: 'position_exists_never_cancel_exits' }) } catch {}
            return false
          }

          // If there is no position and no entry, we can cancel:
          if (!hasPos && noEntryOpen) {
            // A) Internal TP (x_tp_*) – always safe
            if (isTpType && isInternalTp) return true
            // B) TP with exit flags
            if (isTpType && (reduceOnly || closePosition)) return true
            // C) SL with exit flags or internal id; only after small grace window to avoid races
            if (isSlType && side === 'SELL' && (reduceOnly || closePosition || isInternalSl)) {
              const created = Number((o as any)?.time)
              const ageOk = Number.isFinite(created) ? ((now - created) > ORPHAN_SL_GRACE_MS) : true
              return ageOk
            }
            return false
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
      .filter(o => (ageEnabled) && (now - (o.createdAtMs as number)) > ageMs)

    // Combine age-based ALL-orders, delta-based entries and orphan exits. Deduplicate by orderId.
    const combined: Array<{ symbol: string; orderId: number; reason?: string }> = []
    const seen = new Set<number>()
    for (const c of ageAllCandidates) { if (!seen.has(c.orderId)) { combined.push({ symbol: c.symbol, orderId: c.orderId, reason: 'age_based' }); seen.add(c.orderId) } }
    for (const c of entryCandidates) { if (!seen.has(c.orderId)) { combined.push({ symbol: c.symbol, orderId: c.orderId, reason: 'stale_entry' }); seen.add(c.orderId) } }
    for (const c of entryDeltaCandidates) { if (!seen.has(c.orderId)) { combined.push({ symbol: c.symbol, orderId: c.orderId, reason: 'delta_ge_7pct' }); seen.add(c.orderId) } }
    for (const c of orphanExitCandidates) { if (!seen.has(c.orderId)) { combined.push({ symbol: c.symbol, orderId: c.orderId, reason: 'orphan_exit_cleanup' }); seen.add(c.orderId) } }

    if (combined.length === 0) return 0

    let cancelled = 0
    const maxParallel = 4
    for (let i = 0; i < combined.length; i += maxParallel) {
      const batch = combined.slice(i, i + maxParallel)
      const res = await Promise.allSettled(batch.map(async (c) => {
        const r = await cancelOrder(c.symbol, c.orderId)
        pushAudit({ ts: new Date().toISOString(), type: 'cancel', source: 'sweeper', symbol: c.symbol, orderId: c.orderId, reason: c.reason || 'stale_auto_cancel' })
        return r
      }))
      for (const r of res) {
        if (r.status === 'fulfilled') cancelled++
      }
    }
    if (cancelled > 0) {
      __sweeperDidAutoCancel = true
      try { ttlSet(makeKey('/api/open_orders'), null as any, 1) } catch {}
    }
    try { console.error('[SWEEPER_PASS]', { age_min: __pendingCancelAgeMin, threshold_delta_pct: ENTRY_DELTA_CANCEL_PCT, cancelled, age_all: ageAllCandidates.length, entries_age: entryCandidates.length, entries_delta: entryDeltaCandidates.length, orphan_exits: orphanExitCandidates.length }) } catch {}
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
    const api = getBinanceAPI() as any
    // Detect account mode once per pass
    let isHedgeMode = false
    try { isHedgeMode = Boolean(await api.getHedgeMode()) } catch {}
    const workingType = String((tradingCfg as any)?.EXIT_WORKING_TYPE || 'MARK_PRICE') as 'MARK_PRICE' | 'CONTRACT_PRICE'
    const emergencyPct = ((): number => {
      const v = Number((process as any)?.env?.EMERGENCY_SL_PCT)
      if (Number.isFinite(v) && v > 0 && v < 0.5) return v
      return 0.05
    })()
    const quantize = (value: number, step: number): number => {
      const s = String(step)
      const idx = s.indexOf('.')
      const decimals = idx >= 0 ? (s.length - idx - 1) : 0
      const factor = Math.pow(10, decimals)
      return Math.round(value * factor) / factor
    }
    
    for (const pos of posList) {
      try {
        const symbol = String(pos?.symbol || '')
        const amtRaw = Number((pos as any)?.positionAmt ?? (pos as any)?.size ?? 0)
        const size = Math.abs(amtRaw)
        if (!symbol || size === 0) continue
        const exitSide = amtRaw > 0 ? 'SELL' : 'BUY'
        
        const slOrders = ordersList.filter(o => 
          String(o?.symbol) === symbol && 
          String(o?.side || '').toUpperCase() === exitSide && 
          String(o?.type || '').toUpperCase().includes('STOP')
        )
        
        if (slOrders.length === 0) {
          console.error('[CRITICAL_NO_SL_FOR_POSITION]', { 
            symbol, 
            positionSize: size, 
            entryPrice: pos?.entryPrice,
            unrealizedPnl: pos?.unRealizedProfit 
          })
          // Emergency SL: create STOP_MARKET immediately based on entry price +/- emergencyPct
          try {
            const entryPriceNum = Number((pos as any)?.entryPrice)
            if (!Number.isFinite(entryPriceNum) || entryPriceNum <= 0) { throw new Error('bad_entry_price') }
            let emergencyPx = amtRaw > 0
              ? entryPriceNum * (1 - emergencyPct) // LONG: SL below entry
              : entryPriceNum * (1 + emergencyPct) // SHORT: SL above entry
            // Quantize to tick size
            try {
              const info = await api.getSymbolInfo(symbol)
              const pf = (info?.filters || []).find((f: any) => f?.filterType === 'PRICE_FILTER')
              const tickSize = pf ? Number(pf.tickSize) : null
              if (Number.isFinite(tickSize as any) && (tickSize as number) > 0) {
                emergencyPx = quantize(emergencyPx, tickSize as number)
              }
            } catch {}
            const base: any = {
              symbol,
              side: exitSide,
              type: 'STOP_MARKET',
              stopPrice: String(emergencyPx),
              closePosition: true,
              workingType,
              newClientOrderId: makeId('x_sl_em'),
              newOrderRespType: 'RESULT'
            }
            if (isHedgeMode) base.positionSide = amtRaw > 0 ? 'LONG' : 'SHORT'
            const r = await api.placeOrder(base)
            try { console.warn('[EMERGENCY_SL_CREATED]', { symbol, orderId: r?.orderId ?? null, stopPrice: emergencyPx, side: exitSide }) } catch {}
          } catch (emErr: any) {
            try { console.error('[EMERGENCY_SL_FAILED]', { symbol, error: emErr?.message || emErr }) } catch {}
          }
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
    if (!decisionRes.ok) { 
      const errorText = await decisionRes.text().catch(() => 'no_body')
      console.error('[BACKGROUND_DECISION_ERROR]', { status: decisionRes.status, error: errorText })
      console.info('[BACKGROUND_PIPELINE_SKIP]', { reason: `decision_failed_${decisionRes.status}` })
      return 
    }
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

    // 7) KRITICKÁ OPRAVA: Entry Strategies + Risk Manager pro každý pick
    const finalOrders = []
    const failed: string[] = []

    for (const pick of finalResp.data.picks) {
      try {
        const symbol = pick.symbol
        console.info('[BACKGROUND_ENTRY_START]', { symbol })
        
        // 7.1) Získat intraday data
        const intradayRes = await fetch(`http://127.0.0.1:${PORT}/api/intraday_any?symbol=${encodeURIComponent(symbol)}`)
        if (!intradayRes.ok) { 
          failed.push(symbol)
          console.error('[BACKGROUND_INTRADAY_FAILED]', { symbol, status: intradayRes.status })
          continue 
        }
        const intradayData = await intradayRes.json()
        const assets = Array.isArray(intradayData?.assets) ? intradayData.assets : []
        const asset = assets.find((a: any) => a?.symbol === symbol)
        if (!asset) { 
          failed.push(symbol)
          console.error('[BACKGROUND_NO_ASSET]', { symbol })
          continue 
        }

        // 7.2) Zavolat Entry Strategy
        const strategyRes = await fetch(`http://127.0.0.1:${PORT}/api/entry_strategy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol, asset_data: asset })
        })
        if (!strategyRes.ok) { 
          failed.push(symbol)
          console.error('[BACKGROUND_STRATEGY_FAILED]', { symbol, status: strategyRes.status })
          continue 
        }
        const strategyResult = await strategyRes.json()
        if (!strategyResult.ok || !strategyResult.data) { 
          failed.push(symbol)
          console.error('[BACKGROUND_STRATEGY_ERROR]', { symbol, result: strategyResult })
          continue 
        }
        const strategy = strategyResult.data

        // 7.3) Připravit payload pro Risk Manager
        const cons: any = strategy.conservative || null
        const isPlan = (p: any) => p && typeof p.entry === 'number' && typeof p.sl === 'number' && 
          typeof p.tp1 === 'number' && typeof p.tp2 === 'number' && typeof p.tp3 === 'number'
        
        if (!isPlan(cons)) {
          failed.push(symbol)
          console.error('[BACKGROUND_NO_VALID_PLANS]', { symbol })
          continue
        }

        const toTp = (p: any) => ([
          { tag: 'tp1', price: Number(p?.tp1), allocation_pct: 0.33 },
          { tag: 'tp2', price: Number(p?.tp2), allocation_pct: 0.34 },
          { tag: 'tp3', price: Number(p?.tp3), allocation_pct: 0.33 }
        ])

        // 7.4) Zavolat Risk Manager
        const riskPayload = {
          symbol,
          posture: (decision?.flag as any) || 'OK',
          candidates: [
            { style: 'conservative', entry: cons.entry, sl: cons.sl, tp_levels: toTp(cons), reasoning: cons.reasoning || '' }
          ]
        }
        try { console.info('[ENTRY_STRATEGY_AGGRESSIVE_SKIPPED] reason:"temporarily disabled"', { context: 'background_pipeline', symbol }) } catch {}

        const riskRes = await fetch(`http://127.0.0.1:${PORT}/api/entry_risk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(riskPayload)
        })
        if (!riskRes.ok) {
          failed.push(symbol)
          console.error('[BACKGROUND_RISK_FAILED]', { symbol, status: riskRes.status })
          continue
        }
        const riskResult = await riskRes.json()
        const riskData = riskResult?.data || riskResult
        
        // 7.5) Vyhodnotit Risk Manager rozhodnutí
        if (riskData?.decision !== 'enter') {
          console.info('[BACKGROUND_RISK_SKIP]', { symbol, decision: riskData?.decision, reasons: riskData?.reasons })
          continue
        }

        const chosenPlan = riskData?.chosen_plan
        if (!chosenPlan) {
          failed.push(symbol)
          console.error('[BACKGROUND_NO_CHOSEN_PLAN]', { symbol })
          continue
        }

        const chosenStrategy = String(chosenPlan?.style) as ('conservative' | 'aggressive')
        if (!chosenStrategy || (chosenStrategy !== 'conservative' && chosenStrategy !== 'aggressive')) {
          failed.push(symbol)
          console.error('[BACKGROUND_INVALID_STRATEGY]', { symbol, style: chosenPlan?.style })
          continue
        }

        // 7.6) Sestavit objednávku s použitím chosen_plan z risk manageru
        // Vybrat nejvyšší TP z tp_levels (typicky tp3)
        let selectedTp = 0
        let selectedTpTag = 'tp3'
        if (Array.isArray(chosenPlan?.tp_levels)) {
          for (const tpLevel of chosenPlan.tp_levels) {
            const price = Number(tpLevel?.price)
            if (Number.isFinite(price) && price > selectedTp) {
              selectedTp = price
              selectedTpTag = String(tpLevel?.tag || 'tp3')
            }
          }
        }

        // Pokud není TP v chosen_plan, použít fallback z původního plánu
        if (!selectedTp || selectedTp <= 0) {
          const plan = cons
          selectedTp = Number(plan?.tp3) || Number(plan?.tp2) || Number(plan?.tp1) || 0
        }

        const tradingCfg = await import('../config/trading.json').then(m => (m as any).default ?? m)
        const defaultAmount = (tradingCfg as any)?.default_amount_usdt || 10
        const defaultLeverage = (tradingCfg as any)?.default_leverage || 1

        const order = {
          symbol,
          side: 'LONG' as const,
          strategy: chosenStrategy,
          tpLevel: selectedTpTag,
          orderType: chosenStrategy === 'conservative' ? 'limit' : 'stop_limit',
          amount: defaultAmount,
          leverage: defaultLeverage,
          risk_label: String(chosenPlan?.risk || ''),
          entry: Number(chosenPlan.entry),
          sl: Number(chosenPlan.sl),
          tp: selectedTp
        }

        // Validace numerických hodnot
        if (!Number.isFinite(order.entry) || order.entry <= 0 ||
            !Number.isFinite(order.sl) || order.sl <= 0 ||
            !Number.isFinite(order.tp) || order.tp <= 0) {
          failed.push(symbol)
          console.error('[BACKGROUND_INVALID_NUMBERS]', { symbol, order })
          continue
        }

        finalOrders.push(order)
        console.info('[BACKGROUND_ORDER_PREPARED]', { symbol, strategy: chosenStrategy, order })

      } catch (e: any) {
        failed.push(pick.symbol)
        console.error('[BACKGROUND_ENTRY_ERROR]', { symbol: pick.symbol, error: e?.message || 'unknown' })
      }
    }

    if (finalOrders.length === 0) {
      console.info('[BACKGROUND_PIPELINE_SKIP]', { reason: 'no_valid_orders', failed })
      return
    }

    // 8) Odeslat kompletní objednávky
    console.info('[BACKGROUND_SENDING_ORDERS]', { count: finalOrders.length, failed: failed.length })
    const orderReq = { orders: finalOrders }
    const tradingResult = await executeHotTradingOrders(orderReq)
    console.info('[BACKGROUND_PIPELINE_SUCCESS]', { 
      decision_flag: decision.flag,
      picks_count: finalResp.data.picks.length,
      prepared_orders: finalOrders.length,
      failed_symbols: failed,
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
  // Rehydrate entry updater registry from disk
  try {
    (async () => {
      const { rehydrateEntryUpdaterFromDisk } = await import('../services/entry-updater/registry')
      await rehydrateEntryUpdaterFromDisk()
    })().catch(()=>{})
  } catch {}
// Rehydrate profit taker registry from disk
try {
  (async () => {
    const { rehydrateProfitTakerFromDisk } = await import('../services/profit-taker/registry')
    await rehydrateProfitTakerFromDisk()
  })().catch(()=>{})
} catch {}
// Rehydrate top-up watcher registry from disk
try {
  (async () => {
    const { rehydrateWatchersFromDisk } = await import('../services/top-up-watcher/registry')
    await rehydrateWatchersFromDisk()
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

// Profit Taker separate timer (light scheduler check)
let __profitTakerTimer: NodeJS.Timeout | null = null
const startProfitTakerTimer = () => {
  if (__profitTakerTimer) clearInterval(__profitTakerTimer)
  __profitTakerTimer = setInterval(async () => {
    try {
      const { processDueProfitTakers } = await import('../services/profit-taker/trigger')
      processDueProfitTakers().catch(()=>{})
    } catch {}
  }, 60000)
}
try { startProfitTakerTimer() } catch {}

// Top-Up watcher timer (12s jitter handled inside watchdog)
let __topUpWatcherTimer: NodeJS.Timeout | null = null
const startTopUpWatcherTimer = () => {
  if (__topUpWatcherTimer) clearInterval(__topUpWatcherTimer)
  __topUpWatcherTimer = setInterval(async () => {
    try {
      const { syncWatcherEnabledFromEnv } = await import('../services/top-up-watcher/watchdog')
      syncWatcherEnabledFromEnv()
    } catch {}
  }, 15000)
}
try {
  (async () => {
    const { startTopUpWatcher } = await import('../services/top-up-watcher/watchdog')
    startTopUpWatcher()
  })().catch(()=>{})
} catch {}
try { startTopUpWatcherTimer() } catch {}

// Top-Up executor timer (mirrors profit taker cadence)
let __topUpExecutorTimer: NodeJS.Timeout | null = null
const startTopUpExecutorTimer = () => {
  if (__topUpExecutorTimer) clearInterval(__topUpExecutorTimer)
  __topUpExecutorTimer = setInterval(async () => {
    try {
      const { processDueTopUpExecutors } = await import('../services/top-up-executor/trigger')
      processDueTopUpExecutors().catch(()=>{})
    } catch {}
  }, 45000)
}
try { startTopUpExecutorTimer() } catch {}

// Entry Updater separate timer (every 30 seconds)
let __entryUpdaterTimer: NodeJS.Timeout | null = null
const startEntryUpdaterTimer = () => {
  if (__entryUpdaterTimer) clearInterval(__entryUpdaterTimer)
  __entryUpdaterTimer = setInterval(async () => {
    try {
      const { processDueEntryUpdates } = await import('../services/entry-updater/trigger')
      processDueEntryUpdates().catch(()=>{})
    } catch {}
  }, 5000)
}
try { startEntryUpdaterTimer() } catch {}

// Safety watchdog: reset stuck "processing" entries back to waiting after 60s
try {
  setInterval(async () => {
    try {
      const { listEntryOrders, setEntryStatus } = await import('../services/entry-updater/registry')
      const list = listEntryOrders()
      const now = Date.now()
      for (const e of (Array.isArray(list)?list:[])) {
        try {
          if ((e as any)?.status === 'processing') {
            const trig = Date.parse(String(e.triggerAt || ''))
            if (Number.isFinite(trig) && (now - trig) > 60000) {
              setEntryStatus(e.orderId, 'waiting')
              try { console.warn('[EU_WATCHDOG_RESET]', { orderId: e.orderId }) } catch {}
            }
          }
        } catch {}
      }
    } catch {}
  }, 15000)
} catch {}

// On boot: backfill Entry Updater tracks for existing internal BUY LIMIT entries
try {
  (async () => {
    const { getBinanceAPI } = await import('../services/trading/binance_futures')
    const { trackEntryOrder, hasEntryTrack } = await import('../services/entry-updater/registry')
    const api = getBinanceAPI() as any
    const allSymbols: string[] = []
    try {
      const orders = await api.getAllOpenOrders()
      for (const o of (Array.isArray(orders)?orders:[])) {
        try {
          const sideBuy = String(o?.side || '').toUpperCase() === 'BUY'
          const t = String(o?.type || '').toUpperCase()
          const isLimit = t === 'LIMIT'
          const reduceOnly = Boolean(o?.reduceOnly)
          const closePosition = Boolean(o?.closePosition)
          const cid = String((o as any)?.clientOrderId || '')
          const isInternal = /^e_l_/.test(cid)
          const id = Number(o?.orderId || o?.orderID || 0)
          const price = Number(o?.price || 0)
          const sym = String(o?.symbol || '')
          if (sym) allSymbols.push(sym)
          if (sideBuy && isLimit && !reduceOnly && !closePosition && isInternal && id>0 && price>0) {
            if (!hasEntryTrack(id)) {
              trackEntryOrder({ symbol: sym, orderId: id, clientOrderId: cid || null, entryPrice: price, sl: null, tpLevels: [] })
              try { console.info('[EU_BACKFILL_TRACK]', { symbol: sym, orderId: id }) } catch {}
            }
          }
        } catch {}
      }
    } catch {}
  })().catch(()=>{})
} catch {}
// Start Binance user-data WS to capture cancel/filled events into audit log
try {
  try { initCooldownsFromDisk() } catch {}
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
              // Cooldown hook: position open/close
              try {
                if (size > 0) {
                  notePositionOpened(sym)
                } else {
                  await notePositionClosedFromIncomes(sym)
                }
              } catch {}
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

              if (!hasPos) {
                // Double-confirm: recheck position after short delay to avoid race with WS/REST
                let stillNoPos = true
                try {
                  await new Promise((resolve) => setTimeout(resolve, 2200))
                  const api2 = getBinanceAPI() as any
                  const [orders2, positions2] = await Promise.all([
                    api2.getOpenOrders(sym),
                    api2.getPositions()
                  ])
                  const pos2 = (Array.isArray(positions2) ? positions2 : []).find((p: any) => String(p?.symbol) === sym)
                  const size2 = (() => { try { const n = Number(pos2?.size ?? pos2?.positionAmt ?? 0); return Number.isFinite(n) ? Math.abs(n) : 0 } catch { return 0 } })()
                  stillNoPos = size2 <= 0
                  if (!stillNoPos) {
                    console.info('[SU_CLEANUP_SKIPPED_STILL_OPEN]', { symbol: sym })
                    return
                  }
                  console.info('[SU_CLEANUP_CONFIRM]', { symbol: sym })
                  // Use the freshest orders snapshot for cleanup
                  const ordersForCleanup = Array.isArray(orders2) ? orders2 : (Array.isArray(orders) ? orders : [])
                  // 1) VŽDY zruš Strategy Updater exits (x_tp1_/x_tp2_/x_tp3_/x_sl_upd_) po potvrzeném zavření pozice
                  const suExits = ordersForCleanup.filter((o: any) => {
                    try {
                      const cid = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
                      return String(o?.symbol) === sym && (/^x_tp1_|^x_tp2_|^x_tp3_|^x_sl_upd_/).test(cid)
                    } catch { return false }
                  })
                  for (const o of suExits) {
                    try {
                      await cancelOrder(sym, Number(o?.orderId))
                      try { pushAudit({ ts: new Date().toISOString(), type: 'cancel', source: 'server', symbol: sym, orderId: Number(o?.orderId)||undefined, reason: 'cleanup_on_pos_close_su_exit' }) } catch {}
                    } catch (e) {
                      try { console.error('[CLEANUP_ON_CLOSE_SU_ERR]', { symbol: sym, orderId: o?.orderId, error: (e as any)?.message || e }) } catch {}
                    }
                  }

                  // 2) Pokud zároveň neexistuje interní ENTRY, zruš i ostatní interní exits (x_tp_* / x_sl_)
                  const noEntryOpen2 = (() => {
                    try {
                      return !(Array.isArray(ordersForCleanup) ? ordersForCleanup : []).some((o: any) => {
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

                  if (noEntryOpen2) {
                    const otherExits = ordersForCleanup.filter((o: any) => {
                      try {
                        const cid = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
                        const type = String(o?.type || '').toUpperCase()
                        const isExit = type.includes('TAKE_PROFIT') || type.includes('STOP')
                        const isInternal = /^x_tp_|^x_sl_/.test(cid)
                        // Exclude SU prefixes already handled above
                        const isSu = /^x_tp1_|^x_tp2_|^x_tp3_|^x_sl_upd_/.test(cid)
                        return String(o?.symbol) === sym && isExit && isInternal && !isSu
                      } catch { return false }
                    }).slice(0, 3)

                    for (const o of otherExits) {
                      try {
                        await cancelOrder(sym, Number(o?.orderId))
                        try { pushAudit({ ts: new Date().toISOString(), type: 'cancel', source: 'server', symbol: sym, orderId: Number(o?.orderId)||undefined, reason: 'cleanup_on_pos_close_internal_exit' }) } catch {}
                      } catch (e) {
                        try { console.error('[CLEANUP_ON_CLOSE_ERR]', { symbol: sym, orderId: o?.orderId, error: (e as any)?.message || e }) } catch {}
                      }
                    }
                  }
                } catch {}
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
              // Profit Taker disabled when Top-Up Executor is active
              try {
                const { getTopUpExecutorStatus } = await import('../services/top-up-executor/trigger')
                const st = getTopUpExecutorStatus()
                if (!st.enabled) {
                  try {
                    const { detectPositionForProfitTaker } = await import('../services/profit-taker/trigger')
                    detectPositionForProfitTaker(orders, positions)
                  } catch {}
                }
              } catch {}
              try {
                const { scheduleTopUpWatchers } = await import('../services/top-up-watcher/utils')
                scheduleTopUpWatchers(positions)
              } catch {}
              // SU: No immediate force; first run waits 2 minutes by design
            } catch (triggerError) {
              console.error('[STRATEGY_UPDATER_TRIGGER_ERR]', triggerError)
            }
          }, 1000) // 1 sekunda delay pro stabilitu
        }
      } catch {}
    }
  })
} catch (e) {
  try { console.error('[USERDATA_WS_ERROR]', (e as any)?.message || e) } catch {}
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

    const hasRealBinanceKeys = (): boolean => {
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
        
        // Do NOT auto-cleanup waiting TP on manual ENTRY delete
        
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
          isExternal: ((): boolean => {
            try {
              const idStr = String((o as any)?.C || (o as any)?.c || (o as any)?.clientOrderId || '')
              // Internal if matches any internal prefixes: entries (e_l_/e_stl_/e_stm_/e_m_), SL (x_sl_), TP (x_tp_* variants)
              const idIsInternal = idStr ? /^(e_l_|e_stl_|e_stm_|e_m_|x_sl_|x_tp_)/.test(idStr) : false
              if (idIsInternal) return false
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
        // If WS user-data not ready, return 200 with empty positions
        if (!isUserDataReady('positions')) {
          const response = { ok: true, positions: [] }
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(response))
          return
        }
        const raw = getPositionsInMemory()
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
    if (url.pathname === '/api/ws/health') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, connected: false, streams: 0, lastClosedAgeMsByKey: {}, altH1Subscribed: 0, altH1Ready: 0, includedSymbols: 0, lastBackfillCount: 0, drops_noH1: [] }))
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
        // Define nowIso early; used by multiple blocks below
        const nowIso = new Date().toISOString()
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
          // Profit Taker disabled when Top-Up Executor is active
          try {
            const { getTopUpExecutorStatus } = await import('../services/top-up-executor/trigger')
            const st = getTopUpExecutorStatus()
            if (!st.enabled) {
              try {
                const { detectPositionForProfitTaker } = await import('../services/profit-taker/trigger')
                detectPositionForProfitTaker(ordersRaw, positionsRaw)
              } catch {}
            }
          } catch {}
          try {
            const { scheduleTopUpWatchers } = await import('../services/top-up-watcher/utils')
            scheduleTopUpWatchers(positionsRaw)
          } catch {}
        } catch {}
        
        // Build marks map via REST for a SMALL prioritized set to avoid rate limits
        const marks: Record<string, number> = {}
        try {
          if (Number(__binanceBackoffUntilMs) > Date.now()) { throw new Error(`banned until ${__binanceBackoffUntilMs}`) }
          // 1) ENTRY orders (BUY internal entries, not reduceOnly/closePosition)
          const entrySymbols: string[] = []
          try {
            for (const o of (Array.isArray(ordersRaw) ? ordersRaw : [])) {
              try {
                const clientId = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
                // Internal entry prefixes cover LIMIT/STOP/MARKET variants
                const internalEntry = /^(e_l_|e_stl_|e_stm_|e_m_)/.test(clientId)
                const sideBuy = String(o?.side || '').toUpperCase() === 'BUY'
                const reduceOnly = Boolean(o?.reduceOnly)
                const closePosition = Boolean(o?.closePosition)
                const isEntry = internalEntry && sideBuy && !(reduceOnly || closePosition)
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

        // Delta-based cleanup: cancel internal ENTRY orders far from mark (Δ% >= 7)
        // and remove related internal exits (x_tp_*, x_sl_*), including waiting TP.
        // No additional REST reads are performed beyond what's already used above.
        try {
          const DELTA_THRESHOLD = 7
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

          // Identify symbols whose internal ENTRY (e_l_*) have Δ% >= 7 and no open position
          const qualifiedSymbols: Set<string> = new Set()
          try {
            for (const o of (Array.isArray(ordersRaw) ? ordersRaw : [])) {
              try {
                const side = String((o as any)?.side || '').toUpperCase()
                const type = String((o as any)?.type || '').toUpperCase()
                const reduceOnly = Boolean((o as any)?.reduceOnly)
                const closePosition = Boolean((o as any)?.closePosition)
                const clientId = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
                const isInternalEntry = /^(e_l_|e_stl_|e_stm_)/.test(clientId) && side === 'BUY' && (type === 'LIMIT' || type === 'STOP' || type === 'STOP_MARKET') && !reduceOnly && !closePosition
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
                  // SL se nikdy nemaže automaticky (delta-based cleanup se vztahuje pouze na TP a ENTRY)
                  if (isInternalEntry || isInternalTp) {
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
                  try { pushAudit({ ts: new Date().toISOString(), type: 'cancel', source: 'sweeper', symbol: c.symbol, orderId: c.orderId, reason: 'delta7_auto_cancel' }) } catch {}
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

            try { console.error('[SWEEPER_DELTA7]', { symbols: Array.from(qualifiedSymbols), cancelled: toCancel.length }) } catch {}
          }
        } catch {}

        // No-entry cleanup: remove internal exits if no ENTRY and no position (create-then-clean)
        try {
          // Require ordersReady (WS), positions may come from REST snapshot
          if (ordersReady) {
            const nowMs = Date.now()
            const graceMsRaw = Number((process as any)?.env?.NO_ENTRY_CLEANUP_GRACE_MS)
            const graceMs = (Number.isFinite(graceMsRaw) && graceMsRaw >= 0) ? graceMsRaw : 5000 // default 5s: remove orphan exits fast
            const hasInternalEntry = (o: any): boolean => {
              try {
                const clientId = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
                const side = String((o as any)?.side || '').toUpperCase()
                const type = String((o as any)?.type || '').toUpperCase()
                const reduceOnly = Boolean((o as any)?.reduceOnly)
                const closePosition = Boolean((o as any)?.closePosition)
                const isEntryType = (type === 'LIMIT' || type === 'STOP' || type === 'STOP_MARKET')
                return /^e_l_/.test(clientId) && side === 'BUY' && isEntryType && !reduceOnly && !closePosition
              } catch { return false }
            }
            const isInternalExit = (o: any): boolean => {
              try {
                const cid = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
                const sideUp = String((o as any)?.side || '').toUpperCase()
                const typeUp = String((o as any)?.type || '').toUpperCase()
                const reduceOnly = Boolean((o as any)?.reduceOnly)
                const closePosition = Boolean((o as any)?.closePosition)
                const isTp = /^x_tp_/.test(cid)
                const isSlInternal = /^x_sl_/.test(cid)
                const isSlExit = sideUp === 'SELL' && typeUp.includes('STOP') && (reduceOnly || closePosition || isSlInternal)
                return isTp || isSlInternal || isSlExit
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
        // AGE-BASED CLEANUP (UI PASS): platí na VŠECHNY objednávky, kromě SL/TP u otevřených pozic
        try {
          const ageMin = Number(__pendingCancelAgeMin)
          if (Number.isFinite(ageMin) && ageMin > 0) {
            const limitMs = ageMin * 60 * 1000
            const nowMs = Date.now()
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
            try {
              for (const o of (Array.isArray(ordersRaw) ? ordersRaw : [])) {
                try {
                  const sym = String((o as any)?.symbol || '')
                  const orderId = Number((o as any)?.orderId ?? (o as any)?.orderID ?? 0) || 0
                  if (!sym || !orderId) continue
                  const t = Number((o as any)?.time)
                  if (!Number.isFinite(t) || t <= 0) continue
                  const ageOk = (nowMs - t) > limitMs
                  if (!ageOk) continue
                  const typeUp = String((o as any)?.type || '').toUpperCase()
                  const sideUp = String((o as any)?.side || '').toUpperCase()
                  const reduceOnly = Boolean((o as any)?.reduceOnly)
                  const closePosition = Boolean((o as any)?.closePosition)
                  const cid = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
                  const hasPos = (Number(posSizeBySym.get(sym) || 0) > 0)
                  const isStopOrTp = typeUp.includes('STOP') || typeUp.includes('TAKE_PROFIT')
                  const isInternalExit = cid ? (/^x_tp_|^x_sl_/.test(cid)) : false
                  const isProtectedExit = hasPos && isStopOrTp && (reduceOnly || closePosition || isInternalExit)
                  if (isProtectedExit) continue
                  toCancel.push({ symbol: sym, orderId })
                } catch {}
              }
            } catch {}
            if (toCancel.length > 0) {
              const maxParallel = 4
              for (let i = 0; i < toCancel.length; i += maxParallel) {
                const batch = toCancel.slice(i, i + maxParallel)
                const settled = await Promise.allSettled(batch.map(async (c) => {
                  const r = await cancelOrder(c.symbol, c.orderId)
                  try { pushAudit({ ts: new Date().toISOString(), type: 'cancel', source: 'sweeper', symbol: c.symbol, orderId: c.orderId, reason: 'age_all_ui' }) } catch {}
                  return r
                }))
                void settled
              }
              try { console.error('[AGE_ALL_UI]', { cancelled: toCancel.length, limit_min: ageMin }) } catch {}
            }
          }
        } catch {}

        const waiting = getWaitingTpList()
        const last = __lastPlaceOrders ? { request: __lastPlaceOrders.request, result: __lastPlaceOrders.result } : null
        // Plan map for exits per symbol (used for safe SL auto-create)
        const plannedExitBySymbol: Record<string, { sl?: number|null; tp?: number|null }> = {}
        // Augment last_planned_by_symbol from last place_orders request if available (no extra calls)
        try {
          const reqOrders = (last?.request && Array.isArray((last as any).request?.orders)) ? (last as any).request.orders : []
          for (const o of reqOrders) {
            try {
              const sym = String((o as any)?.symbol || '')
              if (!sym) continue
              const amt = Number((o as any)?.amount)
              const lev = Number((o as any)?.leverage)
              const slPlanned = Number((o as any)?.sl)
              const tpPlanned = Number((o as any)?.tp)
              if (!__lastPlannedBySymbol[sym]) {
                __lastPlannedBySymbol[sym] = {
                  amount: Number.isFinite(amt) && amt > 0 ? amt : null,
                  leverage: Number.isFinite(lev) && lev > 0 ? Math.floor(lev) : null,
                  ts: nowIso
                }
              }
              plannedExitBySymbol[sym] = {
                sl: Number.isFinite(slPlanned) && slPlanned > 0 ? slPlanned : null,
                tp: Number.isFinite(tpPlanned) && tpPlanned > 0 ? tpPlanned : null
              }
            } catch {}
          }
        } catch {}
        
        // Merge planned exits with persistent per-symbol memory so symbols from older batches are covered too
        try {
          for (const k of Object.keys(__lastPlannedBySymbol)) {
            const sym = String(k)
            if (!sym) continue
            const mem = (__lastPlannedBySymbol as any)[sym] || {}
            const slMem = Number(mem.sl)
            const tpMem = Number(mem.tp)
            if (!plannedExitBySymbol[sym]) plannedExitBySymbol[sym] = { sl: null, tp: null }
            if (!Number.isFinite(Number((plannedExitBySymbol as any)[sym]?.sl)) && Number.isFinite(slMem) && slMem > 0) {
              plannedExitBySymbol[sym].sl = slMem
            }
            if (!Number.isFinite(Number((plannedExitBySymbol as any)[sym]?.tp)) && Number.isFinite(tpMem) && tpMem > 0) {
              plannedExitBySymbol[sym].tp = tpMem
            }
          }
        } catch {}

        // Ensure protective SL exists for ENTRY symbols when safe (mark > planned SL)
        try {
          const existingOrders = Array.isArray(ordersRaw) ? ordersRaw : []
          // Robustní detekce jakéhokoli existujícího SL (CP nebo RO), aby nedocházelo k duplicitám
          const hasAnySl = (sym: string): boolean => {
            try {
              return existingOrders.some((o: any) => {
                const sameSymbol = String(o?.symbol||'') === sym
                if (!sameSymbol) return false
                const sideUp = String(o?.side||'').toUpperCase()
                const typeUp = String(o?.type||'').toUpperCase()
                const isStop = typeUp.includes('STOP') && !typeUp.includes('TAKE_PROFIT')
                if (!isStop) return false
                const cp = Boolean((o as any)?.closePosition)
                const ro = Boolean((o as any)?.reduceOnly)
                const cid = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
                const isInternal = /^x_sl_/.test(cid)
                return sideUp === 'SELL' && (cp || ro || isInternal)
              })
            } catch { return false }
          }
          const entrySyms: string[] = []
          for (const o of existingOrders) {
            try {
              const cid = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
              const side = String((o as any)?.side||'').toUpperCase()
              const type = String((o as any)?.type||'').toUpperCase()
              const reduceOnly = Boolean((o as any)?.reduceOnly)
              const closePosition = Boolean((o as any)?.closePosition)
              const isInternalEntry = /^(e_l_|e_stl_|e_stm_)/.test(cid) && side==='BUY' && (type==='LIMIT'||type==='STOP'||type==='STOP_MARKET') && !reduceOnly && !closePosition
              if (isInternalEntry) entrySyms.push(String((o as any)?.symbol||''))
            } catch {}
          }
          const toCreate: Array<{ symbol: string; stopPrice: number }> = []
          for (const sym of Array.from(new Set(entrySyms)).filter(Boolean)) {
            try {
              if (hasAnySl(sym)) continue
              const plan = plannedExitBySymbol[sym]
              const slWanted = Number(plan?.sl)
              const mark = Number((marks as any)?.[sym])
              if (Number.isFinite(slWanted) && slWanted > 0 && Number.isFinite(mark) && mark > slWanted) {
                toCreate.push({ symbol: sym, stopPrice: slWanted })
              }
            } catch {}
          }
          if (toCreate.length > 0) {
            const api = getBinanceAPI()
            const maxParallel = 3
            for (let i = 0; i < toCreate.length; i += maxParallel) {
              const batch = toCreate.slice(i, i + maxParallel)
              await Promise.allSettled(batch.map(x => api.placeOrder({ symbol: x.symbol, side: 'SELL', type: 'STOP_MARKET', stopPrice: String(x.stopPrice), closePosition: true, workingType: 'MARK_PRICE', newClientOrderId: `x_sl_auto_${Math.random().toString(36).slice(2,7)}`, newOrderRespType: 'RESULT' } as any)))
            }
          }
        } catch {}

        // PREENTRY SL DEDUP: pokud je otevřen ENTRY a není pozice, povolit max 1 SL (ponechat nejnovější)
        try {
          if (ordersReady) {
            const nowMs = Date.now()
            const dedupGraceRaw = Number((process as any)?.env?.PREENTRY_SL_DEDUP_GRACE_MS)
            const dedupGraceMs = (Number.isFinite(dedupGraceRaw) && dedupGraceRaw >= 0) ? dedupGraceRaw : 5000

            // Připrav mapy entry a pozic (nezávisle na předchozím bloku)
            const entryBySym = new Set<string>()
            try {
              for (const o of (Array.isArray(ordersRaw) ? ordersRaw : [])) {
                try {
                  const cid = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
                  const side = String((o as any)?.side || '').toUpperCase()
                  const type = String((o as any)?.type || '').toUpperCase()
                  const reduceOnly = Boolean((o as any)?.reduceOnly)
                  const closePosition = Boolean((o as any)?.closePosition)
                  const isEntryType = (type === 'LIMIT' || type === 'STOP' || type === 'STOP_MARKET')
                  if (/^e_l_/.test(cid) && side === 'BUY' && isEntryType && !reduceOnly && !closePosition) {
                    entryBySym.add(String((o as any)?.symbol || ''))
                  }
                } catch {}
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

            // Seznam SL per symbol
            const slBySym = new Map<string, Array<{ orderId: number; createdAt: number; cp: boolean; ro: boolean; internal: boolean }>>()
            try {
              for (const o of (Array.isArray(ordersRaw) ? ordersRaw : [])) {
                try {
                  const sym = String((o as any)?.symbol || '')
                  const side = String((o as any)?.side || '').toUpperCase()
                  const type = String((o as any)?.type || '').toUpperCase()
                  if (!sym || side !== 'SELL' || !type.includes('STOP')) continue
                  const cp = Boolean((o as any)?.closePosition)
                  const ro = Boolean((o as any)?.reduceOnly)
                  const cid = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
                  const internal = /^x_sl_/.test(cid)
                  if (!(cp || ro || internal)) continue
                  const id = Number((o as any)?.orderId ?? (o as any)?.orderID ?? 0) || 0
                  if (!id) continue
                  const t = Number((o as any)?.time)
                  const createdAt = Number.isFinite(t) && t > 0 ? t : 0
                  const list = slBySym.get(sym) || []
                  list.push({ orderId: id, createdAt, cp, ro, internal })
                  slBySym.set(sym, list)
                } catch {}
              }
            } catch {}

            const toCancel: Array<{ symbol: string; orderId: number }> = []
            for (const [sym, slListRaw] of slBySym.entries()) {
              try {
                const hasEntry = entryBySym.has(sym)
                const hasPos = (Number(posSizeBySym.get(sym) || 0) > 0)
                if (!hasEntry || hasPos) continue
                const slList = (slListRaw || []).slice().sort((a, b) => (a.createdAt - b.createdAt))
                if (slList.length <= 1) continue
                // ponechat nejnovější, starší zrušit po grace
                const latest = slList[slList.length - 1]
                for (let i = 0; i < slList.length - 1; i += 1) {
                  const it = slList[i]
                  const ageOk = (nowMs - it.createdAt) > dedupGraceMs
                  if (ageOk && it.orderId !== latest.orderId) {
                    toCancel.push({ symbol: sym, orderId: it.orderId })
                  }
                }
              } catch {}
            }

            if (toCancel.length > 0) {
              const maxParallel = 4
              for (let i = 0; i < toCancel.length; i += maxParallel) {
                const batch = toCancel.slice(i, i + maxParallel)
                const settled = await Promise.allSettled(batch.map(async (c) => {
                  const r = await cancelOrder(c.symbol, c.orderId)
                  try { pushAudit({ ts: new Date().toISOString(), type: 'cancel', source: 'sweeper', symbol: c.symbol, orderId: c.orderId, reason: 'preentry_sl_dedup' }) } catch {}
                  return r
                }))
                void settled
              }
              try { console.error('[PREENTRY_SL_DEDUP]', { cancelled: toCancel.length, grace_ms: dedupGraceMs }) } catch {}
            }
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
          // Mark strategy-updater TP/SL (x_tp_*/x_sl_*) and internal entries (e_l_/e_stl_/e_stm_/e_m_) as internal or by known orderId set
          isExternal: ((): boolean => {
            try {
              const idStr = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
              // Consider known internal prefixes only; avoid dynamic requires in hot path
              return idStr ? !/^(e_l_|e_stl_|e_stm_|e_m_|x_sl_|x_tp_)/.test(idStr) : true
            } catch { return true }
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
              try {
                const id = String(o.clientOrderId || '')
                return id ? !/^(e_l_|e_stl_|e_stm_|e_m_|x_sl_|x_tp_)/.test(id) : true
              } catch { return true }
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
            return {
              symbol: String(p?.symbol || ''),
              positionSide: side || null,
              size: Number.isFinite(size) ? size : 0,
              entryPrice: Number.isFinite(entry) ? entry : null,
              markPrice: mark,
              unrealizedPnl: Number.isFinite(pnl) ? pnl : null,
              leverage: lev,
              updatedAt: Number.isFinite(upd) && upd > 0 ? new Date(upd).toISOString() : (Number.isFinite((p as any)?.updatedAt) ? new Date((p as any).updatedAt).toISOString() : null)
            }
          })
          .filter((p: any) => Number.isFinite(p.size) && p.size > 0)
        // Timestamps overview for UI (diagnostic and clarity)
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
        const universeStrategy = uniParam === 'gainers' ? 'gainers' : 'volume'
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
        const universeStrategy = uniParam === 'gainers' ? 'gainers' : 'volume'
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
        type K = { time: string; open: number; high: number; low: number; close: number }
        const toBars = (arr: any[], keep: number): K[] => {
          if (!Array.isArray(arr)) return []
          const base = arr.map((k: any) => ({
            t: Date.parse(String(k.openTime)),
            open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close), volume: Number(k.volume)
          })).filter(k => Number.isFinite(k.t) && Number.isFinite(k.open) && Number.isFinite(k.close))
          if (base.length === 0) return []
          // Determine step from last two bars (ms)
          const step = base.length >= 2 ? Math.max(1, base[base.length-1].t - base[base.length-2].t) : 60 * 1000
          const aligned: typeof base = [base[0]]
          for (let i = 1; i < base.length; i++) {
            const prev = aligned[aligned.length-1]
            const cur = base[i]
            let expected = prev.t + step
            while (cur.t - expected >= step) {
              // fill missing candle with previous close (flat bar, zero volume)
              aligned.push({ t: expected, open: prev.close, high: prev.close, low: prev.close, close: prev.close, volume: 0 })
              expected += step
            }
            aligned.push(cur)
          }
          const out = aligned.slice(-keep)
          return out.map(k => ({ time: toIsoNoMs(new Date(k.t).toISOString()), open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }))
        }
          const symbols = (snap.universe || []).map((u: any) => {
          const H1 = toBars(u.klines?.H1 || [], 24)
          const M15 = toBars(u.klines?.M15 || [], 96)
          const h1Close = H1.map(b => b.close)
          const m15Close = M15.map(b => b.close)
            const atr_h1_pct = atrPctFromBars(H1 as any)
            const atr_m15_pct = atrPctFromBars(M15 as any)
            const h1Last = h1Close.length ? h1Close[h1Close.length - 1] : null
            const m15Last = m15Close.length ? m15Close[m15Close.length - 1] : null
            const atr_h1_abs = (atr_h1_pct != null && h1Last != null) ? (atr_h1_pct / 100) * h1Last : null
            const atr_m15_abs = (atr_m15_pct != null && m15Last != null) ? (atr_m15_pct / 100) * m15Last : null
          const base: any = {
            symbol: u.symbol,
            price: Number(u.price ?? (H1.length ? H1[H1.length-1].close : null)),
            price_origin: (u as any)?.price_origin ?? 'last',
            price_ts: (u as any)?.price_ts ?? null,
            ohlcv: { h1: H1, m15: M15 },
            indicators: {
              atr_h1: atr_h1_abs,
              atr_m15: atr_m15_abs,
              atr_h1_pct,
              atr_m15_pct,
              ema_h1: { 20: emaShared(h1Close, 20), 50: emaShared(h1Close, 50), 200: emaShared(h1Close, 200) },
              ema_m15: { 20: emaShared(m15Close, 20), 50: emaShared(m15Close, 50), 200: emaShared(m15Close, 200) },
              rsi_h1: rsiShared(h1Close, 14),
              rsi_m15: rsiShared(m15Close, 14),
              vwap_today: u.vwap_today ?? u.vwap_daily ?? null
            },
            levels: {
              support: Array.isArray(u.support) ? u.support.slice(0,4) : [],
              resistance: Array.isArray(u.resistance) ? u.resistance.slice(0,4) : []
            },
            market: {
              spread_bps: u.spread_bps ?? null,
              liquidity_usd: (u.liquidity_usd ?? ((u.liquidity_usd_1pct ? (u.liquidity_usd_1pct.bids + u.liquidity_usd_1pct.asks) : (u.liquidity_usd_0_5pct ? (u.liquidity_usd_0_5pct.bids + u.liquidity_usd_0_5pct.asks) : 0)))) || null,
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
        const snap = await retry(() => buildMarketRawSnapshot({ universeStrategy: 'volume', desiredTopN: 1, includeSymbols: [symbol], fresh: true, allowPartial: true }))
        
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
          const base = arr.map((k: any) => ({
            t: Date.parse(String(k.openTime)),
            open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close), volume: Number(k.volume)
          })).filter(k => Number.isFinite(k.t) && Number.isFinite(k.open) && Number.isFinite(k.close))
          if (base.length === 0) return []
          const step = base.length >= 2 ? Math.max(1, base[base.length-1].t - base[base.length-2].t) : 60*1000
          const aligned: typeof base = [base[0]]
          for (let i=1;i<base.length;i++) {
            const prev = aligned[aligned.length-1]
            const cur = base[i]
            let expected = prev.t + step
            while (cur.t - expected >= step) {
              aligned.push({ t: expected, open: prev.close, high: prev.close, low: prev.close, close: prev.close, volume: 0 })
              expected += step
            }
            aligned.push(cur)
          }
          const out = aligned.slice(-keep)
          return out.map(k => ({ time: toIsoNoMs(new Date(k.t).toISOString()), open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }))
        }
        
          const h1 = toBars(targetItem.klines?.H1 || [], 24)
          const m15 = toBars(targetItem.klines?.M15 || [], 40)
        const h1Close = h1.map(b => b.close)
        const m15Close = m15.map(b => b.close)
          const asset = {
          symbol: targetItem.symbol,
            price: Number(targetItem.price ?? (h1.length ? h1[h1.length-1].close : null)),
            price_origin: (targetItem as any)?.price_origin ?? 'last',
            price_ts: (targetItem as any)?.price_ts ?? null,
          ohlcv: { h1, m15 },
          indicators: {
            atr_h1: (()=>{ const pct = atrPctFromBars(h1 as any); const last = h1Close.length ? h1Close[h1Close.length-1] : null; return (pct!=null && last!=null) ? (pct/100)*last : null })(),
            atr_m15: (()=>{ const pct = atrPctFromBars(m15 as any); const last = m15Close.length ? m15Close[m15Close.length-1] : null; return (pct!=null && last!=null) ? (pct/100)*last : null })(),
            atr_h1_pct: atrPctFromBars(h1 as any),
            atr_m15_pct: atrPctFromBars(m15 as any),
            ema_h1: { 20: emaShared(h1Close, 20), 50: emaShared(h1Close, 50), 200: emaShared(h1Close, 200) },
            ema_m15: { 20: emaShared(m15Close, 20), 50: emaShared(m15Close, 50), 200: emaShared(m15Close, 200) },
            rsi_h1: rsiShared(h1Close, 14),
            rsi_m15: rsiShared(m15Close, 14),
            vwap_today: targetItem.vwap_today ?? targetItem.vwap_daily ?? null
          },
          levels: {
            support: Array.isArray(targetItem.support) ? targetItem.support.slice(0,4) : [],
            resistance: Array.isArray(targetItem.resistance) ? targetItem.resistance.slice(0,4) : []
          },
          market: {
            spread_bps: targetItem.spread_bps ?? null,
            liquidity_usd: targetItem.liquidity_usd ?? null,
            oi_change_1h_pct: targetItem.oi_change_1h_pct ?? null,
            funding_8h_pct: targetItem.funding_8h_pct ?? null
          }
        }

        // Order book snapshot (REST-only): OBI, microprice, walls, slippage
        try {
          const { getDepth20, calcObi, findNearestWalls, estimateSlippageBps, calcDepthWithinPctUSD } = await import('./fetcher/binance')
          const depth = await getDepth20(symbol)
          if (depth && Array.isArray(depth.bids) && Array.isArray(depth.asks) && depth.bids.length && depth.asks.length) {
            const bestBidPx = Number(depth.bids[0]?.[0] || 0)
            const bestBidQty = Number(depth.bids[0]?.[1] || 0)
            const bestAskPx = Number(depth.asks[0]?.[0] || 0)
            const bestAskQty = Number(depth.asks[0]?.[1] || 0)
            const denom = bestBidQty + bestAskQty
            const microprice = (bestBidPx > 0 && bestAskPx > 0 && denom > 0)
              ? ((bestBidPx * bestAskQty) + (bestAskPx * bestBidQty)) / denom
              : null
            const obi5 = calcObi(depth as any, 5)
            const obi20 = calcObi(depth as any, 20)
            const walls = findNearestWalls(depth as any, microprice ?? undefined)
            // Heuristic tranche for slippage estimate: 1000 USD buy
            const estSlip = estimateSlippageBps(depth as any, 1000, 'BUY', microprice ?? undefined)
            // Depth within ±0.5% around mark/microprice for sanity check
            const depth05 = calcDepthWithinPctUSD(depth.bids as any, depth.asks as any, microprice ?? bestAskPx, 0.005)
            ;(asset as any).order_book = {
              microprice: Number.isFinite(microprice as any) ? microprice : null,
              obi5: (typeof obi5 === 'number' && Number.isFinite(obi5)) ? obi5 : null,
              obi20: (typeof obi20 === 'number' && Number.isFinite(obi20)) ? obi20 : null,
              nearestAskWallPrice: Number.isFinite(walls?.nearestAskWallPrice as any) ? walls?.nearestAskWallPrice : null,
              nearestAskWallDistBps: Number.isFinite(walls?.nearestAskWallDistBps as any) ? walls?.nearestAskWallDistBps : null,
              nearestBidWallPrice: Number.isFinite(walls?.nearestBidWallPrice as any) ? walls?.nearestBidWallPrice : null,
              nearestBidWallDistBps: Number.isFinite(walls?.nearestBidWallDistBps as any) ? walls?.nearestBidWallDistBps : null,
              estSlippageBps: (typeof estSlip === 'number' && Number.isFinite(estSlip)) ? estSlip : null,
              depth_usd_pm05: depth05 ? { bids: depth05.bids, asks: depth05.asks } : null
            }
          } else {
            ;(asset as any).order_book = null
          }
        } catch { (asset as any).order_book = null }
        
        const out = {
          timestamp: toIsoNoMs((snap as any)?.timestamp || new Date().toISOString()),
          exchange: 'Binance',
          market_type: 'perp',
          assets: [
            {
              ...asset,
              price_ts_utc: (asset as any)?.price_ts ?? null,
              snapshot_ts_utc: toIsoNoMs((snap as any)?.timestamp || new Date().toISOString()),
              is_last_candle_closed: (() => { try { const arr = (asset as any)?.ohlcv?.m15 || []; const last = arr[arr.length - 1]; return last ? (Date.parse(String(last.time)) <= Date.now()) : false } catch { return false } })()
            }
          ]
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
        const universeStrategy = uniParam === 'gainers' ? 'gainers' : 'volume'
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
          const h1Close = h1.map(b => b.close)
          const m15Close = m15.map(b => b.close)
          const atr_h1_pct = atrPctFromBars(h1 as any)
          const atr_m15_pct = atrPctFromBars(m15 as any)
          const h1Last = h1Close.length ? h1Close[h1Close.length - 1] : null
          const m15Last = m15Close.length ? m15Close[m15Close.length - 1] : null
          const atr_h1 = (atr_h1_pct != null && h1Last != null) ? (atr_h1_pct / 100) * h1Last : null
          const atr_m15 = (atr_m15_pct != null && m15Last != null) ? (atr_m15_pct / 100) * m15Last : null
          const rsi_h1 = rsiShared(h1Close, 14)
          const rsi_m15 = rsiShared(m15Close, 14)
          const ema_h1 = { 20: emaShared(h1Close, 20), 50: emaShared(h1Close, 50), 200: emaShared(h1Close, 200) }
          const ema_m15 = { 20: emaShared(m15Close, 20), 50: emaShared(m15Close, 50), 200: emaShared(m15Close, 200) }
          return {
            symbol: u.symbol,
            price: Number(u.price ?? (h1.length ? h1[h1.length-1].close : null)),
            ohlcv: { h1, m15 },
            indicators: { atr_h1, atr_m15, atr_h1_pct, atr_m15_pct, ema_h1, ema_m15, rsi_h1, rsi_m15, vwap_today: u.vwap_today ?? u.vwap_daily ?? null },
            levels: {
              support: Array.isArray(u.support) ? u.support.slice(0,4) : [],
              resistance: Array.isArray(u.resistance) ? u.resistance.slice(0,4) : []
            },
            market: {
              spread_bps: u.spread_bps ?? null,
              liquidity_usd: (u.liquidity_usd ?? ((u.liquidity_usd_1pct ? (u.liquidity_usd_1pct.bids + u.liquidity_usd_1pct.asks) : (u.liquidity_usd_0_5pct ? (u.liquidity_usd_0_5pct.bids + u.liquidity_usd_0_5pct.asks) : 0)))) || null,
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
                const h1Close2 = h1.map(b => b.close)
                const m15Close2 = m15.map(b => b.close)
                const generatedAsset = {
                  symbol: expandedAsset.symbol,
                  price: Number(expandedAsset.price ?? (h1.length ? h1[h1.length-1].close : null)),
                  ohlcv: { h1, m15 },
                  indicators: {
                    atr_h1: atrPctFromBars(h1 as any),
                    atr_m15: atrPctFromBars(m15 as any),
                    ema_h1: { 20: emaShared(h1Close2, 20), 50: emaShared(h1Close2, 50), 200: emaShared(h1Close2, 200) },
                    ema_m15: { 20: emaShared(m15Close2, 20), 50: emaShared(m15Close2, 50), 200: emaShared(m15Close2, 200) },
                    rsi_h1: rsiShared(h1Close2, 14),
                    rsi_m15: rsiShared(m15Close2, 14),
                    vwap_today: expandedAsset.vwap_today ?? expandedAsset.vwap_daily ?? null
                  },
                  levels: {
                    support: Array.isArray(expandedAsset.support) ? expandedAsset.support.slice(0,4) : [],
                    resistance: Array.isArray(expandedAsset.resistance) ? expandedAsset.resistance.slice(0,4) : []
                  },
                  market: {
                    spread_bps: expandedAsset.spread_bps ?? null,
                    liquidity_usd: expandedAsset.liquidity_usd ?? null,
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
        const universeStrategy = uniParam === 'gainers' ? 'gainers' : 'volume'
        const topN = Number(url.searchParams.get('topN') || '')
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
          const m15 = Array.isArray(u.klines?.M15) ? u.klines.M15 : []
          const lastM15CloseIso = (() => { try { const last = m15[m15.length - 1]; return last ? String(last.closeTime) : null } catch { return null } })()
          const isClosed = (() => { try { return lastM15CloseIso ? (Date.parse(lastM15CloseIso) <= Date.now()) : false } catch { return false } })()
          return {
            symbol: u.symbol,
            price: Number(u.price ?? lastClose(h1) ?? null),
            price_ts_utc: (u as any)?.price_ts ?? null,
            is_last_candle_closed: isClosed,
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
        
        if (universeStrategy === 'gainers') {
          // Pro gainers pouze actual gainers z universe, bez vynuceného BTC/ETH
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

        const out = {
          policy: {
            max_hold_minutes: (snap as any)?.policy?.max_hold_minutes ?? null,
            risk_per_trade_pct: (snap as any)?.policy?.risk_per_trade_pct_flat ?? null,
            max_leverage: (snap as any)?.policy?.max_leverage ?? null
          },
          exchange: (snap as any)?.exchange || 'Binance',
          market_type: (snap as any)?.market_type || 'perp',
          regime,
          timestamp: toIsoNoMs((snap as any)?.timestamp || new Date().toISOString()),
          snapshot_ts_utc: toIsoNoMs((snap as any)?.timestamp || new Date().toISOString()),
          coins: dedupCoins
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
        // For universe incomplete we return 200 with partial: true
        const isUniverseIncomplete = /universe_incomplete|universe\s*incomplete/i.test(String(e?.message||'')) || String((e as any)?.stage||'') === 'universe_incomplete'
        res.statusCode = isUniverseIncomplete ? 200 : (abortLike ? 503 : 500)
        if (abortLike) res.setHeader('Retry-After', '1')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(isUniverseIncomplete ? { ok: true, partial: true, coins: [], policy: { max_hold_minutes: null, risk_per_trade_pct: null, max_leverage: null }, exchange: 'Binance', market_type: 'perp', regime: {}, timestamp: new Date().toISOString() } : { error: abortLike ? 'UNAVAILABLE_TEMPORARILY' : (e?.message || 'unknown') }))
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
          // risk_label is optional string; if present, coerce to short allowed set
          if ((order as any).risk_label != null) {
            const r = String((order as any).risk_label || '').toLowerCase()
            const ok = ['nízké','střední','vysoké','nizke','stredni','vysoke','low','medium','high']
            if (!ok.includes(r)) {
              // normalize unknowns to passthrough string
              ;(order as any).risk_label = String((order as any).risk_label)
            }
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
        // Authoritative cooldown guard: remove symbols currently in cooldown
        try {
          const before = parsed.orders.length
          parsed.orders = parsed.orders.filter((o:any) => !isCooldownActive(String(o?.symbol||'')))
          const removed = before - parsed.orders.length
          if (removed > 0) {
            try { console.warn('[COOLDOWN_BLOCKED_ENTRIES]', { removed }) } catch {}
          }
        } catch {}
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
                // Deduplicate against currently open exits: avoid sending duplicates
                let open: any[] = []
                try { open = await api.getOpenOrders(x.symbol) } catch {}
                const hasSameSl = (price: number): boolean => {
                  return (Array.isArray(open) ? open : []).some((o: any) => {
                    try {
                      const isSl = String(o?.type || '').toUpperCase() === 'STOP_MARKET'
                      const cp = Boolean(o?.closePosition)
                      const sp = Number(o?.stopPrice)
                      return isSl && cp && Number.isFinite(sp) && Math.abs(sp - price) < 1e-12
                    } catch { return false }
                  })
                }
                const hasSameTpMkt = (price: number): boolean => {
                  return (Array.isArray(open) ? open : []).some((o: any) => {
                    try {
                      const isTpM = String(o?.type || '').toUpperCase() === 'TAKE_PROFIT_MARKET'
                      const cp = Boolean(o?.closePosition)
                      const sp = Number(o?.stopPrice)
                      return isTpM && cp && Number.isFinite(sp) && Math.abs(sp - price) < 1e-12
                    } catch { return false }
                  })
                }

                if (Number.isFinite(x.sl) && !(hasSameSl(Number(x.sl)))) {
                  const slParams: any = isHedge
                    ? { symbol: x.symbol, side: 'SELL', type: 'STOP_MARKET', stopPrice: String(x.sl), closePosition: true, workingType, positionSide: 'LONG', newClientOrderId: makeId('x_sl'), newOrderRespType: 'RESULT' }
                    : { symbol: x.symbol, side: 'SELL', type: 'STOP_MARKET', stopPrice: String(x.sl), closePosition: true, workingType, newClientOrderId: makeId('x_sl'), newOrderRespType: 'RESULT' }
                  await api.placeOrder(slParams)
                }
                if (Number.isFinite(x.tp) && !(hasSameTpMkt(Number(x.tp)))) {
                  const tpParams: any = isHedge
                    ? { symbol: x.symbol, side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: String(x.tp), closePosition: true, workingType, positionSide: 'LONG', newClientOrderId: makeId('x_tp_tm'), newOrderRespType: 'RESULT' }
                    : { symbol: x.symbol, side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: String(x.tp), closePosition: true, workingType, newClientOrderId: makeId('x_tp_tm'), newOrderRespType: 'RESULT' }
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

        // Immediately invalidate open orders cache and prime next /api/orders_console with REST snapshot for affected symbols
        try {
          const symbols = Array.isArray(parsed?.orders) ? parsed.orders.map((o:any)=>String(o?.symbol||'')).filter(Boolean) : []
          if (symbols.length > 0) {
            try { ttlSet(makeKey('/api/open_orders'), null as any, 1) } catch {}
            // Fire-and-forget: warm the in-memory ws snapshot by fetching REST openOrders once
            const api = getBinanceAPI()
            Promise.allSettled(Array.from(new Set(symbols)).map(sym => api.getOpenOrders(sym))).catch(()=>{})
          }
        } catch {}
        
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
              const slPlanned = Number((o as any)?.sl)
              const tpPlanned = Number((o as any)?.tp)
              __lastPlannedBySymbol[sym] = {
                amount: Number.isFinite(amount) && amount > 0 ? amount : null,
                leverage: Number.isFinite(leverage) && leverage > 0 ? Math.floor(leverage) : null,
                sl: Number.isFinite(slPlanned) && slPlanned > 0 ? slPlanned : null,
                tp: Number.isFinite(tpPlanned) && tpPlanned > 0 ? tpPlanned : null,
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
        const sideRaw = String(input?.side || 'BUY').toUpperCase()
        const qtyRaw = input?.quantity
        if (!symbolRaw || !qtyRaw) { res.statusCode = 400; res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ok:false, error:'missing_symbol_or_quantity' })); return }
        const symbol = symbolRaw.toUpperCase().endsWith('USDT') ? symbolRaw.toUpperCase() : `${symbolRaw.toUpperCase()}USDT`
        const side = sideRaw === 'SELL' ? 'SELL' : 'BUY'
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
            ? { symbol, side: 'SELL', type: 'STOP_MARKET', stopPrice: String(slRounded), closePosition: true, workingType, positionSide: 'LONG', newOrderRespType: 'RESULT' }
            : { symbol, side: 'SELL', type: 'STOP_MARKET', stopPrice: String(slRounded), closePosition: true, workingType, newOrderRespType: 'RESULT' }
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
            const baseLimit = { symbol, side: 'SELL', type: 'TAKE_PROFIT', price: String(tpRounded), stopPrice: String(tpRounded), timeInForce: 'GTC', quantity: qtyStr, workingType, newOrderRespType: 'RESULT' }
            const tpParams: any = isHedgeMode ? { ...baseLimit, positionSide: 'LONG' } : baseLimit
            if (forceTpLimitRO) tpParams.reduceOnly = true
            out.tp = await api.placeOrder(tpParams)
          } else {
            // TP MARKET: v hedge módu musí být uveden positionSide, jinak -4061
            const tpParams: any = isHedgeMode
              ? { symbol, side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: String(tpRounded), closePosition: true, workingType, positionSide: 'LONG', newOrderRespType: 'RESULT' }
              : { symbol, side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: String(tpRounded), closePosition: true, workingType, newOrderRespType: 'RESULT' }
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
    // Admin: trigger immediate emergency SL for a symbol if missing
    if (url.pathname === '/api/admin/emergency_sl' && req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        if (!hasRealBinanceKeysGlobal()) { res.statusCode = 403; res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ok:false, error:'missing_binance_keys' })); return }
        const chunks: Buffer[] = []
        for await (const ch of req) chunks.push(ch as Buffer)
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        const input = bodyStr ? JSON.parse(bodyStr) : null
        const symbolRaw = String(input?.symbol || '')
        const pctRaw = Number(input?.pct)
        if (!symbolRaw) { res.statusCode = 400; res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ok:false, error:'missing_symbol' })); return }
        const normalizeSymbol = (s: string): string => {
          let v = String(s || '').trim().toUpperCase()
          if (!v) return ''
          if (v.includes('/')) v = v.replace('/', '')
          if (!v.endsWith('USDT')) v = `${v}USDT`
          return v
        }
        const symbol = normalizeSymbol(symbolRaw)
        const emergencyPct = (Number.isFinite(pctRaw) && pctRaw > 0 && pctRaw < 0.5) ? pctRaw : (Number((process as any)?.env?.EMERGENCY_SL_PCT) || 0.05)

        const api = getBinanceAPI() as any
        let isHedgeMode = false
        try { isHedgeMode = Boolean(await api.getHedgeMode()) } catch {}
        const workingType = String((tradingCfg as any)?.EXIT_WORKING_TYPE || 'MARK_PRICE') as 'MARK_PRICE' | 'CONTRACT_PRICE'

        const [positions, orders] = await Promise.all([
          api.getPositions(),
          api.getOpenOrders(symbol)
        ])
        const pos = (Array.isArray(positions) ? positions : []).find((p: any) => String(p?.symbol) === symbol)
        const amtRaw = Number((pos as any)?.positionAmt ?? (pos as any)?.size ?? 0)
        if (!pos || !Number.isFinite(amtRaw) || Math.abs(amtRaw) <= 0) {
          res.statusCode = 422
          res.setHeader('content-type','application/json')
          res.end(JSON.stringify({ ok:false, error:'position_not_found' }))
          return
        }
        const exitSide = amtRaw > 0 ? 'SELL' : 'BUY'
        const slOrders = (Array.isArray(orders) ? orders : []).filter((o:any)=> String(o?.symbol)===symbol && String(o?.side||'').toUpperCase()===exitSide && String(o?.type||'').toUpperCase().includes('STOP'))
        if (slOrders.length > 0) {
          res.statusCode = 200
          res.setHeader('content-type','application/json')
          res.end(JSON.stringify({ ok:true, created:false, reason:'already_has_sl' }))
          return
        }

        const quantize = (value: number, step: number): number => {
          const s = String(step)
          const idx = s.indexOf('.')
          const decimals = idx >= 0 ? (s.length - idx - 1) : 0
          const factor = Math.pow(10, decimals)
          return Math.round(value * factor) / factor
        }
        const entryPriceNum = Number((pos as any)?.entryPrice)
        if (!Number.isFinite(entryPriceNum) || entryPriceNum <= 0) { res.statusCode = 500; res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ok:false, error:'bad_entry_price' })); return }
        let emergencyPx = amtRaw > 0 ? entryPriceNum * (1 - emergencyPct) : entryPriceNum * (1 + emergencyPct)
        try {
          const info = await api.getSymbolInfo(symbol)
          const pf = (info?.filters || []).find((f: any) => f?.filterType === 'PRICE_FILTER')
          const tickSize = pf ? Number(pf.tickSize) : null
          if (Number.isFinite(tickSize as any) && (tickSize as number) > 0) emergencyPx = quantize(emergencyPx, tickSize as number)
        } catch {}
        const base: any = { symbol, side: exitSide, type: 'STOP_MARKET', stopPrice: String(emergencyPx), closePosition: true, workingType, newClientOrderId: makeId('x_sl_em'), newOrderRespType: 'RESULT' }
        if (isHedgeMode) base.positionSide = amtRaw > 0 ? 'LONG' : 'SHORT'
        const r = await api.placeOrder(base)
        res.statusCode = 200
        res.setHeader('content-type','application/json')
        res.end(JSON.stringify({ ok:true, created:true, orderId: r?.orderId ?? null, stopPrice: emergencyPx }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type','application/json')
        res.end(JSON.stringify({ ok:false, error: e?.message || 'unknown' }))
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
        const model = (deciderCfg as any)?.m3?.model || 'gpt-5'
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
        // Compute features from compact for mock mode
        const features = (() => {
          try {
            // Reconstruct basic features structure needed for decideFromFeatures
            return {
              breadth: { pct_above_EMA50_H1: compact.breadth?.pct_above_EMA50_H1 || 0 },
              btc: {
                atr_pct_H1: compact.btc?.H1?.atr_pct || 0,
                flags: {
                  H1_above_VWAP: (compact.btc?.H1?.vwap_rel || 0) > 1,
                  H4_ema50_gt_200: compact.btc?.H4?.ema50_gt_200 || false
                }
              },
              eth: {
                atr_pct_H1: compact.eth?.H1?.atr_pct || 0,
                flags: {
                  H1_above_VWAP: (compact.eth?.H1?.vwap_rel || 0) > 1,
                  H4_ema50_gt_200: compact.eth?.H4?.ema50_gt_200 || false
                }
              }
            }
          } catch {
            // Fallback structure
            return {
              breadth: { pct_above_EMA50_H1: 0 },
              btc: { atr_pct_H1: 0, flags: { H1_above_VWAP: false, H4_ema50_gt_200: false } },
              eth: { atr_pct_H1: 0, flags: { H1_above_VWAP: false, H4_ema50_gt_200: false } }
            }
          }
        })()
        const decision = await decideMarketStrict({ mode: mode as any, compact, features: features as any, openaiKey: process.env.OPENAI_API_KEY || '', timeoutMs: (deciderCfg as any)?.timeoutMs || 8000 })
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
        console.error('[DECIDE_API_ERROR]', { 
          error: e?.message || e?.toString(), 
          name: e?.name,
          code: e?.code,
          stack: e?.stack?.split('\n').slice(0, 3).join('\n') 
        })
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.code || e?.name || 'internal_error', message: e?.message }))
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

        // Enforce Futures-only symbols post-processing (no behavior change elsewhere)
        try {
          if (hsRes && hsRes.ok && Array.isArray((hsRes as any)?.data?.hot_picks)) {
            // Robust Futures-only filter using public exchangeInfo
            const futuresSymbols: Set<string> = new Set()
            try {
              const { body, statusCode } = await undiciRequest('https://fapi.binance.com/fapi/v1/exchangeInfo', { method: 'GET' })
              if (statusCode && statusCode >= 200 && statusCode < 300) {
                const text = await body.text()
                const json = JSON.parse(text)
                const arr = Array.isArray(json?.symbols) ? json.symbols : []
                for (const s of arr) {
                  const sym = String(s?.symbol || '')
                  // Keep only USDT perpetual futures in TRADING status
                  const ok = sym.endsWith('USDT') && String(s?.status) === 'TRADING' && (String(s?.contractType || '') === '' || String(s?.contractType) === 'PERPETUAL')
                  if (ok) futuresSymbols.add(sym)
                }
              }
            } catch {}
            if (futuresSymbols.size > 0) {
              ;(hsRes as any).data.hot_picks = (hsRes as any).data.hot_picks.filter((p: any) => futuresSymbols.has(String(p?.symbol || '').toUpperCase()))
            }
          }
        } catch {}

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
        
        // Accept asset_data coming from /api/intraday_any exactly as produced there
        if (!input || typeof input !== 'object' || typeof input.symbol !== 'string' || typeof input.asset_data !== 'object') {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, code: 'bad_request', latencyMs: 0, data: null }))
          return
        }

        // Normalize symbol to uppercase USDT form
        try {
          const normalizeSymbol = (s: string): string => {
            let v = String(s||'').trim().toUpperCase()
            if (!v) return ''
            if (v.includes('/')) v = v.replace('/', '')
            if (!v.endsWith('USDT')) v = `${v}USDT`
            return v
          }
          input.symbol = normalizeSymbol(input.symbol)
        } catch {}

        // Minimal asset_data validation: require price or OHLCV arrays
        const hasPrice = Number.isFinite(Number((input.asset_data as any)?.price))
        const hasOhlcv = !!(input.asset_data && input.asset_data.ohlcv)
        if (!hasPrice && !hasOhlcv) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, code: 'bad_asset_data', latencyMs: 0, data: null }))
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
              // Validate style and map tp_levels
              const style = String(chosen?.style) === 'aggressive' ? 'aggressive' : 'conservative'
              const tps = Array.isArray(chosen?.tp_levels) ? chosen.tp_levels.filter((l:any)=>l && (l.tag==='tp1'||l.tag==='tp2'||l.tag==='tp3')).map((l:any)=>({ tag: l.tag, price: Number(l.price), allocation_pct: Number(l.allocation_pct) })) : []
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

    // Entry Updater status (UX aligned with Strategy Updater)
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

    // Entry Updater audit endpoints (read-only)
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

    // Strategy Updater debug: return last saved input for a symbol (read-only)
    if (url.pathname === '/api/debug/strategy_updater_last' && req.method === 'GET') {
      try {
        const sym = String(url.searchParams.get('symbol') || '')
        if (!sym) { res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: false, error: 'missing_symbol' })); return }
        const fs = await import('node:fs')
        const path = await import('node:path')
        const file = path.resolve(process.cwd(), 'runtime/su_debug', `${sym}.json`)
        if (!fs.existsSync(file)) { res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: false, message: 'none' })); return }
        const text = fs.readFileSync(file, 'utf8')
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(text)
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
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
          
          const su = await ensureStrategyUpdaterLoop(enabledBool)
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ enabled: enabledBool, success: true, workflow: su }))
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
    // Temporal: start StrategyUpdater workflow (runOnce or loop)
    if (url.pathname === '/api/temporal/su/start' && req.method === 'POST') {
      try {
        const address = process.env.TEMPORAL_ADDRESS
        const taskQueue = process.env.TASK_QUEUE
        if (!address) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'TEMPORAL_ADDRESS missing' }))
          return
        }
        if (!taskQueue) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'TASK_QUEUE missing' }))
          return
        }

        const body = await new Promise<string>((resolve) => {
          let data = ''
          req.on('data', chunk => data += chunk)
          req.on('end', () => resolve(data))
        })
        const payload = (() => { try { return JSON.parse(body || '{}') } catch { return {} } })()
        const runOnce = Boolean(payload?.runOnce !== false)

        const { Connection, Client } = await import('@temporalio/client')
        const connection = await Connection.connect({ address })
        const client = new Client({ connection })
        const wfId = `su_${Date.now()}`
        const handle = await client.workflow.start('StrategyUpdaterWorkflow', {
          taskQueue,
          workflowId: wfId,
          args: [{ runOnce, openaiQueue: String(process.env.TASK_QUEUE_OPENAI || '') }],
          workflowIdReusePolicy: 'WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE'
        })
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, workflowId: handle.workflowId }))
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }))
      }
      return
    }

    // Temporal: start TradeLifecycle workflow (PoC)
    if (url.pathname === '/api/temporal/trade/start' && req.method === 'POST') {
      try {
        const address = process.env.TEMPORAL_ADDRESS
        const taskQueue = process.env.TASK_QUEUE
        if (!address) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'TEMPORAL_ADDRESS missing' }))
          return
        }
        if (!taskQueue) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'TASK_QUEUE missing' }))
          return
        }

        const body = await new Promise<string>((resolve) => {
          let data = ''
          req.on('data', chunk => data += chunk)
          req.on('end', () => resolve(data))
        })
        const p = JSON.parse(body || '{}')
        const symbol = String(p?.symbol || '')
        const side = String(p?.side || '')
        const notionalUsd = Number(p?.notionalUsd)
        const leverage = Number(p?.leverage)
        const entryType = String(p?.entryType || '')
        const entryPrice = p?.entryPrice != null ? Number(p.entryPrice) : undefined
        const sl = Number(p?.sl)
        const tp = Number(p?.tp)
        if (!symbol || (side !== 'LONG' && side !== 'SHORT') || !Number.isFinite(notionalUsd) || !Number.isFinite(leverage) || !entryType || !Number.isFinite(sl) || !Number.isFinite(tp)) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'bad_params' }))
          return
        }
        const { Connection, Client } = await import('@temporalio/client')
        const connection = await Connection.connect({ address })
        const client = new Client({ connection })
        const wfId = `trade_${symbol}_${Date.now()}`
        const handle = await client.workflow.start('TradeLifecycleWorkflow', {
          taskQueue,
          workflowId: wfId,
          args: [{ symbol, side, notionalUsd, leverage, entryType, entryPrice, sl, tp, workingType: 'MARK_PRICE', binanceQueue: String(process.env.TASK_QUEUE_BINANCE || '') }],
          workflowIdReusePolicy: 'WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE'
        })
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, workflowId: handle.workflowId }))
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }))
      }
      return
    }

    // Temporal: start Entry Assistant workflow (per-coin entry orchestration)
    if (url.pathname === '/api/temporal/entry/start' && req.method === 'POST') {
      try {
        const body = await new Promise<string>((resolve) => {
          let data = ''
          req.on('data', chunk => data += chunk)
          req.on('end', () => resolve(data))
        })
        const payload = body ? JSON.parse(body) : {}
        const address = process.env.TEMPORAL_ADDRESS
        const taskQueue = process.env.TASK_QUEUE
        if (!address) throw new Error('TEMPORAL_ADDRESS missing')
        if (!taskQueue) throw new Error('TASK_QUEUE missing')

        const { Connection, Client } = await import('@temporalio/client')
        const connection = await Connection.connect({ address })
        const client = new Client({ connection })
        const wfId = `entry_${String(payload?.symbol || 'UNK')}_${Date.now()}`
        const handle = await client.workflow.start('EntryAssistantWorkflow', {
          taskQueue,
          workflowId: wfId,
          args: [{ ...payload, openaiQueue: String(process.env.TASK_QUEUE_OPENAI || ''), binanceQueue: String(process.env.TASK_QUEUE_BINANCE || '') }],
          workflowIdReusePolicy: 'WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE'
        })
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, workflowId: handle.workflowId }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
      }
      return
    }

    // Temporal: start multiple Entry Assistant workflows in batch
    if (url.pathname === '/api/temporal/entry/start_batch' && req.method === 'POST') {
      try {
        const address = process.env.TEMPORAL_ADDRESS
        const taskQueue = process.env.TASK_QUEUE
        if (!address) throw new Error('TEMPORAL_ADDRESS missing')
        if (!taskQueue) throw new Error('TASK_QUEUE missing')

        const body = await new Promise<string>((resolve) => {
          let data = ''
          req.on('data', chunk => data += chunk)
          req.on('end', () => resolve(data))
        })
        const payload = (() => { try { return JSON.parse(body || '[]') } catch { return [] } })()
        const list = Array.isArray(payload) ? payload : []
        if (list.length === 0) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'empty_list' }))
          return
        }

        const { Connection, Client } = await import('@temporalio/client')
        const connection = await Connection.connect({ address })
        const client = new Client({ connection })

        const results: Array<{ workflowId: string; ok: boolean; error?: string }> = []
        for (const item of list) {
          try {
            const sym = String(item?.symbol || 'UNK')
            const wfId = `entry_${sym}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`
            const handle = await client.workflow.start('EntryAssistantWorkflow', {
              taskQueue,
              workflowId: wfId,
              args: [{ ...item, openaiQueue: String(process.env.TASK_QUEUE_OPENAI || ''), binanceQueue: String(process.env.TASK_QUEUE_BINANCE || '') }],
              workflowIdReusePolicy: 'WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE'
            })
            results.push({ workflowId: handle.workflowId, ok: true })
          } catch (e: any) {
            results.push({ workflowId: '', ok: false, error: String(e?.message || e) })
          }
        }

        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, results }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
      }
      return
    }

    // Temporal: query Entry Assistant workflow status (strict, no fallbacks)
    if (url.pathname === '/api/temporal/entry/status' && req.method === 'GET') {
      try {
        const address = process.env.TEMPORAL_ADDRESS
        if (!address) throw new Error('TEMPORAL_ADDRESS missing')
        const id = url.searchParams.get('id') || ''
        if (!id) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'id missing' }))
          return
        }
        const { Connection, Client } = await import('@temporalio/client')
        const connection = await Connection.connect({ address })
        const client = new Client({ connection })
        const handle = client.workflow.getHandle(id)
        const status = await handle.query('status')
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, workflowId: id, status }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
      }
      return
    }

    // Temporal: list active Entry Assistant workflows (running)
    if (url.pathname === '/api/temporal/entry/active' && req.method === 'GET') {
      try {
        const address = process.env.TEMPORAL_ADDRESS
        if (!address) throw new Error('TEMPORAL_ADDRESS missing')
        const namespace = process.env.TEMPORAL_NAMESPACE || 'default'
        const { Connection, Client } = await import('@temporalio/client')
        const connection = await Connection.connect({ address })
        const client = new Client({ connection })
        const svc = client.workflowService
        const listResp = await (svc as any).listWorkflowExecutions({
          namespace,
          pageSize: 50,
          query: 'WorkflowType = "EntryAssistantWorkflow" and ExecutionStatus = "Running"'
        })
        const execs = (listResp?.executions ?? []) as any[]
        const list = execs.map((e: any) => ({ id: e?.execution?.workflowId || null }))
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, items: list }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: String(e?.message || e), items: [] }))
      }
      return
    }

    // Temporal: send cancel signal to Entry Assistant workflow
    if (url.pathname === '/api/temporal/entry/cancel' && req.method === 'POST') {
      try {
        const address = process.env.TEMPORAL_ADDRESS
        if (!address) throw new Error('TEMPORAL_ADDRESS missing')
        const body = await new Promise<string>((resolve) => {
          let data = ''
          req.on('data', chunk => data += chunk)
          req.on('end', () => resolve(data))
        })
        const payload = (() => { try { return JSON.parse(body || '{}') } catch { return {} } })()
        const id = String(payload?.id || '')
        if (!id) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'id missing' }))
          return
        }
        const { Connection, Client } = await import('@temporalio/client')
        const connection = await Connection.connect({ address })
        const client = new Client({ connection })
        const handle = client.workflow.getHandle(id)
        await handle.signal('cancel')
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, workflowId: id }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
      }
      return
    }

    // Temporal: start/stop/status Auto Copy workflow
    if (url.pathname === '/api/temporal/auto_copy/start' && req.method === 'POST') {
      try {
        const address = process.env.TEMPORAL_ADDRESS
        const taskQueue = process.env.TASK_QUEUE
        if (!address) throw new Error('TEMPORAL_ADDRESS missing')
        if (!taskQueue) throw new Error('TASK_QUEUE missing')
        const body = await new Promise<string>((resolve) => { let d=''; req.on('data', c=>d+=c); req.on('end',()=>resolve(d)) })
        const payload = (() => { try { return JSON.parse(body || '{}') } catch { return {} } })()
        const items = Array.isArray(payload?.items) ? payload.items : []
        const intervalMinutes = Math.max(1, Number(payload?.intervalMinutes || 5))
        const maxRounds = payload?.maxRounds == null ? null : Math.max(1, Number(payload?.maxRounds))
        if (items.length === 0) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'items missing' }))
          return
        }
        const { Connection, Client } = await import('@temporalio/client')
        const connection = await Connection.connect({ address })
        const client = new Client({ connection })
        const wfId = String(payload?.workflowId || `auto_copy_${Date.now()}`)
        const handle = await client.workflow.start('AutoCopyWorkflow', {
          taskQueue,
          workflowId: wfId,
          args: [{ items, intervalMinutes, maxRounds, openaiQueue: String(process.env.TASK_QUEUE_OPENAI || ''), binanceQueue: String(process.env.TASK_QUEUE_BINANCE || '') }],
          workflowIdReusePolicy: 'WORKFLOW_ID_REUSE_POLICY_TERMINATE_IF_RUNNING'
        })
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, workflowId: handle.workflowId }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
      }
      return
    }
    // Temporal: find the latest running Auto Copy workflow (best effort)
    if (url.pathname === '/api/temporal/auto_copy/active' && req.method === 'GET') {
      try {
        const address = process.env.TEMPORAL_ADDRESS
        if (!address) throw new Error('TEMPORAL_ADDRESS missing')
        const namespace = process.env.TEMPORAL_NAMESPACE || 'default'
        const { Connection, Client } = await import('@temporalio/client')
        const connection = await Connection.connect({ address })
        const client = new Client({ connection })
        const svc = client.workflowService
        const listResp = await (svc as any).listWorkflowExecutions({
          namespace,
          pageSize: 20,
          query: 'WorkflowType = "AutoCopyWorkflow" and ExecutionStatus = "Running"'
        })
        const execs = (listResp?.executions ?? []) as any[]
        // Sort by startTime descending to get the most recent workflow
        const sorted = execs.sort((a: any, b: any) => {
          const aTime = a?.startTime?.seconds || 0
          const bTime = b?.startTime?.seconds || 0
          return bTime - aTime // Descending (newest first)
        })
        const latest = sorted.length ? sorted[0] : null
        const wid = latest?.execution?.workflowId || null
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, workflowId: wid }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
      }
      return
    }

    if (url.pathname === '/api/temporal/auto_copy/status' && req.method === 'GET') {
      try {
        const address = process.env.TEMPORAL_ADDRESS
        if (!address) throw new Error('TEMPORAL_ADDRESS missing')
        const id = url.searchParams.get('id') || ''
        if (!id) { res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: false, error: 'id missing' })); return }
        const { Connection, Client } = await import('@temporalio/client')
        const connection = await Connection.connect({ address })
        const client = new Client({ connection })
        const h = client.workflow.getHandle(id)
        const status = await h.query('status')
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, workflowId: id, status }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }))
      }
      return
    }

    if (url.pathname === '/api/temporal/auto_copy/command' && req.method === 'POST') {
      try {
        const address = process.env.TEMPORAL_ADDRESS
        if (!address) throw new Error('TEMPORAL_ADDRESS missing')
        const body = await new Promise<string>((resolve) => { let d=''; req.on('data', c=>d+=c); req.on('end',()=>resolve(d)) })
        const payload = (() => { try { return JSON.parse(body || '{}') } catch { return {} } })()
        const id = String(payload?.id || '')
        const cmd = String(payload?.cmd || '')
        if (!id || !cmd) { res.statusCode = 400; res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ok:false, error:'id/cmd missing' })); return }
        const { Connection, Client } = await import('@temporalio/client')
        const connection = await Connection.connect({ address })
        const client = new Client({ connection })
        const h = client.workflow.getHandle(id)
        if (cmd === 'pause') await h.signal('pause')
        else if (cmd === 'resume') await h.signal('resume')
        else if (cmd === 'cancel') await h.signal('cancel')
        else { res.statusCode = 400; res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ok:false, error:'unknown_cmd' })); return }
        res.statusCode = 200
        res.setHeader('content-type','application/json')
        res.end(JSON.stringify({ ok: true, workflowId: id, cmd }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type','application/json')
        res.end(JSON.stringify({ ok:false, error: String(e?.message || e) }))
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
              waitingTpSchedule(symbol, tp, qty, 'LONG', 'MARK_PRICE')
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
    if (url.pathname === '/api/profit_taker_status' && req.method === 'GET') {
      try {
        const { getProfitTakerList } = await import('../services/profit-taker/registry')
        const entries = getProfitTakerList()
        // Align enabled flag with trigger.getConfig logic: env has priority, else config/profit_taker.json
        let enabled = false
        try {
          const env = String(process.env.PROFIT_TAKER_ENABLED || '').toLowerCase()
          if (env) {
            enabled = env === '1' || env === 'true'
          } else {
            const fs = await import('node:fs')
            const path = await import('node:path')
            const j = JSON.parse(fs.readFileSync(path.resolve('config/profit_taker.json'), 'utf8'))
            enabled = j?.enabled !== false
          }
        } catch {}
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

    if (url.pathname === '/api/topup_watcher_status' && req.method === 'GET') {
      try {
        const { listWatchers, isWatcherEnabled } = await import('../services/top-up-watcher/registry')
        const entries = listWatchers()
        const enabled = isWatcherEnabled()
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

    if (url.pathname === '/api/topup_watcher_events/latest' && req.method === 'GET') {
      try {
        const symbol = String(url.searchParams.get('symbol') || '').trim().toUpperCase()
        if (!symbol) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'symbol required' }))
          return
        }
        const { readLatestEvent } = await import('../services/top-up-watcher/events')
        const event = await readLatestEvent(symbol)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ event }))
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ event: null, error: error?.message || 'unknown' }))
      }
      return
    }

    // Top-Up Executor: status
    if (url.pathname === '/api/top_up_executor_status' && req.method === 'GET') {
      try {
        const { getTopUpExecutorStatus } = await import('../services/top-up-executor/trigger')
        const { enabled, entries } = getTopUpExecutorStatus()
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

    // Top-Up Executor: toggle (persist to .env.local)
    if (url.pathname === '/api/top_up_executor_toggle' && (req.method === 'GET' || req.method === 'POST')) {
      try {
        if (req.method === 'POST') {
          const body = await new Promise<string>((resolve) => {
            let data = ''
            req.on('data', chunk => data += chunk)
            req.on('end', () => resolve(data))
          })
          const { enabled } = JSON.parse(body || '{}')
          const enabledBool = Boolean(enabled)
          ;(process as any).env.TOP_UP_EXECUTOR_ENABLED = enabledBool ? '1' : '0'
          const fs = await import('node:fs')
          const path = await import('node:path')
          const envPath = path.resolve(process.cwd(), '.env.local')
          let envContent = ''
          try { if (fs.existsSync(envPath)) envContent = fs.readFileSync(envPath, 'utf8') } catch {}
          const lines = envContent.split('\n')
          let found = false
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('TOP_UP_EXECUTOR_ENABLED=')) { lines[i] = `TOP_UP_EXECUTOR_ENABLED=${enabledBool ? '1' : '0'}`; found = true; break }
          }
          if (!found) lines.push(`TOP_UP_EXECUTOR_ENABLED=${enabledBool ? '1' : '0'}`)
          fs.writeFileSync(envPath, lines.join('\n'), 'utf8')
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ enabled: enabledBool, success: true }))
        } else {
          const envFlag = String(process.env.TOP_UP_EXECUTOR_ENABLED || '').toLowerCase()
          if (envFlag) {
            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ enabled: envFlag === '1' || envFlag === 'true' }))
            return
          }
          try {
            const fs = await import('node:fs')
            const path = await import('node:path')
            const file = path.resolve('config/top_up_executor.json')
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
            const enabled = process.env.TOP_UP_EXECUTOR_ENABLED === '1' || process.env.TOP_UP_EXECUTOR_ENABLED === 'true'
            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ enabled }))
          }
        }
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ enabled: false, success: false, error: error?.message || 'unknown' }))
      }
      return
    }

    if (url.pathname === '/api/profit_taker_audit' && req.method === 'GET') {
      try {
        const { readAuditEntries } = await import('../services/profit-taker/audit')
        const symbol = url.searchParams.get('symbol') || undefined
        const limitParam = Number(url.searchParams.get('limit') || 50)
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(500, Math.floor(limitParam)) : 50
        const entries = await readAuditEntries(symbol, limit as any).catch(()=>Promise.resolve([]))
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

    if (url.pathname === '/api/profit_taker_audit/latest' && req.method === 'GET') {
      try {
        const symbol = url.searchParams.get('symbol') || undefined
        const { readAuditLatest } = await import('../services/profit-taker/audit')
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

    if (url.pathname === '/api/profit_taker_toggle' && (req.method === 'GET' || req.method === 'POST')) {
      try {
        if (req.method === 'POST') {
          const body = await new Promise<string>((resolve) => {
            let data = ''
            req.on('data', chunk => data += chunk)
            req.on('end', () => resolve(data))
          })
          const { enabled } = JSON.parse(body || '{}')
          const enabledBool = Boolean(enabled)
          process.env.PROFIT_TAKER_ENABLED = enabledBool ? '1' : '0'
          const fs = await import('node:fs')
          const path = await import('node:path')
          const envPath = path.resolve(process.cwd(), '.env.local')
          let envContent = ''
          try { if (fs.existsSync(envPath)) envContent = fs.readFileSync(envPath, 'utf8') } catch {}
          const lines = envContent.split('\n')
          let found = false
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('PROFIT_TAKER_ENABLED=')) { lines[i] = `PROFIT_TAKER_ENABLED=${enabledBool ? '1' : '0'}`; found = true; break }
          }
          if (!found) lines.push(`PROFIT_TAKER_ENABLED=${enabledBool ? '1' : '0'}`)
          fs.writeFileSync(envPath, lines.join('\n'), 'utf8')
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ enabled: enabledBool, success: true }))
        } else {
          try {
            const { getConfig } = await import('../services/profit-taker/trigger')
            const cfg = getConfig()
            const enabled = Boolean(cfg?.enabled)
            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ enabled }))
          } catch {
            const enabled = process.env.PROFIT_TAKER_ENABLED === '1' || process.env.PROFIT_TAKER_ENABLED === 'true'
            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ enabled }))
          }
        }
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ enabled: false, success: false, error: error?.message || 'unknown' }))
      }
      return
    }

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
            const enabled = process.env.TOPUP_WATCHER_ENABLED === '1' || process.env.TOPUP_WATCHER_ENABLED === 'true'
            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ enabled }))
          }
        }
      } catch (error: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ enabled: false, success: false, error: error?.message || 'unknown' }))
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
        const r = await undiciRequest('https://api.alternative.me/fng/?limit=1', { method: 'GET' })
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
        if (!Number.isFinite(value as any)) throw new Error('bad_payload')
        const out = { value: Number(value), classification, updated_at: updatedAt, fetched_at: new Date().toISOString() }
        ttlSet(key, out, 20 * 60 * 1000)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(out))
      } catch (e: any) {
        res.statusCode = 502
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'fetch_failed' }))
      }
      return
    }

    if (url.pathname === '/api/top_up_multiplier' && req.method === 'POST') {
      try {
        const body = await new Promise<string>((resolve) => {
          let data = ''
          req.on('data', chunk => data += chunk)
          req.on('end', () => resolve(data))
        })
        const { multiplier } = JSON.parse(body || '{}')
        const val = Number(multiplier)
        if (!Number.isFinite(val) || val <= 0) throw new Error('invalid_multiplier')
        process.env.TOP_UP_MULTIPLIER = String(val)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ multiplier: val }))
      } catch (error: any) {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: error?.message || 'invalid' }))
      }
      return
    }

    if (url.pathname === '/api/top_up_executor_audit' && req.method === 'GET') {
      try {
        const { readAuditEntries } = await import('../services/top-up-executor/audit')
        const symbol = url.searchParams.get('symbol') || undefined
        const limitParam = Number(url.searchParams.get('limit') || 50)
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(200, Math.floor(limitParam)) : 50
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

    if (url.pathname === '/api/top_up_executor_audit/latest' && req.method === 'GET') {
      try {
        const { readAuditLatest } = await import('../services/top-up-executor/audit')
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

    res.statusCode = 404
    res.end('Not found')
  } catch (e: any) {
    res.statusCode = 500
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: e?.message ?? 'Internal error' }))
  }

})

// Nastavení dlouhého timeoutu pro server - 10 minut pro GPT-5
server.timeout = 600000  // 10 minut
server.keepAliveTimeout = 600000  // 10 minut

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`)
  console.log(`Server timeout set to: ${server.timeout}ms (10 minutes for GPT-5)`)
  try { startOrderSweeper() } catch (e) { console.error('[SWEEPER_START_ERR]', (e as any)?.message || e) }
  try { startSlProtectionMonitor() } catch (e) { console.error('[SL_MONITOR_START_ERR]', (e as any)?.message || e) }
  try { loadBackgroundCriteria() } catch {}
  try { startBackgroundTrading() } catch (e) { console.error('[BACKGROUND_START_ERR]', (e as any)?.message || e) }
})