// Type definitions for Reactive Entry (SHORT trading)

export type ReactiveEntryInput = {
  ok: boolean
  symbol: string
  ts_utc: string
  ui_lang?: 'cs' | 'en'
  tradingRules: {
    tickSize: number
    stepSize: number
    minNotional: number
  }
  prices: {
    last_trade: number
    current: number
    vwap_today?: number
  }
  ema?: {
    m5?: { '20': number | null; '50': number | null }
    m15?: { '20': number | null; '50': number | null }
    h1?: { '20': number | null; '50': number | null }
  }
  momentum?: {
    rsi_m5?: number | null
    rsi_m15?: number | null
    atr_m15?: number | null
    atr_m15_bps?: number | null
    atr_m15_price?: number | null
  }
  range?: {
    h1?: { low: number; high: number }
    h4?: { low: number; high: number }
  }
  micro_range?: {
    low_lookback_mins: number
    low: number
    high: number
  } | null
  resistances?: Array<{ price: number; age_mins: number }>
  position?: {
    avg_entry_price: number | null
    size: number | null
    unrealized_pnl: number | null
  }
  bars_meta?: {
    m5: number
    m15: number
    h1: number
  }
  candles?: {
    m5?: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>
    m15?: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>
    h1?: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>
    h4?: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>
  }
  orderbook?: any
  prior_plan?: any
  flow_context?: any
}

export type ReactiveEntryDecision = {
  decision: 'entry' | 'skip'
  confidence: number
  mode: 'breakdown_retest' | 'vwap_or_ema_bounce' | 'sweep_high_with_LH' | 'resistance_tap_absorption' | 'none'
  class: 'standard' | 'scout' | 'none'
  size_hint_pct: 0 | 5 | 10 | 20
  entry: {
    type: 'limit'
    price: number
  } | null
  reasoning: string
  suggestion?: {
    mode: string
    anchor: 'vwap' | 'ema50_m15' | 'recent_resistance' | 'micro_high'
    min_edge_price: number
    anchor_price: number
  }
  diagnostics: {
    edge_from_current_bps: number
    edge_min_required_bps: number
    used_anchor?: string
    dist_to_vwap_bps?: number | null
    dist_to_ema50_m15_bps?: number | null
    ticks_from_nearest_resistance?: number | null
    nearest_resistance_price?: number | null
    min_edge_price?: number | null
  }
  atr_info?: {
    atr_price: number
    atr_buffer: number
    resistance_used: number | null
    proper_entry: number
  }
}

export type ValidationResult = {
  valid: boolean
  code?: 'missing_fields' | 'invalid_tradingRules' | 'context_insufficient' | 'invalid_ranges'
  details?: string
  missing?: Record<string, { required: number; actual: number }>
}

export type ReactiveEntryConfig = {
  enabled: boolean
  min_edge_bps_default: number
  min_edge_ticks_default: number
  anchor_vwap_threshold_bps: number
  anchor_ema50_threshold_bps: number
  anchor_resistance_age_max_mins: number
  openai_timeout_ms: number
  openai_retry_count: number
  openai_retry_backoff_ms: number
  rate_limit_per_minute: number
  symbol_overrides?: Record<string, {
    min_edge_bps?: number
    min_edge_ticks?: number
  }>
}

