import { getBinanceAPI } from '../trading/binance_futures'
import { scheduleStrategyUpdate, cleanupStrategyUpdaterForSymbol } from './registry'

// Detect internal entry order fills and trigger strategy updater
export function detectInternalPositionOpened(
  orders: any[], 
  positions: any[], 
  auditEvent?: { type: 'filled' | 'cancel'; symbol: string; orderId: number }
): void {
  try {
    // First, handle WebSocket filled events
    if (auditEvent?.type === 'filled') {
      handlePotentialInternalFill(auditEvent.symbol, auditEvent.orderId, orders, positions)
    }

    // Auto-detect positions that should have Strategy Updater but don't
    detectMissingStrategyUpdaters(orders, positions)
    
    // Cleanup strategy updater for symbols with no positions
    cleanupExpiredTracking(positions)

  } catch (error) {
    console.error('[STRATEGY_UPDATER_TRIGGER_ERR]', (error as any)?.message || error)
  }
}

// Auto-detect positions that need Strategy Updater
function detectMissingStrategyUpdaters(orders: any[], positions: any[]): void {
  try {
    const { getStrategyUpdaterList } = require('./registry')
    const existingEntries = new Set(getStrategyUpdaterList().map((e: any) => e.symbol))
    
    for (const position of positions) {
      try {
        const symbol = String(position?.symbol || '')
        const amt = Number(position?.positionAmt || position?.size || 0)
        
        if (symbol && Math.abs(amt) > 0 && !existingEntries.has(symbol)) {
          // Attach Strategy Updater to ANY active position (no fallback logic)
          startStrategyUpdaterForPosition(symbol, position, orders)
        }
      } catch {}
    }
  } catch (error) {
    console.error('[DETECT_MISSING_STRATEGY_UPDATERS_ERR]', (error as any)?.message || error)
  }
}

// Handle WebSocket filled event for internal orders
function handlePotentialInternalFill(
  symbol: string, 
  orderId: number, 
  orders: any[], 
  positions: any[]
): void {
  try {
    // Check if this was an internal entry order that got filled
    // Internal entry orders should now be gone from orders list, but position should exist
    
    const hasInternalEntry = orders.some((order: any) => {
      const clientId = String(order?.clientOrderId || '')
      const isInternal = /^e_l_/.test(clientId)
      const isEntry = String(order?.side) === 'BUY' && String(order?.type) === 'LIMIT' && 
                     !(order?.reduceOnly || order?.closePosition)
      return isInternal && isEntry && String(order?.symbol) === symbol
    })

    // Find current position for this symbol
    const position = positions.find((pos: any) => {
      const sym = String(pos?.symbol || '')
      const amt = Number(pos?.positionAmt || pos?.size || 0)
      return sym === symbol && Math.abs(amt) > 0
    })

    if (position && !hasInternalEntry) {
      // Position exists but no internal entry order - likely just filled!
      startStrategyUpdaterForPosition(symbol, position, orders)
    }

  } catch (error) {
    console.error('[INTERNAL_FILL_HANDLER_ERR]', {
      symbol,
      orderId,
      error: (error as any)?.message || error
    })
  }
}

// Removed REST polling backup - WebSocket detection is sufficient

// Start strategy updater timer for a position
function startStrategyUpdaterForPosition(symbol: string, position: any, orders: any[]): void {
  try {
    const positionAmt = Number(position?.positionAmt || position?.size || 0)
    const entryPrice = Number(position?.entryPrice || position?.averagePrice || 0)
    
    if (!positionAmt || !entryPrice || Math.abs(positionAmt) <= 0 || entryPrice <= 0) {
      console.warn('[STRATEGY_UPDATER_INVALID_POSITION]', { symbol, positionAmt, entryPrice })
      return
    }

    const side: 'LONG' | 'SHORT' = positionAmt > 0 ? 'LONG' : 'SHORT'
    const size = Math.abs(positionAmt)

    // Find current SL and TP orders
    let currentSL: number | null = null
    let currentTP: number | null = null

    for (const order of orders) {
      try {
        if (String(order?.symbol) !== symbol) continue
        
        const clientId = String(order?.clientOrderId || '')
        const orderType = String(order?.type || '')
        const stopPrice = Number(order?.stopPrice || 0)
        
        // Check for SL orders (x_sl_ prefix or STOP_MARKET type)
        if (/^x_sl_/.test(clientId) || orderType === 'STOP_MARKET') {
          if (stopPrice > 0) currentSL = stopPrice
        }
        
        // Check for TP orders (x_tp_* prefix or TAKE_PROFIT type)
        if (/^x_tp_/.test(clientId) || /TAKE_PROFIT/i.test(orderType)) {
          const tpPrice = stopPrice || Number(order?.price || 0)
          if (tpPrice > 0) currentTP = tpPrice
        }
      } catch {}
    }

    // Schedule the strategy update
    scheduleStrategyUpdate(symbol, side, entryPrice, size, currentSL, currentTP)
    
    console.info('[STRATEGY_UPDATER_TRIGGERED]', {
      symbol,
      side,
      entryPrice,
      size,
      currentSL,
      currentTP
    })

  } catch (error) {
    console.error('[START_STRATEGY_UPDATER_ERR]', {
      symbol,
      error: (error as any)?.message || error
    })
  }
}

// Cleanup tracking for symbols with no positions
function cleanupExpiredTracking(positions: any[]): void {
  try {
    const activeSymbols = new Set<string>()
    
    for (const position of positions) {
      try {
        const symbol = String(position?.symbol || '')
        const amt = Number(position?.positionAmt || position?.size || 0)
        
        if (symbol && Math.abs(amt) > 0) {
          activeSymbols.add(symbol)
        }
      } catch {}
    }

    // Cleanup Strategy Updater entries for symbols without active positions
    try {
      const { getStrategyUpdaterList, cleanupStrategyUpdaterForSymbol } = require('./registry')
      const entries: any[] = getStrategyUpdaterList()
      for (const e of (Array.isArray(entries) ? entries : [])) {
        try {
          const sym = String(e?.symbol || '')
          if (sym && !activeSymbols.has(sym)) {
            cleanupStrategyUpdaterForSymbol(sym)
          }
        } catch {}
      }
    } catch {}
    console.debug('[STRATEGY_UPDATER_ACTIVE_POSITIONS]', Array.from(activeSymbols))

  } catch (error) {
    console.error('[CLEANUP_EXPIRED_TRACKING_ERR]', (error as any)?.message || error)
  }
}

// Check if strategy updater is enabled (controlled by UI toggle)
export function isStrategyUpdaterEnabled(): boolean {
  try {
    // Default to enabled; allow explicit disable via env
    const envVar = String(process.env.STRATEGY_UPDATER_ENABLED || '').toLowerCase()
    if (envVar === '0' || envVar === 'false' || envVar === 'off') return false
    return true
  } catch {
    return true
  }
}

// Process due strategy updates (called by main tick)
export async function processDueStrategyUpdates(): Promise<void> {
  if (!isStrategyUpdaterEnabled()) return

  try {
    const { getDueUpdates } = await import('./registry')
    const { markStrategyUpdateProcessing } = await import('./registry')
    const { rescheduleStrategyUpdate } = await import('./registry')
    const { appendAudit, isAuditEnabled } = await import('./audit')
    const { runStrategyUpdate, fetchMarketDataForSymbol } = await import('./strategy_updater_gpt')
    const { executeStrategyUpdate } = await import('./executor')
    
    const dueUpdates = getDueUpdates()
    
    if (dueUpdates.length === 0) return

    console.info('[STRATEGY_UPDATER_PROCESSING]', { count: dueUpdates.length })

    for (const entry of dueUpdates) {
      try {
        console.info('[STRATEGY_UPDATER_PROCESS_START]', { symbol: entry.symbol })
        markStrategyUpdateProcessing(entry.symbol)
        
        // 1. Fetch fresh market data (NO CACHE)
        const marketData = await fetchMarketDataForSymbol(entry.symbol)
        
        // 2. Get current position info
        const api = getBinanceAPI()
        const positions = await api.getPositions()
        const currentPosition = positions.find((pos: any) => String(pos?.symbol) === entry.symbol)
        
        if (!currentPosition || Math.abs(Number(currentPosition?.positionAmt || 0)) <= 0) {
          // Position no longer exists - cleanup
          const { markStrategyUpdateCompleted } = await import('./registry')
          markStrategyUpdateCompleted(entry.symbol)
          console.info('[STRATEGY_UPDATER_POSITION_GONE]', { symbol: entry.symbol })
          continue
        }

        const currentPrice = Number(marketData?.price || currentPosition?.markPrice || 0)
        const unrealizedPnl = Number(currentPosition?.unrealizedPnl || 0)

        // 3. Prepare input for OpenAI
        const updateInput = {
          symbol: entry.symbol,
          position: {
            side: entry.side,
            size: entry.positionSize,
            entryPrice: entry.entryPrice,
            currentPrice,
            unrealizedPnl
          },
          currentSL: entry.currentSL,
          currentTP: entry.currentTP,
          marketData
        }

        // 4. Call OpenAI for strategy update
        const aiResult = await runStrategyUpdate(updateInput)
        
        if (!aiResult.ok || !aiResult.data) {
          const { markStrategyUpdateError } = await import('./registry')
          markStrategyUpdateError(entry.symbol, aiResult.code || 'ai_failed')
          if (isAuditEnabled()) appendAudit({ id: `su_${Date.now()}_${entry.symbol}`, symbol: entry.symbol, phase: 'ai_failed', code: aiResult.code, inputMeta: { fresh: true } })
          console.error('[STRATEGY_UPDATER_AI_FAILED]', { 
            symbol: entry.symbol, 
            code: aiResult.code 
          })
          continue
        }

        const response = aiResult.data
        
        // 5. Check confidence threshold
        if (response.confidence < 0.5) {
          // Low confidence: keep cadence; reschedule next pass in 3 minutes
          rescheduleStrategyUpdate(entry.symbol)
          if (isAuditEnabled()) appendAudit({ id: `su_${Date.now()}_${entry.symbol}`, symbol: entry.symbol, phase: 'skipped_low_conf', confidence: response.confidence })
          console.info('[STRATEGY_UPDATER_LOW_CONFIDENCE]', { 
            symbol: entry.symbol, 
            confidence: response.confidence 
          })
          continue
        }

        // 6. Execute the strategy update (create new orders, delete old)
        const execResult = await executeStrategyUpdate(entry.symbol, response, entry)
        
        if (execResult.success) {
          // Success: maintain 3-minute cadence while position is open
          rescheduleStrategyUpdate(entry.symbol)
          if (isAuditEnabled()) appendAudit({ id: `su_${Date.now()}_${entry.symbol}`, symbol: entry.symbol, phase: 'success', created: { sl: execResult.newSlOrderId, tp: execResult.newTpOrderId }, cancelled: execResult.cancelledOrderIds })
          console.info('[STRATEGY_UPDATER_SUCCESS]', { 
            symbol: entry.symbol,
            newSL: response.newSL,
            newTP: response.newTP,
            confidence: response.confidence,
            urgency: response.urgency
          })
        } else {
          const { markStrategyUpdateError } = await import('./registry')
          markStrategyUpdateError(entry.symbol, execResult.error || 'execution_failed')
          if (isAuditEnabled()) appendAudit({ id: `su_${Date.now()}_${entry.symbol}`, symbol: entry.symbol, phase: 'exec_failed', error: execResult.error })
          console.error('[STRATEGY_UPDATER_EXEC_FAILED]', { 
            symbol: entry.symbol, 
            error: execResult.error 
          })
        }

      } catch (error) {
        const { markStrategyUpdateError } = await import('./registry')
        markStrategyUpdateError(entry.symbol, (error as any)?.message || 'unknown_error')
        try { const { appendAudit, isAuditEnabled } = await import('./audit'); if (isAuditEnabled()) appendAudit({ id: `su_${Date.now()}_${entry.symbol}`, symbol: entry.symbol, phase: 'process_error', error: (error as any)?.message || 'unknown_error' }) } catch {}
        console.error('[STRATEGY_UPDATER_PROCESS_ERR]', {
          symbol: entry.symbol,
          error: (error as any)?.message || error
        })
      }
    }

  } catch (error) {
    console.error('[PROCESS_DUE_UPDATES_ERR]', (error as any)?.message || error)
  }
}
