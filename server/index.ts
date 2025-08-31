import { Agent, setGlobalDispatcher } from 'undici'
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { buildMarketRawSnapshot } from './fetcher/binance'
import { WsCollector } from './ws/wsCollector'
import { setCollector } from './ws/registry'
import { performance } from 'node:perf_hooks'
import http from 'node:http'
import { decideMarketStrict } from '../services/decider/market_decider_gpt'
import { runFinalPicker as runFinalPickerServer } from '../services/decider/final_picker_gpt'
import { runHotScreener } from '../services/decider/hot_screener_gpt'
import { runEntryStrategy } from '../services/decider/entry_strategy_gpt'
import { executeHotTradingOrders, type PlaceOrdersRequest, fetchMarkPrice, fetchLastTradePrice, fetchAllOpenOrders } from '../services/trading/binance_futures'
import { preflightCompact } from '../services/decider/market_compact'
import deciderCfg from '../config/decider.json'
import { startAltH1Collector } from './ws/collector_alt_h1'
import { calculateKlineChangePercent, calculateRegime } from './lib/calculations'

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

const PORT = 8788
const wsCollector = new WsCollector({ coreSymbols: ['BTCUSDT','ETHUSDT'], altSymbols: [] })
wsCollector.start()
setCollector(wsCollector)
// Start Alt H1 collector prewarm
startAltH1Collector({ symbols: [], onBar: () => {} })

function isDebugApi(): boolean {
  try { const v = String(process.env.DEBUG_API || '').toLowerCase(); return v === 'true' || v === '1' || v === 'yes'; } catch { return false }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost')
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
        const [mark, last] = await Promise.all([fetchMarkPrice(symbol), fetchLastTradePrice(symbol)])
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ symbol, mark, last }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: e?.message || 'unknown' }))
      }
      return
    }
    if (url.pathname === '/internal/binance/open-orders' && req.method === 'GET') {
      // Guard: only in DEBUG_API or localhost origin
      if (!isDebugApi()) { res.statusCode = 404; res.end('Not found'); return }
      // Basic in-process rate limit + cache (2-3s cache; 1 call per 5s)
      const key = '__open_orders_cache__'
      const now = Date.now()
      const state: any = (globalThis as any)[key] || { at: 0, data: null, lastCallAt: 0 }
      const CACHE_MS = 2500
      const RL_MS = 5000
      if (state.data && (now - state.at) < CACHE_MS) {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, cached: true, items: state.data }))
        return
      }
      if ((now - state.lastCallAt) < RL_MS) {
        res.statusCode = 429
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, code: 'rate_limited' }))
        return
      }
      try {
        const items = await fetchAllOpenOrders()
        const slim = (Array.isArray(items) ? items : []).map((o: any) => ({
          symbol: o?.symbol,
          orderId: o?.orderId,
          type: o?.type,
          side: o?.side,
          price: o?.price ?? null,
          time: o?.time ?? o?.updateTime ?? null,
          status: o?.status ?? null
        }))
        ;(globalThis as any)[key] = { at: now, data: slim, lastCallAt: now }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, cached: false, items: slim }))
      } catch (e: any) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: e?.message || 'unknown' }))
      }
      return
    }
    if (url.pathname === '/api/health') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (url.pathname === '/api/watchdog/health' && req.method === 'GET') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      const enabled = (() => { try { const v = String(process.env.WATCHDOG_ENABLED||'false').toLowerCase(); return v==='true'||v==='1'||v==='yes' } catch { return false } })()
      const mode = String(process.env.WATCHDOG_MODE || 'shadow')
      const allowCancel = (()=>{ try { const v=String(process.env.WATCHDOG_ALLOW_CANCEL||'false').toLowerCase(); return v==='true'||v==='1'||v==='yes' } catch { return false } })()
      const meta = (globalThis as any).__watchdog_meta || {}
      res.end(JSON.stringify({ ok: true, enabled, mode, allowCancel, lastRunISO: meta.lastRunISO ?? null, lastRunDurationMs: meta.lastRunDurationMs ?? null, lastError: meta.lastError ?? null }))
      return
    }
    if (url.pathname === '/api/watchdog/last-evals' && req.method === 'GET') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      const qLimit = Number(url.searchParams.get('limit') || '')
      const limit = Number.isFinite(qLimit) && qLimit > 0 ? Math.min(1000, qLimit) : 100
      const all = ((globalThis as any).__watchdog_last_evals || [])
      const records = Array.isArray(all) ? all.slice(-limit) : []
      const enabled = (() => { try { const v = String(process.env.WATCHDOG_ENABLED||'false').toLowerCase(); return v==='true'||v==='1'||v==='yes' } catch { return false } })()
      const mode = String(process.env.WATCHDOG_MODE || 'shadow')
      res.end(JSON.stringify({ ok: true, enabled, mode, records }))
      return
    }
    if (url.pathname === '/api/watchdog/run-now' && req.method === 'POST') {
      if (!isDebugApi() && String((process as any)?.env?.RUN_MODE||'').toLowerCase() !== 'local') {
        res.statusCode = 404
        res.end('Not found')
        return
      }
      try {
        const runFn = (globalThis as any).__watchdog_run_once
        if (typeof runFn !== 'function') {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'watchdog_not_ready' }))
          return
        }
        const r = await runFn()
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
    if (url.pathname === '/api/ws/health') {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      const perf = (globalThis as any).__perf_last_snapshot || {}
      res.end(JSON.stringify({
        ok: true,
        connected: false,
        streams: 0,
        altH1Subscribed: 0,
        altH1Ready: 0,
        includedSymbols: perf.includedSymbolsCount ?? 0,
        lastBackfillCount: perf.lastBackfillCount ?? 0,
        drops_noH1: Array.isArray(perf.drops_noH1) ? perf.drops_noH1 : []
      }))
      return
    }
    if (url.pathname === '/api/snapshot') {
      res.setHeader('Cache-Control', 'no-store')
      const t0 = performance.now()
      try {
        // universeStrategy: volume (default) | gainers via query ?universe=gainers
        const uniParam = String(url.searchParams.get('universe') || '').toLowerCase()
        const universeStrategy = uniParam === 'gainers' ? 'gainers' : 'volume'
        const topN = Number(url.searchParams.get('topN') || '')
        const snapshot = await buildMarketRawSnapshot({ universeStrategy, desiredTopN: Number.isFinite(topN) ? topN : undefined })
        ;(snapshot as any).duration_ms = Math.round(performance.now() - t0)
        delete (snapshot as any).latency_ms
        const body = JSON.stringify(snapshot)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(body)
      } catch (err: any) {
        // Distinguish universe incomplete (fixed 28 alts rule) from generic errors
        const stage = err?.stage || 'unknown'
        res.statusCode = stage === 'universe_incomplete' ? 503 : 500
        res.setHeader('content-type', 'application/json; charset=utf-8')
        const stack = typeof err?.stack === 'string' ? String(err.stack).split('\n').slice(0, 3) : []
        res.end(JSON.stringify({
          error: err?.message || 'INTERNAL_ERROR',
          stage,
          symbol: err?.symbol || null,
          expected: err?.expected ?? null,
          actual: err?.actual ?? null,
          stack
        }))
      }
      return
    }

    if (url.pathname === '/api/snapshot_light' || url.pathname === '/api/snapshot_pro') {
      res.setHeader('Cache-Control', 'no-store')
      const pro = url.pathname === '/api/snapshot_pro'
      try {
        const uniParam = String(url.searchParams.get('universe') || '').toLowerCase()
        const universeStrategy = uniParam === 'gainers' ? 'gainers' : 'volume'
        const topN = Number(url.searchParams.get('topN') || '')
        // If a symbol is requested, force-include it in the universe build so it can't be dropped
        const includeSymbols = (() => {
          const s = url.searchParams.get('symbol')
          if (!s) return undefined
          const v = String(s).toUpperCase()
          return [v]
        })()
        const snap = await buildMarketRawSnapshot({ universeStrategy, desiredTopN: Number.isFinite(topN) ? topN : undefined, includeSymbols })
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
        const snap = await retry(() => buildMarketRawSnapshot({ universeStrategy: 'volume', desiredTopN: 1, includeSymbols: [symbol] }))
        
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
        const snap = await buildMarketRawSnapshot({ universeStrategy, desiredTopN: Number.isFinite(topN) ? topN : undefined })
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
        const snap = await retry(() => buildMarketRawSnapshot({ universeStrategy, desiredTopN: Number.isFinite(topN) ? topN : undefined }))
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
        res.statusCode = abortLike ? 503 : 500
        if (abortLike) res.setHeader('Retry-After', '1')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: abortLike ? 'UNAVAILABLE_TEMPORARILY' : (e?.message || 'unknown') }))
      }
      return
    }

    if (url.pathname === '/api/place_orders' && req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store')
      try {
        const chunks: Buffer[] = []
        for await (const ch of req) chunks.push(ch as Buffer)
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        const parsed = bodyStr ? JSON.parse(bodyStr) : null as PlaceOrdersRequest
        
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
        try { console.info('[PLACE_ORDERS_REQ]', { sample: parsed.orders.slice(0,3) }) } catch {}
        const result = await executeHotTradingOrders(parsed)
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
        res.statusCode = 400
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
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ flag: 'NO-TRADE', posture: 'RISK-OFF', market_health: 0, expiry_minutes: 30, reasons: ['gpt_error:no_api_key'], risk_cap: { max_concurrent: 0, risk_per_trade_max: 0 } }))
          return
        }
        const chunks: Buffer[] = []
        for await (const ch of req) chunks.push(ch as Buffer)
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        const compact = bodyStr ? JSON.parse(bodyStr) : null
        if (!compact || typeof compact !== 'object') {
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ flag: 'NO-TRADE', posture: 'RISK-OFF', market_health: 0, expiry_minutes: 30, reasons: ['gpt_error:bad_request'], risk_cap: { max_concurrent: 0, risk_per_trade_max: 0 } }))
          return
        }
        const pf = preflightCompact(compact)
        if (!pf.ok) {
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ flag: 'NO-TRADE', posture: 'RISK-OFF', market_health: 0, expiry_minutes: 30, reasons: [`gpt_error:${pf.reason}`], risk_cap: { max_concurrent: 0, risk_per_trade_max: 0 } }))
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
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ flag: 'NO-TRADE', posture: 'RISK-OFF', market_health: 0, expiry_minutes: 30, reasons: [`gpt_error:${e?.code||e?.name||'unknown'}`], risk_cap: { max_concurrent: 0, risk_per_trade_max: 0 } }))
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
})


