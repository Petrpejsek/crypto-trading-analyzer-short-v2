import { getBinanceAPI, makeId, cancelOrder } from '../trading/binance_futures'
import type { StrategyUpdateResponse } from './strategy_updater_gpt'
import type { StrategyUpdaterEntry } from './registry'

export type ExecutionResult = {
  success: boolean
  error?: string
  newSlOrderId?: number
  newTpOrderId?: number
  cancelledOrderIds?: number[]
}

// Execute strategy update - create new TP/SL orders and cleanup old ones
export async function executeStrategyUpdate(
  symbol: string,
  response: StrategyUpdateResponse,
  entry: StrategyUpdaterEntry
): Promise<ExecutionResult> {
  
  const api = getBinanceAPI()
  let newSlOrderId: number | undefined
  let newTpOrderId: number | undefined
  const cancelledOrderIds: number[] = []

  try {
    console.info('[STRATEGY_UPDATE_EXECUTE_START]', {
      symbol,
      side: entry.side,
      newSL: response.newSL,
      newTP: response.newTP,
      urgency: response.urgency
    })
    try {
      const { appendAudit, isAuditEnabled } = await import('./audit')
      if (isAuditEnabled()) appendAudit({ id: `su_exec_${Date.now()}_${symbol}`, symbol, phase: 'execute_start', proposal: { sl: response.newSL, tp: response.newTP } })
    } catch {}

    // 1. Get current position details
    const positions = await api.getPositions()
    const position = positions.find((pos: any) => String(pos?.symbol) === symbol)
    
    if (!position || Math.abs(Number(position?.positionAmt || 0)) <= 0) {
      return {
        success: false,
        error: 'position_not_found'
      }
    }

    const positionAmt = Number(position.positionAmt)
    const positionSize = Math.abs(positionAmt).toString()
    const positionSide = positionAmt > 0 ? 'LONG' : 'SHORT'
    
    // Guard: pokud je otevřen interní ENTRY a NEEXISTUJE skutečná pozice, nespouštěj updater (pre-entry fáze)
    // Pokud ale POZICE existuje (>0), updater musí běžet (bezpečnostní priorita: doplnit SL/TP)
    try {
      const openOrders = await api.getOpenOrders(symbol)
      const entryStillOpen = (Array.isArray(openOrders) ? openOrders : []).some((order: any) => {
        const id = String(order?.clientOrderId || '')
        const isInternalEntry = /^e_l_/.test(id)
        const isBuyLimit = String(order?.side || '').toUpperCase() === 'BUY' && String(order?.type || '').toUpperCase() === 'LIMIT'
        const isExitFlag = Boolean(order?.reduceOnly || order?.closePosition)
        return isInternalEntry && isBuyLimit && !isExitFlag
      })
      const hasRealPosition = Math.abs(Number(position?.positionAmt || 0)) > 0
      if (entryStillOpen && !hasRealPosition) {
        return { success: false, error: 'entry_still_open' }
      }
    } catch {}
    
    // 2. Create new SL order with updated prefix
    try {
      const slParams = {
        symbol,
        side: (positionSide === 'LONG' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
        type: 'STOP_MARKET' as const,
        stopPrice: response.newSL.toString(),
        // close the whole position on trigger; do not send reduceOnly here
        closePosition: true as const,
        workingType: 'MARK_PRICE' as const,
        positionSide: positionSide as 'LONG' | 'SHORT',
        newClientOrderId: makeId('x_sl_upd'),
        newOrderRespType: 'RESULT' as const
      }

      console.info('[STRATEGY_UPDATE_CREATE_SL]', { symbol, slParams })
      const slResult = await api.placeOrder(slParams)
      newSlOrderId = Number(slResult?.orderId)
      console.info('[STRATEGY_UPDATE_SL_SUCCESS]', { symbol, orderId: newSlOrderId })
      
    } catch (slError: any) {
      console.error('[STRATEGY_UPDATE_SL_ERROR]', {
        symbol,
        error: slError?.message || slError
      })
      return {
        success: false,
        error: `sl_creation_failed: ${slError?.message || 'unknown'}`
      }
    }

    // 3. Create new TP order with updated prefix
    try {
      const tpParams = {
        symbol,
        side: (positionSide === 'LONG' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
        type: 'TAKE_PROFIT_MARKET' as const,
        stopPrice: response.newTP.toString(),
        closePosition: true as const,
        workingType: 'MARK_PRICE' as const,
        positionSide: positionSide as 'LONG' | 'SHORT',
        newClientOrderId: makeId('x_tp_upd'),
        newOrderRespType: 'RESULT' as const
      }

      console.info('[STRATEGY_UPDATE_CREATE_TP]', { symbol, tpParams })
      const tpResult = await api.placeOrder(tpParams)
      newTpOrderId = Number(tpResult?.orderId)
      console.info('[STRATEGY_UPDATE_TP_SUCCESS]', { symbol, orderId: newTpOrderId })
      
    } catch (tpError: any) {
      console.error('[STRATEGY_UPDATE_TP_ERROR]', {
        symbol,
        error: tpError?.message || tpError
      })
      
      // If TP creation failed, we should clean up the SL we just created
      if (newSlOrderId) {
        try {
          await cancelOrder(symbol, newSlOrderId)
          console.info('[STRATEGY_UPDATE_SL_ROLLBACK]', { symbol, slOrderId: newSlOrderId })
        } catch (rollbackError) {
          console.error('[STRATEGY_UPDATE_ROLLBACK_ERROR]', {
            symbol,
            slOrderId: newSlOrderId,
            error: (rollbackError as any)?.message || rollbackError
          })
        }
      }
      
      return {
        success: false,
        error: `tp_creation_failed: ${tpError?.message || 'unknown'}`
      }
    }

    // 4. Both new orders created successfully - now cleanup old SL/TP orders
    try {
      const openOrders = await api.getOpenOrders(symbol)
      const exitSide = (positionSide === 'LONG' ? 'SELL' : 'BUY') as 'BUY' | 'SELL'
      const oldOrders = (Array.isArray(openOrders) ? openOrders : []).filter((order: any) => {
        try {
          const orderId = Number(order?.orderId || 0)
          if (orderId === newSlOrderId || orderId === newTpOrderId) return false
          if (String(order?.symbol) !== symbol) return false
          const sideOk = String(order?.side || '').toUpperCase() === exitSide
          const typeStr = String(order?.type || '')
          const isExitType = /stop|take_profit/i.test(typeStr)
          const hasExitFlags = Boolean(order?.closePosition === true || order?.reduceOnly === true)
          const isOldPrefix = /^(x_sl_|x_tp_)/.test(String(order?.clientOrderId || ''))
          // Cancel any previous exit orders for this symbol/side except the ones we just created
          return sideOk && (isExitType || hasExitFlags || isOldPrefix)
        } catch { return false }
      })

      console.info('[STRATEGY_UPDATE_CLEANUP_OLD]', { 
        symbol, 
        oldOrdersCount: oldOrders.length,
        orderIds: oldOrders.map((o: any) => o?.orderId)
      })

      for (const oldOrder of oldOrders) {
        try {
          const orderId = Number(oldOrder?.orderId || 0)
          if (orderId > 0) {
            await cancelOrder(symbol, orderId)
            cancelledOrderIds.push(orderId)
            console.info('[STRATEGY_UPDATE_CANCEL_OLD]', { symbol, orderId })
          }
        } catch (cancelError: any) {
          console.error('[STRATEGY_UPDATE_CANCEL_ERROR]', {
            symbol,
            orderId: oldOrder?.orderId,
            error: cancelError?.message || cancelError
          })
          // Continue with other cancellations even if one fails
        }
      }

    } catch (cleanupError: any) {
      console.error('[STRATEGY_UPDATE_CLEANUP_ERROR]', {
        symbol,
        error: cleanupError?.message || cleanupError
      })
      // Don't fail the whole operation if cleanup fails
    }

    // Mark new orders for UI highlighting (server-side hint)
    try {
      const { markStrategyOrders } = await import('./registry')
      markStrategyOrders([newSlOrderId, newTpOrderId])
      const { appendAudit, isAuditEnabled } = await import('./audit')
      if (isAuditEnabled()) appendAudit({ id: `su_exec_${Date.now()}_${symbol}`, symbol, phase: 'execute_success', created: { sl: newSlOrderId, tp: newTpOrderId }, cancelled: cancelledOrderIds })
    } catch {}

    console.info('[STRATEGY_UPDATE_EXECUTE_SUCCESS]', {
      symbol,
      newSlOrderId,
      newTpOrderId,
      cancelledCount: cancelledOrderIds.length,
      reasoning: response.reasoning
    })

    return {
      success: true,
      newSlOrderId,
      newTpOrderId,
      cancelledOrderIds
    }

  } catch (error: any) {
    console.error('[STRATEGY_UPDATE_EXECUTE_ERROR]', {
      symbol,
      error: error?.message || error
    })

    return {
      success: false,
      error: error?.message || 'execution_failed'
    }
  }
}

// Helper function to validate if strategy update makes sense
export function validateStrategyUpdate(
  symbol: string,
  response: StrategyUpdateResponse,
  entry: StrategyUpdaterEntry,
  currentPrice: number
): { valid: boolean; reason?: string } {
  
  try {
    // Basic validation already done in strategy_updater_gpt.ts
    // Additional business logic validation here
    
    const { side, entryPrice } = entry
    const { newSL, newTP } = response

    // Validate that we're not making position worse
    if (side === 'LONG') {
      // For LONG positions
      if (entry.currentSL && newSL < entry.currentSL) {
        // Moving SL lower = more risk, only allow if position is in profit
        const currentProfitPct = ((currentPrice - entryPrice) / entryPrice) * 100
        if (currentProfitPct < 1.0) { // Less than 1% profit
          return {
            valid: false,
            reason: 'cannot_increase_risk_without_sufficient_profit'
          }
        }
      }
    } else if (side === 'SHORT') {
      // For SHORT positions  
      if (entry.currentSL && newSL > entry.currentSL) {
        // Moving SL higher = more risk, only allow if position is in profit
        const currentProfitPct = ((entryPrice - currentPrice) / entryPrice) * 100
        if (currentProfitPct < 1.0) { // Less than 1% profit
          return {
            valid: false,
            reason: 'cannot_increase_risk_without_sufficient_profit'
          }
        }
      }
    }

    // Validate reasonable price levels (not too extreme)
    const slDistance = Math.abs(currentPrice - newSL) / currentPrice
    const tpDistance = Math.abs(newTP - currentPrice) / currentPrice
    
    if (slDistance > 0.10) { // More than 10% away
      return {
        valid: false,
        reason: 'sl_too_far_from_current_price'
      }
    }

    if (tpDistance > 0.20) { // More than 20% away
      return {
        valid: false,
        reason: 'tp_too_far_from_current_price'
      }
    }

    return { valid: true }

  } catch (error) {
    console.error('[VALIDATE_STRATEGY_UPDATE_ERR]', {
      symbol,
      error: (error as any)?.message || error
    })
    return {
      valid: false,
      reason: 'validation_error'
    }
  }
}
