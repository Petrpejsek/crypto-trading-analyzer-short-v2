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
  rsiH1?: number
  tier: 'SCOUT' | 'WATCH' | 'ALERT' | 'HOT'
  // New fields for 70±10 universe system
  archetype?: 'loser_cont' | 'loser_fade' | 'overbought_blowoff' | 'mixed'
  basket?: 'Prime' | 'Strong Watch' | 'Speculative'
  reason?: string
  // Additional key metrics for debugging
  ret24hPct?: number
  ret60mPct?: number
  ret15mPct?: number
  vwapRelM15?: number
  posInH1RangePct?: number
  fundingZ?: number
  oiChangePctH1?: number
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

// Helper functions for scoring
const saturate = (v: number, min: number, max: number): number => {
  if (!Number.isFinite(v)) return 0
  if (v <= min) return 0
  if (v >= max) return 1
  return (v - min) / (max - min)
}

const invPct01 = (p: number): number => {
  if (!Number.isFinite(p)) return 0
  return Math.max(0, Math.min(1, (100 - p) / 100))
}

const pct01 = (p: number): number => {
  if (!Number.isFinite(p)) return 0
  return Math.max(0, Math.min(1, p / 100))
}

// Basic eligibility check - NO spread/volume filters, only perp check
const isPerp = (c: any): boolean => {
  const marketType = String((c as any)?.market_type || 'perp').toLowerCase()
  return marketType === 'perp'
}

// Generate reason string for a candidate
function generateReason(c: CoinRow, archetype: string, uiLang: string = 'cs'): string {
  const ret24 = Number((c as any).ret_24h_pct || 0)
  const ret60 = Number((c as any).ret_60m_pct || 0)
  const ret15 = Number((c as any).ret_15m_pct || 0)
  const rsiM15 = Number((c as any).RSI_M15 || 50)
  const rsiH1 = Number((c as any).RSI_H1 || 50)
  const vwapRel = Number((c as any).vwap_rel_m15 || 1)
  const emaOrder = String((c as any).ema_order_H1 || '')
  const fundingZ = Number((c as any).funding_z || 0)
  const oiChg = Number((c as any).oi_change_pct_h1 || 0)
  const px = Number(c.price || 0)
  const ema50H1 = Number((c as any).ema50_H1 || NaN)

  if (uiLang === 'en') {
    if (archetype === 'loser_cont') {
      return `Downtrend continuation: ${ret60.toFixed(1)}% 60m decline, RSI ${rsiM15.toFixed(0)}, below VWAP`
    } else if (archetype === 'loser_fade') {
      return `Relief-fade setup: ${ret15.toFixed(1)}% 15m bounce into resistance, downtrend structure ${emaOrder}`
    } else if (archetype === 'overbought_blowoff') {
      const crowding = (fundingZ >= 0 || oiChg > 0) ? ', crowding detected' : ''
      return `Overbought blow-off: RSI M15:${rsiM15.toFixed(0)} H1:${rsiH1.toFixed(0)}, ${(vwapRel * 100).toFixed(1)}% above VWAP${crowding}`
    } else {
      return `Mixed signals: ${ret24.toFixed(1)}% 24h, RSI ${rsiM15.toFixed(0)}, monitoring`
    }
  }

  // Czech default
  if (archetype === 'loser_cont') {
    return `Downtrend pokračování: ${ret60.toFixed(1)}% pokles 60m, RSI ${rsiM15.toFixed(0)}, pod VWAP`
  } else if (archetype === 'loser_fade') {
    return `Relief-fade: ${ret15.toFixed(1)}% odraz 15m do odporu, downtrend ${emaOrder}`
  } else if (archetype === 'overbought_blowoff') {
    const crowding = (fundingZ >= 0 || oiChg > 0) ? ', crowding detekován' : ''
    return `Překoupený blow-off: RSI M15:${rsiM15.toFixed(0)} H1:${rsiH1.toFixed(0)}, ${(vwapRel * 100).toFixed(1)}% nad VWAP${crowding}`
  } else {
    return `Smíšené signály: ${ret24.toFixed(1)}% 24h, RSI ${rsiM15.toFixed(0)}, sledování`
  }
}

// Score a coin with new 0-1 system
function scoreCandidate(c: CoinRow, archetype: 'loser_cont' | 'loser_fade' | 'overbought_blowoff' | 'mixed'): { score: number; breakdown: any } {
  const ret24 = Number((c as any).ret_24h_pct || 0)
  const ret60 = Number((c as any).ret_60m_pct || 0)
  const ret180 = Number((c as any).ret_180m_pct || 0)
  const ret15 = Number((c as any).ret_15m_pct || 0)
  const rsiM15 = Number((c as any).RSI_M15 || 50)
  const rsiH1 = Number((c as any).RSI_H1 || 50)
  const vwapRel = Number((c as any).vwap_rel_m15 || 1)
  const emaOrder = String((c as any).ema_order_H1 || '')
  const posInH1 = Number((c as any).h1_range_pos_pct || 50)
  const fundingZ = Number((c as any).funding_z || NaN)
  const oiChg = Number((c as any).oi_change_pct_h1 || NaN)
  const px = Number(c.price || 0)
  const ema20M15 = Number((c as any).ema20_M15 || NaN)
  const ema50H1 = Number((c as any).ema50_H1 || NaN)
  const ema20H1 = Number((c as any).ema20_H1 || NaN)
  const vwapM15 = Number((c as any).vwap_m15 || NaN)

  let archetypeScore = 0
  let structureScore = 0
  let flowScore = 0

  // Archetype score (max 0.60)
  if (archetype === 'loser_cont') {
    // Continuation-down scoring
    const retPart = Math.max(
      saturate(Math.abs(ret60), 1.5, 4.0),   // -1.5% to -4% last 60m
      saturate(Math.abs(ret180), 3.0, 8.0)   // -3% to -8% last 180m
    )
    const vwapOk = (Number.isFinite(vwapM15) && px > 0 && px <= vwapM15) ? 1 : 0
    const ema20Ok = (Number.isFinite(ema20M15) && px > 0 && px <= ema20M15) ? 1 : 0
    const rsiOk = rsiM15 >= 18 ? 1 : 0
    archetypeScore = 0.22 * (retPart * 0.4 + vwapOk * 0.3 + ema20Ok * 0.2 + rsiOk * 0.1)

  } else if (archetype === 'loser_fade') {
    // Relief-fade scoring
    const bouncePart = saturate(ret15, 0.5, 2.0)  // +0.5% to +2% bounce
    const vwapAbove = vwapRel >= 1.00 ? saturate(vwapRel - 1, 0, 0.03) : 0
    const belowEma50 = (Number.isFinite(ema50H1) && px > 0 && px < ema50H1) ? 1 : 0
    const emaBonus = (emaOrder === '200>50>20') ? 1 : 0
    const rsiOk = rsiM15 <= 65 ? 1 : 0
    archetypeScore = 0.20 * (bouncePart * 0.25 + vwapAbove * 0.25 + belowEma50 * 0.2 + emaBonus * 0.2 + rsiOk * 0.1)

  } else if (archetype === 'overbought_blowoff') {
    // Overbought blow-off scoring
    const rsiPart = Math.max(
      saturate(rsiM15, 70, 85),
      saturate(rsiH1, 65, 80)
    )
    const vwapPart = vwapRel >= 1.01 ? saturate(vwapRel - 1, 0.01, 0.05) : 0
    const pushPart = Math.max(
      saturate(ret15, 1.0, 3.0),
      saturate(ret60, 2.0, 5.0)
    )
    const aboveEmas = (
      (Number.isFinite(ema20M15) && px > ema20M15 ? 0.5 : 0) +
      (Number.isFinite(ema50H1) && px > ema50H1 ? 0.5 : 0)
    )
    const posHigh = posInH1 >= 65 ? saturate(posInH1, 65, 90) : 0
    const fundingBonus = (Number.isFinite(fundingZ) && fundingZ >= 0) ? 0.5 : 0
    const oiBonus = (Number.isFinite(oiChg) && oiChg > 0) ? 0.5 : 0
    const crowdingBonus = fundingBonus + oiBonus
    archetypeScore = 0.18 * (rsiPart * 0.3 + vwapPart * 0.2 + pushPart * 0.2 + aboveEmas * 0.15 + posHigh * 0.1 + (crowdingBonus / 2) * 0.05)

  } else {
    // Mixed - moderate score
    archetypeScore = 0.10
  }

  // Structure score (max 0.28)
  const emaStructure = (emaOrder === '200>50>20') ? 0.08 : 0
  const posScore = archetype === 'overbought_blowoff' 
    ? (posInH1 >= 65 ? 0.06 : 0) 
    : (posInH1 <= 35 ? 0.06 : 0)
  
  const vwapStructure = archetype === 'overbought_blowoff'
    ? (vwapRel >= 1.01 ? 0.07 : 0)
    : (vwapRel < 1.00 ? 0.07 : 0)
  
  const emaRelation = archetype === 'overbought_blowoff'
    ? ((Number.isFinite(ema20M15) && px > ema20M15) ? 0.07 : 0)
    : ((Number.isFinite(ema20M15) && px < ema20M15) ? 0.07 : 0)

  structureScore = emaStructure + posScore + vwapStructure + emaRelation

  // Flow / trap score (max 0.12)
  const fundingPart = (Number.isFinite(fundingZ) && fundingZ >= 0) ? 0.06 : 0
  const oiPart = (Number.isFinite(oiChg) && oiChg > 0) ? 0.06 : 0
  flowScore = fundingPart + oiPart

  const totalScore = Math.max(0, Math.min(1, archetypeScore + structureScore + flowScore))

  return {
    score: totalScore,
    breakdown: {
      archetype: archetypeScore,
      structure: structureScore,
      flow: flowScore
    }
  }
}

export function selectCandidates(
  features: FeaturesSnapshot,
  _snapshot: MarketRawSnapshot,
  opts: SelectOpts & { canComputeSimPreview?: boolean; finalPickerStatus?: 'idle'|'loading'|'success'|'success_no_picks'|'error'; universeStrategy?: 'volume'|'gainers'|'losers'|'overheat' }
): Candidate[] {
  const { decisionFlag, allowWhenNoTrade, limit, cfg, universeStrategy } = opts
  
  if (decisionFlag === 'NO-TRADE' && !allowWhenNoTrade) return []
  
  const coins = features.universe || []
  console.error(`[CAND_SELECT_NEW] Starting with ${coins.length} coins, strategy=${universeStrategy}`)

  // Target: 70±10 candidates
  const TARGET_MIN = 60
  const TARGET_MAX = 80
  const TARGET_IDEAL = 70

  // Basic filter: only perps
  const eligible = coins.filter(c => isPerp(c))
  console.error(`[CAND_SELECT_NEW] After perp filter: ${eligible.length} coins`)

  // A) LOSERS branch
  const losersBase = eligible.filter(c => {
    const ret24 = Number((c as any).ret_24h_pct || 0)
    return ret24 < 0
  })

  // A1) Continuation-down
  const losersCont = losersBase.filter(c => {
    const ret60 = Number((c as any).ret_60m_pct || 0)
    const ret180 = Number((c as any).ret_180m_pct || 0)
    const rsiM15 = Number((c as any).RSI_M15 || 50)
    const px = Number(c.price || 0)
    const vwapM15 = Number((c as any).vwap_m15 || NaN)
    const ema20M15 = Number((c as any).ema20_M15 || NaN)

    const retOk = ret60 <= -1.5 || ret180 <= -3.0
    const vwapOk = !Number.isFinite(vwapM15) || (px > 0 && px <= vwapM15)
    const ema20Ok = !Number.isFinite(ema20M15) || (px > 0 && px <= ema20M15)
    const rsiOk = rsiM15 >= 18

    return retOk && vwapOk && ema20Ok && rsiOk
  })

  // A2) Relief-fade
  const losersFade = losersBase.filter(c => {
    const ret15 = Number((c as any).ret_15m_pct || 0)
    const vwapRel = Number((c as any).vwap_rel_m15 || 1)
    const px = Number(c.price || 0)
    const ema50H1 = Number((c as any).ema50_H1 || NaN)
    const rsiM15 = Number((c as any).RSI_M15 || 50)

    const bounceOk = ret15 >= 0.5 || vwapRel >= 1.00
    const downtrendOk = !Number.isFinite(ema50H1) || (px > 0 && px < ema50H1)
    const rsiOk = rsiM15 <= 65

    return bounceOk && downtrendOk && rsiOk
  })

  // B) OVERBOUGHT branch
  const overbought = eligible.filter(c => {
    const rsiM15 = Number((c as any).RSI_M15 || 50)
    const rsiH1 = Number((c as any).RSI_H1 || 50)
    const vwapRel = Number((c as any).vwap_rel_m15 || 1)
    const ret15 = Number((c as any).ret_15m_pct || 0)
    const ret60 = Number((c as any).ret_60m_pct || 0)
    const px = Number(c.price || 0)
    const ema20M15 = Number((c as any).ema20_M15 || NaN)
    const ema50M15 = Number((c as any).ema50_M15 || NaN)
    const posInH1 = Number((c as any).h1_range_pos_pct || 50)

    // Eligibility criteria (need to meet majority)
    let points = 0

    // Overbought RSI
    if (rsiM15 >= 70 || rsiH1 >= 65) points += 2

    // Above VWAP/EMAs
    if (vwapRel >= 1.01) points += 1
    if (Number.isFinite(ema20M15) && px > ema20M15 && Number.isFinite(ema50M15) && px > ema50M15) points += 1

    // High in H1 range
    if (posInH1 >= 65) points += 1

    // Fresh push
    if (ret15 >= 1.0 || ret60 >= 2.0) points += 2

    return points >= 3  // Need at least 3 points to qualify
  })

  // Anti-late-dump filter for losers
  const antiLateDump = (c: CoinRow): boolean => {
    const rsiM15 = Number((c as any).RSI_M15 || 50)
    const ret15 = Number((c as any).ret_15m_pct || 0)
    const ret60 = Number((c as any).ret_60m_pct || 0)
    const vwapRel = Number((c as any).vwap_rel_m15 || 1)

    // Extreme late-dump: RSI < 14 AND ret_15m <= -3.5%
    const extremeDump = (rsiM15 < 14 && ret15 <= -3.5)
    
    // BUT: keep 10% "flush edge-cases" with ret_60m <= -6% and vwap_rel << 1
    const isFlushEdge = (ret60 <= -6.0 && vwapRel < 0.97)

    if (extremeDump && !isFlushEdge) return true  // Filter out
    return false  // Keep
  }

  // Anti-parabolic guard for overbought
  const antiParabolic = (c: CoinRow): boolean => {
    const rsiM15 = Number((c as any).RSI_M15 || 50)
    const ret1 = Number((c as any).ret_1m_pct || 0)
    
    // Only extreme parabolic: RSI > 88 AND ret_1m > +1.0%
    // We'll mark as speculative but NOT filter out
    return false  // Never filter, handle in basket assignment
  }

  const losersContFiltered = losersCont.filter(c => !antiLateDump(c))
  const losersFadeFiltered = losersFade.filter(c => !antiLateDump(c))
  const overboughtFiltered = overbought.filter(c => !antiParabolic(c))

  console.error(`[CAND_SELECT_NEW] Branch counts: loser_cont=${losersContFiltered.length}, loser_fade=${losersFadeFiltered.length}, overbought=${overboughtFiltered.length}`)

  // Score all candidates
  type ScoredCandidate = {
    coin: CoinRow
    archetype: 'loser_cont' | 'loser_fade' | 'overbought_blowoff' | 'mixed'
    score: number
    breakdown: any
  }

  const scored: ScoredCandidate[] = []

  for (const c of losersContFiltered) {
    const s = scoreCandidate(c, 'loser_cont')
    scored.push({ coin: c, archetype: 'loser_cont', score: s.score, breakdown: s.breakdown })
  }

  for (const c of losersFadeFiltered) {
    const s = scoreCandidate(c, 'loser_fade')
    scored.push({ coin: c, archetype: 'loser_fade', score: s.score, breakdown: s.breakdown })
  }

  for (const c of overboughtFiltered) {
    const s = scoreCandidate(c, 'overbought_blowoff')
    scored.push({ coin: c, archetype: 'overbought_blowoff', score: s.score, breakdown: s.breakdown })
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score)

  // Composition: aim for ~50/50 split (35 losers + 35 overbought)
  const losersScored = scored.filter(s => s.archetype === 'loser_cont' || s.archetype === 'loser_fade')
  const overboughtScored = scored.filter(s => s.archetype === 'overbought_blowoff')

  const TARGET_LOSERS = Math.floor(TARGET_IDEAL / 2)
  const TARGET_OVERBOUGHT = TARGET_IDEAL - TARGET_LOSERS

  let selectedLosers = losersScored.slice(0, TARGET_LOSERS)
  let selectedOverbought = overboughtScored.slice(0, TARGET_OVERBOUGHT)

  // Fallback: if one branch is short, fill from the other
  if (selectedLosers.length < TARGET_LOSERS && overboughtScored.length > TARGET_OVERBOUGHT) {
    const shortage = TARGET_LOSERS - selectedLosers.length
    const extra = overboughtScored.slice(TARGET_OVERBOUGHT, TARGET_OVERBOUGHT + shortage)
    selectedOverbought = [...selectedOverbought, ...extra]
  }

  if (selectedOverbought.length < TARGET_OVERBOUGHT && losersScored.length > TARGET_LOSERS) {
    const shortage = TARGET_OVERBOUGHT - selectedOverbought.length
    const extra = losersScored.slice(TARGET_LOSERS, TARGET_LOSERS + shortage)
    selectedLosers = [...selectedLosers, ...extra]
  }

  let finalSelected = [...selectedLosers, ...selectedOverbought]

  // Final fallback: if still < TARGET_MIN, add more from full pool
  if (finalSelected.length < TARGET_MIN) {
    const remaining = scored.filter(s => !finalSelected.includes(s))
    const needed = TARGET_MIN - finalSelected.length
    finalSelected = [...finalSelected, ...remaining.slice(0, needed)]
  }

  // Fallback #2: If still not enough, use raw eligible coins sorted by ret_24h (losers) or rsi_m15 (overbought)
  if (finalSelected.length < TARGET_MIN) {
    const alreadyUsed = new Set(finalSelected.map(s => s.coin.symbol))
    const unused = eligible.filter(c => !alreadyUsed.has(c.symbol))
    
    // Sort by ret_24h ascending (biggest losers) for losers
    const losersFallback = unused
      .filter(c => Number((c as any).ret_24h_pct || 0) < 0)
      .sort((a, b) => {
        const retA = Number((a as any).ret_24h_pct || 0)
        const retB = Number((b as any).ret_24h_pct || 0)
        return retA - retB
      })
      .slice(0, 20)

    // Sort by rsi_m15 descending (highest RSI) for overbought
    const overboughtFallback = unused
      .filter(c => Number((c as any).RSI_M15 || 0) >= 60)
      .sort((a, b) => {
        const rsiA = Number((a as any).RSI_M15 || 0)
        const rsiB = Number((b as any).RSI_M15 || 0)
        return rsiB - rsiA
      })
      .slice(0, 20)

    const fallbackPool = [...losersFallback, ...overboughtFallback]
    const needed = TARGET_MIN - finalSelected.length

    for (const c of fallbackPool.slice(0, needed)) {
      const s = scoreCandidate(c, 'mixed')
      finalSelected.push({ coin: c, archetype: 'mixed', score: s.score, breakdown: s.breakdown })
    }
  }

  // Sort final selected by score
  finalSelected.sort((a, b) => b.score - a.score)

  // Cap at TARGET_MAX
  finalSelected = finalSelected.slice(0, TARGET_MAX)

  console.error(`[CAND_SELECT_NEW] Final selection: ${finalSelected.length} candidates`)

  // Assign baskets and build output
  const candidates: Candidate[] = finalSelected.map((s, idx) => {
    const score = s.score

    // Basket assignment
    let basket: 'Prime' | 'Strong Watch' | 'Speculative'
    if (score >= 0.62) basket = 'Prime'
    else if (score >= 0.52) basket = 'Strong Watch'
    else basket = 'Speculative'

    // Check for parabolic special case
    const rsiM15 = Number((s.coin as any).RSI_M15 || 50)
    const ret1 = Number((s.coin as any).ret_1m_pct || 0)
    if (s.archetype === 'overbought_blowoff' && rsiM15 > 88 && ret1 > 1.0) {
      basket = 'Speculative'  // Force to speculative
    }

    // Old tier system (keep for compatibility)
    let tier: Candidate['tier'] = 'SCOUT'
    if (score >= 0.70) tier = 'HOT'
    else if (score >= 0.60) tier = 'ALERT'
    else if (score >= 0.50) tier = 'WATCH'

    // Get UI language from config (default 'cs')
    const uiLang = 'cs'  // TODO: get from config/localStorage if needed

    const reason = generateReason(s.coin, s.archetype, uiLang)

    return {
      symbol: s.coin.symbol,
      score: Number(score.toFixed(4)),
      liquidityUsd: s.coin.volume24h_usd ?? 0,
      atrPctH1: s.coin.atr_pct_H1 ?? 0,
      emaOrderH1: (s.coin.ema_order_H1 as any) ?? '',
      rsiM15: (s.coin.RSI_M15 ?? undefined) as number | undefined,
      rsiH1: (s.coin.RSI_H1 ?? undefined) as number | undefined,
      tier,
      archetype: s.archetype,
      basket,
      reason,
      // Debug fields
      ret24hPct: Number((s.coin as any).ret_24h_pct || 0),
      ret60mPct: Number((s.coin as any).ret_60m_pct || 0),
      ret15mPct: Number((s.coin as any).ret_15m_pct || 0),
      vwapRelM15: Number((s.coin as any).vwap_rel_m15 || 1),
      posInH1RangePct: Number((s.coin as any).h1_range_pos_pct || 50),
      fundingZ: Number.isFinite((s.coin as any).funding_z) ? Number((s.coin as any).funding_z) : undefined,
      oiChangePctH1: Number.isFinite((s.coin as any).oi_change_pct_h1) ? Number((s.coin as any).oi_change_pct_h1) : undefined,
      simSetup: null
    }
  })

  console.error(`[CAND_SELECT_NEW] Breakdown: Prime=${candidates.filter(c => c.basket === 'Prime').length}, Strong=${candidates.filter(c => c.basket === 'Strong Watch').length}, Speculative=${candidates.filter(c => c.basket === 'Speculative').length}`)
  console.error(`[CAND_SELECT_NEW] Archetype breakdown: loser_cont=${candidates.filter(c => c.archetype === 'loser_cont').length}, loser_fade=${candidates.filter(c => c.archetype === 'loser_fade').length}, overbought=${candidates.filter(c => c.archetype === 'overbought_blowoff').length}, mixed=${candidates.filter(c => c.archetype === 'mixed').length}`)

  return candidates
}

// NOTE: buildMockSetup() was removed - it was unused legacy code that violated no-fallbacks policy

function scoreOf(c: CoinRow): number {
  // Dummy scorer for backward compatibility (not used in new system)
  return 0
}
