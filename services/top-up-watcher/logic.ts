import type { RegistryEntry, WatcherDecision, WatcherSnapshot, TopUpReasonCode } from './types'

const SPRING_RSI_THRESHOLD = 0

function supportBuffer(snapshot: WatcherSnapshot, entry: RegistryEntry): number {
  const atr = snapshot.indicators.atr_m15
  const tickSize = Number(snapshot.raw?.tick_size || 0)
  const base = atr != null ? Math.max(0.1 * atr, tickSize * 2) : (tickSize > 0 ? tickSize * 4 : 0.5)
  return base
}

function guardConfig(entry: RegistryEntry): {
  wallBandBps: number
  maxSpreadBps: number
  maxSlippageBps: number
  maxTopUps: number
  cooldownSec: number
  // v2 ext
  rmFilterAction: 'HOLD'|'ABORT'
  cooldownMsOnHold: number
  graceWindowMsAfterTouch: number
  maxWatchDurationMs: number
  consumeBidWallPct3s: number
  refreshBidWallPct10s: number
  dwellMs: number
  mildBiasEnabled: boolean
  reversalScoreThreshold: number
  weights: { springReclaim: number; bidwallAbsorb: number; orderflowBias: number; structureBias: number; vwapReclaim: number }
  obi5Min: number
  obi20Min: number
  obi20ContDownAbort: number
  micropriceConfirmMinMs: number
  requireEma20Ge50OnBothTfs: boolean
  requireEma20Ge50AnyTf: boolean
  vwapReclaimBandAtr: number
  minTimeBetweenEntriesMs: number
  maxRepositionPerMinute: number
  topUpWatcherV2Enabled: boolean
} {
  // Read config json (best-effort) to allow dynamic thresholds without changing registry
  let fileCfg: any = {}
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const p = path.resolve('config/top_up_watcher.json')
    if (fs.existsSync(p)) fileCfg = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {}
  const weights = (fileCfg?.weights || {}) as any
  return {
    wallBandBps: Number(entry.limits.wall_band_bps ?? fileCfg?.wallBandBps ?? 10),
    maxSpreadBps: Number(entry.limits.max_spread_bps ?? fileCfg?.maxSpreadBps ?? 25),
    maxSlippageBps: Number(entry.limits.max_slippage_bps ?? fileCfg?.maxSlippageBps ?? 30),
    maxTopUps: Number(entry.limits.max_topups_per_trade ?? 3),
    cooldownSec: Number(entry.limits.cooldown_sec ?? 15),
    rmFilterAction: (String((entry.limits as any)?.rmFilterAction || fileCfg?.rmFilterAction || 'HOLD').toUpperCase() === 'ABORT') ? 'ABORT' : 'HOLD',
    cooldownMsOnHold: Number((entry.limits as any)?.cooldownMsOnHold ?? fileCfg?.cooldownMsOnHold ?? 8000),
    graceWindowMsAfterTouch: Number((entry.limits as any)?.graceWindowMsAfterTouch ?? fileCfg?.graceWindowMsAfterTouch ?? 12000),
    maxWatchDurationMs: Number((entry.limits as any)?.maxWatchDurationMs ?? fileCfg?.maxWatchDurationMs ?? 120000),
    consumeBidWallPct3s: Number((entry.limits as any)?.consumeBidWallPct3s ?? fileCfg?.consumeBidWallPct3s ?? 60),
    refreshBidWallPct10s: Number((entry.limits as any)?.refreshBidWallPct10s ?? fileCfg?.refreshBidWallPct10s ?? 30),
    dwellMs: Number((entry.limits as any)?.dwellMs ?? fileCfg?.dwellMs ?? 5000),
    mildBiasEnabled: Boolean((entry.limits as any)?.mildBiasEnabled ?? fileCfg?.mildBiasEnabled ?? false),
    reversalScoreThreshold: Number((entry.limits as any)?.reversalScoreThreshold ?? fileCfg?.reversalScoreThreshold ?? 1.0),
    weights: {
      springReclaim: Number(weights?.springReclaim ?? 0.5),
      bidwallAbsorb: Number(weights?.bidwallAbsorb ?? 0.35),
      orderflowBias: Number(weights?.orderflowBias ?? 0.25),
      structureBias: Number(weights?.structureBias ?? 0.2),
      vwapReclaim: Number(weights?.vwapReclaim ?? 0.2)
    },
    obi5Min: Number((entry.limits as any)?.obi5Min ?? fileCfg?.obi5Min ?? 0.1),
    obi20Min: Number((entry.limits as any)?.obi20Min ?? fileCfg?.obi20Min ?? 0.1),
    obi20ContDownAbort: Number((entry.limits as any)?.obi20ContDownAbort ?? fileCfg?.obi20ContDownAbort ?? -0.15),
    micropriceConfirmMinMs: Number((entry.limits as any)?.micropriceConfirmMinMs ?? fileCfg?.micropriceConfirmMinMs ?? 1500),
    requireEma20Ge50OnBothTfs: Boolean((entry.limits as any)?.requireEma20Ge50OnBothTfs ?? fileCfg?.requireEma20Ge50OnBothTfs ?? true),
    requireEma20Ge50AnyTf: Boolean((entry.limits as any)?.requireEma20Ge50AnyTf ?? fileCfg?.requireEma20Ge50AnyTf ?? false),
    vwapReclaimBandAtr: Number((entry.limits as any)?.vwapReclaimBandAtr ?? fileCfg?.vwapReclaimBandAtr ?? 0.1),
    minTimeBetweenEntriesMs: Number((entry.limits as any)?.minTimeBetweenEntriesMs ?? fileCfg?.minTimeBetweenEntriesMs ?? 15000),
    maxRepositionPerMinute: Number((entry.limits as any)?.maxRepositionPerMinute ?? fileCfg?.maxRepositionPerMinute ?? 1),
    topUpWatcherV2Enabled: Boolean(fileCfg?.topUpWatcherV2Enabled ?? true)
  }
}

function insideBand(price: number | null, anchor: number | null, bandBps: number): boolean {
  if (!Number.isFinite(price as any) || !Number.isFinite(anchor as any)) return false
  const p = price as number
  const a = anchor as number
  const diffBps = Math.abs(((p - a) / a) * 10000)
  return diffBps <= bandBps
}

function biasChecks(snapshot: WatcherSnapshot): { emaM5Up: boolean; emaM15Up: boolean; vwapHold: boolean } {
  const emaM5Up = snapshot.indicators.ema_m5[20] != null && snapshot.indicators.ema_m5[50] != null && snapshot.indicators.ema_m5[20]! >= snapshot.indicators.ema_m5[50]!
  const emaM15Up = snapshot.indicators.ema_m15[20] != null && snapshot.indicators.ema_m15[50] != null && snapshot.indicators.ema_m15[20]! >= snapshot.indicators.ema_m15[50]!
  const vwap = snapshot.indicators.vwap_m15
  const close = snapshot.raw?.klines?.M15?.at(-1)?.close ?? snapshot.indicators.markPrice
  const vwapHold = vwap != null && close != null && (close as number) >= vwap
  return { emaM5Up, emaM15Up, vwapHold }
}

function checkRiskFilters(snapshot: WatcherSnapshot, entry: RegistryEntry): { fail: boolean; reason?: TopUpReasonCode; telemetry?: Record<string, any> } {
  const { maxSpreadBps, maxSlippageBps } = guardConfig(entry)
  const spread = snapshot.market.spread_bps
  const slip = snapshot.market.estSlippageBps
  const pump = snapshot.pumpFilterActive === true
  const spreadFail = Number.isFinite(spread as any) && (spread as number) > maxSpreadBps
  const slipFail = Number.isFinite(slip as any) && entry.maxSlippagePct > 0 && (slip as number) > entry.maxSlippagePct * 100
  if (spreadFail || slipFail || pump) {
    return {
      fail: true,
      reason: 'RM_FILTER',
      telemetry: {
        spread_bps: spread ?? null,
        estSlipBps: slip ?? null,
        pump
      }
    }
  }
  return { fail: false }
}

function checkBiasFlip(snapshot: WatcherSnapshot): boolean {
  const bias = biasChecks(snapshot)
  const emaM15_20 = snapshot.indicators.ema_m15[20]
  const emaM15_50 = snapshot.indicators.ema_m15[50]
  const emaM5_20 = snapshot.indicators.ema_m5[20]
  const emaM5_50 = snapshot.indicators.ema_m5[50]
  const close = snapshot.raw?.klines?.M15?.at(-1)?.close ?? snapshot.indicators.markPrice
  const atr = snapshot.indicators.atr_m15
  const vwap = snapshot.indicators.vwap_m15

  const flipFlags = [
    emaM15_20 != null && emaM15_50 != null && emaM15_20 < emaM15_50,
    emaM5_20 != null && emaM5_50 != null && emaM5_20 < emaM5_50,
    (() => {
      if (close == null || vwap == null || atr == null) return false
      return close < vwap - 0.15 * atr
    })()
  ]
  if (flipFlags.filter(Boolean).length >= 2) return true
  return !(bias.emaM5Up && bias.emaM15Up && bias.vwapHold)
}

function checkDeltaAtr(entry: RegistryEntry, snapshot: WatcherSnapshot): boolean {
  const mark = snapshot.indicators.markPrice
  const atr = snapshot.indicators.atr_m15
  if (mark == null || atr == null) return false
  return mark <= entry.pilot.entry_price - atr
}

function detectSpring(snapshot: WatcherSnapshot, entry: RegistryEntry, buffer: number, cfg: ReturnType<typeof guardConfig>): { ok: boolean; telemetry?: Record<string, any> } {
  const anchor = entry.pilot.anchor_support
  if (!Number.isFinite(anchor as any)) return { ok: false }
  const candles = snapshot.recentCandles?.m1 || []
  if (candles.length < 2) return { ok: false }
  const springWick = candles.reduce((min, c) => Math.min(min, Number(c.low)), Number.POSITIVE_INFINITY)
  const closes = candles.slice(-2)
  const reclaim = closes.every(c => Number(c.close) >= (anchor as number) + 0.5 * buffer)
  const orderFlow = (() => {
    const obi = snapshot.orderbook?.obi5 ?? snapshot.orderbook?.obi20 ?? null
    const mp = snapshot.orderbook?.micropriceBias
    const taker = snapshot.flow?.takerDelta15s
    return (obi != null && obi >= 0.1) || mp === 'ask' || (Number.isFinite(taker) && (taker as number) > 0)
  })()
  const liquidityOk = (() => {
    const spread = snapshot.market.spread_bps
    const slip = snapshot.market.estSlippageBps
    return (!Number.isFinite(spread as any) || (spread as number) <= cfg.maxSpreadBps) && (!Number.isFinite(slip as any) || (slip as number) <= cfg.maxSlippageBps)
  })()
  const ok = springWick <= (anchor as number) - buffer && reclaim && orderFlow && liquidityOk
  return {
    ok,
    telemetry: {
      springWick: springWick === Number.POSITIVE_INFINITY ? null : springWick,
      reclaim,
      orderFlow,
      liquidityOk
    }
  }
}

function detectAbsorb(snapshot: WatcherSnapshot, entry: RegistryEntry, buffer: number, cfg: ReturnType<typeof guardConfig>): { ok: boolean; telemetry?: Record<string, any> } {
  const anchor = entry.pilot.anchor_support
  if (!Number.isFinite(anchor as any)) return { ok: false }
  const orderbook = snapshot.orderbook
  if (!orderbook) return { ok: false }
  const band = cfg.wallBandBps
  const bidWallPrice = orderbook.nearestBidWallPrice
  const consume = orderbook.consumeBidWallPct3s
  const refresh = orderbook.refreshBidWallPct10s
  const dwellMs = orderbook.dwellBidMs
  const bias = biasChecks(snapshot)
  const close = snapshot.indicators.markPrice
  const absorb = insideBand(bidWallPrice, anchor, band) && (
    (consume != null && consume >= cfg.consumeBidWallPct3s && close != null && close >= (anchor as number) - buffer)
    || (refresh != null && refresh >= cfg.refreshBidWallPct10s && dwellMs != null && dwellMs >= cfg.dwellMs)
  ) && (
    (cfg.mildBiasEnabled ? (bias.emaM5Up || bias.emaM15Up) : (bias.emaM5Up && bias.emaM15Up))
  ) && bias.vwapHold
  const liquidityOk = (() => {
    const spread = snapshot.market.spread_bps
    const slip = snapshot.market.estSlippageBps
    return (!Number.isFinite(spread as any) || (spread as number) <= cfg.maxSpreadBps) && (!Number.isFinite(slip as any) || (slip as number) <= cfg.maxSlippageBps)
  })()
  return {
    ok: absorb && liquidityOk,
    telemetry: {
      bidWallPrice,
      consume,
      refresh,
      dwellMs,
      bias,
      liquidityOk
    }
  }
}

function detectWallFailure(snapshot: WatcherSnapshot, entry: RegistryEntry, buffer: number, cfg: ReturnType<typeof guardConfig>): boolean {
  const anchor = entry.pilot.anchor_support
  if (!snapshot.orderbook || !Number.isFinite(anchor as any)) return false
  const consume = snapshot.orderbook.consumeBidWallPct3s
  const refresh = snapshot.orderbook.refreshBidWallPct10s
  const close = snapshot.indicators.markPrice
  return insideBand(snapshot.orderbook.nearestBidWallPrice, anchor, cfg.wallBandBps)
    && consume != null && consume >= 80
    && (refresh == null || refresh < 15)
    && close != null && close < (anchor as number) - buffer
}

function detectContinuationDown(snapshot: WatcherSnapshot, cfg: ReturnType<typeof guardConfig>): boolean {
  const obi20 = snapshot.orderbook?.obi20
  const mp = snapshot.orderbook?.micropriceBias
  const taker = snapshot.flow?.takerDelta15s
  const dwellBid = snapshot.orderbook?.dwellBidMs ?? 0
  return (obi20 != null && (obi20 as number) <= cfg.obi20ContDownAbort) && mp === 'bid' && dwellBid >= cfg.micropriceConfirmMinMs && (Number.isFinite(taker) && (taker as number) < 0)
}

function computeReversalScore(snapshot: WatcherSnapshot, entry: RegistryEntry, buffer: number, cfg: ReturnType<typeof guardConfig>): { score: number; flags: string[] } {
  const flags: string[] = []
  let score = 0
  // Spring + reclaim
  const m1 = snapshot.recentCandles?.m1 || []
  const anchor = entry.pilot.anchor_support
  const springWick = m1.length ? m1.reduce((min, c) => Math.min(min, Number(c.low)), Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY
  const closes = m1.slice(-2)
  const reclaim = closes.length >= 2 && closes.every(c => Number(c.close) >= (anchor as number) + 0.5 * buffer)
  if (Number.isFinite(springWick) && (anchor != null) && (springWick as number) <= (anchor as number) - buffer && reclaim) { score += cfg.weights.springReclaim; flags.push('spring') }
  // Bidwall absorb
  const ob = snapshot.orderbook
  if (ob && insideBand(ob.nearestBidWallPrice, anchor ?? null, cfg.wallBandBps)) {
    const okAbs = (ob.consumeBidWallPct3s != null && (ob.consumeBidWallPct3s as number) >= cfg.consumeBidWallPct3s)
      || (ob.refreshBidWallPct10s != null && (ob.refreshBidWallPct10s as number) >= cfg.refreshBidWallPct10s && (ob.dwellBidMs != null && (ob.dwellBidMs as number) >= cfg.dwellMs))
    if (okAbs) { score += cfg.weights.bidwallAbsorb; flags.push('absorb') }
  }
  // Orderflow bias
  const obi5 = snapshot.orderbook?.obi5
  const obi20 = snapshot.orderbook?.obi20
  const mpBias = snapshot.orderbook?.micropriceBias
  if (((obi5 != null && (obi5 as number) >= cfg.obi5Min) || (obi20 != null && (obi20 as number) >= cfg.obi20Min)) && mpBias === 'ask') { score += cfg.weights.orderflowBias; flags.push('orderflow_ok') }
  // Structure bias
  const bias = biasChecks(snapshot)
  const structureOk = cfg.mildBiasEnabled ? (bias.emaM5Up || bias.emaM15Up) : (bias.emaM5Up && bias.emaM15Up)
  if (structureOk) { score += cfg.weights.structureBias; flags.push('structure_mild') }
  // VWAP reclaim
  const vwap = snapshot.indicators.vwap_m15
  const mark = snapshot.indicators.markPrice
  const atr = snapshot.indicators.atr_m15
  if (vwap != null && mark != null && atr != null && (mark as number) >= (vwap as number) - cfg.vwapReclaimBandAtr * (atr as number)) { score += cfg.weights.vwapReclaim; flags.push('vwap_reclaim') }
  return { score, flags }
}

export function evaluateWatcherTick(entry: RegistryEntry, snapshot: WatcherSnapshot): WatcherDecision {
  const now = Date.now()
  const deadline = Date.parse(entry.deadlineAt)
  const cfg = guardConfig(entry)
  const ttlExpired = Number.isFinite(deadline) && now >= deadline
  const telemetry: Record<string, any> = {
    symbol: entry.symbol,
    anchor_support: entry.pilot.anchor_support,
    ttlLeftSec: Number.isFinite(deadline) ? Math.max(0, Math.floor((deadline - now) / 1000)) : null
  }

  if (ttlExpired) {
    return { action: 'HOLD', reason_code: 'TTL_EXPIRED', reasoning: 'ttl_expired_hold', confidence: 0.5, telemetry }
  }

  const risk = checkRiskFilters(snapshot, entry)
  if (risk.fail) {
    if (cfg.rmFilterAction === 'HOLD') {
      return {
        action: 'HOLD',
        reason_code: risk.reason!,
        reasoning: 'rm_filter_hold',
        confidence: 0.5,
        telemetry: { ...telemetry, ...(risk.telemetry || {}), cooldownMs: cfg.cooldownMsOnHold }
      }
    }
    return { action: 'ABORT_TOPUP', reason_code: risk.reason!, reasoning: 'Risk filter violation (spread/slippage/pump)', confidence: 0.7, telemetry: { ...telemetry, ...(risk.telemetry || {}) } }
  }

  if (checkBiasFlip(snapshot)) {
    // V2: no immediate abort; hold and reassess
    return { action: 'HOLD', reason_code: 'FLIP', reasoning: 'structure_flip_hold', confidence: 0.5, telemetry }
  }

  if (checkDeltaAtr(entry, snapshot)) {
    // Treat as hold unless other fatal signals
    return { action: 'HOLD', reason_code: 'DELTA_ATR', reasoning: 'delta_atr_hold', confidence: 0.5, telemetry }
  }

  const buffer = supportBuffer(snapshot, entry)
  const spring = detectSpring(snapshot, entry, buffer, cfg)
  const absorb = detectAbsorb(snapshot, entry, buffer, cfg)

  if (detectWallFailure(snapshot, entry, buffer, cfg)) {
    return { action: 'HOLD', reason_code: 'WALL_EXHAUSTED', reasoning: 'wall_exhausted_hold', confidence: 0.5, telemetry }
  }

  if (detectContinuationDown(snapshot, cfg)) {
    return { action: 'HOLD', reason_code: 'CONTINUATION_DOWN', reasoning: 'continuation_guard_hold', confidence: 0.5, telemetry }
  }

  // Reversal scoring layer (V2)
  const { score, flags } = computeReversalScore(snapshot, entry, buffer, cfg)

  if (spring.ok || absorb.ok || score >= cfg.reversalScoreThreshold) {
    const need = Math.max(1, entry.limits.debounce_required)
    const nextCount = entry.lastResult === 'TOP_UP_ELIGIBLE' ? entry.debounceCounter + 1 : 1
    const reason: TopUpReasonCode = spring.ok ? 'SPRING_RECLAIM_CONFIRMED' : (absorb.ok ? 'ABSORB_CONFIRMED' : 'EMA_VWAP_BIAS')
    const reasonTelemetry = spring.ok ? spring.telemetry : (absorb.ok ? absorb.telemetry : {})
    if (nextCount >= need) {
      return {
        action: 'TOP_UP_ELIGIBLE',
        reason_code: reason,
        reasoning: spring.ok ? 'Spring and reclaim confirmed with positive order flow' : (absorb.ok ? 'Absorption confirmed with defended bid wall' : 'Reversal score threshold reached'),
        confidence: 0.7,
        telemetry: { ...telemetry, buffer, score, why_ready: flags, ...(reasonTelemetry || {}) }
      }
    }
    return {
      action: 'HOLD',
      reason_code: reason,
      reasoning: 'First confirmation detected, waiting debounce',
      confidence: 0.5,
      telemetry: { ...telemetry, buffer, score, why_ready: flags, ...(reasonTelemetry || {}), debounce: nextCount }
    }
  }

  return {
    action: 'HOLD',
    reason_code: 'NONE',
    reasoning: 'Awaiting further confirmation',
    confidence: 0.4,
    telemetry
  }
}


