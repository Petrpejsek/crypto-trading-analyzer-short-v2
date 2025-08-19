import type { CoinRow, FinalPickerCandidate } from '../../types/features'
import candCfg from '../../config/candidates.json'

function toNum(n: any): number | null { return Number.isFinite(n) ? Number(n) : null }
function round(n: number | null, d: number): number | null { if (!Number.isFinite(n as any)) return null; const f = Math.pow(10, d); return Math.round((n as number) * f) / f }

export function buildFinalPickerCandidates(candidates: CoinRow[], settings?: { topK?: number }): FinalPickerCandidate[] {
  const topK = Math.min(12, settings?.topK ?? (candCfg as any)?.topK ?? 12)

  // Deterministic sort: symbol ASC primary, then S desc, rvol_h1 desc, ret_m15_pct desc
  const sorted = [...candidates].sort((a: any, b: any) => {
    const s = String(a.symbol).localeCompare(String(b.symbol))
    if (s !== 0) return s
    const sd = (b.score ?? 0) - (a.score ?? 0)
    if (sd !== 0) return sd
    const rv = (b.rvol_h1 ?? 0) - (a.rvol_h1 ?? 0)
    if (rv !== 0) return rv
    const rm = (b.ret_m15_pct ?? 0) - (a.ret_m15_pct ?? 0)
    return rm
  })
  const take = sorted.slice(0, topK)

  const compact = Boolean(((candCfg as any)?.profiles?.[(candCfg as any)?.profile || 'lean']?.adapter_compact_payload) || (candCfg as any)?.adapter_compact_payload)
  return take.map((c: any) => {
    // clamp h1_range_pos_pct
    const pos = Number.isFinite(c.h1_range_pos_pct) ? Math.max(0, Math.min(100, c.h1_range_pos_pct)) : null
    const out: FinalPickerCandidate = {
      symbol: String(c.symbol),
      price: round(toNum(c.price), 6),
      ret_m15_pct: round(toNum(c.ret_m15_pct), 3),
      ret_h1_pct: round(toNum(c.ret_h1_pct), 3),
      rvol_m15: round(toNum(c.rvol_m15), 2),
      rvol_h1: round(toNum(c.rvol_h1), 2),
      atr_pct_h1: round(toNum(c.atr_pct_H1 ?? c.atr_pct_h1), 3),
      ema_stack: toNum(c.ema_stack),
      vwap_rel_m15: round(toNum(c.vwap_rel_M15 ?? c.vwap_rel_m15), 3),
      oi_change_pct_h1: round(toNum(c.oi_change_pct_h1), 3),
      funding_rate: round(toNum(c.funding), 3),
      funding_z: round(toNum(c.funding_z), 3),
      quoteVolumeUSDT: toNum(c.volume24h_usd),
      tradesCount: toNum(c.tradesCount),
      is_new: (typeof c.is_new === 'boolean') ? c.is_new : null,
      h1_range_pos_pct: round(pos, 3),
      hh_h1: round(toNum(c.hh_h1), 6),
      ll_h1: round(toNum(c.ll_h1), 6),
      vwap_m15: round(toNum(c.vwap_m15), 6),
    }
    ;(out as any).oi_delta_reliable = !(c.oi_delta_unreliable === true)
    if (!compact) {
      ;(out as any).body_ratio_m15 = round(toNum(c.body_ratio_m15), 3)
      ;(out as any).consec_above_vwap_m15 = Number.isFinite(c.consec_above_vwap_m15) ? Math.max(0, Math.min(5, Math.floor(c.consec_above_vwap_m15))) : null
      ;(out as any).oi_price_div_h1 = round(toNum(c.oi_price_div_h1), 3)
      ;(out as any).avg_trade_usdt = round(toNum(c.avg_trade_usdt), 2)
      ;(out as any).cooldown_recent = (Number(c.cooldown_factor) ?? 0) > 0 ? true : false
    } else {
      ;(out as any).burst_m15_pct = round(toNum(c.burst_m15_pct), 3)
    }
    return out
  })
}


