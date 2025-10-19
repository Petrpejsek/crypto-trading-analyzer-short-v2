// Health Monitor - Server Calculator
// SHORT-INVERTED LOGIC: bearish market = high health (good for SHORT)

import type { MarketPayload, HealthOutput, BiasLabel, MomentumLabel } from './types'

/**
 * Calculate health using deterministic server-side algorithm
 * INVERTED FOR SHORT: bearish conditions = high scores
 * 
 * @param payload Market data payload
 * @param options Optional context for pending orders
 */
export function calculateHealth(
  payload: MarketPayload, 
  options?: { 
    isPendingOrder?: boolean
    orderPrice?: number
    plannedTP?: number | null 
  }
): HealthOutput {
  const { symbol, price, vwap_today, ema, atr, spread_bps, liquidity_usd, rsi, support, resistance } = payload
  
  // Extract pending order context
  const isPending = options?.isPendingOrder || false
  const orderPrice = options?.orderPrice
  const plannedTP = options?.plannedTP

  // ============================================
  // BIAS SCORE (0-100) - INVERTED FOR SHORT
  // ============================================
  
  // 1. Price vs VWAP (40% weight) - INVERTED
  const vwapDiff = ((price - vwap_today) / vwap_today) * 100
  let priceVsVwapScore = 0
  
  // For SHORT: price BELOW vwap = good
  if (vwapDiff <= -0.5) priceVsVwapScore = 100 // strong bearish
  else if (vwapDiff <= -0.2) priceVsVwapScore = 80
  else if (vwapDiff <= 0) priceVsVwapScore = 60
  else if (vwapDiff <= 0.2) priceVsVwapScore = 40
  else if (vwapDiff <= 0.5) priceVsVwapScore = 20
  else priceVsVwapScore = 0 // strong bullish = bad for SHORT

  // 2. EMA Alignment (40% weight) - INVERTED
  // For SHORT: price < ema20 < ema50 = bearish alignment = good
  let emaAlignmentScore = 0
  
  // M15 alignment
  if (price < ema.m15[20]) emaAlignmentScore += 25 // price below ema20
  if (ema.m15[20] < ema.m15[50]) emaAlignmentScore += 25 // ema20 below ema50 (downtrend)
  
  // H1 alignment
  if (price < ema.h1[20]) emaAlignmentScore += 25
  if (ema.h1[20] < ema.h1[50]) emaAlignmentScore += 25

  // 3. Support/Resistance (20% weight)
  let supportResistanceScore = 50 // neutral default
  if (support && resistance && support.length > 0 && resistance.length > 0) {
    const nearestSupport = support[0]
    const nearestResistance = resistance[0]
    const distToSupport = Math.abs(price - nearestSupport)
    const distToResistance = Math.abs(price - nearestResistance)
    
    // For SHORT: closer to resistance = more room to fall = good
    if (distToResistance < distToSupport) {
      supportResistanceScore = 70 // near resistance, can fall
    } else {
      supportResistanceScore = 30 // near support, less room
    }
  }

  const raw_bias = (
    priceVsVwapScore * 0.4 +
    emaAlignmentScore * 0.4 +
    supportResistanceScore * 0.2
  )
  const bias_score = Math.round(Math.max(0, Math.min(100, raw_bias)))

  // ============================================
  // MOMENTUM SCORE (0-100) - INVERTED FOR SHORT
  // ============================================

  // 1. EMA Slope (30% weight) - INVERTED
  // For SHORT: negative slope = downtrend = good
  const emaSlope = ((ema.m15[20] - ema.m15[50]) / ema.m15[50]) * 100
  let emaSlopeScore = 0
  
  if (emaSlope <= -0.5) emaSlopeScore = 100 // strong downtrend
  else if (emaSlope <= -0.2) emaSlopeScore = 80
  else if (emaSlope <= 0) emaSlopeScore = 60 // mild downtrend
  else if (emaSlope <= 0.2) emaSlopeScore = 40
  else if (emaSlope <= 0.5) emaSlopeScore = 20
  else emaSlopeScore = 0 // strong uptrend = bad

  // 2. RSI Score (30% weight) - INVERTED
  let rsiScore = 50 // neutral default
  if (rsi && Number.isFinite(rsi.m15)) {
    const rsiVal = rsi.m15
    // For SHORT: 30-50 = healthy bearish zone
    if (rsiVal >= 30 && rsiVal <= 50) rsiScore = 100 // perfect bearish
    else if (rsiVal < 30) rsiScore = 60 // oversold warning (bounce risk)
    else if (rsiVal >= 50 && rsiVal < 60) rsiScore = 40
    else if (rsiVal >= 60 && rsiVal < 70) rsiScore = 20
    else rsiScore = 0 // overbought = very bad for SHORT
  }

  // 3. Spread Score (20% weight) - neutral (same for both directions)
  let spreadScore = 0
  if (spread_bps <= 5) spreadScore = 100
  else if (spread_bps <= 10) spreadScore = 80
  else if (spread_bps <= 20) spreadScore = 60
  else if (spread_bps <= 40) spreadScore = 40
  else if (spread_bps <= 60) spreadScore = 20
  else spreadScore = 0

  // 4. Liquidity Score (20% weight) - neutral
  let liquidityScore = 0
  if (liquidity_usd >= 500_000) liquidityScore = 100
  else if (liquidity_usd >= 300_000) liquidityScore = 80
  else if (liquidity_usd >= 150_000) liquidityScore = 60
  else if (liquidity_usd >= 75_000) liquidityScore = 40
  else if (liquidity_usd >= 30_000) liquidityScore = 20
  else liquidityScore = 0

  const raw_momentum = (
    emaSlopeScore * 0.3 +
    rsiScore * 0.3 +
    spreadScore * 0.2 +
    liquidityScore * 0.2
  )
  const momentum_score = Math.round(Math.max(0, Math.min(100, raw_momentum)))

  // ============================================
  // FINAL HEALTH SCORE
  // ============================================

  const raw_score = bias_score * 0.55 + momentum_score * 0.45
  const soft_penalties = 0 // placeholder for future enhancements
  const health_pct = Math.round(Math.max(0, Math.min(100, raw_score - soft_penalties)))

  // ============================================
  // SUCCESS PROBABILITY (for SHORT: high % = likely goes DOWN)
  // ============================================

  const success_prob_pct = Math.round(
    health_pct * 0.5 +
    bias_score * 0.3 +
    momentum_score * 0.2
  )

  // ============================================
  // TP HIT PROBABILITIES (SHORT: TP below entry)
  // ============================================

  const tp_hit_probs_pct = {
    tp1: Math.round(success_prob_pct * 0.9), // 90% of success
    tp2: Math.round(success_prob_pct * 0.6), // 60% of success
    tp3: Math.round(success_prob_pct * 0.4)  // 40% of success
  }

  // ============================================
  // SL TOUCH PROBABILITY (SHORT: SL above entry)
  // ============================================

  const sl_touch_prob_pct = Math.round(100 - health_pct * 0.8)

  // ============================================
  // SEGMENTS (visual semafor)
  // ============================================

  let green_pct: number, orange_pct: number, red_pct: number

  if (health_pct >= 70) {
    green_pct = 60 + Math.random() * 40 // 60-100%
    orange_pct = 5 + Math.random() * 25  // 5-30%
    red_pct = 100 - green_pct - orange_pct
  } else if (health_pct >= 40) {
    green_pct = 20 + Math.random() * 40 // 20-60%
    orange_pct = 30 + Math.random() * 30 // 30-60%
    red_pct = 100 - green_pct - orange_pct
  } else {
    green_pct = Math.random() * 20 // 0-20%
    orange_pct = 30 + Math.random() * 30 // 30-60%
    red_pct = 100 - green_pct - orange_pct
  }

  // Normalize to exactly 100
  const segmentsSum = green_pct + orange_pct + red_pct
  green_pct = Math.round((green_pct / segmentsSum) * 100)
  orange_pct = Math.round((orange_pct / segmentsSum) * 100)
  red_pct = 100 - green_pct - orange_pct

  // ============================================
  // LABELS
  // ============================================

  const bias_label: BiasLabel = 
    bias_score >= 60 ? 'BEARISH' :
    bias_score >= 40 ? 'NEUTRAL' :
    'BULLISH'

  const momentum_label: MomentumLabel =
    momentum_score >= 60 ? 'ACCELERATING/DOWN' :
    momentum_score >= 40 ? 'COOLING' :
    'UP'

  // ============================================
  // REASONS (max 5, prioritized, SHORT-aware)
  // ============================================

  const reasons: string[] = []

  // Pending order specific reason (if applicable)
  if (isPending && orderPrice && Number.isFinite(orderPrice)) {
    const deltaPct = ((orderPrice - price) / price) * 100
    if (Math.abs(deltaPct) >= 0.5) {
      if (deltaPct < 0) {
        // Order price BELOW current price (good for SHORT entry)
        reasons.push(`Entry order ${Math.abs(deltaPct).toFixed(1)}% below mark (good SHORT entry)`)
      } else {
        // Order price ABOVE current price (risky for SHORT entry)
        reasons.push(`Entry order ${deltaPct.toFixed(1)}% above mark (risky SHORT entry)`)
      }
    }
  }

  // 1. Price vs VWAP
  if (Math.abs(vwapDiff) >= 0.3) {
    if (vwapDiff < 0) {
      reasons.push(`Price ${Math.abs(vwapDiff).toFixed(1)}% below VWAP, strong bearish`)
    } else {
      reasons.push(`Price ${vwapDiff.toFixed(1)}% above VWAP, bullish pressure`)
    }
  }

  // 2. EMA alignment
  if (emaAlignmentScore >= 75) {
    reasons.push('Downtrend EMAs aligned (good for SHORT)')
  } else if (emaAlignmentScore <= 25) {
    reasons.push('Uptrend EMAs aligned (bad for SHORT)')
  }

  // 3. EMA slope
  if (emaSlope <= -0.3) {
    reasons.push(`Strong downtrend momentum (slope ${emaSlope.toFixed(2)}%)`)
  } else if (emaSlope >= 0.3) {
    reasons.push(`Uptrend momentum detected (slope ${emaSlope.toFixed(2)}%)`)
  }

  // 4. RSI zone
  if (rsi && Number.isFinite(rsi.m15)) {
    const rsiVal = rsi.m15
    if (rsiVal < 30) {
      reasons.push(`RSI oversold at ${rsiVal.toFixed(0)} (bounce risk)`)
    } else if (rsiVal >= 30 && rsiVal <= 50) {
      reasons.push(`RSI healthy bearish zone at ${rsiVal.toFixed(0)}`)
    } else if (rsiVal > 70) {
      reasons.push(`RSI overbought at ${rsiVal.toFixed(0)} (correction potential)`)
    }
  }

  // 5. Spread warning
  if (spread_bps > 40) {
    reasons.push(`Wide spread (${spread_bps.toFixed(0)} bps) - execution risk`)
  }

  // Keep max 5 reasons
  const finalReasons = reasons.slice(0, 5)

  // ============================================
  // OUTPUT
  // ============================================

  return {
    version: 'semafor.v2',
    symbol,
    health_pct,
    success_prob_pct,
    tp_hit_probs_pct,
    sl_touch_prob_pct,
    segments: {
      green_pct,
      orange_pct,
      red_pct
    },
    bias_score,
    momentum_score,
    bias_label,
    momentum_label,
    reasons: finalReasons,
    hard_fail: false,
    updated_at_utc: new Date().toISOString(),
    _debug: {
      raw_bias,
      raw_momentum,
      soft_penalties,
      raw_score,
      used_prompt_version: 'server_calculator_short_v1',
      current_price: price,
      provider: 'server'
    }
  }
}

