// ====================================================================
// DISABLED: Entry Updater je natvrdo vypnutý - žere OpenAI kredity
// Timer je vypnutý v server/index.ts a tracking je zakázán v binance_futures.ts
// ====================================================================

import { getBinanceAPI } from '../trading/binance_futures'
import { getDueEntryOrders, reschedule, markTouchedRecently, setEntryStatus, untrackEntryOrder, trackEntryOrder } from './registry'
import { isAuditEnabled, appendAudit } from './audit'
import { runEntryUpdater } from './gpt_runner'
import type { EntryUpdaterInput } from './types'

function isEntryUpdaterEnabled(): boolean {
  try {
    const v = String(process.env.ENTRY_UPDATER_ENABLED || '').toLowerCase()
    if (v === '0' || v === 'false' || v === 'off') return false
    return true
  } catch { return true }
}

// Build fresh snapshot for one order (LIMIT SELL only for SHORT)
async function buildInputForOrder(order: any): Promise<EntryUpdaterInput | null> {
  try {
    const symbol = String(order?.symbol || '')
    const price = Number(order?.price || 0)
    const clientOrderId = String(order?.clientOrderId || '')
    const entryType = String(order?.type || '')
    const side = String(order?.side || '')
    // SHORT project: entry = SELL
    if (!symbol || side !== 'SELL' || entryType !== 'LIMIT') return null
    if (order?.reduceOnly || order?.closePosition) return null

    const api = getBinanceAPI() as any
    const [markPrice, filters, orderbook, m5, m15] = await Promise.all([
      api.getMarkPrice(symbol).catch(()=>null),
      api.getExchangeInfo(symbol).catch(()=>null),
      api.getOrderBook(symbol, 50).catch(()=>null),
      api.getKlines(symbol, '5m', 60).catch(()=>[]),
      api.getKlines(symbol, '15m', 60).catch(()=>[])
    ])

    const tickSize = Number(filters?.tickSize || 0)
    const stepSize = Number(filters?.stepSize || 0)
    const minNotional = Number(filters?.minNotional || 5)
    const nearestBidWall = Number(orderbook?.nearestBidWall || 0)
    const nearestAskWall = Number(orderbook?.nearestAskWall || 0)
    const obi5 = Number(orderbook?.obi5 || 0)
    const obi20 = Number(orderbook?.obi20 || 0)
    const micropriceBias = ((): 'bid'|'ask'|'neutral' => {
      const s = String(orderbook?.micropriceBias || '').toLowerCase()
      return s === 'bid' || s === 'ask' ? (s as any) : 'neutral'
    })()

    const atrM15 = Number(m15?.atr || 0)
    const ema5_20 = Number(m5?.ema20 || 0)
    const ema5_50 = Number(m5?.ema50 || 0)
    const ema15_20 = Number(m15?.ema20 || 0)
    const ema15_50 = Number(m15?.ema50 || 0)
    const vwap15 = Number(m15?.vwap || 0)
    const spread_bps = Number(orderbook?.spread_bps || 0)
    const estSlippageBps = Number(orderbook?.estSlippageBps || 0)

    const entryPrice = price
    const sl = Number(order?.stopPrice || 0) || null
    const tp_levels: Array<{ tag: 'tp1'|'tp2'|'tp3'; price: number; allocation_pct: number }> = []
    // We don't reconstruct TP trio here; reposition logic keeps deltas, TP refresh is delegated to LLM per prompt

    const input: EntryUpdaterInput = {
      spec_version: '1.0.0',
      symbol,
      snapshot_ts: new Date().toISOString(),
      asset_data: { tickSize, stepSize, minNotional },
      market_snapshot: {
        markPrice: Number(markPrice || 0),
        atr: { m15: atrM15 },
        ema: { m5: { 20: ema5_20, 50: ema5_50 }, m15: { 20: ema15_20, 50: ema15_50 } },
        vwap: { m15: vwap15 },
        orderbook: { nearestBidWall, nearestAskWall, obi5, obi20, micropriceBias },
        spread_bps,
        estSlippageBps
      },
      current_plan: {
        remaining_ratio: 1.0,
        entry: { type: 'limit', price: entryPrice },
        sl: sl || 0,
        tp_levels,
        order_created_at: new Date(Number(order?.time || Date.now())).toISOString(),
        current_touch_count: 0
      },
      fills: { tp_hits_count: 0, last_tp_hit_tag: null, realized_pct_of_initial: 0 },
      exchange_filters: { maxSlippagePct: Number(process.env.MAX_SLIPPAGE_PCT || 0.05) }
    }
    return input
  } catch {
    return null
  }
}

export async function processDueEntryUpdates(): Promise<void> {
  if (!isEntryUpdaterEnabled()) return
  try {
    const api = getBinanceAPI() as any
    const due = getDueEntryOrders()
    if (due.length === 0) return

    for (const rec of due) {
      try {
        // mark processing for UI
        try { setEntryStatus(rec.orderId, 'processing') } catch {}
        // Fetch live open order by id for freshness
        const orders = await api.getOpenOrders(rec.symbol)
        const order = (Array.isArray(orders) ? orders : []).find((o: any) => Number(o?.orderId || o?.orderID || 0) === rec.orderId)
        if (!order) { 
          try { untrackEntryOrder(rec.orderId) } catch {}
          try { setEntryStatus(rec.orderId, 'waiting') } catch {}
          continue 
        }

        const input = await buildInputForOrder(order)
        if (!input) { 
          reschedule(rec.orderId)
          try { setEntryStatus(rec.orderId, 'waiting') } catch {}
          continue 
        }

        // Risk Manager gate is applied inside the prompt rules; we keep runner pure
        const ai = await runEntryUpdater(input)
        // DEBUG/AUDIT: Při vypnutém audit logu zapiš aspoň základní záznam no_op/cancel/reposition
        if (!ai.ok || !ai.data) {
          reschedule(rec.orderId)
          try { setEntryStatus(rec.orderId, 'waiting') } catch {}
          if (isAuditEnabled()) appendAudit({ symbol: rec.symbol, phase: 'ai_failed', orderId: rec.orderId, code: ai.code })
          continue
        }

        const out = ai.data
        if (out.action === 'no_op') {
          markTouchedRecently(rec.orderId)
          reschedule(rec.orderId)
          if (isAuditEnabled()) appendAudit({ symbol: rec.symbol, phase: 'no_op', orderId: rec.orderId, reason_code: out.reason_code })
        } else if (out.action === 'cancel') {
          console.warn('[ENTRY_UPDATER_CANCEL_ORDER]', { 
            symbol: rec.symbol, 
            orderId: rec.orderId, 
            reason_code: out.reason_code,
            reasoning: (out as any)?.reasoning || 'N/A'
          })
          try { await api.cancelOrder(rec.symbol, rec.orderId) } catch {}
          if (isAuditEnabled()) appendAudit({ symbol: rec.symbol, phase: 'cancel', orderId: rec.orderId, reason_code: out.reason_code })
          try { untrackEntryOrder(rec.orderId) } catch {}
          try { setEntryStatus(rec.orderId, 'waiting') } catch {}
        } else if (out.action === 'reposition' && out.new_plan) {
          // Cancel and replace with new plan
          try { await api.cancelOrder(rec.symbol, rec.orderId) } catch {}
          const price = Number(out.new_plan.entry.price || 0)
          const qty = Number(order?.origQty || order?.origQuantity || order?.quantity || 0)
          const cid = `sv2_eu_${Date.now()}_${rec.symbol.toLowerCase()}`
          // SHORT: entry = SELL (opening short position)
          const placed = await api.placeOrder({ symbol: rec.symbol, side: 'SELL', type: 'LIMIT', price, quantity: qty, timeInForce: 'GTC', newClientOrderId: cid })
          markTouchedRecently(rec.orderId)
          try { untrackEntryOrder(rec.orderId) } catch {}
          try { const newId = Number((placed as any)?.orderId || 0); if (Number.isFinite(newId) && newId>0) trackEntryOrder({ symbol: rec.symbol, orderId: newId, clientOrderId: cid, entryPrice: price, sl: null, tpLevels: [] }) } catch {}
          reschedule(rec.orderId)
          if (isAuditEnabled()) appendAudit({ symbol: rec.symbol, phase: 'reposition', oldOrderId: rec.orderId, newEntry: price, reason_code: out.reason_code })
        }
        // mark waiting again after loop
        try { setEntryStatus(rec.orderId, 'waiting') } catch {}
      } catch (e) {
        try { console.error('[EU_PROCESS_ERR]', (e as any)?.message || e) } catch {}
        // safety: return to waiting state to avoid stuck processing
        try { setEntryStatus(rec.orderId, 'waiting') } catch {}
      }
    }
  } catch (e) {
    try { console.error('[EU_DUE_ERR]', (e as any)?.message || e) } catch {}
  }
}


