export type EntryUpdaterAction = 'no_op' | 'reposition' | 'cancel'

export type EntryUpdaterInput = {
  spec_version: '1.0.0'
  symbol: string
  snapshot_ts: string
  asset_data: { tickSize: number; stepSize: number; minNotional: number }
  market_snapshot: {
    markPrice: number
    atr: { m15: number }
    ema: { m5: { 20: number; 50: number }; m15: { 20: number; 50: number } }
    vwap: { m15: number }
    rsi?: { m5?: number; m15?: number }
    orderbook: {
      nearestBidWall: number
      nearestAskWall: number
      obi5?: number
      obi20?: number
      micropriceBias?: 'bid' | 'ask' | 'neutral'
    }
    spread_bps: number
    estSlippageBps: number
  }
  current_plan: {
    remaining_ratio: number
    entry: { type: 'limit'; price: number }
    sl: number
    tp_levels: Array<{ tag: 'tp1' | 'tp2' | 'tp3'; price: number; allocation_pct: number }>
    order_created_at: string
    current_touch_count: number
  }
  fills: { tp_hits_count: number; last_tp_hit_tag: 'tp1' | 'tp2' | 'tp3' | null; realized_pct_of_initial: number }
  exchange_filters: { maxSlippagePct: number }
}

export type EntryUpdaterPlan = {
  entry: { type: 'limit'; price: number; buffer_bps?: number; size_pct_of_tranche?: number }
  sl: number
  tp_levels: Array<{ tag: 'tp1' | 'tp2' | 'tp3'; price: number; allocation_pct: number }>
}

export type EntryUpdaterResponse = {
  spec_version: '1.0.0'
  symbol: string
  action: EntryUpdaterAction
  new_plan: EntryUpdaterPlan | null
  reason_code: 'NO_OP_ZONE' | 'REPOSITION_SUPPORT' | 'CANCEL_FLIP' | 'CANCEL_DELTA_ATR' | 'CANCEL_RM_FILTER'
  reasoning: string
  confidence: number
}



