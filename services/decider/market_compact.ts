import type { FeaturesSnapshot } from '../../types/features'
import type { MarketRawSnapshot } from '../../types/market_raw'

export type MarketCompact = {
  timestamp: string
  feeds_ok: boolean
  breadth: { pct_above_EMA50_H1: number }
  avg_volume24h_topN: number
  btc: {
    H1: { vwap_rel: number; ema20: number; ema50: number; ema200: number; rsi: number; atr_pct: number }
    H4: { ema50_gt_200: boolean }
  }
  eth: {
    H1: { vwap_rel: number; ema20: number; ema50: number; ema200: number; rsi: number; atr_pct: number }
    H4: { ema50_gt_200: boolean }
  }
  data_warnings: string[]
}

function safeNum(x: any, d = 0): number {
  const n = typeof x === 'number' ? x : Number(x)
  return Number.isFinite(n) ? n : d
}

function safeBool(x: any, d = false): boolean {
  return typeof x === 'boolean' ? x : d
}

function safeArrStrings(a: any): string[] {
  if (!Array.isArray(a)) return []
  return a.map(v => (typeof v === 'string' ? v : String(v))).slice(0, 20)
}

export function buildMarketCompact(features: FeaturesSnapshot, snapshot: MarketRawSnapshot): MarketCompact {
  const ts = (snapshot?.timestamp && typeof snapshot.timestamp === 'string') ? snapshot.timestamp : (features?.timestamp || new Date().toISOString())

  const avgVol = (() => {
    const vols = Array.isArray(snapshot?.universe) ? snapshot.universe
      .map(u => safeNum(u?.volume24h_usd, 0))
      .filter(v => Number.isFinite(v) && v > 0) : []
    if (vols.length === 0) return 0
    const sum = vols.reduce((a, b) => a + b, 0)
    return sum / vols.length
  })()

  const btcH1 = {
    vwap_rel: safeNum(features.btc.vwap_rel_H1, 0),
    ema20: safeNum(features.btc.ema20_H1, 0),
    ema50: safeNum(features.btc.ema50_H1, 0),
    ema200: safeNum(features.btc.ema200_H1, 0),
    rsi: safeNum(features.btc.rsi_H1, 0),
    atr_pct: safeNum(features.btc.atr_pct_H1, 0),
  }
  const ethH1 = {
    vwap_rel: safeNum(features.eth.vwap_rel_H1, 0),
    ema20: safeNum(features.eth.ema20_H1, 0),
    ema50: safeNum(features.eth.ema50_H1, 0),
    ema200: safeNum(features.eth.ema200_H1, 0),
    rsi: safeNum(features.eth.rsi_H1, 0),
    atr_pct: safeNum(features.eth.atr_pct_H1, 0),
  }
  const btcH4 = { ema50_gt_200: safeBool(features.btc.flags.H4_ema50_gt_200, false) }
  const ethH4 = { ema50_gt_200: safeBool(features.eth.flags.H4_ema50_gt_200, false) }

  return {
    timestamp: String(ts),
    feeds_ok: !!snapshot?.feeds_ok,
    breadth: { pct_above_EMA50_H1: safeNum(features.breadth.pct_above_EMA50_H1, 0) },
    avg_volume24h_topN: safeNum(avgVol, 0),
    btc: { H1: btcH1, H4: btcH4 },
    eth: { H1: ethH1, H4: ethH4 },
    data_warnings: safeArrStrings(snapshot?.data_warnings)
  }
}

export function preflightCompact(compact: any): { ok: boolean; reason?: string } {
  try {
    const raw = JSON.stringify(compact)
    const bytes = Buffer.byteLength(raw, 'utf8')
    if (!Number.isFinite(bytes as any) || bytes <= 2) return { ok: false, reason: 'schema_invalid:empty' }
    if (bytes > 3072) return { ok: false, reason: `schema_invalid:too_large:${bytes}` }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'schema_invalid:serialize' }
  }
}

