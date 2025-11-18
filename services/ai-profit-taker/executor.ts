/**
 * AI Profit Taker - Order Executor
 * 
 * KRITICKÁ ČÁST: Bezpečná execution sequence pro SL/TP úpravy
 * 
 * EXECUTION ORDER (MUST follow):
 * 1. Create NEW SL order (ai_pt_sl_*)
 * 2. Wait 100ms
 * 3. Create NEW TP order (ai_pt_tp_*)
 * 4. Cancel OLD orders (protect manual_*, su_*)
 * 
 * NEVER cancel orders before creating new ones - pozice by byla bez ochrany!
 */

import { getBinanceAPI, cancelOrder } from '../trading/binance_futures'
import type { AIProfitTakerDecision, ExecutionResult } from './types'

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Count decimals in tick size (for precision handling)
 */
function countDecimals(tickSize: number): number {
  const str = String(tickSize)
  const idx = str.indexOf('.')
  return idx >= 0 ? (str.length - idx - 1) : 0
}

/**
 * Round price to tick size (handles scientific notation like 1e-7)
 */
function roundToTickSize(price: number, tickSize: number): string {
  const step = Number(tickSize)
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error(`Invalid tick size: ${tickSize}`)
  }
  
  const rounded = Math.round(price / step) * step
  const decimals = countDecimals(tickSize)
  
  return rounded.toFixed(decimals)
}

/**
 * Execute AI Profit Taker decision
 * 
 * @param symbol - Trading symbol
 * @param position - Current position info
 * @param decision - AI decision from OpenAI
 * @returns Execution result with order IDs
 */
export async function executeAIProfitTaker(
  symbol: string,
  position: { size: number; side: string },
  decision: AIProfitTakerDecision
): Promise<ExecutionResult> {
  const api = getBinanceAPI()
  
  try {
    // 1. Get symbol info for precision
    const symbolInfo = await api.getSymbolInfo(symbol)
    const priceFilter = (symbolInfo?.filters || []).find((f: any) => f?.filterType === 'PRICE_FILTER')
    const tickSize = Number(priceFilter?.tickSize || '0.01')
    
    const lotFilter = (symbolInfo?.filters || []).find((f: any) => f?.filterType === 'LOT_SIZE')
    const stepSize = Number(lotFilter?.stepSize || '0.001')
    const qtyDecimals = countDecimals(stepSize)
    
    // Round position size
    const quantity = Number(position.size).toFixed(qtyDecimals)
    
    console.info('[AI_PT_EXEC_START]', { 
      symbol, 
      action: decision.action, 
      new_sl: decision.new_sl, 
      new_tp: decision.new_tp,
      quantity,
      tickSize,
      stepSize
    })
    
    // Skip if no changes
    if (decision.action === 'skip') {
      console.info('[AI_PT_EXEC_SKIP]', { symbol, rationale: decision.rationale })
      return {}
    }
    
    // 2. Get current open orders
    const openOrders = await api.getOpenOrders(symbol)
    
    // Filter SL orders (STOP_MARKET, BUY side for SHORT)
    const slOrders = (Array.isArray(openOrders) ? openOrders : []).filter((o: any) => {
      const type = String(o?.type || '').toUpperCase()
      const side = String(o?.side || '').toUpperCase()
      const clientId = String(o?.clientOrderId || '')
      
      return (
        (type === 'STOP_MARKET' || type === 'STOP') &&
        side === 'BUY' &&
        !clientId.startsWith('manual_')  // NEVER touch manual orders
      )
    })
    
    // Filter TP orders (TAKE_PROFIT_MARKET, BUY side for SHORT)
    const tpOrders = (Array.isArray(openOrders) ? openOrders : []).filter((o: any) => {
      const type = String(o?.type || '').toUpperCase()
      const side = String(o?.side || '').toUpperCase()
      const clientId = String(o?.clientOrderId || '')
      
      return (
        (type === 'TAKE_PROFIT_MARKET' || type === 'TAKE_PROFIT') &&
        side === 'BUY' &&
        !clientId.startsWith('manual_')  // NEVER touch manual orders
      )
    })
    
    console.info('[AI_PT_CURRENT_ORDERS]', {
      symbol,
      sl_orders: slOrders.length,
      tp_orders: tpOrders.length
    })
    
    const results: ExecutionResult = {
      sl_order_id: null,
      tp_order_id: null,
      cancelled_order_ids: []
    }
    
    // 3. Create NEW SL order FIRST (if requested)
    if (decision.new_sl !== null && Number.isFinite(decision.new_sl)) {
      try {
        const stopPrice = roundToTickSize(decision.new_sl, tickSize)
        
        console.info('[AI_PT_CREATE_SL]', { symbol, stopPrice, quantity })
        
        // HEDGE MODE: Musíme specifikovat positionSide: 'SHORT'
        const slOrderParams: any = {
          symbol,
          side: 'BUY',
          type: 'STOP_MARKET',
          stopPrice,
          positionSide: 'SHORT',  // KRITICKÉ: Hedge mode vyžaduje tento parametr!
          closePosition: true,
          workingType: 'MARK_PRICE',
          newClientOrderId: `ai_pt_sl_${Date.now()}`,
          __engine: 'ai_profit_taker'
        }
        
        console.info('[AI_PT_SL_PARAMS]', JSON.stringify(slOrderParams))
        
        const slOrder = await api.placeOrder(slOrderParams)
        
        results.sl_order_id = String(slOrder?.orderId || null)
        console.info('[AI_PT_SL_CREATED]', { symbol, orderId: results.sl_order_id, stopPrice })
        
        // CRITICAL: Small delay between orders
        await sleep(100)
      } catch (err: any) {
        console.error('[AI_PT_SL_ERROR]', { symbol, error: err?.message || String(err) })
        throw new Error(`Failed to create SL order: ${err?.message || err}`)
      }
    }
    
    // 4. Create NEW TP order SECOND (if requested)
    if (decision.new_tp !== null && Number.isFinite(decision.new_tp)) {
      try {
        const stopPrice = roundToTickSize(decision.new_tp, tickSize)
        
        console.info('[AI_PT_CREATE_TP]', { symbol, stopPrice, quantity })
        
        // HEDGE MODE: Musíme specifikovat positionSide: 'SHORT'
        const tpOrderParams: any = {
          symbol,
          side: 'BUY',
          type: 'TAKE_PROFIT_MARKET',
          stopPrice,
          positionSide: 'SHORT',  // KRITICKÉ: Hedge mode vyžaduje tento parametr!
          closePosition: true,
          workingType: 'MARK_PRICE',
          newClientOrderId: `ai_pt_tp_${Date.now()}`,
          __engine: 'ai_profit_taker'
        }
        
        console.info('[AI_PT_TP_PARAMS]', JSON.stringify(tpOrderParams))
        
        const tpOrder = await api.placeOrder(tpOrderParams)
        
        results.tp_order_id = String(tpOrder?.orderId || null)
        console.info('[AI_PT_TP_CREATED]', { symbol, orderId: results.tp_order_id, stopPrice })
      } catch (err: any) {
        console.error('[AI_PT_TP_ERROR]', { symbol, error: err?.message || String(err) })
        throw new Error(`Failed to create TP order: ${err?.message || err}`)
      }
    }
    
    // 5. Cancel OLD orders LAST (only if we created new ones)
    const shouldCancelSL = decision.new_sl !== null && results.sl_order_id
    const shouldCancelTP = decision.new_tp !== null && results.tp_order_id
    
    if (shouldCancelSL || shouldCancelTP) {
      const ordersToCancel: any[] = []
      
      if (shouldCancelSL) ordersToCancel.push(...slOrders)
      if (shouldCancelTP) ordersToCancel.push(...tpOrders)
      
      for (const order of ordersToCancel) {
        const clientId = String(order?.clientOrderId || '')
        const orderId = String(order?.orderId || '')
        
        // SAFETY: Never cancel protected orders
        if (clientId.startsWith('manual_')) {
          console.info('[AI_PT_SKIP_MANUAL]', { symbol, orderId, clientId })
          continue
        }
        
        if (clientId.startsWith('su_')) {
          console.info('[AI_PT_SKIP_SU]', { symbol, orderId, clientId })
          continue
        }
        
        try {
          await cancelOrder(symbol, orderId)
          results.cancelled_order_ids = results.cancelled_order_ids || []
          results.cancelled_order_ids.push(orderId)
          console.info('[AI_PT_CANCELLED]', { symbol, orderId, clientId })
        } catch (err: any) {
          // Non-critical - log but continue
          console.error('[AI_PT_CANCEL_ERR]', { 
            symbol, 
            orderId, 
            clientId, 
            error: err?.message || String(err) 
          })
        }
      }
    }
    
    console.info('[AI_PT_EXEC_COMPLETE]', { symbol, results })
    return results
    
  } catch (err: any) {
    console.error('[AI_PT_EXEC_ERROR]', { 
      symbol, 
      error: err?.message || String(err),
      stack: err?.stack
    })
    throw err
  }
}

