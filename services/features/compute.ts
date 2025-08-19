import type { FeaturesSnapshot, CoinFeat, CoinRow, EmaOrder } from '../../types/features'
import type { Kline, MarketRawSnapshot } from '../../types/market_raw'

function lastClosed(kl: Kline[] | undefined): Kline | undefined {
  if (!kl || kl.length === 0) return undefined
  return kl[kl.length - 1]
}

function ema(values: number[], period: number): number | null {
  if (!Array.isArray(values) || values.length < period) return null
  const k = 2 / (period + 1)
  let emaVal = values[0]
  for (let i = 1; i < values.length; i++) emaVal = values[i] * k + emaVal * (1 - k)
  return Number.isFinite(emaVal) ? emaVal : null
}

function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null
  let gains = 0, losses = 0
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1]
    if (d >= 0) gains += d; else losses -= d
  }
  let avgGain = gains / period
  let avgLoss = losses / period
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period
  }
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  const out = 100 - 100 / (1 + rs)
  return Number.isFinite(out) ? out : null
}

function atr(high: number[], low: number[], close: number[], period = 14): number | null {
  if (high.length !== low.length || low.length !== close.length) return null
  const n = high.length
  if (n < period + 1) return null
  const tr: number[] = []
  for (let i = 1; i < n; i++) {
    const hl = high[i] - low[i]
    const hc = Math.abs(high[i] - close[i - 1])
    const lc = Math.abs(low[i] - close[i - 1])
    tr.push(Math.max(hl, hc, lc))
  }
  // Wilder smoothing
  let atrVal = tr.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < tr.length; i++) atrVal = (atrVal * (period - 1) + tr[i]) / period
  return Number.isFinite(atrVal) ? atrVal : null
}

function adx(high: number[], low: number[], close: number[], period = 14): number | null {
  const n = high.length
  if (n < period + 1) return null
  const dmPlus: number[] = [], dmMinus: number[] = [], trArr: number[] = []
  for (let i = 1; i < n; i++) {
    const upMove = high[i] - high[i - 1]
    const downMove = low[i - 1] - low[i]
    dmPlus.push(upMove > downMove && upMove > 0 ? upMove : 0)
    dmMinus.push(downMove > upMove && downMove > 0 ? downMove : 0)
    const hl = high[i] - low[i]
    const hc = Math.abs(high[i] - close[i - 1])
    const lc = Math.abs(low[i] - close[i - 1])
    trArr.push(Math.max(hl, hc, lc))
  }
  const smooth = (arr: number[]) => {
    let val = arr.slice(0, period).reduce((a, b) => a + b, 0)
    const out: number[] = [val]
    for (let i = period; i < arr.length; i++) { val = val - val / period + arr[i]; out.push(val) }
    return out
  }
  const trSmooth = smooth(trArr)
  const plusSmooth = smooth(dmPlus)
  const minusSmooth = smooth(dmMinus)
  const diPlus = plusSmooth.map((v, i) => (v / trSmooth[i]) * 100)
  const diMinus = minusSmooth.map((v, i) => (v / trSmooth[i]) * 100)
  const dx = diPlus.map((v, i) => Math.abs(v - diMinus[i]) / (v + diMinus[i]) * 100)
  const adxVals = [] as number[]
  let acc = 0
  for (let i = 0; i < period; i++) acc += dx[i]
  adxVals.push(acc / period)
  for (let i = period; i < dx.length; i++) {
    adxVals.push((adxVals[adxVals.length - 1] * (period - 1) + dx[i]) / period)
  }
  const out = adxVals[adxVals.length - 1]
  return Number.isFinite(out) ? out : null
}

function vwap(klines: Kline[]): number | null {
  if (!klines || klines.length === 0) return null
  let pv = 0
  let vol = 0
  for (const k of klines) { pv += ((k.high + k.low + k.close) / 3) * k.volume; vol += k.volume }
  if (vol <= 0) return null
  return pv / vol
}

function computeEmaOrder(e20: number | null, e50: number | null, e200: number | null): EmaOrder | null {
  if (e20 == null || e50 == null || e200 == null) return null
  const arr = [
    { k: '20', v: e20 },
    { k: '50', v: e50 },
    { k: '200', v: e200 },
  ].sort((a, b) => b.v - a.v)
  const key = arr.map(x => x.k).join('>') as EmaOrder
  return key
}

export function computeFeatures(snapshot: MarketRawSnapshot): FeaturesSnapshot {
  const t0 = performance.now()
  const warnings: string[] = []
  const candlesH4 = (kl?: Kline[]) => kl?.map(k => k.close) ?? []
  const candlesH1 = (kl?: Kline[]) => kl?.map(k => k.close) ?? []
  const candlesM15 = (kl?: Kline[]) => kl?.map(k => k.close) ?? []

  const computeCoin = (sym: 'btc' | 'eth'): CoinFeat => {
    const kH4 = snapshot[sym]?.klines.H4 ?? []
    const kH1 = snapshot[sym]?.klines.H1 ?? []
    const kM15 = snapshot[sym]?.klines.M15 ?? []
    const closeH1 = candlesH1(kH1)
    const closeH4 = candlesH4(kH4)
    const closeM15 = candlesM15(kM15)
    const highH1 = kH1.map(k => k.high)
    const lowH1 = kH1.map(k => k.low)

    const ema20_H4 = ema(closeH4, 20)
    const ema50_H4 = ema(closeH4, 50)
    const ema200_H4 = ema(closeH4, 200)
    const ema20_H1 = ema(closeH1, 20)
    const ema50_H1 = ema(closeH1, 50)
    const ema200_H1 = ema(closeH1, 200)
    const rsi_H1 = rsi(closeH1, 14)
    const atrAbs = atr(highH1, lowH1, closeH1, 14)
    const atr_pct_H1 = atrAbs != null && closeH1.length ? (atrAbs / closeH1[closeH1.length - 1]) * 100 : null
    const vwap_H1 = vwap(kH1)
    const vwap_M15 = vwap(kM15)
    const lastCloseH1 = closeH1.length ? closeH1[closeH1.length - 1] : null
    const lastCloseM15 = closeM15.length ? closeM15[closeM15.length - 1] : null
    const vwap_rel_H1 = vwap_H1 && lastCloseH1 ? (lastCloseH1 - vwap_H1) / vwap_H1 : null
    const vwap_rel_M15 = vwap_M15 && lastCloseM15 ? (lastCloseM15 - vwap_M15) / vwap_M15 : null
    const adx_H1 = adx(highH1, lowH1, closeH1, 14)
    const flags = {
      H1_above_VWAP: vwap_H1 != null && lastCloseH1 != null ? lastCloseH1 > vwap_H1 : null,
      H4_ema50_gt_200: ema50_H4 != null && ema200_H4 != null ? ema50_H4 > ema200_H4 : null,
    }
    return { ema20_H4, ema50_H4, ema200_H4, ema20_H1, ema50_H1, ema200_H1, rsi_H1, atr_pct_H1, vwap_rel_H1, vwap_rel_M15, adx_H1, flags }
  }

  const btc = computeCoin('btc')
  const eth = computeCoin('eth')

  const universe: CoinRow[] = snapshot.universe.map((u) => {
    const kH1 = u.klines.H1 ?? []
    const kM15 = u.klines.M15 ?? []
    const closeH1 = kH1.map(k => k.close)
    const closeM15 = kM15.map(k => k.close)
    const highH1 = kH1.map(k => k.high)
    const lowH1 = kH1.map(k => k.low)
    const ema20_H1 = ema(closeH1, 20)
    const ema50_H1 = ema(closeH1, 50)
    const ema200_H1 = ema(closeH1, 200)
    const hasM15 = closeM15.length > 0
    const ema20_M15 = hasM15 ? ema(closeM15, 20) : null
    const ema50_M15 = hasM15 ? ema(closeM15, 50) : null
    const ema200_M15 = hasM15 ? ema(closeM15, 200) : null
    const ema_order_H1 = computeEmaOrder(ema20_H1, ema50_H1, ema200_H1)
    const ema_order_M15 = hasM15 ? computeEmaOrder(ema20_M15, ema50_M15, ema200_M15) : null
    const atrAbs = atr(highH1, lowH1, closeH1, 14)
    const lastCloseH1 = closeH1.length ? closeH1[closeH1.length - 1] : null
    const atr_pct_H1 = atrAbs != null && lastCloseH1 != null ? (atrAbs / lastCloseH1) * 100 : null
    const vwap_M15 = hasM15 ? vwap(kM15) : null
    const vwap_rel_M15 = vwap_M15 && closeM15.length ? (closeM15[closeM15.length - 1] - vwap_M15) / vwap_M15 : null
    const RSI_M15 = hasM15 ? rsi(closeM15, 14) : null
    const price = lastCloseH1
    const volume24h_usd = u.volume24h_usd ?? null
    const funding = u.funding ?? null
    const OI_chg_1h = null
    const OI_chg_4h = null
    return { symbol: u.symbol, price, atr_pct_H1, volume24h_usd, ema_order_H1, ema_order_M15, RSI_M15, vwap_rel_M15, funding, OI_chg_1h, OI_chg_4h }
  })

  const denom = Math.max(1, snapshot.universe.length)
  const above = snapshot.universe.filter(u => {
    const kH1 = u.klines.H1 ?? []
    const closeH1 = kH1.map(k => k.close)
    const ema50 = ema(closeH1, 50)
    const last = closeH1.length ? closeH1[closeH1.length - 1] : null
    return ema50 != null && last != null && last > ema50
  }).length
  const breadth = { pct_above_EMA50_H1: Math.round((above / denom) * 100) }

  const snapshotOut: FeaturesSnapshot = {
    timestamp: snapshot.timestamp,
    btc, eth, universe, breadth,
    warnings: warnings.length ? warnings : undefined
  }

  // Validate no NaN/Infinity and numbers only
  const json = JSON.stringify(snapshotOut)
  if (!isFinite(new TextEncoder().encode(json).length)) {
    throw new Error('Invalid snapshot size')
  }
  return snapshotOut
}


