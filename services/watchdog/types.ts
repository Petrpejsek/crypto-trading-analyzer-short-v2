export type WatchdogMode = 'shadow' | 'active'

export type WatchdogReason = 'TTL_SOFT' | 'TTL_HARD' | 'DIVERGENCE' | 'SESSION_CUTOFF'

export type WatchdogDecision = {
  action: 'keep' | 'cancel'
  reason: WatchdogReason | null
}

export type EvalRecord = {
  tsISO: string
  symbol: string
  orderId: number | string
  type: string
  side: 'BUY' | 'SELL' | string
  age_min: number | null
  entry: number | null
  mark: number | null
  atr_h1_pct: number | null
  pDiff_pct: number | null
  decision: 'KEEP' | 'WOULD_CANCEL'
  reason: WatchdogReason | null
  mode: WatchdogMode
}

export type OrderLite = {
  orderId: number | string
  symbol: string
  type: string
  side: 'BUY' | 'SELL' | string
  time?: number
  updateTime?: number
  price?: string | number
  stopPrice?: string | number
}



