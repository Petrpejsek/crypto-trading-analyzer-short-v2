import { Agent, setGlobalDispatcher } from 'undici'
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
import { executeHotTradingOrders, type PlaceOrdersRequest, fetchMarkPrice, fetchLastTradePrice, fetchAllOpenOrders, fetchPositions, cancelOrder, getBinanceAPI, getWaitingTpList, cleanupWaitingTpForSymbol, waitingTpProcessPassFromPositions, rehydrateWaitingFromDiskOnce } from '../services/trading/binance_futures'
import { ttlGet, ttlSet, makeKey } from './lib/ttlCache'
import { preflightCompact } from '../services/decider/market_compact'
import deciderCfg from '../config/decider.json'
import tradingCfg from '../config/trading.json'
import { calculateKlineChangePercent, calculateRegime } from './lib/calculations'
import { startBinanceUserDataWs, getPositionsInMemory, getOpenOrdersInMemory, isUserDataReady } from '../services/exchange/binance/userDataWs'
import { getLimitsSnapshot, setBanUntilMs } from './lib/rateLimits'
 

// Load env from .env.local and .env even in production
try {
  const tryLoad = (p: string) => { if (fs.existsSync(p)) dotenv.config({ path: p }) }
  tryLoad(path.resolve(process.cwd(), '.env.local'))
  tryLoad(path.resolve(process.cwd(), '.env'))
} catch {}

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
    const entryCandidates = (Array.isArray(raw) ? raw : [])
      .filter((o: any) => {
        try {
          const side = String(o?.side || '').toUpperCase()
          const type = String(o?.type || '').toUpperCase()
          const reduceOnly = Boolean(o?.reduceOnly)
          const closePosition = Boolean(o?.closePosition)
          return side === 'BUY' && type === 'LIMIT' && !reduceOnly && !closePosition
        } catch { return false }
      })
      .map((o: any) => ({
        symbol: String(o?.symbol || ''),
        orderId: Number(o?.orderId ?? o?.orderID ?? 0) || 0,
        createdAtMs: (() => { const t = Number((o as any)?.time); return Number.isFinite(t) && t > 0 ? t : null })()
      }))
      .filter(o => o.symbol && o.orderId && Number.isFinite(o.createdAtMs as any))
      .filter(o => (now - (o.createdAtMs as number)) > ageMs)

    // KRITICKÁ OPRAVA: SL ordery NIKDY nesmí být rušeny automaticky!
    // Pouze TP ordery mohou být rušeny jako "orphan exits" 
    const entrySymbols = new Set<string>((Array.isArray(raw) ? raw : [])
      .filter((o: any) => {
        try {
          return String(o?.side||'').toUpperCase()==='BUY' && String(o?.type||'').toUpperCase()==='LIMIT' && !(o?.reduceOnly||o?.closePosition)
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
          const isExitType = type.includes('STOP') || type.includes('TAKE_PROFIT') // SL i TP
          const hasPos = (Number(posSizeBySym.get(sym)||0) > 0)
          const noEntryOpen = !entrySymbols.has(sym)
          
          // KRITICKÁ OCHRANA: Pokud máme pozici, NIKDY neruš SL ani TP!
          if (hasPos && isExitType) {
            console.warn('[SWEEPER_POSITION_PROTECTION]', { symbol: sym, orderId: o?.orderId, type, reason: 'position_exists_never_cancel_exits' })
            return false
          }
          
          // Pokud není pozice, sweeper může mazat normálně
          return side==='SELL' && isExitType && (reduceOnly || closePosition) && !hasPos && noEntryOpen
        } catch { return false }
      })
      .map((o: any) => ({
        symbol: String(o?.symbol || ''),
        orderId: Number(o?.orderId ?? o?.orderID ?? 0) || 0,
        createdAtMs: (() => { const t = Number((o as any)?.time); return Number.isFinite(t) && t > 0 ? t : null })()
      }))
      .filter(o => o.symbol && o.orderId && Number.isFinite(o.createdAtMs as any))
      .filter(o => (now - (o.createdAtMs as number)) > ageMs)

    if (entryCandidates.length === 0 && orphanExitCandidates.length === 0) return 0

    let cancelled = 0
    const maxParallel = 4
    const all = entryCandidates.concat(orphanExitCandidates)
    for (let i = 0; i < all.length; i += maxParallel) {
      const batch = all.slice(i, i + maxParallel)
      const res = await Promise.allSettled(batch.map(async (c) => {
        const r = await cancelOrder(c.symbol, c.orderId)
        pushAudit({ ts: new Date().toISOString(), type: 'cancel', source: 'sweeper', symbol: c.symbol, orderId: c.orderId, reason: 'stale_auto_cancel' })
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
    try { console.error('[SWEEPER_PASS]', { age_min: __pendingCancelAgeMin, cancelled, entries: entryCandidates.length, orphan_exits: orphanExitCandidates.length }) } catch {}
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
        
        // Auto-cleanup waiting TP if this was an ENTRY order
        try {
          const orderInfo = r || {}
          const wasEntryOrder = (
            String(orderInfo?.side) === 'BUY' && 
            String(orderInfo?.type) === 'LIMIT' && 
            !(orderInfo?.reduceOnly || orderInfo?.closePosition)
          )
          if (wasEntryOrder) {
            cleanupWaitingTpForSymbol(symbol)
          }
        } catch {}
        
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
              const idIsInternal = idStr ? /^(e_l_|x_sl_|x_tp_)/.test(idStr) : false
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
            for (const w of (Array.isArray(pending) ? pending : [])) {
              try {
                const sym = String(w?.symbol || '')
                if (!sym) continue
                const size = Number(posSizeBySym.get(sym) || 0)
                // DEBUG: Log cleanup decision
                const hasEntry = entrySymbols.has(sym)
                const hasPosition = size > 0
                console.debug('[WAITING_CLEANUP_DEBUG]', { 
                  symbol: sym, 
                  hasEntry, 
                  hasPosition, 
                  willCleanup: !hasEntry && !hasPosition,
                  entrySymbols: Array.from(entrySymbols)
                })
                // Cleanup only if there is no internal ENTRY for the symbol AND no position
                if (!hasEntry && !hasPosition) {
                  console.warn('[WAITING_CLEANUP_DECISION]', { symbol: sym, reason: 'no_entry_and_no_position' })
                  cleanupWaitingTpForSymbol(sym)
                } else {
                  console.info('[WAITING_KEEP_DECISION]', { symbol: sym, hasEntry, hasPosition })
                }
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
          isExternal: ((): boolean => {
            try {
              const idStr = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
              const idIsInternal = idStr ? /^(e_l_|x_sl_|x_tp_)/.test(idStr) : false
              if (idIsInternal) return false
              const n = Number(o?.orderId ?? 0)
              const { isStrategyOrderId } = require('../services/strategy-updater/registry')
              if (Number.isFinite(n) && isStrategyOrderId(n)) return false
              return true
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
            const isExternal = (() => { const id = String(o.clientOrderId || ''); return id ? !/^(e_l_|x_sl_|x_tp_tm_|x_tp_l_)/.test(id) : true })()
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
        const asset = {
          symbol: targetItem.symbol,
          price: Number(targetItem.price ?? (h1.length ? h1[h1.length-1].close : null)),
          ohlcv: { h1, m15 },
          indicators: {
            atr_h1: targetItem.atr_h1 ?? null,
            atr_m15: targetItem.atr_m15 ?? null,
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
          coins: dedupCoins
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(out))
      } catch (e: any) {
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
                    ? { symbol: x.symbol, side: 'SELL', type: 'STOP_MARKET', stopPrice: String(x.sl), closePosition: true, workingType, positionSide: 'LONG', newOrderRespType: 'RESULT' }
                    : { symbol: x.symbol, side: 'SELL', type: 'STOP_MARKET', stopPrice: String(x.sl), closePosition: true, workingType, newOrderRespType: 'RESULT' }
                  await api.placeOrder(slParams)
                }
                if (Number.isFinite(x.tp)) {
                  const tpParams: any = isHedge
                    ? { symbol: x.symbol, side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: String(x.tp), closePosition: true, workingType, positionSide: 'LONG', newOrderRespType: 'RESULT' }
                    : { symbol: x.symbol, side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: String(x.tp), closePosition: true, workingType, newOrderRespType: 'RESULT' }
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


