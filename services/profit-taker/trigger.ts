import { getBinanceAPI } from '../trading/binance_futures'
import { scheduleProfitTaker, rescheduleProfitTaker, getDueProfitTakers, markProcessing, markCompleted, markError, getProfitTakerList } from './registry'
import { fetchMarketDataForSymbol } from '../strategy-updater/strategy_updater_gpt'
import { runProfitTakerDecision } from './decision'
import { appendAudit, isAuditEnabled } from './audit'

export function getConfig(): any {
  try {
    const fs = require('node:fs')
    const path = require('node:path')
    const j = JSON.parse(fs.readFileSync(path.resolve('config/profit_taker.json'), 'utf8'))
    const env = String(process.env.PROFIT_TAKER_ENABLED || '').toLowerCase()
    const hasEnv = env.length > 0
    const envEnabled = env === '1' || env === 'true'
    const configExplicitFalse = j?.enabled === false
    const enabled = configExplicitFalse ? false : (hasEnv ? envEnabled : (j?.enabled !== false))
    return { ...j, enabled }
  } catch {
    const env = String(process.env.PROFIT_TAKER_ENABLED || '').toLowerCase()
    const enabled = env ? (env === '1' || env === 'true') : true
    return { intervalMinutes: 5, cooldownSec: 20, enabled }
  }
}

export function detectPositionForProfitTaker(orders: any[], positions: any[]): void {
  try {
    const cfg = getConfig()
    if (!cfg?.enabled) return
    const existing = new Set(getProfitTakerList().map((e: any) => e.symbol))
    for (const pos of (Array.isArray(positions) ? positions : [])) {
      try {
        const symbol = String(pos?.symbol || '')
        const amt = Number(pos?.positionAmt || pos?.size || 0)
        if (!symbol) continue
        if (amt > 0 && !existing.has(symbol)) {
          const entryPrice = Number(pos?.entryPrice || pos?.averagePrice || 0)
          const size = Math.abs(amt)
          if (entryPrice > 0 && size > 0) {
            scheduleProfitTaker(symbol, entryPrice, size, 5)
          }
        }
      } catch {}
    }
  } catch (e) {
    try { console.error('[PT_DETECT_ERR]', (e as any)?.message || e) } catch {}
  }
}

export async function processDueProfitTakers(): Promise<void> {
  const cfg = getConfig()
  if (!cfg?.enabled) return
  try {
    const dueAll = getDueProfitTakers()
    const maxConc = Math.max(1, Number(cfg?.maxConcurrentDecisions || 8))
    const due = dueAll.slice(0, maxConc)
    if (due.length === 0) return
    const api = getBinanceAPI()
    for (const e of due) {
      try {
        markProcessing(e.symbol)
        const marketData = await fetchMarketDataForSymbol(e.symbol)
        const positions = await api.getPositions()
        const pos = (Array.isArray(positions) ? positions : []).find((p: any) => String(p?.symbol) === e.symbol)
        const amt = Number(pos?.positionAmt || 0)
        if (!pos || !(amt > 0)) {
          // Nedestruktivně přeskoč – krátký cooldown + audit
          try { if (isAuditEnabled()) appendAudit({ id: `pt_${Date.now()}_${e.symbol}`, symbol: e.symbol, phase: 'cooldown_skip', rationale: 'position not visible in snapshot', ts: new Date().toISOString() }) } catch {}
          rescheduleProfitTaker(e.symbol, Math.min(2, Number(cfg.intervalMinutes || 5)))
          continue
        }
        const size = Math.abs(amt)
        const currentPrice = Number(marketData?.price || pos?.markPrice || 0)
        // Enrich with current SL/TP from open orders so AI understands our exits context
        let exits: { currentSL: number | null; currentTP: number | null } = { currentSL: null, currentTP: null }
        try {
          const oo = await api.getOpenOrders(e.symbol).catch(() => [])
          const toNum = (v: any): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null }
          const priceOf = (o: any): number | null => toNum((o && o.price) != null ? o.price : null)
          const stopOf = (o: any): number | null => toNum((o && o.stopPrice) != null ? o.stopPrice : null)
          const sell = Array.isArray(oo) ? oo.filter((o: any) => String(o?.side || '').toUpperCase() === 'SELL') : []
          const sls = sell.filter((o: any) => {
            const t = String(o?.type || '').toUpperCase()
            return t === 'STOP' || t === 'STOP_MARKET'
          })
          const tps = sell.filter((o: any) => {
            const t = String(o?.type || '').toUpperCase()
            return t === 'TAKE_PROFIT' || t === 'TAKE_PROFIT_MARKET'
          })
          const slCandidates: number[] = sls.map((o: any) => stopOf(o)).filter((n: any) => n != null) as number[]
          const tpCandidates: number[] = tps.map((o: any) => {
            const t = String(o?.type || '').toUpperCase()
            if (t === 'TAKE_PROFIT') return priceOf(o) ?? stopOf(o)
            return stopOf(o)
          }).filter((n: any) => n != null) as number[]
          if (slCandidates.length) {
            const cp = Number(currentPrice)
            exits.currentSL = Number.isFinite(cp) && cp > 0
              ? (slCandidates.filter(n => n <= cp).sort((a,b)=>b-a)[0] ?? slCandidates.sort((a,b)=>b-a)[0] ?? null)
              : (slCandidates.sort((a,b)=>b-a)[0] ?? null)
          }
          if (tpCandidates.length) {
            const cp = Number(currentPrice)
            exits.currentTP = Number.isFinite(cp) && cp > 0
              ? (tpCandidates.filter(n => n >= cp).sort((a,b)=>a-b)[0] ?? tpCandidates.sort((a,b)=>a-b)[0] ?? null)
              : (tpCandidates.sort((a,b)=>a-b)[0] ?? null)
          }
        } catch {}
        const sinceMs = new Date(e.since).getTime()
        const timeInPosSec = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000))
        const ctx = { cycle: Math.max(1, Number(e.cycleIndex || 1)), time_in_position_sec: timeInPosSec }
        const aiInput = { symbol: e.symbol, position: { size, entryPrice: e.entryPrice, currentPrice, unrealizedPnl: Number(pos?.unrealizedPnl || pos?.unRealizedProfit || 0) }, context: ctx, marketData, exits }
        const ai = await runProfitTakerDecision(aiInput)
        if (!ai.ok || !ai.data) {
          markError(e.symbol, ai.code || 'ai_failed')
          rescheduleProfitTaker(e.symbol, cfg.intervalMinutes || 5)
          if (isAuditEnabled()) appendAudit({ id: `pt_${Date.now()}_${e.symbol}`, symbol: e.symbol, phase: 'ai_failed', code: ai.code })
          continue
        }
        const decision = ai.data
        const pct = Number(decision.take_percent)
        if (decision.action === 'partial_take_profit' && pct > 0) {
          const execMeta = await executePartialReduceOnly(e.symbol, size, pct).catch(()=>null)
          if (isAuditEnabled()) appendAudit({ id: `pt_${Date.now()}_${e.symbol}`, symbol: e.symbol, phase: execMeta?.qty_sent ? 'executed' : 'no_op_below_step', take_percent: pct, rationale: decision.rationale, confidence: decision.confidence ?? null, qty_requested: execMeta?.qty_requested ?? null, qty_sent: execMeta?.qty_sent ?? null, position_size_before: execMeta?.pos_before ?? size, position_size_after: execMeta?.pos_after ?? null })
        } else {
          if (isAuditEnabled()) appendAudit({ id: `pt_${Date.now()}_${e.symbol}`, symbol: e.symbol, phase: 'skipped', take_percent: pct, rationale: decision.rationale, confidence: decision.confidence ?? null })
        }
        rescheduleProfitTaker(e.symbol, cfg.intervalMinutes || 5)
      } catch (err: any) {
        markError(e.symbol, err?.message || 'unknown_error')
        rescheduleProfitTaker(e.symbol, cfg.intervalMinutes || 5)
        try { if (isAuditEnabled()) appendAudit({ id: `pt_${Date.now()}_${e.symbol}`, symbol: e.symbol, phase: 'process_error', error: err?.message || String(err) }) } catch {}
      }
    }
  } catch (e) { try { console.error('[PT_PROCESS_ERR]', (e as any)?.message || e) } catch {} }
}

async function executePartialReduceOnly(symbol: string, positionSize: number, takePercent: number): Promise<{ qty_requested: number; qty_sent: number; pos_before: number; pos_after: number | null } | void> {
  const api = getBinanceAPI()
  const info = await api.getSymbolInfo(symbol)
  const lot = (info?.filters || []).find((f: any) => f?.filterType === 'LOT_SIZE')
  const stepSize = Number(lot?.stepSize || '0.001')
  const dec = countStepDecimals(stepSize)
  const rawQty = positionSize * Math.max(0, Math.min(100, takePercent)) / 100
  const floored = Math.floor(rawQty / stepSize) * stepSize
  const qty = Number(floored.toFixed(Number.isFinite(dec) ? dec : 3))
  const posBefore = Number.isFinite(positionSize) ? positionSize : NaN
  if (!(qty > 0)) {
    return { qty_requested: rawQty, qty_sent: 0, pos_before: posBefore, pos_after: null }
  }
  const params = { symbol, side: 'SELL' as const, type: 'MARKET' as const, quantity: String(qty), reduceOnly: true, newOrderRespType: 'RESULT' as const, __engine: 'profit_taker' }
  await api.placeOrder(params as any)
  let posAfter: number | null = null
  try {
    const positions = await api.getPositions()
    const p = (Array.isArray(positions) ? positions : []).find((pp: any) => String(pp?.symbol) === symbol)
    const amt = Number(p?.positionAmt)
    posAfter = Number.isFinite(amt) ? Math.abs(amt) : null
  } catch {}
  return { qty_requested: rawQty, qty_sent: qty, pos_before: posBefore, pos_after: posAfter }
}

const lastActionAtMs: Record<string, number> = {}
function countStepDecimals(step: number): number { const s = String(step); const idx = s.indexOf('.'); return idx >= 0 ? (s.length - idx - 1) : 0 }


