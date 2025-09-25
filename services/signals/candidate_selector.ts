import type { FeaturesSnapshot, CoinRow } from '../../types/features'
import type { MarketRawSnapshot } from '../../types/market_raw'
import signalsCfg from '../../config/signals.json'
import candCfg from '../../config/candidates.json'

export type Candidate = {
  symbol: string
  score: number
  liquidityUsd: number
  atrPctH1: number
  emaOrderH1: string
  rsiM15?: number
  tier: 'SCOUT' | 'WATCH' | 'ALERT' | 'HOT'
  simSetup?: {
    side: 'LONG' | 'SHORT'
    entry: number
    stop: number
    tp1: number
    tp2: number
    rrr1: number
    risk_usd: number
    size_usd: number
  } | null
}

type SelectOpts = {
  decisionFlag: 'OK' | 'CAUTION' | 'NO-TRADE'
  allowWhenNoTrade?: boolean
  limit: number
  cfg: {
    atr_pct_min: number
    atr_pct_max: number
    min_liquidity_usdt: number
  }
}

export function selectCandidates(
  features: FeaturesSnapshot,
  _snapshot: MarketRawSnapshot,
  opts: SelectOpts & { canComputeSimPreview?: boolean; finalPickerStatus?: 'idle'|'loading'|'success'|'success_no_picks'|'error' }
): Candidate[] {
  const { decisionFlag, allowWhenNoTrade, limit, cfg } = opts
  if (decisionFlag === 'NO-TRADE' && !allowWhenNoTrade) return []
  const coins = features.universe || []
  // Hard gates (M2-Lite)
  const gates = (candCfg as any).hard_gates || {}
  const newGates = (candCfg as any).gates || {}
  const gateCounts: Record<string, number> = {
    gate_min_avg_trade_usdt: 0,
    gate_min_body_ratio_m15: 0,
    gate_max_upper_wick_ratio_m15: 0,
    gate_atr_pct_h1: 0,
    gate_quantile_ret_m15: 0,
    gate_quantile_rvol_h1: 0,
    gate_quantile_h1pos: 0,
  }
  const filtered = coins.filter(c => {
    // Strict volume gate: missing or low volume fails
    const volOk = (c.volume24h_usd ?? 0) >= (gates.min_quote_volume_usd ?? 0)
    const atrMin = (gates.atr_pct_h1_min ?? 0)
    const atrMax = (gates.atr_pct_h1_max ?? Infinity)
    let atrOk = true
    const atrVal = (c as any).atr_pct_H1
    if (Number.isFinite(atrVal)) {
      atrOk = (atrVal as number) >= atrMin && (atrVal as number) <= atrMax
      if (!atrOk) gateCounts.gate_atr_pct_h1++
    }
    const avgMin = (newGates.min_avg_trade_usdt ?? 0)
    const bodyMin = (newGates.min_body_ratio_m15 ?? 0)
    const wickMax = (newGates.max_upper_wick_ratio_m15 ?? 1)
    const avgTradeOk = (c.avg_trade_usdt ?? Infinity) >= avgMin
    // Apply M15-dependent gates only when metric exists; inclusive comparisons
    let bodyOk = true
    const bodyVal = (c as any).body_ratio_m15
    if (Number.isFinite(bodyVal)) {
      bodyOk = (bodyVal as number) >= bodyMin
      if (!bodyOk) gateCounts.gate_min_body_ratio_m15++
    }
    let wickOk = true
    const wickVal = (c as any).upper_wick_ratio_m15
    if (Number.isFinite(wickVal)) {
      wickOk = (wickVal as number) <= wickMax
      if (!wickOk) gateCounts.gate_max_upper_wick_ratio_m15++
    }
    if (!avgTradeOk) gateCounts.gate_min_avg_trade_usdt++
    return volOk && atrOk && avgTradeOk && bodyOk && wickOk
  })

  // Optional quantile gates (respect profile overrides)
  const prof: string = (candCfg as any)?.profile || 'lean'
  const profileCfg: any = (candCfg as any)?.profiles?.[prof] || {}
  const qBase = (candCfg as any)?.quantile_gates || {}
  const qcfg = {
    enabled: Boolean(profileCfg?.quantile_gates_enabled ?? qBase.enabled),
    ret_m15_q_min: Number(qBase.ret_m15_q_min ?? 0.65),
    rvol_h1_q_min: Number(qBase.rvol_h1_q_min ?? 0.7),
    h1_range_pos_q_min: Number(qBase.h1_range_pos_q_min ?? 0.7),
    apply_only_in_no_trade: Boolean(qBase.apply_only_in_no_trade ?? true)
  }
  let qFiltered = filtered
  if (qcfg.enabled && (!qcfg.apply_only_in_no_trade || decisionFlag === 'NO-TRADE')) {
    function qvalue(arr: number[], q: number): number {
      const a = [...arr].filter(x=>Number.isFinite(x)).sort((x,y)=>x-y)
      if (!a.length) return Infinity
      const pos = (a.length - 1) * Math.max(0, Math.min(1, q))
      const lo = Math.floor(pos), hi = Math.ceil(pos)
      if (lo === hi) return a[lo]
      const t = pos - lo
      return a[lo] * (1 - t) + a[hi] * t
    }
    const retQ = qvalue(filtered.map(c=>Number(c.ret_m15_pct)||0), Number(qcfg.ret_m15_q_min ?? 0.65))
    const rvolQ = qvalue(filtered.map(c=>Number(c.rvol_h1)||0), Number(qcfg.rvol_h1_q_min ?? 0.7))
    const posQ = qvalue(filtered.map(c=>Number(c.h1_range_pos_pct)||0), Number(qcfg.h1_range_pos_q_min ?? 0.7))
    const afterQ: CoinRow[] = []
    for (const c of filtered) {
      const gateReasons: string[] = []
      // Apply quantile gates only when metric exists (avoid penalizing missing M15)
      const hasRetM15 = Number.isFinite(c.ret_m15_pct as any)
      const hasRvolH1 = Number.isFinite(c.rvol_h1 as any)
      const hasH1Pos = Number.isFinite(c.h1_range_pos_pct as any)
      if (hasRetM15 && (c.ret_m15_pct as any) < retQ) gateReasons.push('q_ret_m15')
      if (hasRvolH1 && (c.rvol_h1 as any) < rvolQ) gateReasons.push('q_rvol_h1')
      if (hasH1Pos && (c.h1_range_pos_pct as any) < posQ) gateReasons.push('q_h1pos')
      if (gateReasons.length === 0) afterQ.push(c as any)
      else {
        if (gateReasons.includes('q_ret_m15')) gateCounts.gate_quantile_ret_m15++
        if (gateReasons.includes('q_rvol_h1')) gateCounts.gate_quantile_rvol_h1++
        if (gateReasons.includes('q_h1pos')) gateCounts.gate_quantile_h1pos++
        ;(c as any).gated_by = gateReasons.join(',')
      }
    }
    qFiltered = afterQ
  }
  function rank(values: Array<number | null | undefined>, v: number | null | undefined) {
    const arr = values.filter((x): x is number => Number.isFinite(x as any))
    if (!arr.length || !Number.isFinite(v as any)) return 0
    const sorted = [...arr].sort((a,b)=>a-b)
    const idx = sorted.findIndex(x => x >= (v as number))
    const r = (idx < 0 ? sorted.length - 1 : idx) / Math.max(1, sorted.length - 1)
    return r
  }
  // Precompute arrays for ranking
  const retsM15 = filtered.map(c => c.ret_m15_pct ?? 0)
  const retsH1 = filtered.map(c => c.ret_h1_pct ?? 0)
  const rvolH1 = filtered.map(c => c.rvol_h1 ?? 0)
  const atrP = filtered.map(c => c.atr_pct_H1 ?? 0)
  const vwapRel = filtered.map(c => c.vwap_rel_M15 ?? 0)
  const oiChg = filtered.map(c => c.oi_change_pct_h1 ?? 0)
  const bursts = filtered.map(c => c.burst_m15_pct ?? 0)
  const w = (candCfg as any).weights
  const wx = (candCfg as any).score_extra || {}
  function scoreOf(c: any): number {
    let s =
      (w.ret_m15_pct ?? 0.25) * rank(retsM15, c.ret_m15_pct) +
      (w.rvol_h1 ?? 0.20) * rank(rvolH1, c.rvol_h1) +
      (w.ret_h1_pct ?? 0.15) * rank(retsH1, c.ret_h1_pct) +
      (w.atr_pct_h1 ?? 0.15) * rank(atrP, c.atr_pct_H1) +
      (w.vwap_rel_m15 ?? 0.15) * rank(vwapRel, c.vwap_rel_M15) +
      (w.oi_change_pct_h1 ?? 0.10) * rank(oiChg, c.oi_change_pct_h1) +
      (((candCfg as any)?.score?.w_burst_m15 ?? 0.08)) * rank(bursts, c.burst_m15_pct) +
      (wx.w_body_ratio_m15 ?? 0.08) * (Number.isFinite(c.body_ratio_m15) ? Number(c.body_ratio_m15) : 0) +
      (wx.w_consec_above_vwap_m15 ?? 0.05) * (Number.isFinite(c.consec_above_vwap_m15) ? Math.min(1, Number(c.consec_above_vwap_m15)/5) : 0) +
      (wx.w_rvol_liq_product ?? 0.06) * (Number.isFinite(c.rvol_liq_product) ? Math.tanh(Number(c.rvol_liq_product)/10) : 0)
    // OI divergence squeeze bonus
    const thrDiv = Number((candCfg as any)?.score_extra?.thr_oi_div ?? 5)
    if (Number.isFinite(c.oi_change_pct_h1) && Number.isFinite(c.ret_m15_pct)) {
      const squeeze = (c.ret_h1_pct ?? 0) < 0 && (c.oi_change_pct_h1 ?? 0) > thrDiv && (c.ret_m15_pct ?? 0) > 0
      const good = squeeze ? (wx.w_oi_divergence ?? 0.05) : 0
      s += good
      if (!squeeze && (c.oi_price_div_h1 ?? 0) > 0) s -= 0.01
    }
    if (c.oi_change_pct_h1 == null) s -= ((candCfg as any)?.score?.penalty_missing_oi_delta ?? 0)
    if (c.oi_delta_unreliable === true) {
      const base = ((candCfg as any)?.score?.penalty_oi_unreliable ?? 0)
      const byAge = (candCfg as any)?.score?.penalty_oi_unreliable_by_age
      let extra = 0
      if (byAge?.enabled && Number.isFinite(c.oi_prev_age_min)) {
        const gap = Math.max(0, 60 - Math.min(60, Number(c.oi_prev_age_min)))
        extra = (gap / 60) * Number(byAge.max_additional ?? 0)
      }
      s -= (base + extra)
    }
    if (c.burst_m15_pct == null) s -= ((((candCfg as any)?.score?.w_burst_m15 ?? 0.08) > 0) ? 0.01 : 0)
    if (c.vwap_m15 == null && c.vwap_rel_M15 == null) s -= ((candCfg as any)?.score?.penalty_missing_vwap ?? 0)
    const emaBonus = (c.ema_stack ?? 0) > 0 ? (w.ema_stack_bonus ?? 0.5) : (c.ema_stack ?? 0) < 0 ? -(w.ema_stack_bonus ?? 0.5) : 0
    const newBonus = (c.is_new ? (w.new_coin_bonus ?? 0.5) : 0)
    // Cooldown penalizace
    const cdMax = Number((candCfg as any)?.score_extra?.penalty_cooldown_max ?? 0.04)
    if (Number.isFinite(c.cooldown_factor)) s -= cdMax * Math.max(0, Math.min(1, Number(c.cooldown_factor)))
    const out = s + emaBonus + newBonus
    // clamp S into [0,1] for stability
    return Number(Math.max(0, Math.min(1, out)).toFixed(4))
  }
  // Persist gate stats (optional, behind try/catch; feature-flag removed)
  try { localStorage.setItem('cand_gate_stats', JSON.stringify({ ts: Date.now(), universe: coins.length, counts: gateCounts })) } catch {}

  const lastTopRaw = (()=>{ try { return JSON.parse(localStorage.getItem('lastTopK')||'') } catch { return null } })()
  const lastTs = lastTopRaw?.ts as number | undefined
  const lastMap: Record<string, { S: number, rank: number }> = {}
  try { for (const [idx, it] of (lastTopRaw?.items || []).entries()) lastMap[it.symbol] = { S: Number(it.S)||0, rank: idx+1 } } catch {}

  // Determine effective TopK (profile -> base -> env override for Node runner)
  let desiredTopK = Number(profileCfg?.topK ?? (candCfg as any)?.topK ?? 12)
  try {
    const envTop = (typeof process !== 'undefined' && (process as any)?.env?.CAND_TOPK) ? Number((process as any).env.CAND_TOPK) : NaN
    if (Number.isFinite(envTop) && envTop > 0) desiredTopK = envTop
  } catch {}

  const ranked = qFiltered
    .map((c: CoinRow) => {
      const orig = (candCfg as any)
      let score = scoreOf(c)
      const stickyCfg = (candCfg as any)?.sticky || {}
      const stickyEnabled: boolean = Boolean(profileCfg?.sticky_enabled ?? stickyCfg.enabled)
      if (stickyEnabled && lastTs && lastMap[c.symbol]) {
        const minutes = Math.max(0, Math.floor((Date.now() - lastTs) / 60000))
        const stickyMin = Number(stickyCfg.sticky_minutes ?? 30)
        if (minutes <= stickyMin) {
          const prev = lastMap[c.symbol]
          const delta = Math.abs(Number(score) - Number(prev.S))
          const deltaMax = Number(stickyCfg.delta_s_max ?? 0.02)
          if (delta <= deltaMax) {
            const bonusMax = Number(stickyCfg.bonus_max ?? 0.015)
            const bonus = bonusMax * (1 - (minutes / stickyMin))
            score = Number(Math.max(0, Math.min(1, score + bonus)).toFixed(4))
            ;(c as any).contrib_sticky_bonus = bonus
            ;(c as any).S_after_sticky = score
          }
        }
      }
      let tier: Candidate['tier'] = 'SCOUT'
      if (score >= 80) tier = 'HOT'
      else if (score >= 65) tier = 'ALERT'
      else if (score >= 50) tier = 'WATCH'
      const base: Candidate = {
        symbol: c.symbol,
        score,
        liquidityUsd: c.volume24h_usd ?? 0,
        atrPctH1: c.atr_pct_H1 ?? 0,
        emaOrderH1: (c.ema_order_H1 as any) ?? '',
        rsiM15: (c.RSI_M15 ?? undefined) as number | undefined,
        tier,
      }
      // optional mock setup in preview mode (guarded, no-fallback)
      const canSim = Boolean(opts.canComputeSimPreview) && (opts.finalPickerStatus !== 'error')
      if (canSim && (signalsCfg as any)?.preview?.computeMockSetup) {
        const m = buildMockSetup(c, signalsCfg as any)
        if (m) base.simSetup = m
      }
      ;(base as any).prev_rank = lastMap[c.symbol]?.rank ?? Infinity
      ;(base as any).S_after_sticky = (c as any).S_after_sticky ?? score
      return base
    })
    .sort((a, b) => {
      return (b.score - a.score) || ((b as any).rvol_h1 - (a as any).rvol_h1) || ((b as any).ret_m15_pct - (a as any).ret_m15_pct) || a.symbol.localeCompare(b.symbol)
    })
    // Always enforce configured TopK after sorting. Allow an optional additional cap via opts.limit for UI preview use-cases.
    .slice(0, Math.max(1, Math.min(desiredTopK, Number.isFinite(limit as any) ? Number(limit) : desiredTopK)))
  // Persist lastTopK for sticky (best-effort)
  try { localStorage.setItem('lastTopK', JSON.stringify({ ts: Date.now(), items: ranked.map((r,i)=>({ symbol: r.symbol, S: r.score, rank: i+1 })) })) } catch {}
  return ranked
}

// Deterministic mock setup builder for preview-only levels
export function buildMockSetup(c: CoinRow, cfg: any) {
  const preview = (cfg?.preview) || {}
  const px = c.price ?? null
  const atrPct = c.atr_pct_H1 ?? null
  const emaOrder = c.ema_order_H1
  const rsi = c.RSI_M15 ?? 50
  if (!px || !Number.isFinite(px)) return null
  if (!atrPct || !Number.isFinite(atrPct)) return null
  if (atrPct < (preview.min_atr_pct ?? 0.25) || atrPct > (preview.max_atr_pct ?? 8)) return null

  let side: 'LONG' | 'SHORT' | null = null
  if ((emaOrder === '20>50>200') && rsi >= 45) side = 'LONG'
  else if ((emaOrder === '200>50>20') && rsi <= 55) side = 'SHORT'
  else return null

  const atrPx = px * (atrPct / 100)
  const entryOff = preview.entry_offset_atr ?? 0.2
  const slOff = preview.sl_offset_atr ?? 1.2
  const tp1rr = preview.tp1_rrr ?? 1.5
  const tp2rr = preview.tp2_rrr ?? 2.5
  let entry: number, stop: number, tp1: number, tp2: number
  if (side === 'LONG') {
    entry = px - entryOff * atrPx
    stop = entry - slOff * atrPx
    tp1 = entry + tp1rr * (entry - stop)
    tp2 = entry + tp2rr * (entry - stop)
  } else {
    entry = px + entryOff * atrPx
    stop = entry + slOff * atrPx
    tp1 = entry - tp1rr * (stop - entry)
    tp2 = entry - tp2rr * (stop - entry)
  }
  if (![entry, stop, tp1, tp2].every(x => Number.isFinite(x) && x > 0)) return null
  if ((side === 'LONG' && stop >= entry) || (side === 'SHORT' && stop <= entry)) return null

  const eq = preview.account_equity_usd_preview ?? 10000
  const riskPct = preview.risk_per_trade_pct_preview ?? 0.3
  const riskUsd = Math.max(0, (eq * riskPct) / 100)
  const riskPerUnit = Math.abs(entry - stop)
  const sizeUsd = riskPerUnit > 0 ? riskUsd * (entry / riskPerUnit) : 0
  return { side, entry, stop, tp1, tp2, rrr1: tp1rr, risk_usd: riskUsd, size_usd: Math.max(0, sizeUsd) }
}


