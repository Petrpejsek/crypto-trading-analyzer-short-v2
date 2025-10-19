// Health Monitor - Market Payload Builder
// Transform MarketRawSnapshot to MarketPayload for health calculation

import type { MarketRawSnapshot } from '../../types/market_raw'
import type { MarketPayload } from './types'
import { PAYLOAD_FRESHNESS_MS } from './types'

/**
 * Normalize quarterly contract symbols to perpetual
 * Example: ETHUSDT_260327 → ETHUSDT
 */
export function normalizeSymbolForMarketData(symbol: string): string {
  // Check if quarterly contract (ends with _DDMMYY pattern)
  const quarterlyPattern = /_\d{6}$/
  if (quarterlyPattern.test(symbol)) {
    return symbol.replace(quarterlyPattern, '')
  }
  return symbol
}

/**
 * Check if symbol is quarterly contract
 */
export function isQuarterlyContract(symbol: string): boolean {
  return /_\d{6}$/.test(symbol)
}

/**
 * Build health payload from market snapshot
 * Validates required fields and freshness
 */
export function buildHealthPayload(
  snapshot: MarketRawSnapshot,
  symbol: string
): MarketPayload {
  // Normalize symbol for market data lookup
  const normalizedSymbol = normalizeSymbolForMarketData(symbol)
  
  // Find symbol in universe
  const item = snapshot.universe.find((u) => u.symbol === normalizedSymbol)
  if (!item) {
    throw new Error(`Symbol ${normalizedSymbol} not found in market snapshot`)
  }

  // Extract required fields
  const price = item.price
  const vwap_today = item.vwap_today ?? item.vwap_daily
  const ema20_m15 = item.ema20_M15 ?? item.ema_m15?.[20]
  const ema50_m15 = item.ema50_M15 ?? item.ema_m15?.[50]
  const ema20_h1 = item.ema20_H1 ?? item.ema_h1?.[20]
  const ema50_h1 = item.ema50_H1 ?? item.ema_h1?.[50]
  const atr_m15 = item.atr_m15 ?? item.atr_pct_M15

  // Validate required fields
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid price for ${normalizedSymbol}: ${price}`)
  }
  if (!Number.isFinite(vwap_today) || vwap_today <= 0) {
    throw new Error(`Invalid vwap_today for ${normalizedSymbol}: ${vwap_today}`)
  }
  if (!Number.isFinite(ema20_m15) || ema20_m15 <= 0) {
    throw new Error(`Invalid ema20_m15 for ${normalizedSymbol}: ${ema20_m15}`)
  }
  if (!Number.isFinite(ema50_m15) || ema50_m15 <= 0) {
    throw new Error(`Invalid ema50_m15 for ${normalizedSymbol}: ${ema50_m15}`)
  }
  if (!Number.isFinite(ema20_h1) || ema20_h1 <= 0) {
    throw new Error(`Invalid ema20_h1 for ${normalizedSymbol}: ${ema20_h1}`)
  }
  if (!Number.isFinite(ema50_h1) || ema50_h1 <= 0) {
    throw new Error(`Invalid ema50_h1 for ${normalizedSymbol}: ${ema50_h1}`)
  }
  if (!Number.isFinite(atr_m15) || atr_m15 <= 0) {
    throw new Error(`Invalid atr_m15 for ${normalizedSymbol}: ${atr_m15}`)
  }

  // Check timestamp freshness
  const snapshotTime = new Date(snapshot.timestamp).getTime()
  const now = Date.now()
  const age = now - snapshotTime
  
  if (age > PAYLOAD_FRESHNESS_MS) {
    throw new Error(
      `Market snapshot too stale: ${(age / 1000).toFixed(0)}s old (max ${PAYLOAD_FRESHNESS_MS / 1000}s)`
    )
  }

  // Extract spread and liquidity
  const spread_bps = item.spread_bps ?? 0
  const liquidity_usd = item.liquidity_usd ?? (
    ((item.liquidity_usd_0_5pct?.bids || 0) + 
     (item.liquidity_usd_0_5pct?.asks || 0) +
     (item.liquidity_usd_1pct?.bids || 0) +
     (item.liquidity_usd_1pct?.asks || 0)) || 0
  )

  if (!Number.isFinite(spread_bps) || spread_bps < 0) {
    throw new Error(`Invalid spread_bps for ${normalizedSymbol}: ${spread_bps}`)
  }
  if (!Number.isFinite(liquidity_usd) || liquidity_usd < 0) {
    throw new Error(`Invalid liquidity_usd for ${normalizedSymbol}: ${liquidity_usd}`)
  }

  // Build payload
  const payload: MarketPayload = {
    symbol: normalizedSymbol,
    price,
    price_ts_utc: snapshot.timestamp,
    vwap_today,
    ema: {
      m15: {
        20: ema20_m15,
        50: ema50_m15
      },
      h1: {
        20: ema20_h1,
        50: ema50_h1
      }
    },
    atr: {
      m15: atr_m15
    },
    spread_bps,
    liquidity_usd
  }

  // Optional fields
  if (item.rsi_M15 && Number.isFinite(item.rsi_M15)) {
    payload.rsi = { m15: item.rsi_M15 }
  }

  if (Array.isArray(item.support) && item.support.length > 0) {
    payload.support = item.support.slice(0, 3) // first 3 levels
  }

  if (Array.isArray(item.resistance) && item.resistance.length > 0) {
    payload.resistance = item.resistance.slice(0, 3) // first 3 levels
  }

  if (item.funding_8h_pct && Number.isFinite(item.funding_8h_pct)) {
    payload.funding_8h_pct = item.funding_8h_pct
  }

  if (item.oi_change_1h_pct && Number.isFinite(item.oi_change_1h_pct)) {
    payload.oi_change_1h_pct = item.oi_change_1h_pct
  }

  return payload
}

/**
 * Build health payload for pending order (not yet filled)
 * Uses order limit price instead of filled entry price
 */
export function buildHealthPayloadForPendingOrder(
  snapshot: MarketRawSnapshot,
  symbol: string,
  orderPrice: number,
  plannedTP: number | null
): MarketPayload & { pending_order_context: { order_price: number; planned_tp: number | null } } {
  // Build base payload (same market data as positions)
  const basePayload = buildHealthPayload(snapshot, symbol)
  
  // Validate order price
  if (!Number.isFinite(orderPrice) || orderPrice <= 0) {
    throw new Error(`Invalid order price for pending order ${symbol}: ${orderPrice}`)
  }
  
  // Add pending order specific context
  return {
    ...basePayload,
    pending_order_context: {
      order_price: orderPrice,
      planned_tp: plannedTP
    }
  }
}

/**
 * Validate market payload has all required fields
 */
export function validatePayload(payload: MarketPayload): void {
  const errors: string[] = []

  if (!payload.symbol) errors.push('symbol missing')
  if (!Number.isFinite(payload.price) || payload.price <= 0) errors.push('invalid price')
  if (!payload.price_ts_utc) errors.push('price_ts_utc missing')
  if (!Number.isFinite(payload.vwap_today) || payload.vwap_today <= 0) errors.push('invalid vwap_today')
  
  if (!payload.ema?.m15?.[20] || !Number.isFinite(payload.ema.m15[20])) errors.push('invalid ema.m15.20')
  if (!payload.ema?.m15?.[50] || !Number.isFinite(payload.ema.m15[50])) errors.push('invalid ema.m15.50')
  if (!payload.ema?.h1?.[20] || !Number.isFinite(payload.ema.h1[20])) errors.push('invalid ema.h1.20')
  if (!payload.ema?.h1?.[50] || !Number.isFinite(payload.ema.h1[50])) errors.push('invalid ema.h1.50')
  
  if (!payload.atr?.m15 || !Number.isFinite(payload.atr.m15)) errors.push('invalid atr.m15')
  if (!Number.isFinite(payload.spread_bps) || payload.spread_bps < 0) errors.push('invalid spread_bps')
  if (!Number.isFinite(payload.liquidity_usd) || payload.liquidity_usd < 0) errors.push('invalid liquidity_usd')

  if (errors.length > 0) {
    throw new Error(`Payload validation failed: ${errors.join(', ')}`)
  }
}

