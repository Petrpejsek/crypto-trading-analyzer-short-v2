import { buildMarketRawSnapshot, calcObi, estimateSlippageBps, findNearestWalls, getDepth20 } from '../../server/fetcher/binance'
import type { WatcherSnapshot } from './types'
import { request as undiciRequest } from 'undici'
import fetcherConfig from '../../config/fetcher.json'

const CONSUME_LOOKBACK_MS = 3000
const CONSUME_MIN_OFFSET_MS = 1000
const TIMELINE_WINDOW_MS = 15000
const REFRESH_WINDOW_MS = 10000
const MAX_M1_CANDLES = 6
const AGG_TRADES_LIMIT = 600

type DepthSample = {
  timestamp: number
  bidNotional: number | null
  askNotional: number | null
  bestBidPrice: number | null
  bestAskPrice: number | null
}

const depthMemory: Record<string, DepthSample[]> = {}

function recordDepthSample(symbol: string, sample: DepthSample): void {
  const arr = depthMemory[symbol] || []
  arr.push(sample)
  const cutoff = Date.now() - TIMELINE_WINDOW_MS
  while (arr.length && arr[0].timestamp < cutoff) arr.shift()
  depthMemory[symbol] = arr
}

function computeConsumePct(symbol: string, side: 'bid' | 'ask'): number | null {
  const arr = depthMemory[symbol]
  if (!arr || arr.length < 2) return null
  const latest = arr[arr.length - 1]
  const latestTs = latest.timestamp
  const base = [...arr].reverse().find(sample => {
    const age = latestTs - sample.timestamp
    return age >= CONSUME_MIN_OFFSET_MS && age <= CONSUME_LOOKBACK_MS
  })
  if (!base) return null
  const latestNotional = side === 'bid' ? latest.bidNotional : latest.askNotional
  const baseNotional = side === 'bid' ? base.bidNotional : base.askNotional
  if (latestNotional == null || baseNotional == null || baseNotional <= 0) return null
  const consumed = baseNotional - latestNotional
  if (consumed <= 0) return 0
  const pct = (consumed / baseNotional) * 100
  if (!Number.isFinite(pct)) return null
  return Math.max(0, Math.min(100, pct))
}

function computeEma(values: number[], period: number): number | null {
  if (!Array.isArray(values) || values.length === 0) return null
  const k = 2 / (period + 1)
  let ema = values[0]
  for (let i = 1; i < values.length; i++) ema = values[i] * k + ema * (1 - k)
  return Number.isFinite(ema) ? ema : null
}

function computeRsi(values: number[], period: number): number | null {
  if (!Array.isArray(values) || values.length <= period) return null
  let gain = 0
  let loss = 0
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1]
    if (diff >= 0) gain += diff
    else loss -= diff
  }
  if (loss === 0) return 100
  const rs = (gain / period) / (loss / period)
  const rsi = 100 - 100 / (1 + rs)
  return Number.isFinite(rsi) ? rsi : null
}

function computeRefreshPct(symbol: string, side: 'bid' | 'ask'): number | null {
  const arr = depthMemory[symbol]
  if (!arr || arr.length < 2) return null
  const latest = arr[arr.length - 1]
  const base = [...arr].reverse().find(sample => {
    const age = latest.timestamp - sample.timestamp
    return age >= REFRESH_WINDOW_MS - 500 && age <= REFRESH_WINDOW_MS + 500
  })
  if (!base) return null
  const latestNotional = side === 'bid' ? latest.bidNotional : latest.askNotional
  const baseNotional = side === 'bid' ? base.bidNotional : base.askNotional
  if (latestNotional == null || baseNotional == null || baseNotional <= 0) return null
  const delta = latestNotional - baseNotional
  if (delta <= 0) return 0
  return Math.min(100, (delta / baseNotional) * 100)
}

function computeDwell(samples: DepthSample[], side: 'bid' | 'ask', referencePrice: number | null): number | null {
  if (!samples.length || !Number.isFinite(referencePrice as any)) return null
  const ref = referencePrice as number
  const lower = ref * 0.9995
  const upper = ref * 1.0005
  let dwellMs = 0
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]
    const curr = samples[i]
    const price = side === 'bid' ? prev.bestBidPrice : prev.bestAskPrice
    if (price != null && price >= lower && price <= upper) {
      dwellMs += Math.max(0, curr.timestamp - prev.timestamp)
    }
  }
  return dwellMs
}

function extractRecentCandles(target: any, interval: 'M1' | 'M5', limit: number) {
  try {
    const arr = target?.klines?.[interval]
    if (!Array.isArray(arr)) return undefined
    const slice = arr.slice(-limit)
    return slice.map((k: any) => ({
      openTime: k.openTime,
      closeTime: k.closeTime,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume
    }))
  } catch {
    return undefined
  }
}

async function fetchTakerDelta(symbol: string): Promise<number | null> {
  try {
    const qs = new URLSearchParams({ symbol, limit: String(Math.min(AGG_TRADES_LIMIT, 600)), startTime: String(Date.now() - 15000) }).toString()
    const url = `https://fapi.binance.com/fapi/v1/aggTrades?${qs}`
    const res = await undiciRequest(url, { method: 'GET', headers: { 'Content-Type': 'application/json' }, maxRedirections: 0, bodyTimeout: (fetcherConfig as any)?.timeoutMs ?? 6000, headersTimeout: (fetcherConfig as any)?.timeoutMs ?? 6000 })
    if (res.statusCode < 200 || res.statusCode >= 300) return null
    const text = await (res as any).body.text()
    const trades = JSON.parse(text)
    if (!Array.isArray(trades)) return null
    let delta = 0
    for (const t of trades) {
      const qty = Number(t?.q)
      const price = Number(t?.p)
      const side = Boolean(t?.m) ? -1 : 1
      if (Number.isFinite(qty) && Number.isFinite(price)) {
        delta += side * qty * price
      }
    }
    return delta
  } catch {
    return null
  }
}

export async function fetchWatcherSnapshot(symbol: string): Promise<WatcherSnapshot> {
  const snapshot = await buildMarketRawSnapshot({ includeSymbols: [symbol], fresh: true, allowPartial: true, desiredTopN: 20 })
  const target = snapshot.universe.find(item => item.symbol === symbol)
  if (!target) throw new Error(`Symbol ${symbol} not found in snapshot`)

  const m15 = target.klines?.M15 || []
  const m5 = target.klines?.M5 || []
  const recentM1 = extractRecentCandles(target, 'M1', MAX_M1_CANDLES)

  const markPrice = Number(target.price ?? m5.at(-1)?.close ?? m15.at(-1)?.close ?? NaN)
  const atrM15 = target.atr_m15 ?? null

  const emaM15 = {
    20: target.ema20_M15 ?? target.ema_m15?.[20] ?? null,
    50: target.ema50_M15 ?? target.ema_m15?.[50] ?? null
  }
  const emaM5 = {
    20: computeEma(m5.map(k => k.close), 20),
    50: computeEma(m5.map(k => k.close), 50)
  }

  const rsiM15 = computeRsi(m15.map(k => k.close), 14)
  const rsiM5 = computeRsi(m5.map(k => k.close), 14)
  const rsiM5Delta = (() => {
    if (!Number.isFinite(rsiM5 as number)) return null
    if (m5.length < 6) return null
    const closes = m5.map(k => k.close)
    const last = closes[closes.length - 1]
    const prev = closes[Math.max(0, closes.length - 6)]
    if (!Number.isFinite(last) || !Number.isFinite(prev) || prev === 0) return null
    return ((last - prev) / prev) * 100
  })()

  const depth = await getDepth20(symbol)
  let orderbook: WatcherSnapshot['orderbook'] = null
  let spreadBps = target.spread_bps ?? null
  let estSlipBps: number | null = target.liquidity_usd ?? null

  if (depth && depth.bids.length && depth.asks.length) {
    const bestBid = depth.bids[0][0]
    const bestAsk = depth.asks[0][0]
    if (bestBid && bestAsk) {
      const spread = ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 10000
      spreadBps = Number.isFinite(spread) ? spread : spreadBps
    }

    const microprice = (() => {
      try {
        const bidPx = depth.bids[0][0]
        const bidQty = depth.bids[0][1]
        const askPx = depth.asks[0][0]
        const askQty = depth.asks[0][1]
        const denom = bidQty + askQty
        if (denom <= 0) return null
        return (bidPx * askQty + askPx * bidQty) / denom
      } catch {
        return null
      }
    })()

    const obi5 = calcObi(depth as any, 5)
    const obi20 = calcObi(depth as any, 20)
    const walls = findNearestWalls(depth as any, microprice ?? undefined)
    const slippage = estimateSlippageBps(depth as any, 1000, 'BUY', microprice ?? undefined)
    estSlipBps = Number.isFinite(slippage as any) ? slippage : estSlipBps

    const bidNotional = depth.bids.slice(0, 5).reduce((acc, [price, qty]) => acc + price * qty, 0)
    const askNotional = depth.asks.slice(0, 5).reduce((acc, [price, qty]) => acc + price * qty, 0)
    const now = Date.now()
    recordDepthSample(symbol, {
      timestamp: now,
      bidNotional: Number.isFinite(bidNotional) ? bidNotional : null,
      askNotional: Number.isFinite(askNotional) ? askNotional : null,
      bestBidPrice: Number.isFinite(bestBid) ? bestBid : null,
      bestAskPrice: Number.isFinite(bestAsk) ? bestAsk : null
    })
    const depthSamples = depthMemory[symbol] || []

    orderbook = {
      microprice: microprice ?? null,
      micropriceBias: typeof obi5 === 'number' && obi5 > 0.05 ? 'bid' : typeof obi5 === 'number' && obi5 < -0.05 ? 'ask' : 'neutral',
      obi5: typeof obi5 === 'number' ? obi5 : null,
      obi20: typeof obi20 === 'number' ? obi20 : null,
      nearestAskWallPrice: walls.nearestAskWallPrice ?? null,
      nearestAskWallDistBps: walls.nearestAskWallDistBps ?? null,
      nearestBidWallPrice: walls.nearestBidWallPrice ?? null,
      nearestBidWallDistBps: walls.nearestBidWallDistBps ?? null,
      consumeBidWallPct3s: computeConsumePct(symbol, 'bid'),
      consumeAskWallPct3s: computeConsumePct(symbol, 'ask'),
      refreshBidWallPct10s: computeRefreshPct(symbol, 'bid'),
      refreshAskWallPct10s: computeRefreshPct(symbol, 'ask'),
      dwellBidMs: computeDwell(depthSamples, 'bid', target.price ?? null),
      dwellAskMs: null,
      timeline: depthSamples.map(s => ({
        timestamp: s.timestamp,
        bidPrice: s.bestBidPrice,
        bidNotional: s.bidNotional,
        askPrice: s.bestAskPrice,
        askNotional: s.askNotional
      }))
    }
  }

  const pumpFilterActive = (() => {
    if (m15.length === 0) return null
    const last = m15[m15.length - 1]
    const changePct = (last.close / last.open - 1) * 100
    const rsi6 = computeRsi(m15.map(k => k.close), 6)
    if (changePct > 12 && (rsi6 ?? 0) > 70) return true
    return false
  })()

  return {
    symbol,
    timestamp: new Date().toISOString(),
    indicators: {
      markPrice: Number.isFinite(markPrice) ? markPrice : null,
      atr_m15: Number.isFinite(atrM15 as any) ? atrM15 : null,
      ema_m5: {
        20: Number.isFinite(emaM5[20] as any) ? emaM5[20] : null,
        50: Number.isFinite(emaM5[50] as any) ? emaM5[50] : null
      },
      ema_m15: {
        20: Number.isFinite(emaM15[20] as any) ? emaM15[20] : null,
        50: Number.isFinite(emaM15[50] as any) ? emaM15[50] : null
      },
      vwap_m15: Number.isFinite(target.vwap_today as any) ? target.vwap_today ?? null : null,
      rsi_m5: Number.isFinite(rsiM5 as any) ? rsiM5 : null,
      rsi_m15: Number.isFinite(rsiM15 as any) ? rsiM15 : null,
      rsi_m5_delta: Number.isFinite(rsiM5Delta as any) ? rsiM5Delta : null
    },
    orderbook,
    market: {
      spread_bps: Number.isFinite(spreadBps as any) ? spreadBps : null,
      estSlippageBps: Number.isFinite(estSlipBps as any) ? estSlipBps : null,
      pumpFilter: pumpFilterActive,
      posture: snapshot.policy ? 'OK' : null
    },
    raw: target,
    pumpFilterActive,
    recentCandles: {
      m1: recentM1
    },
    flow: {
      takerDelta15s: await fetchTakerDelta(symbol)
    }
  }
}


