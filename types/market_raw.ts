export type Kline = {
  openTime: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  closeTime: string
}

export type KlineSet = {
  H4?: Kline[]
  H1?: Kline[]
  M15?: Kline[]
  M5?: Kline[]
}

export type ExchangeFilters = Record<string, {
  tickSize: number
  stepSize: number
  minQty: number
  minNotional: number
}>

export type UniverseItem = {
  symbol: string
  klines: {
    H1?: Kline[]
    M15?: Kline[]
    M5?: Kline[]
  }
  price?: number
  funding?: number
  oi_now?: number
  oi_hist?: Array<{ timestamp: string; value: number }>
  depth1pct_usd?: number
  spread_bps?: number
  volume24h_usd?: number
  // Added analytics (server-provided to avoid client recompute)
  atr_h1?: number | null
  atr_m15?: number | null
  atr_pct_H1?: number | null
  atr_pct_M15?: number | null
  ema20_H1?: number | null
  ema50_H1?: number | null
  ema200_H1?: number | null
  ema20_M15?: number | null
  ema50_M15?: number | null
  ema200_M15?: number | null
  ema_h1?: { 20?: number | null; 50?: number | null; 200?: number | null }
  ema_m15?: { 20?: number | null; 50?: number | null; 200?: number | null }
  rsi_H1?: number | null
  rsi_M15?: number | null
  oi_change_1h_pct?: number | null
  funding_8h_pct?: number | null
  vwap_daily?: number | null
  vwap_rel_daily?: number | null
  vwap_today?: number | null
  vwap_rel_today?: number | null
  support?: number[]
  resistance?: number[]
  prev_day_close?: number | null
  h4_high?: number | null
  h4_low?: number | null
  d1_high?: number | null
  d1_low?: number | null
  liquidity_usd_0_5pct?: { bids: number; asks: number } | null
  liquidity_usd_1pct?: { bids: number; asks: number } | null
  liquidity_usd?: number | null
  // Instrument info
  exchange?: string
  market_type?: 'perp' | 'spot'
  fees_bps?: number | null
  tick_size?: number | null
}

export type MarketRawSnapshot = {
  timestamp: string
  latency_ms?: number
  duration_ms?: number
  feeds_ok: boolean
  data_warnings: string[]
  btc?: {
    klines: KlineSet
    funding?: number
    oi_now?: number
    oi_hist?: Array<{ timestamp: string; value: number }>
    regime?: { h1_close?: number | null; m15_close?: number | null; pct_change_1h?: number | null }
    // Real-time ticker data from Binance
    price?: number
    priceChange?: number
    priceChangePercent?: number
    volume24h_usd?: number
    volume24h_btc?: number
  }
  eth?: {
    klines: KlineSet
    funding?: number
    oi_now?: number
    oi_hist?: Array<{ timestamp: string; value: number }>
    regime?: { h1_close?: number | null; m15_close?: number | null; pct_change_1h?: number | null }
    // Real-time ticker data from Binance
    price?: number
    priceChange?: number
    priceChangePercent?: number
    volume24h_usd?: number
    volume24h_eth?: number
  }
  universe: UniverseItem[]
  exchange_filters: ExchangeFilters
  policy?: {
    max_hold_minutes?: number
    risk_per_trade_pct?: { ok: number; caution: number; no_trade: number }
    risk_per_trade_pct_flat?: number
    max_leverage?: number
  }
  regime?: {
    BTCUSDT?: { h1_change_pct?: number | null }
    ETHUSDT?: { h1_change_pct?: number | null }
  }
  exchange?: string
  market_type?: 'perp' | 'spot'
}

