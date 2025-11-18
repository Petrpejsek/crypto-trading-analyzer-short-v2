/**
 * AI Profit Taker - TypeScript Types
 * 
 * Systém pro inteligentní úpravu SL/TP orderů na SHORT pozicích
 * - Manuální trigger z TradingViewChart
 * - Symbol-specific analýza
 * - OpenAI GPT-4o decision making
 */

export type AIProfitTakerInput = {
  symbol: string
  position: {
    side: 'SHORT'
    size: number
    entryPrice: number
    currentPrice: number
    unrealizedPnl: number
  }
  currentOrders: {
    sl: number | null  // Aktuální SL price
    tp: number | null  // Aktuální TP price
  }
  marketData: any  // Z fetchMarketDataForSymbol (RSI, EMA, VWAP, ATR, volume, bias, momentum)
  obstacles?: Array<{ type: 'ema' | 'vwap' | 'level' | 'round'; price: number; strength: 'low' | 'mid' | 'high'; timeframe?: string }>
  trendData: {
    bearish_m5: boolean
    bearish_m15: boolean
    bearish_score: number  // 0-3
    chop_flag: boolean
  }
}

export type AIProfitTakerDecision = {
  action: 'adjust_exits' | 'skip'
  symbol: string
  new_sl: number | null    // null = keep current
  new_tp: number | null    // null = keep current
  rationale: string
  confidence: number       // 0-1
}

export type ExecutionResult = {
  sl_order_id?: string | null
  tp_order_id?: string | null
  cancelled_order_ids?: string[]
}

export type AIProfitTakerResult = {
  ok: boolean
  code?: 'no_api_key' | 'invalid_json' | 'schema' | 'empty_output' | 'timeout' | 'http' | 'unknown' | 'no_position' | 'execution_error'
  latencyMs: number
  data?: {
    input: AIProfitTakerInput
    decision: AIProfitTakerDecision
    execution?: ExecutionResult
  } | null
  meta?: any
}

