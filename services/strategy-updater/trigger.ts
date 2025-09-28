import { getBinanceAPI } from '../trading/binance_futures'
import { scheduleStrategyUpdate, cleanupStrategyUpdaterForSymbol } from './registry'

// Local helper: stable order for TP tags
function orderOf(tag: string): number {
  try {
    switch (String(tag)) {
      case 'tp': return 1
      default: return 999
    }
  } catch { return 999 }
}

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
        const isOpen = Math.abs(amt) > 0
        const ps = String((position as any)?.positionSide || '').toUpperCase()
        const isShort = ps === 'SHORT' ? true : (amt < 0)
        // Pouze SHORT pozice jsou interní – naplánuj SU
        if (symbol && isOpen && isShort && !existingEntries.has(symbol)) {
          startStrategyUpdaterForPosition(symbol, position, orders)
        } else if (symbol && isOpen && !isShort && existingEntries.has(symbol)) {
          // LONG = external: pokud by existoval záznam, ukliď jej
          try { const { cleanupStrategyUpdaterForSymbol } = require('./registry'); cleanupStrategyUpdaterForSymbol(symbol) } catch {}
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
    // Ignoruj prefixy, rozlišíme podle strany pozice
    const position = positions.find((pos: any) => {
      const sym = String(pos?.symbol || '')
      const amt = Number(pos?.positionAmt || pos?.size || 0)
      return sym === symbol && Math.abs(amt) > 0
    })

    if (!position) return

    const amt = Number(position?.positionAmt || position?.size || 0)
    const ps = String((position as any)?.positionSide || '').toUpperCase()
    const side: 'LONG' | 'SHORT' = ps === 'LONG' ? 'LONG' : ps === 'SHORT' ? 'SHORT' : (amt > 0 ? 'LONG' : 'SHORT')
    if (side === 'SHORT') startStrategyUpdaterForPosition(symbol, position, orders)
    else {
      try { const { cleanupStrategyUpdaterForSymbol } = require('./registry'); cleanupStrategyUpdaterForSymbol(symbol) } catch {}
      try { console.info('[STRATEGY_UPDATER_EXTERNAL_LONG]', { symbol }) } catch {}
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
export function startStrategyUpdaterForPosition(symbol: string, position: any, orders: any[], options?: { initialDelayMs?: number }): void {
  try {
    const positionAmt = Number(position?.positionAmt || position?.size || 0)
    const entryPrice = Number(position?.entryPrice || position?.averagePrice || 0)
    
    if (!positionAmt || !entryPrice || Math.abs(positionAmt) <= 0 || entryPrice <= 0) {
      console.warn('[STRATEGY_UPDATER_INVALID_POSITION]', { symbol, positionAmt, entryPrice })
      return
    }

    const ps = String((position as any)?.positionSide || '').toUpperCase()
    const side: 'LONG' | 'SHORT' = ps === 'LONG' ? 'LONG' : ps === 'SHORT' ? 'SHORT' : (positionAmt > 0 ? 'LONG' : 'SHORT')
    const size = Math.abs(positionAmt)

    // Scheduling relies on provided positions argument; no extra WS readiness gate here

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

    // Schedule the strategy update (caller controls initial delay policy)
    scheduleStrategyUpdate(symbol, side, entryPrice, size, currentSL, currentTP, options)
    
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
    // No global WS readiness gate – we validate per-symbol below if needed

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
        // Proceed without hard-skipping; per-symbol validation is handled during execution

        console.info('[STRATEGY_UPDATER_PROCESS_START]', { symbol: entry.symbol })
        // Persist minimal marker immediately (prevents stale files from other symbols being shown)
        try {
          const fs = await import('node:fs')
          const path = await import('node:path')
          const dir = path.resolve('runtime/su_debug')
          try { fs.mkdirSync(dir, { recursive: true }) } catch {}
          const file = path.join(dir, `${entry.symbol}.json`)
          const blob = { ts: new Date().toISOString(), symbol: entry.symbol, status: 'processing_start' as const }
          fs.writeFileSync(file, JSON.stringify(blob, null, 2), 'utf8')
        } catch {}
        markStrategyUpdateProcessing(entry.symbol)
        
        // 0. Read shared chosen_plan + posture from Risk Manager (optional)
        const { getRiskChosenPlan } = await import('./registry')
        const riskRec = getRiskChosenPlan(entry.symbol)
        const currentPlan = riskRec?.plan
        const posture = riskRec?.posture

        // 1. Fetch fresh FUTURES market data (NO CACHE, exact symbol only)
        const marketData = await fetchMarketDataForSymbol(entry.symbol)
        
        // 1b. Get full market snapshot with klines and depth data
        let fullSnapshot: any = null
        try {
          const { buildMarketRawSnapshot } = await import('../../server/fetcher/binance')
          fullSnapshot = await buildMarketRawSnapshot({
            universeStrategy: 'volume',
            desiredTopN: 2,
            includeSymbols: [entry.symbol],
            fresh: true,
            allowPartial: true,
            skipExchangeInfo: true
          })
        } catch (e) {
          console.warn('[SU_FULL_SNAPSHOT_FALLBACK]', { symbol: entry.symbol, error: (e as any)?.message })
          fullSnapshot = { universe: [], bySymbol: {} }
        }
        
        // 2. Use entry position data directly (avoid fresh REST call inconsistency)
        const currentPosition = {
          symbol: entry.symbol,
          positionAmt: entry.side === 'LONG' ? entry.positionSize : -entry.positionSize,
          entryPrice: entry.entryPrice,
          markPrice: 0 // Will be updated from market data
        }
        console.info('[SU_USING_ENTRY_DATA_TRIGGER]', { symbol: entry.symbol, side: entry.side, size: entry.positionSize })

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
        const api = getBinanceAPI()
        const openOrdersRaw = await api.getOpenOrders(entry.symbol).catch(() => [])
        const exitSide = entry.side === 'LONG' ? 'SELL' : 'BUY'
        // Accept project-prefixed IDs (sv2_x_tp_...) and plain x_tp_
        const tagOf = (cid: string): 'tp'|null => (String(cid).includes('x_tp_') ? 'tp' : null)
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

        const rawM5List = (() => {
          const list = marketData?.klines?.M5 ?? marketData?.klines?.m5 ?? []
          if (!Array.isArray(list) || list.length === 0) return []
          return list.slice(-60)
        })()

        const normalizedM5 = rawM5List.map((c: any) => ({
          time: c?.openTime ?? c?.t ?? null,
          open: Number(c?.open ?? c?.o ?? 0),
          high: Number(c?.high ?? c?.h ?? 0),
          low: Number(c?.low ?? c?.l ?? 0),
          close: Number(c?.close ?? c?.c ?? 0),
          volume: Number(c?.volume ?? c?.v ?? 0)
        })).filter(row => typeof row.time === 'string' || typeof row.time === 'number')

        const lastRaw = rawM5List[rawM5List.length - 1] || null
        const closeTimeMs = Number(lastRaw?.closeTime ?? lastRaw?.close_time ?? NaN)
        const priceTs = marketData?.price_ts ?? new Date().toISOString()
        const isLastClosed = Number.isFinite(closeTimeMs) ? closeTimeMs <= Date.now() : Boolean(lastRaw)

        const tpDisplay = tpLevels.map(tp => ({ price: tp.price, sizePct: Number(tp.allocation_pct ?? 0) }))
        const unrealizedPnlPct = (entry.entryPrice > 0
          ? ((currentPrice - entry.entryPrice) / entry.entryPrice) * (entry.side === 'LONG' ? 100 : -100)
          : 0)

        const minimalSnapshot = {
          ts: priceTs,
          symbol: entry.symbol,
          position: {
            side: entry.side,
            size: entry.positionSize,
            entryPrice: entry.entryPrice,
            currentPrice,
            currentSL: currentSlLive ?? null,
            currentTP: tpDisplay,
            unrealizedPnlPct
          },
          market: {
            is_last_candle_closed: isLastClosed,
            ohlcv: { m5: normalizedM5 },
            indicators: {
              rsi: { m5: marketData?.rsi_M5 ?? null },
              ema: { m5: { '20': marketData?.ema20_M5 ?? null, '50': marketData?.ema50_M5 ?? null } },
              atr: { m5: marketData?.atr_m5 ?? null }
            }
          },
          exchange_filters: {
            minNotional: Number(process.env.MIN_NOTIONAL ?? 5),
            maxSlippagePct: Number(process.env.MAX_SLIPPAGE_PCT ?? 0.05)
          }
        }

        try {
          const fs = await import('node:fs')
          const path = await import('node:path')
          const dir = path.resolve('runtime/su_debug')
          try { fs.mkdirSync(dir, { recursive: true }) } catch {}
          const file = path.join(dir, `${entry.symbol}.json`)
          fs.writeFileSync(file, JSON.stringify(minimalSnapshot, null, 2), 'utf8')
        } catch {}

        const pnlDirection = entry.side === 'LONG' ? 1 : -1
        const unrealizedPnlUsd = Number(((currentPrice - entry.entryPrice) * entry.positionSize * pnlDirection).toFixed(4))

        const aiInput: StrategyUpdateInput = {
          symbol: entry.symbol,
          position: {
            side: entry.side,
            size: entry.positionSize,
            entryPrice: entry.entryPrice,
            currentPrice,
            unrealizedPnl: unrealizedPnlUsd,
            unrealizedPnlPct
          },
          currentSL: currentSlLive ?? null,
          currentTP: tpLevels,
          market_snapshot: {
            ts: Date.now(),
            price_ts: priceTs,
            is_last_candle_closed: isLastClosed,
            ohlcv: { m5: normalizedM5 },
            indicators: minimalSnapshot.market.indicators
          },
          exchange_filters: minimalSnapshot.exchange_filters,
          fills: await (async () => {
            const sinceMs = Date.parse(String(entry.since || ''))
            if (!Number.isFinite(sinceMs)) return { tp_hits_count: 0, last_tp_hit_tag: null, realized_pct_of_initial: 0 }
            const endMs = Date.now()
            const [allOrders, trades] = await Promise.all([
              api.getAllOrders(entry.symbol, { startTime: sinceMs, endTime: endMs, limit: 1000 }).catch(() => []),
              api.getUserTrades(entry.symbol, { startTime: sinceMs, endTime: endMs, limit: 1000 }).catch(() => [])
            ])
            const tagByOrderId: Map<number, 'tp'> = new Map()
            for (const o of allOrders || []) {
              const id = Number(o?.orderId)
              if (!Number.isFinite(id)) continue
              const cid = String(o?.clientOrderId || '')
              if (cid.includes('x_tp_')) tagByOrderId.set(id, 'tp')
            }
            let hits = 0
            let realizedQty = 0
            for (const tr of trades || []) {
              const oid = Number(tr?.orderId)
              if (!tagByOrderId.has(oid)) continue
              hits = 1
              const qty = Number(tr?.qty || tr?.executedQty || 0)
              if (Number.isFinite(qty)) realizedQty += qty
            }
            const realizedPct = entry.positionSize > 0 ? Math.max(0, Math.min(1, realizedQty / entry.positionSize)) : 0
            return { tp_hits_count: hits, last_tp_hit_tag: hits ? 'tp' : null, realized_pct_of_initial: realizedPct }
          })()
        }

        const aiResult = await runStrategyUpdate(aiInput)
        
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
        
        // 5. Check confidence threshold (configurable)
        const floorRaw = process.env.SU_CONFIDENCE_FLOOR
        const confFloor = (() => { const v = Number(floorRaw); return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.0 })()
        if (response.confidence < confFloor) {
          // Low confidence: keep cadence; reschedule next pass in 1 minute
          rescheduleStrategyUpdate(entry.symbol)
          if (isAuditEnabled()) appendAudit({ id: `su_${Date.now()}_${entry.symbol}`, symbol: entry.symbol, phase: 'skipped_low_conf', confidence: response.confidence, floor: confFloor })
          console.info('[STRATEGY_UPDATER_LOW_CONFIDENCE]', { 
            symbol: entry.symbol, 
            confidence: response.confidence,
            floor: confFloor
          })
          continue
        }

        // 6. CRITICAL: Validate SL for SHORT positions before execution
        if (entry.side === 'SHORT') {
          // Ensure SL is above current mark with a realistic buffer and never increase against current SL
          let mark = 0
          let tickSize: number | null = null
          try {
            const { getBinanceAPI } = await import('../trading/binance_futures')
            const api = getBinanceAPI()
            mark = Number(await api.getMarkPrice(entry.symbol))
            try {
              const info = await api.getSymbolInfo(entry.symbol)
              const pf = (info?.filters || []).find((f: any) => f?.filterType === 'PRICE_FILTER')
              tickSize = pf ? Number(pf.tickSize) : null
            } catch {}
          } catch {}

          const quantize = (value: number, step: number | null): number => {
            if (!Number.isFinite(step as any) || (step as number) <= 0) return value
            const s = String(step)
            const idx = s.indexOf('.')
            const decimals = idx >= 0 ? (s.length - idx - 1) : 0
            const factor = Math.pow(10, decimals)
            return Math.round(value * factor) / factor
          }

          if (Number.isFinite(mark) && mark > 0) {
            const atrM5 = Number(marketData?.atr_m5)
            const minAtrBuf = Number.isFinite(atrM5) && atrM5 > 0 ? atrM5 * 0.15 : 0
            const minTickBuf = Number.isFinite(tickSize as any) && (tickSize as number) > 0 ? (tickSize as number) * 3 : 0
            const buffer = Math.max(minAtrBuf, minTickBuf)

            if (response.newSL < mark + buffer) {
              const unclamped = quantize(mark + buffer, tickSize)
              const currentSlCap = currentSlLive != null ? Number(currentSlLive) : null
              const corrected = currentSlCap != null ? Math.min(unclamped, currentSlCap) : unclamped
              console.warn('[STRATEGY_UPDATE_SL_VALIDATION_TRIGGER]', {
                symbol: entry.symbol,
                side: entry.side,
                proposedSL: response.newSL,
                markPrice: mark,
                buffer,
                tickSize,
                atrM5,
                currentSlLive,
                corrected
              })
              response.newSL = corrected
              console.info('[STRATEGY_UPDATE_SL_CORRECTED]', {
                symbol: entry.symbol,
                originalSL: response.newSL,
                correctedSL: corrected
              })
            }
          }
        }

        // 7. Execute the strategy update (create new orders, delete old)
        try { console.info('[STRATEGY_UPDATER_EXECUTE_CALL]', { symbol: entry.symbol, proposedSL: response.newSL, tp: response.tp_levels, confidence: response.confidence }) } catch {}
        const execResult = await executeStrategyUpdate(entry.symbol, response, entry)
        
        if (execResult.success) {
          // Success: maintain 1-minute cadence while position is open
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
        // Persist error snapshot for UI visibility (replaces processing_start)
        try {
          const fs = await import('node:fs')
          const path = await import('node:path')
          const dir = path.resolve('runtime/su_debug')
          try { fs.mkdirSync(dir, { recursive: true }) } catch {}
          const file = path.join(dir, `${entry.symbol}.json`)
          const blob = { ts: new Date().toISOString(), symbol: entry.symbol, status: 'process_error' as const, error: String((error as any)?.message || 'unknown_error') }
          fs.writeFileSync(file, JSON.stringify(blob, null, 2), 'utf8')
        } catch {}
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
