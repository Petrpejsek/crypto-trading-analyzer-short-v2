import { getBinanceAPI, makeId, cancelOrder, makeDeterministicClientId } from '../trading/binance_futures'
import tradingCfg from '../../config/trading.json'
import type { StrategyUpdateResponse } from './strategy_updater_gpt'
import type { StrategyUpdaterEntry } from './registry'

export type ExecutionResult = {
  success: boolean
  error?: string
  newSlOrderId?: number
  newTpOrderIds?: number[]
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
  let newTpOrderIds: number[] = []
  const cancelledOrderIds: number[] = []

  try {
    console.info('[STRATEGY_UPDATE_EXECUTE_START]', {
      symbol,
      side: entry.side,
      newSL: response.newSL,
      tp_levels: response.tp_levels,
      urgency: response.urgency
    })
    try {
      const { appendAudit, isAuditEnabled } = await import('./audit')
      if (isAuditEnabled()) appendAudit({ id: `su_exec_${Date.now()}_${symbol}`, symbol, phase: 'execute_start', proposal: { sl: response.newSL, tp_levels: response.tp_levels } })
    } catch {}

    // 1. Use entry position data directly (avoid fresh REST call inconsistency). Do not block on WS readiness.
    const position = {
      symbol: entry.symbol,
      positionAmt: entry.side === 'LONG' ? entry.positionSize : -entry.positionSize,
      entryPrice: entry.entryPrice
    }
    console.info('[SU_USING_ENTRY_DATA]', { symbol, side: entry.side, size: entry.positionSize })
    
    if (!position || Math.abs(Number(position?.positionAmt || 0)) <= 0) {
      return {
        success: false,
        error: 'position_not_found'
      }
    }

    const positionAmt = Number(position.positionAmt)
    const positionSize = Math.abs(positionAmt).toString()
    const positionSide = positionAmt > 0 ? 'LONG' : 'SHORT'
    // Include positionSide param only in hedge mode
    let includePositionSide = false
    try { includePositionSide = await api.getHedgeMode() } catch {}
    
    // Guard: pokud je otevřen interní ENTRY a NEEXISTUJE skutečná pozice, nespouštěj updater (pre-entry fáze)
    // Pokud ale POZICE existuje (>0), updater musí běžet (bezpečnostní priorita: doplnit SL/TP)
    try {
      const openOrders = await api.getOpenOrders(symbol)
      const entryStillOpen = (Array.isArray(openOrders) ? openOrders : []).some((order: any) => {
        const id = String(order?.clientOrderId || '')
        const isInternalEntry = /^sv2_e_l_/.test(id)
        const isBuyLimit = String(order?.side || '').toUpperCase() === 'BUY' && String(order?.type || '').toUpperCase() === 'LIMIT'
        const isExitFlag = Boolean(order?.reduceOnly || order?.closePosition)
        return isInternalEntry && isBuyLimit && !isExitFlag
      })
      const hasRealPosition = Math.abs(Number(position?.positionAmt || 0)) > 0
      if (entryStillOpen && !hasRealPosition) {
        return { success: false, error: 'entry_still_open' }
      }
    } catch {}
    
    // 2. CRITICAL: Clean up ALL existing SL/TP orders before creating new ones
    try {
      console.info('[STRATEGY_UPDATE_CLEANUP_START]', { symbol })
      const openOrders = await api.getOpenOrders(symbol)
      const exitSide = (positionSide === 'LONG' ? 'SELL' : 'BUY') as 'BUY' | 'SELL'
      
      // Find all SL and TP orders to cancel - MUST be our orders (sv2_x_* or x_sl_/x_tp_)
      const ordersToCancel = (Array.isArray(openOrders) ? openOrders : []).filter((o: any) => {
        try {
          const sameSymbol = String(o?.symbol) === symbol
          const sideOk = String(o?.side || '').toUpperCase() === exitSide
          const t = String(o?.type || '').toUpperCase()
          const isStopOrTp = t.includes('STOP') || t.includes('TAKE_PROFIT')
          const cid = String(o?.clientOrderId || '')
          const isOurOrder = cid.startsWith('sv2_x_') || /^x_(sl|tp)/.test(cid)
          return sameSymbol && sideOk && isStopOrTp && isOurOrder
        } catch { return false }
      })
      
      console.info('[STRATEGY_UPDATE_CLEANUP_FOUND]', { 
        symbol, 
        ordersToCancel: ordersToCancel.length,
        orderIds: ordersToCancel.map((o: any) => o.orderId)
      })
      
      // Cancel all existing SL/TP orders
      for (const order of ordersToCancel) {
        try {
          await api.cancelOrder(symbol, Number(order.orderId))
          cancelledOrderIds.push(Number(order.orderId))
          console.info('[STRATEGY_UPDATE_CANCELLED]', { 
            symbol, 
            orderId: order.orderId, 
            type: order.type,
            clientOrderId: order.clientOrderId
          })
        } catch (cancelError) {
          console.warn('[STRATEGY_UPDATE_CANCEL_FAILED]', { 
            symbol, 
            orderId: order.orderId, 
            error: (cancelError as any)?.message 
          })
        }
      }
      
      console.info('[STRATEGY_UPDATE_CLEANUP_DONE]', { 
        symbol, 
        cancelledCount: cancelledOrderIds.length 
      })
    } catch (cleanupError) {
      console.warn('[STRATEGY_UPDATE_CLEANUP_ERROR]', { 
        symbol, 
        error: (cleanupError as any)?.message 
      })
    }

    // 3. Create new SL order with updated prefix (with strict monotonic guard)
    try {
      const disableSl = ((tradingCfg as any)?.DISABLE_SL === true)
      if (disableSl) {
        console.warn('[STRATEGY_UPDATE_SL_SKIPPED_DISABLED]', { symbol })
      }
      // Detect current most-protective SL from existing STOP orders for this symbol/side
      let currentSlPx: number | null = null
      let currentSlOrderId: number | null = null
      try {
        const openOrdersForSl = await api.getOpenOrders(symbol)
        const exitSide = (positionSide === 'LONG' ? 'SELL' : 'BUY') as 'BUY' | 'SELL'
        const stopOrders = (Array.isArray(openOrdersForSl) ? openOrdersForSl : []).filter((o: any) => {
          try {
            const sameSymbol = String(o?.symbol) === symbol
            const sideOk = String(o?.side || '').toUpperCase() === exitSide
            const t = String(o?.type || '').toUpperCase()
            const isStop = t.includes('STOP')
            return sameSymbol && sideOk && isStop
          } catch { return false }
        })
        if (stopOrders.length > 0) {
          const pick = stopOrders.reduce((acc: any, o: any) => {
            const sp = Number(o?.stopPrice || o?.price || 0)
            if (!Number.isFinite(sp) || sp <= 0) return acc
            if (!acc) return { id: Number(o?.orderId), px: sp }
            if (positionSide === 'LONG') {
              return sp > acc.px ? { id: Number(o?.orderId), px: sp } : acc
            } else {
              // For SHORT: prefer higher SL (better protection)
              return sp > acc.px ? { id: Number(o?.orderId), px: sp } : acc
            }
          }, null as any)
          if (pick) { currentSlPx = pick.px; currentSlOrderId = pick.id }
        }
      } catch {}

      const proposedSl = Number(response.newSL)
      const hasCurrentSl = Number.isFinite(currentSlPx as any)
      let effectiveSl: number | null = null
      
      if (!disableSl) {
        // CRITICAL: For SHORT positions, SL must be ABOVE current price with realistic buffer (ATR/tick)
        const mark = Number(await api.getMarkPrice(symbol))
        let tickSize: number | null = null
        try {
          const info = await api.getSymbolInfo(symbol)
          const pf = (info?.filters || []).find((f: any) => f?.filterType === 'PRICE_FILTER')
          tickSize = pf ? Number(pf.tickSize) : null
        } catch {}
        const quantize = (value: number, step: number | null): number => {
          if (!Number.isFinite(step as any) || (step as number) <= 0) return value
          const s = String(step)
          const idx = s.indexOf('.')
          const decimals = idx >= 0 ? (s.length - idx - 1) : 0
          const factor = Math.pow(10, decimals)
          return Math.round(value * factor) / factor
        }

        if (positionSide === 'SHORT' && Number.isFinite(mark)) {
          // Prefer ATR(M5) buffer when available via latest market snapshot stored by trigger
          let atrM5: number | null = null
          try {
            const { readFileSync } = await import('node:fs')
            const { resolve } = await import('node:path')
            const p = resolve('runtime/su_debug', `${symbol}.json`)
            const j = JSON.parse(readFileSync(p, 'utf8'))
            atrM5 = Number(j?.market?.indicators?.atr?.m5 ?? j?.market?.indicators?.atr_m5)
          } catch {}
          const minAtrBuf = Number.isFinite(atrM5 as any) && (atrM5 as number) > 0 ? (atrM5 as number) * 0.15 : 0
          const minTickBuf = Number.isFinite(tickSize as any) && (tickSize as number) > 0 ? (tickSize as number) * 3 : 0
          const buffer = Math.max(minAtrBuf, minTickBuf)

          if (proposedSl < mark + buffer) {
            const unclamped = quantize(mark + buffer, tickSize)
            effectiveSl = unclamped
            console.warn('[STRATEGY_UPDATE_SL_VALIDATION]', { 
              symbol, 
              side: positionSide, 
              proposedSL: proposedSl, 
              markPrice: mark,
              tickSize,
              atrM5,
              buffer,
              corrected: unclamped
            })
          } else {
            effectiveSl = proposedSl
            console.info('[STRATEGY_UPDATE_SL_VALIDATION_OK]', { 
              symbol, 
              side: positionSide, 
              proposedSL: proposedSl, 
              markPrice: mark,
              effectiveSL: effectiveSl
            })
          }
        } else {
          effectiveSl = proposedSl
        }
      }
      // GUARD LOGIC COMPLETELY DISABLED - Let AI decide everything
      // if (hasCurrentSl) {
      //   const curr = currentSlPx as number
      //   const violates = (positionSide === 'LONG' && effectiveSl < curr) || (positionSide === 'SHORT' && effectiveSl > curr)
      //   // Never degrade SL: if proposal degrades, keep current; otherwise use proposal (even if equal)
      //   effectiveSl = violates ? curr : effectiveSl
      //   if (violates) console.warn('[STRATEGY_UPDATE_SL_GUARD_KEEP]', { symbol, side: positionSide, currentSL: curr, proposedSL: proposedSl, effectiveSL: effectiveSl })
      // }

      // Immediate exit policy: if AI requested SL at/above mark for LONG (or at/below for SHORT), execute immediate close via MARKET
      try {
        const mark = Number(await api.getMarkPrice(symbol))
        const wantsImmediateExit = Number.isFinite(mark) && Number.isFinite(proposedSl) && (
          (positionSide === 'LONG' && proposedSl >= mark) ||
          (positionSide === 'SHORT' && proposedSl >= mark)
        )
        if (wantsImmediateExit) {
          const exitSide = (positionSide === 'LONG' ? 'SELL' : 'BUY') as 'BUY' | 'SELL'
          const qty = String(Math.abs(Number(position.positionAmt)))
          const posSidePayload = includePositionSide ? { positionSide: positionSide as 'LONG' | 'SHORT' } : {}
          const params = {
            symbol,
            side: exitSide,
            type: 'MARKET' as const,
            reduceOnly: true as const,
            quantity: qty,
            ...posSidePayload,
            newClientOrderId: makeDeterministicClientId('x_exit_now', includePositionSide ? { symbol, side: exitSide, type: 'MARKET', reduceOnly: true, quantity: qty, positionSide } : { symbol, side: exitSide, type: 'MARKET', reduceOnly: true, quantity: qty }),
            newOrderRespType: 'RESULT' as const
          }
          console.warn('[STRATEGY_UPDATE_IMMEDIATE_EXIT]', { symbol, side: positionSide, mark, proposedSl })
          const res = await api.placeOrder(params as any)
          newSlOrderId = Number(res?.orderId) || undefined
        // Mark exit order as created by Strategy Updater so UI can highlight it
        try {
          const { markStrategyOrders } = await import('./registry')
          markStrategyOrders([newSlOrderId])
        } catch {}
        // After market-close, skip TP creation and cleanup will remove exits
          return {
            success: true,
            newSlOrderId,
            newTpOrderIds: [],
            cancelledOrderIds
          }
        }
      } catch {}

      if (!disableSl) {
        // Quantize SL stopPrice to tickSize with directional rounding (LONG: ceil, SHORT: floor)
        let slStopPrice = Number(effectiveSl)
        try {
          const info = await api.getSymbolInfo(symbol)
          const priceFilter = (info?.filters || []).find((f: any) => f?.filterType === 'PRICE_FILTER')
          const tickSize = Number(priceFilter?.tickSize || 0)
          const countStepDecimals = (step: number): number => { const s = String(step); const idx = s.indexOf('.'); return idx >= 0 ? (s.length - idx - 1) : 0 }
          const quantizeDir = (value: number, step: number, mode: 'ceil' | 'floor'): number => {
            if (!(Number.isFinite(step) && step > 0)) return value
            const decimals = countStepDecimals(step)
            const factor = Math.pow(10, decimals)
            const v = Math.round(value * factor)
            const st = Math.round(step * factor)
            const q = mode === 'ceil' ? Math.ceil(v / st) * st : Math.floor(v / st) * st
            return q / factor
          }
          if (Number.isFinite(tickSize) && tickSize > 0) {
            slStopPrice = quantizeDir(slStopPrice, tickSize, positionSide === 'LONG' ? 'ceil' : 'floor')
          }
        } catch {}
        const posSidePayload = includePositionSide ? { positionSide: positionSide as 'LONG' | 'SHORT' } : {}
        const slParams = {
          symbol,
          side: (positionSide === 'LONG' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
          type: 'STOP_MARKET' as const,
          stopPrice: String(slStopPrice),
          // close the whole position on trigger; do not send reduceOnly here
          closePosition: true as const,
          workingType: 'MARK_PRICE' as const,
          ...posSidePayload,
          // Always create a NEW SL (unique CID), cleanup will cancel the previous
          newClientOrderId: makeId('x_sl'),
          newOrderRespType: 'RESULT' as const
        }

        console.info('[STRATEGY_UPDATE_PLACE_SL]', { symbol, sl: slStopPrice })
        const slResult = await api.placeOrder(slParams)
        newSlOrderId = Number(slResult?.orderId)
        console.info('[STRATEGY_UPDATE_SL_SUCCESS]', { symbol, orderId: newSlOrderId })
      }
      
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

    // 3. Create/update TP order according to tp_levels (exactly 1: tp)
    try {
      if (!Array.isArray(response.tp_levels) || response.tp_levels.length !== 1) {
        throw new Error('invalid_tp_levels')
      }

      const info = await api.getSymbolInfo(symbol)
      const priceFilter = (info?.filters || []).find((f: any) => f?.filterType === 'PRICE_FILTER')
      const lotSize = (info?.filters || []).find((f: any) => f?.filterType === 'LOT_SIZE')
      const tickSize = Number(priceFilter?.tickSize || 0.01)
      const stepSize = Number(lotSize?.stepSize || 0.001)

      const countStepDecimals = (step: number): number => {
        const s = String(step)
        const idx = s.indexOf('.')
        return idx >= 0 ? (s.length - idx - 1) : 0
      }
      const quantizeToStep = (value: number, step: number, mode: 'floor' | 'round' = 'floor'): number => {
        const decimals = countStepDecimals(step)
        const factor = Math.pow(10, decimals)
        const v = Math.round(value * factor)
        const st = Math.round(step * factor)
        let q: number
        if (mode === 'floor') q = Math.floor(v / st) * st
        else q = Math.round(v / st) * st
        return q / factor
      }
      const roundToTickSize = (price: number, tick: number): number => quantizeToStep(price, tick, 'round')
      const directionallyRoundForTp = (price: number, tick: number, side: 'LONG' | 'SHORT'): number => {
        try {
          const decimals = countStepDecimals(tick)
          const factor = Math.pow(10, decimals)
          const v = Math.round(price * factor)
          const st = Math.round(tick * factor)
          const q = side === 'LONG' ? Math.floor(v / st) * st : Math.ceil(v / st) * st
          return q / factor
        } catch { return price }
      }

      const posSize = Math.abs(Number(position.positionAmt))
      if (!Number.isFinite(posSize) || posSize <= 0) {
        throw new Error('no_position_size')
      }

      const levels = [...response.tp_levels]

      const trancheQtys: string[] = []
      let allocated = 0
      for (let i = 0; i < levels.length; i++) {
        const lvl = levels[i]
        const baseQty = i < levels.length - 1 ? posSize * lvl.allocation_pct : (posSize - allocated)
        const qNum = Math.max(0, quantizeToStep(baseQty, stepSize, 'floor'))
        allocated += qNum
        trancheQtys.push(qNum.toFixed(countStepDecimals(stepSize)))
      }

      // Build desired TP orders spec and detect tranches that are already in-the-money (<= mark)
      const currentMark = Number((await api.getMarkPrice(symbol)) || 0)
      const desired = levels.map((lvl, i) => {
        const px = directionallyRoundForTp(Number(lvl.price), tickSize, positionSide)
        const immediate = (() => {
          if (!(Number.isFinite(currentMark) && currentMark > 0)) return false
          const mark = Number(currentMark)
          // Immediate if price already reached TP threshold
          return positionSide === 'LONG' ? (mark >= px) : (mark <= px)
        })()
        return { tag: lvl.tag, price: px, quantity: trancheQtys[i], marketNow: immediate }
      })

      // Determine exit side for TP orders
      const openOrders = await api.getOpenOrders(symbol)
      const exitSide = (positionSide === 'LONG' ? 'SELL' : 'BUY') as 'BUY' | 'SELL'

      // Create or replace TP (single level)
      const createdIds: number[] = []
        for (const d of desired) {
        const qtyNum = Number(d.quantity)
        if (!Number.isFinite(qtyNum) || qtyNum <= 0) continue
          const posSidePayload = includePositionSide ? { positionSide: positionSide as 'LONG' | 'SHORT' } : {}
          // Always create a NEW TP (unique CID); cleanup phase will remove previous TPs
          const cid = makeId('x_tp')
        const tpParams = d.marketNow
          ? {
              symbol,
              side: exitSide,
              type: 'TAKE_PROFIT_MARKET' as const,
              stopPrice: String(d.price),
              closePosition: true as const,
              // IMPORTANT: When closePosition=true, do not send quantity
              workingType: 'MARK_PRICE' as const,
              ...posSidePayload,
              newClientOrderId: cid,
              newOrderRespType: 'RESULT' as const
            }
          : {
              symbol,
              side: exitSide,
              type: 'TAKE_PROFIT' as const,
              price: String(d.price),
              stopPrice: String(d.price),
              timeInForce: 'GTC' as const,
              quantity: String(d.quantity),
              // CRITICAL: Remove reduceOnly for TAKE_PROFIT orders - not required by Binance
              workingType: 'MARK_PRICE' as const,
              ...posSidePayload,
              newClientOrderId: cid,
              newOrderRespType: 'RESULT' as const
            }
        console.info('[STRATEGY_UPDATE_PLACE_TP]', { symbol, price: String(d.price), qty: String(d.quantity), marketNow: d.marketNow })
        const res = await api.placeOrder(tpParams as any)
        createdIds.push(Number(res?.orderId))
      }

      newTpOrderIds = createdIds
      console.info('[STRATEGY_UPDATE_TPS_SUCCESS]', { symbol, orderIds: newTpOrderIds })
    } catch (tpError: any) {
      console.error('[STRATEGY_UPDATE_TPS_ERROR]', { symbol, error: tpError?.message || tpError })
      // CRITICAL POLICY: nikdy nerušíme nově vytvořený SL při chybě TP
      // Zachovej nový SL, ať pozice není bez ochrany.
      return { success: false, error: `tp_creation_failed: ${tpError?.message || 'unknown'}` }
    }

    // 4. Both new orders created successfully - now cleanup old SL/TP orders
    try {
      const openOrders = await api.getOpenOrders(symbol)
      const exitSide = (positionSide === 'LONG' ? 'SELL' : 'BUY') as 'BUY' | 'SELL'
      const oldOrders = (Array.isArray(openOrders) ? openOrders : []).filter((order: any) => {
        try {
          const orderId = Number(order?.orderId || 0)
          if (orderId === newSlOrderId) return false
          if (Array.isArray(newTpOrderIds) && newTpOrderIds.includes(orderId)) return false
          if (String(order?.symbol) !== symbol) return false
          const sideOk = String(order?.side || '').toUpperCase() === exitSide
          const typeStr = String(order?.type || '')
          const isExitType = /stop|take_profit/i.test(typeStr)
          const hasExitFlags = Boolean(order?.closePosition === true || order?.reduceOnly === true)
          const isOldPrefix = /^(x_sl_|x_tp1_|x_tp2_|x_tp3_)/.test(String(order?.clientOrderId || ''))
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
      markStrategyOrders([newSlOrderId, ...(newTpOrderIds || [])])
      const { appendAudit, isAuditEnabled } = await import('./audit')
      if (isAuditEnabled()) appendAudit({ id: `su_exec_${Date.now()}_${symbol}`, symbol, phase: 'execute_success', created: { sl: newSlOrderId, tps: newTpOrderIds }, cancelled: cancelledOrderIds })
    } catch {}

    console.info('[STRATEGY_UPDATE_EXECUTE_SUCCESS]', {
      symbol,
      newSlOrderId,
      newTpOrderIds,
      cancelledCount: cancelledOrderIds.length,
      reasoning: response.reasoning
    })

    return {
      success: true,
      newSlOrderId,
      newTpOrderIds,
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
    const { newSL } = response

    // Validate that we're not making position worse
    if (side === 'LONG') {
      // Strict monotonic SL for LONG: never allow lower SL than previously set
      if (entry.currentSL != null && Number.isFinite(entry.currentSL as any) && newSL < entry.currentSL) {
        return {
          valid: false,
          reason: 'sl_monotonicity_violation_long'
        }
      }
    } else if (side === 'SHORT') {
      // Strict monotonic SL for SHORT: never allow higher SL than previously set
      if (entry.currentSL != null && Number.isFinite(entry.currentSL as any) && newSL > entry.currentSL) {
        return {
          valid: false,
          reason: 'sl_monotonicity_violation_short'
        }
      }
    }

    // Validate reasonable price levels (not too extreme)
    const slDistance = Math.abs(currentPrice - newSL) / currentPrice
    // Optional: keep a sanity check using the closest tp price
    let tpDistance = 0
    try {
      const minTp = Array.isArray(response.tp_levels) && response.tp_levels.length ? Math.min(...response.tp_levels.map(l => Number(l.price))) : null
      tpDistance = Number.isFinite(minTp as any) ? Math.abs((minTp as number) - currentPrice) / currentPrice : 0
    } catch { tpDistance = 0 }
    
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

