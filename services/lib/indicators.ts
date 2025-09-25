// Shared indicator implementations used across server and client.
// All functions are deterministic, side-effect free, and return null when inputs are insufficient.

export function ema(values: number[], period: number): number | null {
  // Allow partial EMA even when values.length < period (use standard k but initialize from first value)
  if (!Array.isArray(values) || values.length === 0) return null
  const k = 2 / (period + 1)
  let emaVal = values[0]
  for (let i = 1; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k)
  }
  return Number.isFinite(emaVal) ? emaVal : null
}

export function rsi(values: number[], period = 14): number | null {
  if (!Array.isArray(values) || values.length <= period) return null
  let gains = 0
  let losses = 0
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1]
    if (diff >= 0) gains += diff; else losses -= diff
  }
  let avgGain = gains / period
  let avgLoss = losses / period
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1]
    const gain = diff > 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
  }
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  const out = 100 - 100 / (1 + rs)
  return Number.isFinite(out) ? out : null
}

export function atr(high: number[], low: number[], close: number[], period = 14): number | null {
  if (!Array.isArray(high) || !Array.isArray(low) || !Array.isArray(close)) return null
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

export function atrPctFromBars(bars: Array<{ high: number; low: number; close: number }>, period = 14): number | null {
  if (!Array.isArray(bars) || bars.length < period + 1) return null
  const highs = bars.map(b => b.high)
  const lows = bars.map(b => b.low)
  const closes = bars.map(b => b.close)
  const abs = atr(highs, lows, closes, period)
  const last = closes[closes.length - 1]
  return abs != null && Number.isFinite(last) && last > 0 ? (abs / last) * 100 : null
}

export function vwapFromBars(bars: Array<{ high: number; low: number; close: number; volume: number }>): number | null {
  if (!Array.isArray(bars) || bars.length === 0) return null
  let pv = 0
  let vol = 0
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3
    pv += tp * b.volume
    vol += b.volume
  }
  if (!(Number.isFinite(vol) && vol > 0)) return null
  const v = pv / vol
  return Number.isFinite(v) ? v : null
}


