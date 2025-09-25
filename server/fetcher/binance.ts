import config from '../../config/fetcher.json'
import deciderCfg from '../../config/decider.json'
import signalsCfg from '../../config/signals.json'
import type { MarketRawSnapshot, Kline, ExchangeFilters, UniverseItem } from '../../types/market_raw'
import { ema, rsi, atr } from '../../services/lib/indicators'
import { calcSpreadBps, clampSnapshotSize, toNumber, toUtcIso } from '../../services/fetcher/normalize'
import { request } from 'undici'
import { noteApiCall } from '../lib/rateLimits'
// TTL cache disabled by policy: no caching
import { request as undiciRequest } from 'undici'

const BASE_URL = 'https://fapi.binance.com'

type RetryConfig = {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

async function sleep(ms: number): Promise<void> { return new Promise(res => setTimeout(res, ms)) }

async function withRetry<T>(fn: () => Promise<T>, retryCfg: RetryConfig): Promise<T> {
  let attempt = 0
  let lastError: any
  while (attempt < retryCfg.maxAttempts) {
    try { return await fn() } catch (e) { lastError = e; attempt += 1; if (attempt >= retryCfg.maxAttempts) break; const delay = Math.min(retryCfg.baseDelayMs * Math.pow(2, attempt - 1), retryCfg.maxDelayMs); await sleep(delay) }
  }
  throw lastError
}

async function httpGet(path: string, params?: Record<string, string | number>): Promise<any> {
  const qs = params ? new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : ''
  const url = `${BASE_URL}${path}${qs ? `?${qs}` : ''}`
  const ac = new AbortController()
  const to = setTimeout(() => ac.abort(), config.timeoutMs ?? 6000)
  try {
    const { body, statusCode, headers } = await request(url, { method: 'GET', signal: ac.signal })
    try { noteApiCall({ method: 'GET', path, status: Number(statusCode), headers }) } catch {}
    if (statusCode < 200 || statusCode >= 300) {
      try { noteApiCall({ method: 'GET', path, status: Number(statusCode), headers }) } catch {}
      throw new Error(`HTTP ${statusCode} ${path}`)
    }
    const text = await body.text()
    return JSON.parse(text)
  } finally {
    clearTimeout(to)
  }
}

async function httpGetCached(path: string, params: Record<string, string | number> | undefined, _ttlMs: number, _fresh = false): Promise<any> {
  // Strict NO-CACHE: always hit origin
  return httpGet(path, params)
}

async function getServerTime(): Promise<number> {
  const data = await withRetry(() => httpGet('/fapi/v1/time'), config.retry)
  const serverTime = toNumber(data?.serverTime)
  if (!serverTime) throw new Error('Invalid serverTime')
  return serverTime
}

type ExchangeInfoSymbol = {
  symbol: string
  filters: Array<{ filterType: string; tickSize?: string; stepSize?: string; minQty?: string; notional?: string; minNotional?: string }>
  status: string
  contractType?: string
  quoteAsset?: string
}

async function getExchangeInfo(): Promise<ExchangeFilters> {
  // Always fetch fresh exchangeInfo to avoid any caching
  const data = await withRetry(() => httpGet('/fapi/v1/exchangeInfo', undefined), config.retry)
  const symbols: ExchangeInfoSymbol[] = Array.isArray(data?.symbols) ? data.symbols : []
  const filters: ExchangeFilters = {}
  for (const s of symbols) {
    if (s.status !== 'TRADING') continue
    if (s.contractType && s.contractType !== 'PERPETUAL') continue
    if (s.quoteAsset && s.quoteAsset !== 'USDT') continue
    const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER')
    const lotSize = s.filters.find(f => f.filterType === 'LOT_SIZE')
    const minNotional = s.filters.find(f => f.filterType === 'MIN_NOTIONAL')
    const tickSize = toNumber(priceFilter?.tickSize)
    const stepSize = toNumber(lotSize?.stepSize)
    const minQty = toNumber(lotSize?.minQty)
    const minNot = toNumber((minNotional?.notional ?? minNotional?.minNotional) as any)
    if (!tickSize || !stepSize || !minQty || !minNot) continue
    filters[s.symbol] = { tickSize, stepSize, minQty, minNotional: minNot }
  }
  return filters
}

async function getTopNUsdtSymbols(n: number, fresh = false): Promise<string[]> {
  const data = await withRetry(() => httpGetCached('/fapi/v1/ticker/24hr', undefined, (config as any).cache?.ticker24hMs ?? 30000, fresh), config.retry)
  const entries = Array.isArray(data) ? data : []
  const filtered = entries.filter((e: any) => e?.symbol?.endsWith('USDT'))
  const sorted = filtered.sort((a: any, b: any) => {
    const va = Number(a.quoteVolume)
    const vb = Number(b.quoteVolume)
    if (vb !== va) return vb - va
    return String(a.symbol).localeCompare(String(b.symbol))
  })
  const unique = Array.from(new Set(sorted.map((e: any) => e.symbol)))
  return unique.slice(0, n)
}

async function getTopGainersUsdtSymbols(n: number, fresh = false): Promise<string[]> {
  const data = await withRetry(() => httpGetCached('/fapi/v1/ticker/24hr', undefined, (config as any).cache?.ticker24hMs ?? 30000, fresh), config.retry)
  const entries = Array.isArray(data) ? data : []
  const filtered = entries.filter((e: any) => e?.symbol?.endsWith('USDT'))
  const sorted = filtered.sort((a: any, b: any) => {
    const pa = Number(a.priceChangePercent)
    const pb = Number(b.priceChangePercent)
    if (pb !== pa) return pb - pa
    // tie-break by volume
    const va = Number(a.quoteVolume)
    const vb = Number(b.quoteVolume)
    if (vb !== va) return vb - va
    return String(a.symbol).localeCompare(String(b.symbol))
  })
  const unique = Array.from(new Set(sorted.map((e: any) => e.symbol)))
  return unique.slice(0, n)
}

async function getKlines(symbol: string, interval: string, limit: number, fresh = false): Promise<Kline[]> {
  const run = () => httpGet('/fapi/v1/klines', { symbol, interval, limit })
  let raw: any
  try {
    raw = await withRetry(run, config.retry)
  } catch (e) {
    if (interval === '1h') {
      const jitter = 200 + Math.floor(Math.random() * 200)
      await sleep(jitter)
      raw = await withRetry(run, { ...config.retry, maxAttempts: 1 })
    } else {
      throw e
    }
  }
  if (!Array.isArray(raw)) return []
  return raw.map((k: any) => ({
    openTime: toUtcIso(k[0])!, open: toNumber(k[1])!, high: toNumber(k[2])!, low: toNumber(k[3])!, close: toNumber(k[4])!, volume: toNumber(k[5])!, closeTime: toUtcIso(k[6])!
  })).filter(k => Number.isFinite(k.open) && Number.isFinite(k.close))
}

async function getFundingRate(symbol: string): Promise<number | undefined> {
  const data = await withRetry(() => httpGet('/fapi/v1/fundingRate', { symbol, limit: 1 }), config.retry)
  if (!Array.isArray(data) || data.length === 0) return undefined
  return toNumber(data[0]?.fundingRate)
}

async function getOpenInterestNow(symbol: string): Promise<number | undefined> {
  const data = await withRetry(() => httpGet('/fapi/v1/openInterest', { symbol }), config.retry)
  return toNumber(data?.openInterest)
}

async function getOpenInterestHistChange1h(symbol: string): Promise<number | undefined> {
  // Use 5m OI history to compute ~1h change
  try {
    const data = await withRetry(() => httpGet('/futures/data/openInterestHist', { symbol, period: '5m', limit: 13 }), { ...config.retry, maxAttempts: 2 })
    if (!Array.isArray(data) || data.length < 2) return undefined
    const first = toNumber(data[0]?.sumOpenInterest) || 0
    const last = toNumber(data[data.length - 1]?.sumOpenInterest) || 0
    if (first <= 0 || last <= 0) return undefined
    return ((last - first) / first) * 100
  } catch {
    return undefined
  }
}

async function getBookTicker(symbol: string): Promise<{ bid: number | undefined; ask: number | undefined }> {
  try {
    const d = await withRetry(() => httpGet('/fapi/v1/ticker/bookTicker', { symbol }), config.retry)
    return { bid: toNumber(d?.bidPrice), ask: toNumber(d?.askPrice) }
  } catch { return { bid: undefined, ask: undefined } }
}

async function getOrderBook(symbol: string, limit: number): Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]> } | undefined> {
  try {
    const d = await withRetry(() => httpGet('/fapi/v1/depth', { symbol, limit }), config.retry)
    const toArr = (a: any[]) => Array.isArray(a) ? a.map((x: any) => [toNumber(x[0]) || 0, toNumber(x[1]) || 0] as [number, number]).filter(x => x[0] > 0 && x[1] > 0) : []
    return { bids: toArr(d?.bids || []), asks: toArr(d?.asks || []) }
  } catch { return undefined }
}

// Public REST depth (top 20)
export async function getDepth20(symbol: string): Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]> } | null> {
  try {
    const d = await withRetry(() => httpGet('/fapi/v1/depth', { symbol, limit: 20 }), config.retry)
    const toArr = (a: any[]) => Array.isArray(a) ? a.map((x: any) => [toNumber(x[0]) || 0, toNumber(x[1]) || 0] as [number, number]).filter(x => x[0] > 0 && x[1] > 0) : []
    const bids = toArr(d?.bids || [])
    const asks = toArr(d?.asks || [])
    if (!bids.length || !asks.length) return null
    return { bids, asks }
  } catch {
    return null
  }
}

export function calcDepthWithinPctUSD(
  bids: Array<[number, number]>,
  asks: Array<[number, number]>,
  markPrice: number,
  pct: number
): { bids: number; asks: number } | undefined {
  if (!Array.isArray(bids) || !Array.isArray(asks) || !markPrice || markPrice <= 0) return undefined
  const lower = markPrice * (1 - pct)
  const upper = markPrice * (1 + pct)
  let bidUsd = 0
  for (const [price, qty] of bids) {
    if (price < lower) break
    bidUsd += price * qty
  }
  let askUsd = 0
  for (const [price, qty] of asks) {
    if (price > upper) break
    askUsd += price * qty
  }
  if (!Number.isFinite(bidUsd) || !Number.isFinite(askUsd)) return undefined
  return { bids: bidUsd, asks: askUsd }
}

// Order Book Imbalance over top N levels; returns value in [-1, +1]
export function calcObi(depth: { bids: Array<[number, number]>; asks: Array<[number, number]> }, n: number): number | null {
  try {
    const nb = Math.min(n, depth.bids.length)
    const na = Math.min(n, depth.asks.length)
    if (nb === 0 || na === 0) return null
    let bidNotional = 0
    for (let i = 0; i < nb; i++) bidNotional += depth.bids[i][0] * depth.bids[i][1]
    let askNotional = 0
    for (let i = 0; i < na; i++) askNotional += depth.asks[i][0] * depth.asks[i][1]
    const denom = bidNotional + askNotional
    if (!Number.isFinite(denom) || denom <= 0) return null
    const v = (bidNotional - askNotional) / denom
    return Math.max(-1, Math.min(1, v))
  } catch {
    return null
  }
}

export function findNearestWalls(depth: { bids: Array<[number, number]>; asks: Array<[number, number]> }, midPrice?: number | null): { nearestAskWallPrice: number | null; nearestAskWallDistBps: number | null; nearestBidWallPrice: number | null; nearestBidWallDistBps: number | null } {
  const safeMid = (Number.isFinite(midPrice as any) && (midPrice as number) > 0) ? (midPrice as number) : (() => {
    try {
      const b = depth.bids[0]?.[0] || 0
      const a = depth.asks[0]?.[0] || 0
      return (b > 0 && a > 0) ? (b + a) / 2 : 0
    } catch { return 0 }
  })()
  if (safeMid <= 0) return { nearestAskWallPrice: null, nearestAskWallDistBps: null, nearestBidWallPrice: null, nearestBidWallDistBps: null }

  const median = (arr: number[]): number => {
    if (!arr.length) return 0
    const s = [...arr].sort((x, y) => x - y)
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }

  const topAsks = depth.asks.slice(0, 20)
  const topBids = depth.bids.slice(0, 20)

  // Rolling 3-level notional windows for stability
  const window = 3
  const sumNotional = (side: Array<[number, number]>, i: number): number => {
    let s = 0
    for (let k = 0; k < window && i + k < side.length; k++) s += side[i + k][0] * side[i + k][1]
    return s
  }
  const askWins = topAsks.map((_, i) => sumNotional(topAsks, i))
  const bidWins = topBids.map((_, i) => sumNotional(topBids, i))
  const medAskWin = median(askWins)
  const medBidWin = median(bidWins)
  // Threshold: pick strongest cluster above 5× median; if none, pick global max as soft signal
  const askThresh = medAskWin > 0 ? 5 * medAskWin : Infinity
  const bidThresh = medBidWin > 0 ? 5 * medBidWin : Infinity

  let nearestAskWallPrice: number | null = null
  for (let i = 0; i < topAsks.length; i++) { if (askWins[i] >= askThresh) { nearestAskWallPrice = topAsks[i][0]; break } }
  let nearestBidWallPrice: number | null = null
  for (let i = 0; i < topBids.length; i++) { if (bidWins[i] >= bidThresh) { nearestBidWallPrice = topBids[i][0]; break } }
  // Soft-fill with strongest window if strict threshold not met (still a meaningful wall candidate)
  if (nearestAskWallPrice == null && askWins.length) {
    const idx = askWins.indexOf(Math.max(...askWins))
    if (idx >= 0) nearestAskWallPrice = topAsks[idx]?.[0] ?? null
  }
  if (nearestBidWallPrice == null && bidWins.length) {
    const idx = bidWins.indexOf(Math.max(...bidWins))
    if (idx >= 0) nearestBidWallPrice = topBids[idx]?.[0] ?? null
  }

  const toBps = (p: number | null): number | null => {
    if (!Number.isFinite(p as any) || (p as number) <= 0) return null
    return Math.abs(((p as number) / safeMid - 1) * 10000)
  }

  return {
    nearestAskWallPrice,
    nearestAskWallDistBps: toBps(nearestAskWallPrice),
    nearestBidWallPrice,
    nearestBidWallDistBps: toBps(nearestBidWallPrice)
  }
}

export function estimateSlippageBps(depth: { bids: Array<[number, number]>; asks: Array<[number, number]> }, trancheNotionalUsd: number, side: 'BUY' | 'SELL', referencePrice?: number | null): number | null {
  try {
    const bestBid = depth.bids[0]?.[0]
    const bestAsk = depth.asks[0]?.[0]
    // Side-specific base: bestAsk for BUY, bestBid for SELL (more realistic than mid)
    const base = (Number.isFinite(referencePrice as any) && (referencePrice as number) > 0)
      ? (referencePrice as number)
      : (side === 'BUY' ? (bestAsk || 0) : (bestBid || 0))
    if (!(trancheNotionalUsd > 0) || base <= 0) return null

    let remaining = trancheNotionalUsd
    let cost = 0
    let qtyTotal = 0
    if (side === 'BUY') {
      for (const [price, qty] of depth.asks) {
        const levelNotional = price * qty
        if (levelNotional <= 0) continue
        const take = Math.min(remaining, levelNotional)
        const qtyTaken = take / price
        cost += qtyTaken * price
        qtyTotal += qtyTaken
        remaining -= take
        if (remaining <= 1e-8) break
      }
    } else {
      for (const [price, qty] of depth.bids) {
        const levelNotional = price * qty
        if (levelNotional <= 0) continue
        const take = Math.min(remaining, levelNotional)
        const qtyTaken = take / price
        cost += qtyTaken * price
        qtyTotal += qtyTaken
        remaining -= take
        if (remaining <= 1e-8) break
      }
    }
    if (qtyTotal <= 0) return null
    const vwap = cost / qtyTotal
    if (!(Number.isFinite(vwap) && vwap > 0)) return null
    const bps = ((vwap / base) - 1) * 10000
    return Math.abs(bps)
  } catch {
    return null
  }
}

// Use shared EMA/RSI/ATR to ensure 1:1 across server and UI
function atrPct(klines: Kline[]): number | null {
  if (!Array.isArray(klines) || klines.length < 15) return null
  const highs = klines.map(k => k.high)
  const lows = klines.map(k => k.low)
  const closes = klines.map(k => k.close)
  const abs = atr(highs, lows, closes, 14)
  const lastClose = closes[closes.length - 1]
  return abs != null && Number.isFinite(lastClose) && lastClose > 0 ? (abs / lastClose) * 100 : null
}

function computeDailyVwapFromM15(m15: Kline[]): { vwap: number | null; rel: number | null } {
  // VWAP "today" reset strictly at 00:00:00 UTC and computed from the same
  // OHLCV source as M15 svíčky. We also align/fill intraday gaps with
  // zero-volume flat bars so VWAP není zkreslený chybějícími intervaly.
  if (!Array.isArray(m15) || m15.length === 0) return { vwap: null, rel: null }
  const now = new Date()
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate()
  const start = Date.UTC(y, m, d, 0, 0, 0)
  const step = 15 * 60 * 1000

  // Prepare ascending list within today
  const today = m15
    .map(k => ({ t: Date.parse(k.openTime), o: k.open, h: k.high, l: k.low, c: k.close, v: k.volume }))
    .filter(k => Number.isFinite(k.t) && k.t >= start)
    .sort((a, b) => a.t - b.t)
  if (today.length === 0) return { vwap: null, rel: null }

  // Align and fill missing 15m slots with zero-volume flat bars
  const aligned = [today[0]] as typeof today
  for (let i = 1; i < today.length; i++) {
    const prev = aligned[aligned.length - 1]
    const cur = today[i]
    let expected = prev.t + step
    while (cur.t - expected >= step) {
      aligned.push({ t: expected, o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: 0 })
      expected += step
    }
    aligned.push(cur)
  }

  let pv = 0, vv = 0
  for (const k of aligned) {
    const tp = (k.h + k.l + k.c) / 3
    pv += tp * k.v
    vv += k.v
  }
  const lastClose = aligned[aligned.length - 1]?.c
  if (!(vv > 0 && Number.isFinite(pv) && Number.isFinite(lastClose))) return { vwap: null, rel: null }
  const vwap = pv / vv
  const rel = (lastClose - vwap) / vwap
  return { vwap, rel }
}

function computeSRLevels(h1: Kline[], maxLevels = 4): { support: number[]; resistance: number[] } {
  const support: number[] = []
  const resistance: number[] = []
  if (!Array.isArray(h1) || h1.length < 20) return { support, resistance }

  // Adaptive-edge fractal detection: allow truncated window near array boundaries
  const window = 3
  for (let i = 0; i < h1.length; i++) {
    const left = Math.max(0, i - window)
    const right = Math.min(h1.length - 1, i + window)
    let isLow = true
    let isHigh = true
    for (let j = left; j <= right; j++) {
      if (j === i) continue
      if (h1[j].low < h1[i].low) isLow = false
      if (h1[j].high > h1[i].high) isHigh = false
      if (!isLow && !isHigh) break
    }
    if (isLow) support.push(h1[i].low)
    if (isHigh) resistance.push(h1[i].high)
  }

  // Sort and pick nearest levels around last close, split by side; ensure uniqueness and min 2 per side
  const lastClose = h1[h1.length - 1].close
  const dedup = (arr: number[]): number[] => {
    const out: number[] = []
    for (const v of arr) {
      if (!out.some(x => Math.abs(x - v) <= Math.max(1e-12, Math.abs(lastClose) * 1e-8))) out.push(v)
    }
    return out
  }
  const lowsBelow = h1.map(k => k.low).filter(v => v <= lastClose)
  const highsAbove = h1.map(k => k.high).filter(v => v >= lastClose)
  const sortByDist = (arr: number[], dir: 'below' | 'above') => dedup(arr
    .filter(v => (dir === 'below' ? v <= lastClose : v >= lastClose))
    .sort((a, b) => Math.abs(a - lastClose) - Math.abs(b - lastClose)))
    .slice(0, Math.max(2, Math.floor(maxLevels / 2)))
  let s = sortByDist(support, 'below')
  let r = sortByDist(resistance, 'above')
  // Guarantee at least 2 per side by supplementing with nearest lows/highs if needed
  if (s.length < 2) {
    const extra = dedup(lowsBelow.sort((a, b) => Math.abs(a - lastClose) - Math.abs(b - lastClose)))
    for (const v of extra) { if (s.length >= 2) break; if (!s.includes(v)) s.push(v) }
  }
  if (r.length < 2) {
    const extra = dedup(highsAbove.sort((a, b) => Math.abs(a - lastClose) - Math.abs(b - lastClose)))
    for (const v of extra) { if (r.length >= 2) break; if (!r.includes(v)) r.push(v) }
  }
  return { support: s.slice(0, Math.max(2, Math.floor(maxLevels / 2))), resistance: r.slice(0, Math.max(2, Math.floor(maxLevels / 2))) }
}

// --- QA helpers ---
function countGapBars(klines: Kline[] | undefined, intervalMs: number): number {
  try {
    if (!Array.isArray(klines) || klines.length <= 1) return 0
    const t = klines
      .map(k => Date.parse(k.openTime))
      .filter(v => Number.isFinite(v))
      .sort((a, b) => a - b)
    if (t.length <= 1) return 0
    let gaps = 0
    for (let i = 1; i < t.length; i++) {
      const delta = t[i] - t[i - 1]
      if (delta > intervalMs) {
        const missing = Math.floor(delta / intervalMs) - 1
        if (missing > 0) gaps += missing
      }
    }
    return gaps
  } catch {
    return 0
  }
}

function maxHighTodayFromM15(m15: Kline[] | undefined): number | null {
  if (!Array.isArray(m15) || m15.length === 0) return null
  const now = new Date()
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate()
  const start = Date.UTC(y, m, d, 0, 0, 0)
  let mx = -Infinity
  for (const k of m15) {
    const t = Date.parse(k.openTime)
    if (!Number.isFinite(t) || t < start) continue
    if (Number.isFinite(k.high) && k.high > mx) mx = k.high
  }
  return Number.isFinite(mx) && mx > 0 ? mx : null
}

function valueIsFiniteOrNull(x: number | null | undefined): boolean {
  return x == null || (Number.isFinite(x) && !Number.isNaN(x))
}

function hasIndicatorNaN(u: UniverseItem): boolean {
  const vals: Array<number | null | undefined> = [
    u.atr_pct_H1, u.atr_pct_M15, u.atr_h1, u.atr_m15,
    u.ema20_H1, u.ema50_H1, u.ema200_H1,
    u.ema20_M15, u.ema50_M15, u.ema200_M15,
    u.rsi_H1, u.rsi_M15,
    u.vwap_daily, u.vwap_rel_daily, u.vwap_today, u.vwap_rel_today
  ]
  for (const v of vals) {
    if (v == null) continue
    if (!Number.isFinite(v) || Number.isNaN(v)) return true
  }
  return false
}

function hasOutOfRangeIndicators(u: UniverseItem): string | null {
  if (u.rsi_H1 != null && (u.rsi_H1 < 0 || u.rsi_H1 > 100)) return 'rsi_h1_range'
  if (u.rsi_M15 != null && (u.rsi_M15 < 0 || u.rsi_M15 > 100)) return 'rsi_m15_range'
  if (u.atr_pct_H1 != null && (u.atr_pct_H1 <= 0 || u.atr_pct_H1 > 50)) return 'atr_pct_h1_range'
  if (u.atr_pct_M15 != null && (u.atr_pct_M15 <= 0 || u.atr_pct_M15 > 80)) return 'atr_pct_m15_range'
  return null
}

async function runWithConcurrency<T>(factories: Array<() => Promise<T>>, limit: number): Promise<Array<{ ok: true; value: T } | { ok: false; error: any }>> {
  const results: Array<{ ok: true; value: T } | { ok: false; error: any }> = []
  let idx = 0
  const inFlight: Promise<void>[] = []
  async function runOne(factory: () => Promise<T>) {
    try { const value = await factory(); results.push({ ok: true, value }) } catch (error) { results.push({ ok: false, error }) }
  }
  while (idx < factories.length || inFlight.length > 0) {
    while (idx < factories.length && inFlight.length < limit) {
      const p = runOne(factories[idx++])
      inFlight.push(p)
      p.finally(() => { const i = inFlight.indexOf(p); if (i >= 0) inFlight.splice(i, 1) })
    }
    if (inFlight.length > 0) await Promise.race(inFlight)
  }
  return results
}

// Simple mapLimit helper
async function mapLimit<T, R>(arr: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let index = 0
  const workers = Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (true) {
      const i = index++
      if (i >= arr.length) break
      results[i] = await fn(arr[i])
    }
  })
  await Promise.all(workers)
  return results
}

// REST-only builder – no WS cache access

export async function buildMarketRawSnapshot(opts?: { universeStrategy?: 'volume'|'gainers'; desiredTopN?: number; includeSymbols?: string[]; fresh?: boolean; allowPartial?: boolean }): Promise<MarketRawSnapshot> {
  const t0 = Date.now()
  const globalAc = new AbortController()
  const globalTimeout = setTimeout(() => globalAc.abort(), (config as any).globalDeadlineMs ?? 8000)
  const uniKlines: Record<string, { H1?: Kline[]; M15?: Kline[]; H4?: Kline[] }> = {}
  const exchangeFilters = await getExchangeInfo()
  const filteredSymbols = Object.keys(exchangeFilters)
  // Fixed target: always BTC+ETH + exactly N-2 alts (when possible)
  const desired = Number.isFinite(opts?.desiredTopN as any) && (opts!.desiredTopN as any) > 0 ? (opts!.desiredTopN as number) : config.universe.topN
  const altTarget = Math.max(0, desired - 2)
  // When includeSymbols provided, expand target to accommodate them
  const hasIncludeSymbols = Array.isArray(opts?.includeSymbols) && opts!.includeSymbols!.length > 0
  const effectiveAltTarget = hasIncludeSymbols ? Math.max(altTarget, altTarget + opts!.includeSymbols!.length) : altTarget
  // Pull a large candidate list (the endpoint returns all anyway)
  const strategy = (opts?.universeStrategy || (config as any)?.universe?.strategy || 'volume') as 'volume'|'gainers'
  const fresh = Boolean(opts?.fresh)
  const baseList = strategy === 'gainers' ? await getTopGainersUsdtSymbols(Math.max(200, desired * 10), fresh) : await getTopNUsdtSymbols(Math.max(200, desired * 10), fresh)
  const extendedCandidates = baseList
  const allAltCandidates = extendedCandidates.filter(s => s !== 'BTCUSDT' && s !== 'ETHUSDT' && filteredSymbols.includes(s))
  // Normalize includeSymbols and force them to the front of the alt list (if supported on futures USDT)
  const includeNorm = Array.from(new Set(((opts?.includeSymbols || []) as string[])
    .map(s => String(s || '').toUpperCase().replace('/', ''))
    .map(s => s.endsWith('USDT') ? s : `${s}USDT`)
    // Do NOT drop unknown symbols from include list – Strategy Updater may target any valid futures symbol
    // BTC/ETH are handled separately above
    .filter(s => s !== 'BTCUSDT' && s !== 'ETHUSDT')))
  // Merge include first, then candidate list without duplicates
  const mergedPref = includeNorm.concat(allAltCandidates.filter(s => !includeNorm.includes(s)))
  // Build universe symbol list
  const altSymbols: string[] = mergedPref.slice(0, effectiveAltTarget)
  const universeSymbols = altSymbols.slice()

  // Fetch klines via REST for BTC/ETH and alts
  let backfillCount = 0
  let dropsAlts: string[] = []

  const klinesTasks: Array<() => Promise<any>> = []
  const coreIntervals: Array<{ key: 'H4'|'H1'|'M15'; interval: string; limit: number }> = [
    { key: 'H4', interval: '4h', limit: (config as any).candles || 220 },
    { key: 'H1', interval: '1h', limit: (config as any).candles || 220 },
    { key: 'M15', interval: '15m', limit: (config as any).candles || 220 }
  ]
  for (const c of coreIntervals) klinesTasks.push(async () => ({ key: `btc.${c.key}`, k: await getKlines('BTCUSDT', c.interval, c.limit) }))
  for (const c of coreIntervals) klinesTasks.push(async () => ({ key: `eth.${c.key}`, k: await getKlines('ETHUSDT', c.interval, c.limit) }))
  // Lighter alt intervals to keep snapshot under maxSnapshotBytes
  const altH1Limit = Number((config as any)?.altH1Limit ?? 80)
  const altM15Limit = Number((config as any)?.altM15Limit ?? 96)
  const altIntervals: Array<{ key: 'H1'|'M15'; interval: string; limit: number }> = [
    { key: 'H1', interval: '1h', limit: altH1Limit },
    { key: 'M15', interval: '15m', limit: altM15Limit }
  ]
  for (const sym of universeSymbols) {
    for (const c of altIntervals) {
      klinesTasks.push(async () => {
        const k = await getKlines(sym, c.interval, c.limit)
        uniKlines[sym] = uniKlines[sym] || {}
        ;(uniKlines[sym] as any)[c.key] = k
        return { key: `${sym}.${c.key}`, k }
      })
    }
  }
  const klinesSettled = await runWithConcurrency(klinesTasks, config.concurrency)
  const btc: any = { klines: {} }, eth: any = { klines: {} }
  for (const s of klinesSettled) {
    if ((s as any).ok) {
      const r = (s as any).value
      const [left, right] = r.key.split('.')
      if (left === 'btc') (btc.klines as any)[right] = r.k
      else if (left === 'eth') (eth.klines as any)[right] = r.k
      else { const sym = left; if (!uniKlines[sym]) uniKlines[sym] = {}; (uniKlines[sym] as any)[right] = r.k }
    }
  }

  // Funding & OI now
  const fundingMap: Record<string, number | undefined> = {}
  const oiNowMap: Record<string, number | undefined> = {}
  const oiChangeMap: Record<string, number | undefined> = {}
  const coreSymbols = ['BTCUSDT', 'ETHUSDT']

  // Cold-start guard: pokud ještě nemáme H1 data pro významnou část altů,
  // omezíme side-dotazy (funding/OI/oiChg) jen na BTC/ETH, aby první volání bylo rychlé a stabilní.
  const altH1ReadyCount = universeSymbols.reduce((acc, s) => {
    const h1 = (uniKlines[s]?.H1 || []) as Kline[]
    return acc + (Array.isArray(h1) && h1.length > 0 ? 1 : 0)
  }, 0)
  const coldStart = altH1ReadyCount < Math.max(8, Math.floor(universeSymbols.length * 0.25))

  const fundingSymbolsBase = (config as any).fundingMode === 'coreOnly' ? coreSymbols : universeSymbols.concat(coreSymbols)
  const oiSymbolsBase = (config as any).openInterestMode === 'coreOnly' ? coreSymbols : universeSymbols.concat(coreSymbols)

  const fundingSymbols = coldStart ? coreSymbols : fundingSymbolsBase
  const oiSymbols = coldStart ? coreSymbols : oiSymbolsBase

  const sideTasks: Array<() => Promise<any>> = []
  for (const s of fundingSymbols) { sideTasks.push(() => getFundingRate(s).then(v => ({ type: 'fund', s, v }))) }
  for (const s of oiSymbolsBase) { sideTasks.push(() => getOpenInterestNow(s).then(v => ({ type: 'oi', s, v }))) }
  // OI hist change 1h – rozšiř na celý výběr (možno zredukovat dle výkonu v configu)
  const oiHistSymbols = oiSymbolsBase
  for (const s of oiHistSymbols) { sideTasks.push(() => getOpenInterestHistChange1h(s).then(v => ({ type: 'oiChg', s, v }))) }

  const sideSettled = await runWithConcurrency(sideTasks, config.concurrency)
  for (const r of sideSettled) {
    if ((r as any).ok) {
      const v = (r as any).value
      if (v.type === 'fund') fundingMap[v.s] = v.v
      if (v.type === 'oi') oiNowMap[v.s] = v.v
      if (v.type === 'oiChg') oiChangeMap[v.s] = v.v
    }
  }

  const latencyMs = Date.now() - t0

  const tickerMap = await (async () => {
    try {
      const map = await get24hTickerMap()
      return map
    } catch {
      return await get24hTickerMap()
    }
  })()

  const universe: UniverseItem[] = []
  const warnings: string[] = []
  let coreIssues = false
  const hasCore = (sym: 'BTCUSDT'|'ETHUSDT') => {
    const core = sym === 'BTCUSDT' ? (btc.klines as any) : (eth.klines as any)
    return !!(core?.H1 && core?.H4 && core?.M15 && core.H1.length && core.H4.length && core.M15.length)
  }
  const hasAlt = (sym: string) => Array.isArray(uniKlines[sym]?.H1) && (uniKlines[sym] as any).H1.length > 0
  for (const sym of ['BTCUSDT', 'ETHUSDT']) {
    const core = sym === 'BTCUSDT' ? (btc.klines as any) : (eth.klines as any)
    const coreOkNow = !!(core?.H1 && core?.H4 && core.H1.length && core.H4.length)
    if (!coreOkNow) { warnings.push(`drop:core:no_klines:${sym}`); continue }
    const item: UniverseItem = { symbol: sym, klines: { H1: core?.H1, M15: core?.M15 }, funding: fundingMap[sym], oi_now: oiNowMap[sym], oi_hist: [], depth1pct_usd: undefined, spread_bps: undefined, volume24h_usd: tickerMap[sym]?.volume24h_usd, price: tickerMap[sym]?.lastPrice, exchange: 'Binance', market_type: 'perp', fees_bps: null, tick_size: (exchangeFilters as any)?.[sym]?.tickSize ?? null }
    // Analytics
    const h1 = item.klines.H1 || []
    const m15 = item.klines.M15 || []
    const closeH1 = h1.map(k => k.close)
    const closeM15 = m15.map(k => k.close)
    item.atr_pct_H1 = atrPct(h1)
    item.atr_pct_M15 = atrPct(m15)
    item.atr_h1 = item.atr_pct_H1 != null && h1.length ? (item.atr_pct_H1 / 100) * h1[h1.length - 1].close : null
    item.atr_m15 = item.atr_pct_M15 != null && m15.length ? (item.atr_pct_M15 / 100) * m15[m15.length - 1].close : null
    item.ema20_H1 = ema(closeH1, 20)
    item.ema50_H1 = ema(closeH1, 50)
    item.ema200_H1 = ema(closeH1, 200)
    item.ema20_M15 = ema(closeM15, 20)
    item.ema50_M15 = ema(closeM15, 50)
    item.ema200_M15 = ema(closeM15, 200)
    item.ema_h1 = { 20: item.ema20_H1, 50: item.ema50_H1, 200: item.ema200_H1 }
    item.ema_m15 = { 20: item.ema20_M15, 50: item.ema50_M15, 200: item.ema200_M15 }
    item.rsi_H1 = rsi(closeH1, 14)
    item.rsi_M15 = rsi(closeM15, 14)
    item.oi_change_1h_pct = oiChangeMap[sym]
    item.funding_8h_pct = Number.isFinite(item.funding as any) ? (item.funding as any) * 100 : null
    const vwap = computeDailyVwapFromM15(m15)
    item.vwap_daily = vwap.vwap
    item.vwap_rel_daily = vwap.rel
    item.vwap_today = vwap.vwap
    item.vwap_rel_today = vwap.rel
    const sr = computeSRLevels(h1)
    item.support = sr.support
    item.resistance = sr.resistance
    // QA: core gaps and indicators sanity
    const gapH1 = countGapBars(h1, 60 * 60 * 1000)
    const gapM15 = countGapBars(m15, 15 * 60 * 1000)
    if (gapH1 > 0) { warnings.push(`core:gaps:H1:${sym}:missing=${gapH1}`); coreIssues = true }
    if (gapM15 > 0) { warnings.push(`core:gaps:M15:${sym}:missing=${gapM15}`); coreIssues = true }
    if (hasIndicatorNaN(item)) { warnings.push(`core:nan_indicators:${sym}`); coreIssues = true }
    const rangeErr = hasOutOfRangeIndicators(item)
    if (rangeErr) { warnings.push(`core:${rangeErr}:${sym}`); coreIssues = true }
    const mxToday = maxHighTodayFromM15(m15)
    if (item.vwap_today != null && mxToday != null && item.vwap_today > mxToday) { warnings.push(`core:vwap_gt_maxHigh:${sym}:${item.vwap_today}`); coreIssues = true }
    // Gap/context
    item.prev_day_close = (() => {
      if (!m15.length) return null
      const last = m15[m15.length - 1]
      const d = new Date(last.openTime)
      d.setUTCDate(d.getUTCDate() - 1); d.setUTCHours(23, 59, 59, 999)
      // fallback: approximate by H1 close 24 bars back
      const h1c = h1.length >= 24 ? h1[h1.length - 24].close : null
      return h1c ?? null
    })()
    item.h4_high = Array.isArray((btc as any)?.klines?.H4) ? Math.max(...((btc as any).klines.H4 as Kline[]).map(k=>k.high)) : null
    item.h4_low = Array.isArray((btc as any)?.klines?.H4) ? Math.min(...((btc as any).klines.H4 as Kline[]).map(k=>k.low)) : null
    item.d1_high = null
    item.d1_low = null
    // Propagate computed indicators and market fields back to core btc/eth
    const coreTarget = (sym === 'BTCUSDT') ? (btc as any) : (eth as any)
    coreTarget.funding = item.funding
    coreTarget.oi_now = item.oi_now
    coreTarget.oi_change_1h_pct = item.oi_change_1h_pct
    coreTarget.funding_8h_pct = item.funding_8h_pct
    coreTarget.atr_pct_H1 = item.atr_pct_H1
    coreTarget.atr_pct_M15 = item.atr_pct_M15
    coreTarget.atr_h1 = item.atr_h1
    coreTarget.atr_m15 = item.atr_m15
    coreTarget.ema20_H1 = item.ema20_H1
    coreTarget.ema50_H1 = item.ema50_H1
    coreTarget.ema200_H1 = item.ema200_H1
    coreTarget.ema20_M15 = item.ema20_M15
    coreTarget.ema50_M15 = item.ema50_M15
    coreTarget.ema200_M15 = item.ema200_M15
    coreTarget.rsi_H1 = item.rsi_H1
    coreTarget.rsi_M15 = item.rsi_M15
    coreTarget.vwap_today = item.vwap_today
    coreTarget.vwap_daily = item.vwap_daily
    coreTarget.vwap_rel_today = item.vwap_rel_today
    coreTarget.vwap_rel_daily = item.vwap_rel_daily
    coreTarget.volume24h_usd = item.volume24h_usd
    coreTarget.price = item.price
    coreTarget.support = item.support
    coreTarget.resistance = item.resistance
  }
  for (const sym of universeSymbols) {
    if (!hasAlt(sym) && !(opts as any)?.allowPartial) {
      // Keep explicitly included symbols even without H1 if allowPartial OR includeSymbols requested
      const isExplicitInclude = Array.isArray(opts?.includeSymbols) && opts!.includeSymbols!.some(s=>{
        try { const ns = String(s||'').toUpperCase().replace('/',''); return (ns.endsWith('USDT')?ns:`${ns}USDT`) === sym } catch { return false }
      })
      if (!isExplicitInclude) { warnings.push(`drop:alt:noH1:${sym}`); continue }
    }
    const item: UniverseItem = { symbol: sym, klines: { H1: (uniKlines[sym]?.H1 || []), M15: (uniKlines[sym]?.M15 || []) }, funding: fundingMap[sym], oi_now: oiNowMap[sym], oi_hist: [], depth1pct_usd: undefined, spread_bps: undefined, volume24h_usd: tickerMap[sym]?.volume24h_usd, price: tickerMap[sym]?.lastPrice, exchange: 'Binance', market_type: 'perp', fees_bps: null, tick_size: (exchangeFilters as any)?.[sym]?.tickSize ?? null }
    // Attach explicit price origin metadata
    ;(item as any).price_origin = 'last'
    ;(item as any).price_ts = new Date().toISOString()
    // Analytics for alts
    const h1 = item.klines.H1 || []
    const m15 = item.klines.M15 || []
    const closeH1 = h1.map(k => k.close)
    const closeM15 = m15.map(k => k.close)
    item.atr_pct_H1 = atrPct(h1)
    item.atr_pct_M15 = atrPct(m15)
    item.atr_h1 = item.atr_pct_H1 != null && h1.length ? (item.atr_pct_H1 / 100) * h1[h1.length - 1].close : null
    item.atr_m15 = item.atr_pct_M15 != null && m15.length ? (item.atr_pct_M15 / 100) * m15[m15.length - 1].close : null
    item.ema20_H1 = ema(closeH1, 20)
    item.ema50_H1 = ema(closeH1, 50)
    item.ema200_H1 = ema(closeH1, 200)
    item.ema20_M15 = ema(closeM15, 20)
    item.ema50_M15 = ema(closeM15, 50)
    item.ema200_M15 = ema(closeM15, 200)
    item.ema_h1 = { 20: item.ema20_H1, 50: item.ema50_H1, 200: item.ema200_H1 }
    item.ema_m15 = { 20: item.ema20_M15, 50: item.ema50_M15, 200: item.ema200_M15 }
    item.rsi_H1 = rsi(closeH1, 14)
    item.rsi_M15 = rsi(closeM15, 14)
    item.oi_change_1h_pct = oiChangeMap[sym]
    item.funding_8h_pct = Number.isFinite(item.funding as any) ? (item.funding as any) * 100 : null
    const vwap = computeDailyVwapFromM15(m15)
    item.vwap_daily = vwap.vwap
    item.vwap_rel_daily = vwap.rel
    item.vwap_today = vwap.vwap
    item.vwap_rel_today = vwap.rel
    const sr = computeSRLevels(h1)
    item.support = sr.support
    item.resistance = sr.resistance
    // Gap/context
    item.prev_day_close = (() => {
      if (!m15.length) return null
      const last = m15[m15.length - 1]
      const d = new Date(last.openTime)
      d.setUTCDate(d.getUTCDate() - 1); d.setUTCHours(23, 59, 59, 999)
      const h1c = h1.length >= 24 ? h1[h1.length - 24].close : null
      return h1c ?? null
    })()
    item.h4_high = Array.isArray(h1) ? Math.max(...h1.map(k=>k.high)) : null
    item.h4_low = Array.isArray(h1) ? Math.min(...h1.map(k=>k.low)) : null
    item.d1_high = null
    item.d1_low = null
    // QA guards for alts: no gaps, finite indicators, reasonable ranges, VWAP <= max(high)
    const gapH1 = countGapBars(h1, 60 * 60 * 1000)
    if (gapH1 > 0) { warnings.push(`drop:alt:gaps:H1:${sym}:missing=${gapH1}`); continue }
    const gapM15 = m15.length ? countGapBars(m15, 15 * 60 * 1000) : 0
    if (gapM15 > 0) { warnings.push(`drop:alt:gaps:M15:${sym}:missing=${gapM15}`); continue }
    if (hasIndicatorNaN(item)) { warnings.push(`drop:alt:nan_indicators:${sym}`); continue }
    const rangeErr = hasOutOfRangeIndicators(item)
    if (rangeErr) { warnings.push(`drop:alt:${rangeErr}:${sym}`); continue }
    const mxToday = maxHighTodayFromM15(m15)
    if (item.vwap_today != null && mxToday != null && item.vwap_today > mxToday) { warnings.push(`drop:alt:vwap_gt_maxHigh:${sym}:${item.vwap_today}>${mxToday}`); continue }
    universe.push(item)
  }
  // Enforce fixed size: require exactly 28 alts in the universe (unless includeSymbols override)
  if (universe.length !== altTarget && !hasIncludeSymbols) {
    if (!(opts as any)?.allowPartial) {
      const err: any = new Error('UNIVERSE_INCOMPLETE')
      err.stage = 'universe_incomplete'
      err.expected = altTarget
      err.actual = universe.length
      throw err
    }
  }

  const latestTimes: number[] = []
  const pushTime = (iso?: string) => { if (iso) latestTimes.push(Date.parse(iso)) }
  for (const arr of [btc.klines?.M15, eth.klines?.M15]) { const last = Array.isArray(arr) ? arr[arr.length - 1] : undefined; pushTime(last?.closeTime) }
  for (const sym of universe) { const last2 = sym.klines?.M15?.[sym.klines?.M15.length - 1]; pushTime(last2?.closeTime) }
  const feedsOk = latestTimes.every(t => (Date.now() - t) <= (config.staleThresholdSec * 1000))

  // Orderbook/Spread data (best-effort)
  try {
    if (String((config as any).depthMode || '').toLowerCase() !== 'none') {
      const obSymbols = universeSymbols.concat(coreSymbols)
      const tasks: Array<() => Promise<{ s: string; spread?: number; d05?: { bids: number; asks: number } | undefined; d1?: { bids: number; asks: number } | undefined }>> = []
      for (const s of obSymbols) {
        tasks.push(async () => {
          const [bt, ob] = await Promise.all([getBookTicker(s), getOrderBook(s, (config as any)?.orderbook?.limit || 50)])
          const spread = calcSpreadBps(bt.bid, bt.ask)
          const mid = (bt.bid && bt.ask) ? ((bt.bid + bt.ask) / 2) : (tickerMap[s]?.lastPrice || 0)
          const d05 = ob && mid ? calcDepthWithinPctUSD(ob.bids, ob.asks, mid, 0.005) : undefined
          const d1 = ob && mid ? calcDepthWithinPctUSD(ob.bids, ob.asks, mid, 0.01) : undefined
          return { s, spread, d05, d1 }
        })
      }
      const obSettled = await runWithConcurrency(tasks, Math.min(8, (config as any).concurrency || 8))
      for (const r of obSettled) {
        if ((r as any).ok) {
          const { s, spread, d05, d1 } = (r as any).value
          const target = s === 'BTCUSDT' ? (btc as any) : s === 'ETHUSDT' ? (eth as any) : (universe.find(u => u.symbol === s) as any)
          if (target) {
            if (spread != null) target.spread_bps = spread
            if (d05) target.liquidity_usd_0_5pct = d05
            if (d1) target.liquidity_usd_1pct = d1
            // Use strictly 1% window for liquidity_usd; no spot/no 0.5% fallback
            if (d1) {
              const total = (d1.bids + d1.asks)
              if (Number.isFinite(total) && total > 0) target.liquidity_usd = total
            }
          }
        }
      }
    }
  } catch {}

  // Strict liquidity/spread filter for alts (post-orderbook metrics)
  try {
    const filt = (config as any)?.universeFilter || {}
    if (filt.enabled) {
      const maxSpread = Number(filt.max_spread_bps ?? Infinity)
      const minLiq = Number(filt.min_liquidity_usd ?? 0)
      const before = universe.length
      const kept: UniverseItem[] = []
      for (const u of universe) {
        const spread = (u as any).spread_bps
        const liq05b = (u as any)?.liquidity_usd_0_5pct?.bids ?? 0
        const liq05a = (u as any)?.liquidity_usd_0_5pct?.asks ?? 0
        const liq05 = (liq05b + liq05a)
        const ok = Number.isFinite(spread as any) && (spread as number) <= maxSpread && liq05 >= minLiq
        if (ok) kept.push(u)
        else warnings.push(`drop:alt:liq_spread:${u.symbol}:liq05=${liq05}:spread=${(spread as any) ?? 'na'}`)
      }
      if (kept.length !== before) {
        // Replace universe with filtered list; BTC/ETH unaffected
        universe.splice(0, universe.length, ...kept)
      }
    }
  } catch {}

  // BTC/ETH regime filter + ticker data
  try {
    const regimeFor = (set: any) => {
      const h1 = Array.isArray(set?.klines?.H1) ? set.klines.H1 as Kline[] : []
      const m15 = Array.isArray(set?.klines?.M15) ? set.klines.M15 as Kline[] : []
      const h1c = h1.length ? h1[h1.length - 1].close : null
      const h1p = h1.length > 1 ? h1[h1.length - 2].close : null
      const m15c = m15.length ? m15[m15.length - 1].close : null
      const pct = (h1c != null && h1p != null) ? ((h1c / h1p) - 1) * 100 : null
      return { h1_close: h1c ?? null, m15_close: m15c ?? null, pct_change_1h: pct ?? null }
    }
    ;(btc as any).regime = regimeFor(btc)
    ;(eth as any).regime = regimeFor(eth)
    
    // Add ticker data to BTC/ETH objects
    const btcTicker = tickerMap['BTCUSDT']
    const ethTicker = tickerMap['ETHUSDT']
    
    if (btcTicker) {
      ;(btc as any).price = btcTicker.lastPrice
      ;(btc as any).volume24h_usd = btcTicker.volume24h_usd
      ;(btc as any).volume24h_btc = btcTicker.volume
      ;(btc as any).priceChange = btcTicker.priceChange
      ;(btc as any).priceChangePercent = btcTicker.priceChangePercent
    }
    
    if (ethTicker) {
      ;(eth as any).price = ethTicker.lastPrice
      ;(eth as any).volume24h_usd = ethTicker.volume24h_usd
      ;(eth as any).volume24h_eth = ethTicker.volume
      ;(eth as any).priceChange = ethTicker.priceChange
      ;(eth as any).priceChangePercent = ethTicker.priceChangePercent
    }
  } catch {}

  // Policy
  const policy = {
    max_hold_minutes: Number((signalsCfg as any)?.expires_in_min ?? null) || undefined,
    risk_per_trade_pct: (signalsCfg as any)?.risk_pct_by_posture || undefined,
    risk_per_trade_pct_flat: Number((signalsCfg as any)?.risk_pct ?? null) || undefined,
    max_leverage: Number((deciderCfg as any)?.final_picker?.max_leverage ?? null) || undefined
  }

  const snapshot: MarketRawSnapshot = {
    timestamp: new Date().toISOString(),
    latency_ms: latencyMs,
    feeds_ok: (feedsOk && !coreIssues),
    data_warnings: warnings,
    btc, eth, universe, exchange_filters: exchangeFilters,
    policy,
    exchange: 'Binance',
    market_type: 'perp',
    regime: {
      BTCUSDT: { h1_change_pct: (()=>{ try { const h1 = (btc as any)?.klines?.H1 as Kline[]; return (h1?.length>1 && Number.isFinite(h1[h1.length-2]?.close) && Number.isFinite(h1[h1.length-1]?.close)) ? (((h1[h1.length-1].close / h1[h1.length-2].close) - 1) * 100) : null } catch { return null } })() },
      ETHUSDT: { h1_change_pct: (()=>{ try { const h1 = (eth as any)?.klines?.H1 as Kline[]; return (h1?.length>1 && Number.isFinite(h1[h1.length-2]?.close) && Number.isFinite(h1[h1.length-1]?.close)) ? (((h1[h1.length-1].close / h1[h1.length-2].close) - 1) * 100) : null } catch { return null } })() }
    }
  }
  ;(globalThis as any).__perf_last_snapshot = {
    drops_noH1: dropsAlts.length ? dropsAlts : warnings.filter(w => w.startsWith('drop:alt:noH1:')).map(w => w.split(':').pop() as string),
    lastBackfillCount: backfillCount,
    includedSymbolsCount: 2 + universe.length
  }
  const json = JSON.stringify(snapshot)
  if (!clampSnapshotSize(json, config.maxSnapshotBytes)) throw new Error('Snapshot too large')
  clearTimeout(globalTimeout)
  return snapshot
}

async function get24hTickerMap(): Promise<Record<string, { volume24h_usd?: number; lastPrice?: number; closeTimeMs?: number }>> {
  const data = await withRetry(() => httpGet('/fapi/v1/ticker/24hr'), config.retry)
  const out: Record<string, { volume24h_usd?: number; lastPrice?: number; closeTimeMs?: number }> = {}
  if (Array.isArray(data)) {
    for (const t of data) {
      const sym = t?.symbol
      if (!sym || !String(sym).endsWith('USDT')) continue
      const quoteVol = toNumber(t?.quoteVolume)
      const lastPrice = toNumber(t?.lastPrice)
      const closeTimeMs = toNumber(t?.closeTime)
      out[String(sym)] = {
        volume24h_usd: Number.isFinite(quoteVol as any) ? (quoteVol as number) : undefined,
        lastPrice: Number.isFinite(lastPrice as any) ? (lastPrice as number) : undefined,
        closeTimeMs: Number.isFinite(closeTimeMs as any) ? (closeTimeMs as number) : undefined
      }
    }
  }
  return out
}


