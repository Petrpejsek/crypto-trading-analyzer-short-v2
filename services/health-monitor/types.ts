// Health Monitor - TypeScript Type Definitions
// SHORT-only trading system

export type HealthProviderType = 'server' | 'gpt'

export type BiasLabel = 'BEARISH' | 'NEUTRAL' | 'BULLISH'
export type MomentumLabel = 'ACCELERATING/DOWN' | 'COOLING' | 'UP'

// Output schema version semafor.v2
export type HealthOutput = {
  version: 'semafor.v2'
  symbol: string
  health_pct: number // 0-100
  success_prob_pct: number // 0-100, for SHORT: high % = likely goes DOWN
  tp_hit_probs_pct: {
    tp1: number // 0-100
    tp2: number // 0-100
    tp3: number // 0-100
  }
  sl_touch_prob_pct: number // 0-100
  segments: {
    green_pct: number
    orange_pct: number
    red_pct: number // must sum to 100
  }
  bias_score: number // 0-100, for SHORT: high = bearish market (good)
  momentum_score: number // 0-100, for SHORT: high = downtrend (good)
  bias_label: BiasLabel
  momentum_label: MomentumLabel
  reasons: string[] // max 5 items
  hard_fail: boolean
  updated_at_utc: string // ISO timestamp
  _debug?: {
    raw_bias?: number
    raw_momentum?: number
    soft_penalties?: number
    raw_score?: number
    used_prompt_version?: string
    current_price?: number
    provider?: HealthProviderType
  }
}

// Market data payload for health calculation
export type MarketPayload = {
  symbol: string
  price: number
  price_ts_utc: string
  vwap_today: number
  ema: {
    m15: {
      20: number
      50: number
    }
    h1: {
      20: number
      50: number
    }
  }
  atr: {
    m15: number
  }
  spread_bps: number
  liquidity_usd: number
  rsi?: {
    m15: number
  }
  support?: number[]
  resistance?: number[]
  funding_8h_pct?: number
  oi_change_1h_pct?: number
}

// Worker registry entry
export type HealthWorkerEntry = {
  symbol: string
  side: 'SHORT' // always SHORT in this project
  status: 'waiting' | 'processing' | 'completed'
  nextRunAt: string // ISO timestamp
  lastRunAt: string | null
  lastOutput: HealthOutput | null
  lastError: string | null
  tickCount: number
  type: 'position' | 'pending_order'
  orderId?: number | null
}

// Entry snapshot for P&L report
export type EntrySnapshot = {
  symbol: string
  health_pct: number
  success_pct: number
  color: 'green' | 'orange' | 'red'
  timestamp: string
  entryTime: number
}

export type SnapshotsData = Record<string, EntrySnapshot>

// Validation constants
export const HEALTH_VERSION = 'semafor.v2'
export const MAX_REASONS = 5
export const SEGMENTS_SUM_TOLERANCE = 1 // ±1%
export const INDEPENDENCE_MIN_DELTA = 5 // |health - success| >= 5

// Timing constants
export const TICK_INTERVAL_MS = 60_000 // 60 seconds
export const JITTER_MIN_MS = 5_000 // 5 seconds
export const JITTER_MAX_MS = 15_000 // 15 seconds
export const CHECK_INTERVAL_MS = 10_000 // 10 seconds
export const MAX_SAMPLES_PER_SYMBOL = 50 // Ring buffer size
export const PAYLOAD_FRESHNESS_MS = 90_000 // 90 seconds
export const SNAPSHOT_RETENTION_DAYS = 30 // Entry snapshots retention

