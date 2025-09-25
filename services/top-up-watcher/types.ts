import type { UniverseItem } from '../../types/market_raw'

export type TopUpAction = 'HOLD' | 'TOP_UP_ELIGIBLE' | 'ABORT_TOPUP'

export type TopUpReasonCode =
  | 'SPRING_RECLAIM_CONFIRMED'
  | 'ABSORB_CONFIRMED'
  | 'EMA_VWAP_BIAS'
  | 'FLIP'
  | 'DELTA_ATR'
  | 'RM_FILTER'
  | 'TTL_EXPIRED'
  | 'WALL_EXHAUSTED'
  | 'CONTINUATION_DOWN'
  | 'TECH_ERROR'
  | 'NONE'

export type PilotPosition = {
  entry_price: number
  size: number
  sl: number
  tp_levels: Array<{ tag: 'tp1' | 'tp2' | 'tp3'; price: number; allocation_pct: number }>
  opened_at: string
  anchor_support: number | null
}

export type TopUpPlan = {
  planned_total_size: number
}

export type TopUpLimits = {
  ttl_minutes: number
  debounce_required: number
  poll_interval_sec: number
  poll_interval_jitter_sec: number
  cooldown_sec?: number
  max_topups_per_trade?: number
  wall_band_bps?: number
  max_spread_bps?: number
  max_slippage_bps?: number
  continuation_down_delta_usd?: number
  // V2 extensions
  rmFilterAction?: 'HOLD' | 'ABORT'
  cooldownMsOnHold?: number
  graceWindowMsAfterTouch?: number
  maxWatchDurationMs?: number
  consumeBidWallPct3s?: number
  refreshBidWallPct10s?: number
  dwellMs?: number
  mildBiasEnabled?: boolean
  reversalScoreThreshold?: number
  weights?: {
    springReclaim?: number
    bidwallAbsorb?: number
    orderflowBias?: number
    structureBias?: number
    vwapReclaim?: number
  }
  obi5Min?: number
  obi20Min?: number
  obi20ContDownAbort?: number
  micropriceConfirmMinMs?: number
  requireEma20Ge50OnBothTfs?: boolean
  requireEma20Ge50AnyTf?: boolean
  vwapReclaimBandAtr?: number
  minTimeBetweenEntriesMs?: number
  maxRepositionPerMinute?: number
}

export type WatcherContext = {
  symbol: string
  pilot: PilotPosition
  plan: TopUpPlan
  limits: TopUpLimits
  maxSlippagePct: number
}

export type SnapshotOrderBook = {
  microprice: number | null
  micropriceBias: 'bid' | 'ask' | 'neutral'
  obi5: number | null
  obi20: number | null
  nearestAskWallPrice: number | null
  nearestAskWallDistBps: number | null
  nearestBidWallPrice: number | null
  nearestBidWallDistBps: number | null
  consumeBidWallPct3s: number | null
  consumeAskWallPct3s: number | null
  refreshBidWallPct10s?: number | null
  refreshAskWallPct10s?: number | null
  dwellBidMs?: number | null
  dwellAskMs?: number | null
  timeline?: Array<{ timestamp: number; bidPrice: number | null; bidNotional: number | null; askPrice: number | null; askNotional: number | null }>
}

export type SnapshotIndicators = {
  markPrice: number | null
  atr_m15: number | null
  ema_m5: { 20: number | null; 50: number | null }
  ema_m15: { 20: number | null; 50: number | null }
  vwap_m15: number | null
  rsi_m5: number | null
  rsi_m15: number | null
  rsi_m5_delta: number | null
}

export type SnapshotMarket = {
  spread_bps: number | null
  estSlippageBps: number | null
  pumpFilter: boolean | null
  posture: 'OK' | 'CAUTION' | 'NO-TRADE' | null
}

export type WatcherSnapshot = {
  symbol: string
  timestamp: string
  indicators: SnapshotIndicators
  orderbook: SnapshotOrderBook | null
  market: SnapshotMarket
  raw?: UniverseItem | null
  pumpFilterActive?: boolean | null
  recentCandles?: {
    m1?: Array<{ openTime: string; closeTime: string; open: number; high: number; low: number; close: number; volume: number }>
    m5?: Array<{ openTime: string; closeTime: string; open: number; high: number; low: number; close: number; volume: number }>
  }
  flow?: {
    takerDelta15s?: number | null
  }
}

export type WatcherDecision = {
  action: TopUpAction
  reason_code: TopUpReasonCode
  reasoning: string
  confidence: number
  telemetry?: Record<string, any>
}

export type WatcherEvent = WatcherDecision & {
  symbol: string
  snapshot_ts: string
  pilotEntryPrice?: number
  markPrice?: number
  desiredTopUpNotionalMultiplier?: number
  riskSnapshot?: Record<string, any>
  supportRef?: string | null
}

export type RegistryEntry = {
  symbol: string
  pilot: PilotPosition
  plan: TopUpPlan
  limits: TopUpLimits
  maxSlippagePct: number
  startedAt: string
  deadlineAt: string
  status: 'running' | 'completed'
  lastTickAt: string | null
  checks: number
  debounceCounter: number
  lastResult: TopUpAction | null
  nextRunAt: string
  lastBidWallPrice: number | null
  lastBidWallSeenAt: number | null
  lastAskWallPrice: number | null
  lastAskWallSeenAt: number | null
  topUpsEmitted: number
}


