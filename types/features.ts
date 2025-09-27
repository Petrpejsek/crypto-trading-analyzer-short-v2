import type { Kline, MarketRawSnapshot } from './market_raw'

export type CoinFeat = {
  ema20_H4: number | null
  ema50_H4: number | null
  ema200_H4: number | null
  ema20_H1: number | null
  ema50_H1: number | null
  ema200_H1: number | null
  rsi_H1: number | null
  atr_pct_H1: number | null
  vwap_rel_H1: number | null
  vwap_rel_M15: number | null
  adx_H1: number | null
  flags: {
    H1_above_VWAP: boolean | null
    H4_ema50_gt_200: boolean | null
  }
}

export type EmaOrder =
  | '20>50>200'
  | '20>200>50'
  | '50>20>200'
  | '50>200>20'
  | '200>20>50'
  | '200>50>20'

export type CoinRow = {
  symbol: string
  price: number | null
  atr_pct_H1: number | null
  volume24h_usd: number | null
  ema_order_H1: EmaOrder | null
  ema_order_M15: EmaOrder | null
  RSI_M15: number | null
  RSI_H1?: number | null
  vwap_rel_M15: number | null
  funding: number | null
  OI_chg_1h: number | null
  OI_chg_4h: number | null
  // 24h return (computed from H1 series)
  ret_24h_pct?: number | null
  // derived shortcuts for preview (optional)
  price_h1?: number
  vwap_h1?: number
  // M2-Lite
  ret_m15_pct?: number | null
  ret_h1_pct?: number | null
  rvol_m15?: number | null
  rvol_h1?: number | null
  ema_stack?: number | null // +1 | 0 | -1
  funding_z?: number | null
  oi_change_pct_h1?: number | null
  oi_prev_age_min?: number | null
  is_new?: boolean | null
  age_hours?: number | null
  h1_range_pos_pct?: number | null
  hh_h1?: number | null
  ll_h1?: number | null
  vwap_m15?: number | null
  oi_delta_unreliable?: boolean | null
  burst_m15_pct?: number | null
  // Breakout quality (M15)
  body_ratio_m15?: number | null
  upper_wick_ratio_m15?: number | null
  lower_wick_ratio_m15?: number | null
  consec_above_vwap_m15?: number | null
  // OI × Price divergence (H1)
  oi_price_div_h1?: number | null
  // Liquidity sanity
  avg_trade_usdt?: number | null
  rvol_liq_product?: number | null
  spread_bps?: number | null
  market_type?: 'perp' | 'spot'
  // Cooldown
  cooldown_factor?: number | null
}

// Final Picker payload (sanitized/rounded) — only for GPT input
export type FinalPickerCandidate = {
  symbol: string
  price: number | null
  ret_m15_pct: number | null
  ret_h1_pct: number | null
  rvol_m15: number | null
  rvol_h1: number | null
  atr_pct_h1: number | null
  ema_stack: number | null
  vwap_rel_m15: number | null
  oi_change_pct_h1: number | null
  funding_rate: number | null
  funding_z: number | null
  quoteVolumeUSDT: number | null
  tradesCount: number | null
  is_new: boolean | null
  h1_range_pos_pct: number | null
  hh_h1: number | null
  ll_h1: number | null
  vwap_m15: number | null
}

export type FeaturesSnapshot = {
  timestamp: string
  btc: CoinFeat
  eth: CoinFeat
  universe: CoinRow[]
  breadth: { pct_above_EMA50_H1: number }
  warnings?: string[]
}


