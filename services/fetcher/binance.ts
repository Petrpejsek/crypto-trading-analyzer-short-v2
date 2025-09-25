import config from '../../config/fetcher.json'
import type { MarketRawSnapshot, Kline, ExchangeFilters, UniverseItem } from '../../types/market_raw'
import { calcDepthWithin1PctUSD, calcSpreadBps, clampSnapshotSize, toNumber, toUtcIso } from './normalize'

// Use Vite dev proxy to avoid CORS in browser
const BASE_URL = '/binance'

type RetryConfig = {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

async function withRetry<T>(fn: () => Promise<T>, retryCfg: RetryConfig): Promise<T> {
  let attempt = 0
  let lastError: any
  while (attempt < retryCfg.maxAttempts) {
    try {
      return await fn()
    } catch (e: any) {
      lastError = e
      attempt += 1
      if (attempt >= retryCfg.maxAttempts) break
      const delay = Math.min(retryCfg.baseDelayMs * Math.pow(2, attempt - 1), retryCfg.maxDelayMs)
      await sleep(delay)
    }
  }
  throw lastError
}

async function binanceGet(path: string, params?: Record<string, string | number>): Promise<any> {
  const qs = params ? new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : ''
  const url = `${BASE_URL}${path}${qs ? `?${qs}` : ''}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${path}`)
    }
    const data = await res.json()
    return data
  } finally {
    clearTimeout(timeout)
  }
}

async function getServerTime(): Promise<number> {
  const data = await withRetry(() => binanceGet('/fapi/v1/time'), config.retry)
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

let exchangeInfoCache: ExchangeFilters | null = null
async function getExchangeInfo(): Promise<ExchangeFilters> {
  if (exchangeInfoCache) return exchangeInfoCache
  const data = await withRetry(() => binanceGet('/fapi/v1/exchangeInfo'), config.retry)
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
  exchangeInfoCache = filters
  return filters
}

async function getTopNUsdtSymbols(n: number): Promise<string[]> {
  // Use 24h ticker to sort by quoteVolume
  const data = await withRetry(() => binanceGet('/fapi/v1/ticker/24hr'), config.retry)
  const entries = Array.isArray(data) ? data : []
  const filtered = entries.filter((e: any) => e?.symbol?.endsWith('USDT'))
  const sorted = filtered.sort((a: any, b: any) => {
    const va = Number(a.quoteVolume)
    const vb = Number(b.quoteVolume)
    if (vb !== va) return vb - va
    // Secondary key for determinism when volumes are equal
    return String(a.symbol).localeCompare(String(b.symbol))
  })
  const unique = Array.from(new Set(sorted.map((e: any) => e.symbol)))
  return unique.slice(0, n)
}

async function getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
  // Use standard klines on symbol to avoid continuous contract quirks
  const raw = await withRetry(() => binanceGet('/fapi/v1/klines', { symbol, interval, limit }), config.retry)
  if (!Array.isArray(raw)) return []
  return raw.map((k: any) => ({
    openTime: toUtcIso(k[0])!,
    open: toNumber(k[1])!,
    high: toNumber(k[2])!,
    low: toNumber(k[3])!,
    close: toNumber(k[4])!,
    volume: toNumber(k[5])!,
    closeTime: toUtcIso(k[6])!
  })).filter(k => Number.isFinite(k.open) && Number.isFinite(k.close))
}

async function getFundingRate(symbol: string): Promise<number | undefined> {
  const data = await withRetry(() => binanceGet('/fapi/v1/fundingRate', { symbol, limit: 1 }), config.retry)
  if (!Array.isArray(data) || data.length === 0) return undefined
  return toNumber(data[0]?.fundingRate)
}

async function getOpenInterestNow(symbol: string): Promise<number | undefined> {
  const data = await withRetry(() => binanceGet('/fapi/v1/openInterest', { symbol }), config.retry)
  return toNumber(data?.openInterest)
}

async function getOpenInterestHist(symbol: string, period: '15m' | '1h' | '4h' = '15m', limit = 24): Promise<Array<{ timestamp: string; value: number }>> {
  const data = await withRetry(() => binanceGet('/futures/data/openInterestHist', { symbol, period, limit }), config.retry)
  if (!Array.isArray(data)) return []
  return data.map((r: any) => ({ timestamp: toUtcIso(r?.timestamp)!, value: toNumber(r?.sumOpenInterest) || toNumber(r?.sumOpenInterestValue) || toNumber(r?.openInterest) || 0 }))
    .filter(r => Number.isFinite(r.value))
}

async function getDepth(symbol: string, limit: number): Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]>; bestBid?: number; bestAsk?: number }> {
  const data = await withRetry(() => binanceGet('/fapi/v1/depth', { symbol, limit }), config.retry)
  const bids = Array.isArray(data?.bids) ? data.bids.map((b: any) => [toNumber(b[0])!, toNumber(b[1])!]).filter((x: any) => x.every((v: any) => Number.isFinite(v))) : []
  const asks = Array.isArray(data?.asks) ? data.asks.map((a: any) => [toNumber(a[0])!, toNumber(a[1])!]).filter((x: any) => x.every((v: any) => Number.isFinite(v))) : []
  const bestBid = bids[0]?.[0]
  const bestAsk = asks[0]?.[0]
  return { bids, asks, bestBid, bestAsk }
}

async function get24hTickerMap(): Promise<Record<string, { volume24h_usd?: number; lastPrice?: number; closeTimeMs?: number }>> {
  const data = await withRetry(() => binanceGet('/fapi/v1/ticker/24hr'), config.retry)
  const out: Record<string, { volume24h_usd?: number; lastPrice?: number; closeTimeMs?: number }> = {}
  if (Array.isArray(data)) {
    for (const t of data) {
      const sym = t?.symbol
      if (!sym || !sym.endsWith('USDT')) continue
      const quoteVol = toNumber(t?.quoteVolume)
      const lastPrice = toNumber(t?.lastPrice)
      const closeTimeMs = toNumber(t?.closeTime)
      out[sym] = { volume24h_usd: quoteVol, lastPrice, closeTimeMs }
    }
  }
  return out
}

function isFresh(nowMs: number, timestampsMs: number[], staleThresholdSec: number): boolean {
  const maxAgeMs = staleThresholdSec * 1000
  for (const t of timestampsMs) {
    if (nowMs - t > maxAgeMs) return false
  }
  return true
}

function record<T>(warnings: string[], condition: boolean, message: string) {
  if (!condition) warnings.push(message)
}

async function runWithConcurrency<T>(
  factories: Array<() => Promise<T>>,
  limit: number
): Promise<Array<{ ok: true; value: T } | { ok: false; error: any }>> {
  const results: Array<{ ok: true; value: T } | { ok: false; error: any }> = []
  let idx = 0
  const inFlight: Promise<void>[] = []
  async function runOne(factory: () => Promise<T>) {
    try {
      const value = await factory()
      results.push({ ok: true, value })
    } catch (error) {
      results.push({ ok: false, error })
    }
  }
  while (idx < factories.length || inFlight.length > 0) {
    while (idx < factories.length && inFlight.length < limit) {
      const p = runOne(factories[idx++])
      inFlight.push(p)
      p.finally(() => {
        const i = inFlight.indexOf(p)
        if (i >= 0) inFlight.splice(i, 1)
      })
    }
    if (inFlight.length > 0) await Promise.race(inFlight)
  }
  return results
}

export async function buildMarketRawSnapshot(): Promise<MarketRawSnapshot> {
  const t0Local = Date.now()
  const t0Server = await getServerTime()
  const exchangeFilters = await getExchangeInfo()
  const filteredSymbols = Object.keys(exchangeFilters)
  const allFuturesUSDT = filteredSymbols.length
  const topN = await getTopNUsdtSymbols(config.universe.topN)

  const tickMapSymbols = new Set(filteredSymbols)
  const preUniverseSymbols = topN.filter(s => tickMapSymbols.has(s) && s !== 'BTCUSDT' && s !== 'ETHUSDT')
  const universeSymbols = preUniverseSymbols.slice(0, config.universe.topN)
  const topNSelected = universeSymbols.length

  const warnings: string[] = []

  const klinesTasks: Array<() => Promise<any>> = []
  const addTask = (f: () => Promise<any>) => klinesTasks.push(f)

  const { H4, H1, M15 } = config.klines.btceth
  addTask(() => getKlines('BTCUSDT', H4.interval, H4.limit).then(k => ({ key: 'btc.H4', k })))
  addTask(() => getKlines('BTCUSDT', H1.interval, H1.limit).then(k => ({ key: 'btc.H1', k })))
  addTask(() => getKlines('BTCUSDT', M15.interval, M15.limit).then(k => ({ key: 'btc.M15', k })))
  addTask(() => getKlines('ETHUSDT', H4.interval, H4.limit).then(k => ({ key: 'eth.H4', k })))
  addTask(() => getKlines('ETHUSDT', H1.interval, H1.limit).then(k => ({ key: 'eth.H1', k })))
  addTask(() => getKlines('ETHUSDT', M15.interval, M15.limit).then(k => ({ key: 'eth.M15', k })))

  const uniK = config.klines.universe
  for (const sym of universeSymbols) {
    addTask(() => getKlines(sym, uniK.H1.interval, uniK.H1.limit).then(k => ({ key: `${sym}.H1`, k })))
    addTask(() => getKlines(sym, uniK.M15.interval, uniK.M15.limit).then(k => ({ key: `${sym}.M15`, k })))
  }

  const klinesSettled = await runWithConcurrency(klinesTasks, config.concurrency)
  const btc: any = { klines: {} }
  const eth: any = { klines: {} }
  const uniKlines: Record<string, { H1?: Kline[]; M15?: Kline[] }> = {}
  let klinesOk = 0
  for (const s of klinesSettled) {
    if (!s) continue
    if ((s as any).ok) {
      const r = (s as any).value
      if (!r || !r.key) continue
      const [left, right] = r.key.split('.')
      if (left === 'btc') {
        btc.klines[right] = r.k
      } else if (left === 'eth') {
        eth.klines[right] = r.k
      } else if (left.endsWith('USDT')) {
        const sym = left
        if (!uniKlines[sym]) uniKlines[sym] = {}
        ;(uniKlines[sym] as any)[right] = r.k
      }
      if (Array.isArray(r.k) && r.k.length > 0) klinesOk += 1
    } else {
      warnings.push('Klines fetch failed for one or more series')
    }
  }

  // Funding, OI, Depth, 24h ticker
  // Funding
  const fundingMap: Record<string, number | undefined> = {}
  const fundingTasks = universeSymbols.concat(['BTCUSDT', 'ETHUSDT']).map((s) => () => getFundingRate(s).then(v => ({ s, v })))
  const fundingSettled = await runWithConcurrency(fundingTasks, config.concurrency)
  for (const r of fundingSettled) {
    if ((r as any).ok) {
      const { s, v } = (r as any).value
      fundingMap[s] = v
    } else {
      warnings.push('Funding fetch failed for one or more symbols')
    }
  }

  // Open interest now
  const oiNowMap: Record<string, number | undefined> = {}
  const oiNowTasks = universeSymbols.concat(['BTCUSDT', 'ETHUSDT']).map((s) => () => getOpenInterestNow(s).then(v => ({ s, v })))
  const oiNowSettled = await runWithConcurrency(oiNowTasks, config.concurrency)
  for (const r of oiNowSettled) {
    if ((r as any).ok) {
      const { s, v } = (r as any).value
      oiNowMap[s] = v
    } else {
      warnings.push('Open interest (now) fetch failed for one or more symbols')
    }
  }

  // Open interest hist
  // OI historie dočasně vypnuto (rychlost)
  const oiHistMap: Record<string, Array<{ timestamp: string; value: number }>> = {}

  // Depth (respect depthMode)
  const depthMap: Record<string, { bids: Array<[number, number]>; asks: Array<[number, number]>; bestBid?: number; bestAsk?: number }> = {}
  let depthOk = 0
  if (config.depthMode !== 'none') {
    const depthTasks = ['BTCUSDT', 'ETHUSDT'].map((s) => () => getDepth(s, config.orderbook.limit).then(v => ({ s, v })))
    const depthSettled = await runWithConcurrency(depthTasks, config.concurrency)
    for (const r of depthSettled) {
      if ((r as any).ok) {
        const { s, v } = (r as any).value
        depthMap[s] = v
        if ((v?.bids?.length ?? 0) > 0 && (v?.asks?.length ?? 0) > 0) depthOk += 1
      } else {
        warnings.push('Orderbook depth fetch failed for one or more symbols')
      }
    }
  }

  const tickerMap = await get24hTickerMap()

  // Compose universe
  const universe: UniverseItem[] = []

  const allSymbols = ['BTCUSDT', 'ETHUSDT', ...universeSymbols]
  for (const sym of allSymbols) {
    if (!exchangeFilters[sym]) {
      warnings.push(`Missing exchangeInfo for ${sym}`)
      if (sym === 'BTCUSDT' || sym === 'ETHUSDT') continue
    }
    const depth = depthMap[sym]
    const spread = calcSpreadBps(depth?.bestBid, depth?.bestAsk)
    const lastPrice = tickerMap[sym]?.lastPrice
    const depthBoth = depth?.bids && depth?.asks && lastPrice ? calcDepthWithin1PctUSD(depth.bids, depth.asks, lastPrice, 0) : undefined
    const depth1pctNumber = depthBoth ? Math.min(depthBoth.bids, depthBoth.asks) : undefined

    const item: UniverseItem = sym === 'BTCUSDT' || sym === 'ETHUSDT'
      ? ({
          symbol: sym,
          klines: { H1: undefined, M15: undefined },
          funding: fundingMap[sym],
          oi_now: oiNowMap[sym],
          oi_hist: oiHistMap[sym],
          depth1pct_usd: depth1pctNumber,
          spread_bps: spread,
          volume24h_usd: tickerMap[sym]?.volume24h_usd
        })
      : ({
          symbol: sym,
          klines: { H1: uniKlines[sym]?.H1, M15: uniKlines[sym]?.M15 },
          funding: fundingMap[sym],
          oi_now: oiNowMap[sym],
          oi_hist: oiHistMap[sym],
          depth1pct_usd: depth1pctNumber,
          spread_bps: spread,
          volume24h_usd: tickerMap[sym]?.volume24h_usd
        })

    if (sym !== 'BTCUSDT' && sym !== 'ETHUSDT') universe.push(item)
    if (sym === 'BTCUSDT') (btc as any).funding = item.funding, (btc as any).oi_now = item.oi_now, (btc as any).oi_hist = item.oi_hist
    if (sym === 'ETHUSDT') (eth as any).funding = item.funding, (eth as any).oi_now = item.oi_now, (eth as any).oi_hist = item.oi_hist
  }

  // Data quality checks
  const t1Server = await getServerTime()
  const t1Local = Date.now()
  const latencyMs = Math.max(0, (t1Local - t0Local) - (t1Server - t0Server))

  // Freshness checks: use M15 klines and 24h ticker closeTime as proxies of feed recency
  const latestTimes: number[] = []
  const pushTime = (iso?: string) => { if (iso) latestTimes.push(Date.parse(iso)) }
  for (const arr of [btc.klines?.M15, eth.klines?.M15]) {
    const last = Array.isArray(arr) ? arr[arr.length - 1] : undefined
    pushTime(last?.closeTime)
  }
  // Also include ticker recency for BTC/ETH
  const btcTick = tickerMap['BTCUSDT']?.closeTimeMs
  const ethTick = tickerMap['ETHUSDT']?.closeTimeMs
  if (btcTick) latestTimes.push(Number(btcTick))
  if (ethTick) latestTimes.push(Number(ethTick))
  for (const sym of universe) {
    const last2 = sym.klines?.M15?.[sym.klines?.M15.length - 1]
    pushTime(last2?.closeTime)
    const tickT = tickerMap[sym.symbol]?.closeTimeMs
    if (tickT) latestTimes.push(Number(tickT))
  }

  const feedsOk = isFresh(Date.now(), latestTimes, config.staleThresholdSec)
  record(warnings, feedsOk, 'Feeds appear stale based on klines/ticker recency')

  // Coverage: >= 90% symbols must have depth and spread
  const numWithDepth = universe.filter(u => (u.depth1pct_usd ?? 0) > 0 && (u.spread_bps ?? 0) > 0).length
  const coverageOk = universe.length === 0 ? false : (numWithDepth / universe.length) >= 0.9
  if (!coverageOk) warnings.push(`Coverage insufficient: ${numWithDepth}/${universe.length} have depth1pct and spread`)

  const snapshot: MarketRawSnapshot = {
    timestamp: new Date().toISOString(),
    latency_ms: latencyMs,
    feeds_ok: feedsOk,
    data_warnings: warnings,
    btc,
    eth,
    universe,
    exchange_filters: exchangeFilters
  }

  const json = JSON.stringify(snapshot)
  if (!clampSnapshotSize(json, config.maxSnapshotBytes)) {
    throw new Error(`Snapshot exceeds size limit ${(new TextEncoder().encode(json).length)} bytes > ${config.maxSnapshotBytes}`)
  }

  // Summary log only
  try {
    const size = new TextEncoder().encode(json).length
    console.table({ allFuturesUSDT, topNSelected, klinesOk, fundingOk: Object.values(fundingMap).filter(v=>v!==undefined).length, openInterestOk: Object.values(oiNowMap).filter(v=>v!==undefined).length, depthOk })
    console.log(`Snapshot built: symbols=${universe.length + 2}, durationMs=${Math.round(latencyMs)}, sizeBytes=${size}`)
  } catch {}

  return snapshot
}

