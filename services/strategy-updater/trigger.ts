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
        
        // 0. Read shared chosen_plan + posture from Risk Manager (optional)
        const { getRiskChosenPlan } = await import('./registry')
        const riskRec = getRiskChosenPlan(entry.symbol)
        const currentPlan = riskRec?.plan
        const posture = riskRec?.posture

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
        // 3a. Read lastDecision ONLY for this run: same symbol, phase=execute_start, ts >= entry.since
        let lastDecision: { newSL: number; tp_levels: Array<{ tag: 'tp'; price: number; allocation_pct: number }> } | null = null
        try {
          const { readAuditEntries } = await import('./audit')
          const recent = await readAuditEntries(entry.symbol, 200)
          const sinceMs = Date.parse(String(entry.since || ''))
          const isValidPhase = (r: any) => String(r?.phase || '') === 'execute_start'
          const withinSession = (r: any) => {
            const t = Date.parse(String(r?.ts || ''))
            return Number.isFinite(t) && Number.isFinite(sinceMs) && t >= sinceMs
          }
          const proposal = [...(Array.isArray(recent) ? recent : [])]
            .reverse()
            .find((r: any) => r && r.symbol === entry.symbol && isValidPhase(r) && withinSession(r) && r.proposal && typeof r.proposal.sl === 'number' && Array.isArray(r.proposal.tp_levels))
          if (proposal) {
            const levels = (proposal.proposal.tp_levels || []).filter((l: any) => l && (l.tag === 'tp'))
            lastDecision = { newSL: Number(proposal.proposal.sl), tp_levels: levels }
          }
        } catch {}

        // 2a. Read live open orders and derive current TP trio and current SL (no fallbacks)
        const openOrdersRaw = await api.getOpenOrders(entry.symbol).catch(() => [])
        const exitSide = entry.side === 'LONG' ? 'SELL' : 'BUY'
        const tagOf = (cid: string): 'tp'|null => cid.startsWith('x_tp_') ? 'tp' : null
        const tpLevels: Array<{ tag:'tp'; price:number; allocation_pct:number }> = []
        let currentSlLive: number | null = null
        try {
          const orders = Array.isArray(openOrdersRaw) ? openOrdersRaw : []
          // TP levels from live open orders (CID prefix authoritative)
          for (const o of orders) {
            try {
              if (String(o?.symbol) !== entry.symbol) continue
              if (String(o?.side) !== exitSide) continue
              const cid = String(o?.clientOrderId || '')
              const tag = tagOf(cid)
              if (!tag) continue
              const price = Number(o?.price || o?.stopPrice || 0)
              if (!Number.isFinite(price) || price <= 0) continue
              tpLevels.push({ tag, price, allocation_pct: 1.0 })
            } catch {}
          }
          // Current SL from live open orders: most-protective around mark
          let markPx: number | null = null
          try { markPx = await api.getMarkPrice(entry.symbol) } catch {}
          const stopOrders = orders.filter((o: any) => {
            try {
              if (String(o?.symbol) !== entry.symbol) return false
              if (String(o?.side) !== exitSide) return false
              const t = String(o?.type || '').toUpperCase()
              return t.includes('STOP') && !t.includes('TAKE_PROFIT')
            } catch { return false }
          })
          const candidates: number[] = []
          for (const o of stopOrders) {
            try {
              const sp = Number(o?.stopPrice || o?.price || 0)
              if (!Number.isFinite(sp) || sp <= 0) continue
              if (Number.isFinite(markPx as any)) {
                if (entry.side === 'LONG') {
                  if (sp < (markPx as number)) candidates.push(sp)
                } else {
                  if (sp > (markPx as number)) candidates.push(sp)
                }
              }
            } catch {}
          }
          if (candidates.length > 0) {
            currentSlLive = entry.side === 'LONG' ? Math.max(...candidates) : Math.min(...candidates)
          }
          // Telemetry logs
          try {
            if ((currentSlLive == null) && tpLevels.length === 0) {
              console.warn('[SU_LIVE_ORDERS_EMPTY]', { symbol: entry.symbol })
            }
            if (currentSlLive != null) {
              console.info('[SU_LIVE_SL_APPLIED]', { symbol: entry.symbol, prev: entry.currentSL ?? null, live: currentSlLive })
            }
            if (tpLevels.length > 0) {
              const tags = tpLevels.map(t => t.tag).sort((a,b)=>orderOf(a)-orderOf(b))
              console.info('[SU_LIVE_TP_APPLIED]', { symbol: entry.symbol, count: tpLevels.length, tags })
            }
          } catch {}
        } catch {}
        // Sort TPs by tag order and dedupe by tag keeping nearest price to mark if available
        try {
          const markPx = await api.getMarkPrice(entry.symbol).catch(()=>null)
          const byTag: Record<'tp', { tag:'tp'; price:number; allocation_pct:number } | undefined> = { tp: undefined }
          for (const lvl of tpLevels) {
            const existing = byTag[lvl.tag]
            if (!existing) { byTag[lvl.tag] = lvl; continue }
            if (Number.isFinite(markPx as any)) {
              const dNew = Math.abs(lvl.price - (markPx as number))
              const dOld = Math.abs((existing as any).price - (markPx as number))
              if (dNew < dOld) byTag[lvl.tag] = lvl
            } else {
              byTag[lvl.tag] = lvl // last-wins if no mark
            }
          }
          const compact: typeof tpLevels = []
          ;(['tp'] as const).forEach(t => { if (byTag[t]) compact.push(byTag[t] as any) })
          tpLevels.length = 0; for (const x of compact) tpLevels.push(x)
        } catch {}

        const initialSizeAbs = Math.abs(Number(entry.positionSize || 0))
        const currentAbsSize = Math.abs(Number(currentPosition?.positionAmt || 0))
        const sizeRemainingPct = ((): number | undefined => {
          if (initialSizeAbs > 0 && Number.isFinite(currentAbsSize)) {
            const ratio = currentAbsSize / initialSizeAbs
            return Math.max(0, Math.min(1, ratio))
          }
          return undefined
        })()

        const updateInput = {
          symbol: entry.symbol,
          position: {
            side: entry.side,
            size: entry.positionSize,
            initialSize: initialSizeAbs || undefined,
            sizeRemainingPct: sizeRemainingPct,
            entryPrice: entry.entryPrice,
            currentPrice,
            unrealizedPnl,
            unrealizedPnlPct: (entry.entryPrice > 0 ? ((currentPrice - entry.entryPrice) / entry.entryPrice) * (entry.side === 'LONG' ? 100 : -100) : 0)
          },
          currentSL: currentSlLive ?? null,
          currentTP: tpLevels.length ? tpLevels.sort((a,b)=>orderOf(a.tag)-orderOf(b.tag)) : [],
          // Risk-aligned inputs
          current_plan: currentPlan || undefined,
          market_snapshot: {
            ts: Date.now(),
            markPrice: currentPrice,
            bestBid: null,
            bestAsk: null,
            spread: null,
            atr: { m5: (marketData?.atr_m15 ?? null), m15: (marketData?.atr_h1 ?? null) },
            rsi: { m5: (marketData?.rsi_M5 ?? null), m15: (marketData?.rsi_M15 ?? null) },
            ema: { m5: { 20: (marketData?.ema20_M5 ?? null), 50: (marketData?.ema50_M5 ?? null) }, m15: { 20: (marketData?.ema20_M15 ?? null), 50: (marketData?.ema50_M15 ?? null) } },
            vwap: (marketData?.vwap_today ?? marketData?.vwap_daily ?? null),
            volume: { m5: (marketData?.volume ?? null), spike: null },
            delta: { m5: null },
            sr: { nearestSupport: (Array.isArray(marketData?.support) && marketData.support.length ? marketData.support[0] : null), nearestResistance: (Array.isArray(marketData?.resistance) && marketData.resistance.length ? marketData.resistance[0] : null) }
          },
          posture: posture || 'OK',
          exchange_filters: ((): any => {
            const v = Number(process.env.MAX_SLIPPAGE_PCT)
            if (!(Number.isFinite(v) && v > 0 && v < 1)) {
              throw new Error('slippage_env_missing')
            }
            return { maxSlippagePct: v, minNotional: 5 }
          })(),
          lastDecision,
          // Fills metadata strictly from actual Binance fills (no heuristics)
          fills: await (async (): Promise<{ tp_hits_count: number; last_tp_hit_tag: 'tp1'|'tp2'|'tp3'|null; realized_pct_of_initial: number }> => {
            try {
              const sinceMs = Date.parse(String(entry.since || ''))
              if (!Number.isFinite(sinceMs)) {
                console.warn('[SU_FILLS_FALLBACK]', { symbol: entry.symbol, reason: 'bad_since' })
                return { tp_hits_count: 0, last_tp_hit_tag: null, realized_pct_of_initial: 0 }
              }
              const endMs = Date.now()
              // Fetch all orders and user trades since entry start (narrow window)
              const [allOrders, trades] = await Promise.all([
                api.getAllOrders(entry.symbol, { startTime: sinceMs, endTime: endMs, limit: 1000 }).catch((e: any) => { console.warn('[SU_FILLS_FALLBACK]', { symbol: entry.symbol, reason: 'getAllOrders_error', error: (e?.message||'unknown') }); return [] }),
                api.getUserTrades(entry.symbol, { startTime: sinceMs, endTime: endMs, limit: 1000 }).catch((e: any) => { console.warn('[SU_FILLS_FALLBACK]', { symbol: entry.symbol, reason: 'getUserTrades_error', error: (e?.message||'unknown') }); return [] })
              ])
              const ordersArr = Array.isArray(allOrders) ? allOrders : []
              const tradesArr = Array.isArray(trades) ? trades : []
              if (ordersArr.length === 0 || tradesArr.length === 0) {
                console.warn('[SU_FILLS_FALLBACK]', { symbol: entry.symbol, reason: 'empty_data', orders: ordersArr.length, trades: tradesArr.length })
              }
              const cidOf = (o: any): string => String(o?.clientOrderId || o?.C || o?.c || '')
              const tagOfCid = (cid: string): 'tp1'|'tp2'|'tp3'|null => cid.startsWith('x_tp1_') ? 'tp1' : cid.startsWith('x_tp2_') ? 'tp2' : cid.startsWith('x_tp3_') ? 'tp3' : null

              // Map orderId -> tag (based solely on CID prefix)
              const tagByOrderId: Map<number, 'tp1'|'tp2'|'tp3'> = new Map()
              for (const o of ordersArr) {
                try {
                  const id = Number(o?.orderId || o?.orderID || 0)
                  if (!Number.isFinite(id) || id <= 0) continue
                  const tag = tagOfCid(cidOf(o))
                  if (tag) tagByOrderId.set(id, tag)
                } catch {}
              }

              // Aggregate fills per tag using trades linked to TP orders
              const qtyByTag: Record<'tp1'|'tp2'|'tp3', number> = { tp1: 0, tp2: 0, tp3: 0 }
              let lastTradeTime: number = 0
              let lastTag: 'tp1'|'tp2'|'tp3'|null = null
              const exitOrderIds = new Set<number>()
              for (const [oid, t] of tagByOrderId.entries()) exitOrderIds.add(oid)

              for (const tr of tradesArr) {
                try {
                  const oid = Number(tr?.orderId || tr?.orderID || tr?.id || tr?.tradeId || 0)
                  if (!exitOrderIds.has(oid)) continue
                  const tag = tagByOrderId.get(oid)
                  if (!tag) continue
                  const q = Number(tr?.qty || tr?.qtyFilled || tr?.executedQty || 0)
                  const tt = Number(tr?.time || tr?.T || 0)
                  if (Number.isFinite(q) && q > 0) {
                    qtyByTag[tag] += q
                    if (Number.isFinite(tt) && tt >= lastTradeTime) { lastTradeTime = tt; lastTag = tag }
                  }
                } catch {}
              }

              const distinctHits = (['tp1','tp2','tp3'] as const).filter(t => qtyByTag[t] > 0)

              // Realized percent from actual exit trades (TP + SL); include any reduce-only/closePosition sells matching exit side too
              let realizedQty = 0
              for (const tr of tradesArr) {
                try {
                  const oid = Number(tr?.orderId || tr?.orderID || tr?.id || tr?.tradeId || 0)
                  if (!Number.isFinite(oid) || oid <= 0) continue
                  const isExit = exitOrderIds.has(oid)
                  if (!isExit) continue
                  const q = Number(tr?.qty || tr?.qtyFilled || tr?.executedQty || 0)
                  if (Number.isFinite(q) && q > 0) realizedQty += q
                } catch {}
              }
              const realizedPct = initialSizeAbs > 0 ? Math.max(0, Math.min(1, realizedQty / initialSizeAbs)) : 0

              const out = { tp_hits_count: Math.max(0, Math.min(3, distinctHits.length)), last_tp_hit_tag: lastTag, realized_pct_of_initial: realizedPct }
              try { console.info('[SU_FILLS_ACTUAL]', { symbol: entry.symbol, ...out }) } catch {}
              return out
            } catch (e: any) {
              try { console.warn('[SU_FILLS_FALLBACK]', { symbol: entry.symbol, reason: 'exception', error: (e?.message||'unknown') }) } catch {}
              return { tp_hits_count: 0, last_tp_hit_tag: null, realized_pct_of_initial: 0 }
            }
          })()
        }

        // 4. Call OpenAI for strategy update
        // DEBUG: persist exact input 1:1 for UI payload preview (read-only)
        try {
          const fs = await import('node:fs')
          const path = await import('node:path')
          const dir = path.resolve('runtime/su_debug')
          try { fs.mkdirSync(dir, { recursive: true }) } catch {}
          const file = path.join(dir, `${entry.symbol}.json`)
          const blob = { ts: new Date().toISOString(), symbol: entry.symbol, input: updateInput }
          fs.writeFileSync(file, JSON.stringify(blob, null, 2), 'utf8')
        } catch {}

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
          // Low confidence: keep cadence; reschedule next pass in 5 minutes
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
          // Success: maintain 5-minute cadence while position is open
          rescheduleStrategyUpdate(entry.symbol)
          if (isAuditEnabled()) appendAudit({ id: `su_${Date.now()}_${entry.symbol}`, symbol: entry.symbol, phase: 'success', created: { sl: execResult.newSlOrderId, tps: execResult.newTpOrderIds }, cancelled: execResult.cancelledOrderIds })
          console.info('[STRATEGY_UPDATER_SUCCESS]', { 
            symbol: entry.symbol,
            newSL: response.newSL,
            tp_levels: response.tp_levels,
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
