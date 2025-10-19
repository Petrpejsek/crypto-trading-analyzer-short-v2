import { getBinanceAPI } from '../trading/binance_futures'
import { fetchMarketDataForSymbol } from '../strategy-updater/strategy_updater_gpt'
import {
  scheduleTopUpExecutor,
  rescheduleTopUpExecutor,
  getDueTopUpExecutors,
  markProcessing,
  markCompleted,
  markError,
  incrementTopUps,
  getTopUpExecutorList
} from './registry'
import { runTopUpExecutorDecision } from './decision'
import { appendAudit, isAuditEnabled } from './audit'

export function getConfig(): any {
  try {
    const fs = require('node:fs')
    const path = require('node:path')
    const j = JSON.parse(fs.readFileSync(path.resolve('config/top_up_executor.json'), 'utf8'))
    const env = String(process.env.TOP_UP_EXECUTOR_ENABLED || '').toLowerCase()
    const hasEnv = env.length > 0
    const envEnabled = env === '1' || env === 'true'
    const configExplicitFalse = j?.enabled === false
    const enabled = configExplicitFalse ? false : (hasEnv ? envEnabled : (j?.enabled !== false))
    return { ...j, enabled }
  } catch {
    const env = String(process.env.TOP_UP_EXECUTOR_ENABLED || '').toLowerCase()
    const enabled = env ? (env === '1' || env === 'true') : true
    return { intervalMinutes: 2, cooldownSec: 15, enabled }
  }
}

type WatcherSignal = {
  symbol: string
  pilotEntryPrice: number
  pilotSize: number
  plannedTotalSize: number
  multiplier: number
  reason_code: string
  confidence: number
  snapshot_ts: string
  riskSnapshot?: Record<string, any>
}

export function enqueueFromWatcher(signal: WatcherSignal): void {
  try {
    const cfg = getConfig()
    if (!cfg?.enabled) return
    scheduleTopUpExecutor(signal.symbol, {
      pilotEntryPrice: signal.pilotEntryPrice,
      pilotSize: signal.pilotSize,
      multiplier: signal.multiplier,
      plannedTotalSize: signal.plannedTotalSize,
      initialDelaySec: cfg?.cooldownSec ?? 15,
      watcherReasonCode: signal.reason_code,
      watcherConfidence: signal.confidence
    })
  } catch (e) {
    try { console.error('[TOPUP_EXEC_ENQUEUE_ERR]', (e as any)?.message || e) } catch {}
  }
}

export async function processDueTopUpExecutors(): Promise<void> {
  const cfg = getConfig()
  if (!cfg?.enabled) return
  try {
    const dueAll = getDueTopUpExecutors()
    const maxConc = Math.max(1, Number(cfg?.maxConcurrentDecisions || 4))
    const due = dueAll.slice(0, maxConc)
    if (due.length === 0) return
    const api = getBinanceAPI()
    for (const entry of due) {
      try {
        markProcessing(entry.symbol)
        const marketData = await fetchMarketDataForSymbol(entry.symbol)
        const positions = await api.getPositions()
        const pos = (Array.isArray(positions) ? positions : []).find((p: any) => String(p?.symbol) === entry.symbol)
        const amt = Number(pos?.positionAmt || 0)
        // SHORT: positionAmt is NEGATIVE
        if (!pos || !(amt < 0)) {
          if (isAuditEnabled()) appendAudit({ id: `tup_${Date.now()}_${entry.symbol}`, symbol: entry.symbol, phase: 'cooldown_skip', rationale: 'position not visible in snapshot', ts: new Date().toISOString() })
          rescheduleTopUpExecutor(entry.symbol, Math.min(120, Number(cfg?.intervalMinutes || 2) * 60))
          continue
        }

        const topUpsAlreadySent = Number(entry.topUpsEmitted || 0)
        const existingSize = Math.abs(amt)
        const totalTargetSize = Number(entry.plannedTotalSize || existingSize)
        const multiplier = Number(entry.multiplier || 1)
        const desiredSize = existingSize * multiplier
        const maxSize = Math.max(existingSize, totalTargetSize)
        const cappedTarget = Math.min(desiredSize, maxSize)
        const sizeRemaining = Math.max(0, cappedTarget - existingSize)

        const ttlMinutesLeft = Math.max(0, Math.floor((new Date(entry.since).getTime() + (cfg?.ttlMinutes || 45) * 60000 - Date.now()) / 60000))

        // Derive current exits (SL/TP) from open orders for richer AI context
        let exits: { currentSL: number | null; currentTP: number | null } = { currentSL: null, currentTP: null }
        try {
          const oo = await api.getOpenOrders(entry.symbol).catch(() => [])
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
          const cp = Number(marketData?.price || pos?.markPrice || 0)
          if (slCandidates.length) {
            exits.currentSL = Number.isFinite(cp) && cp > 0
              ? (slCandidates.filter(n => n <= cp).sort((a,b)=>b-a)[0] ?? slCandidates.sort((a,b)=>b-a)[0] ?? null)
              : (slCandidates.sort((a,b)=>b-a)[0] ?? null)
          }
          if (tpCandidates.length) {
            exits.currentTP = Number.isFinite(cp) && cp > 0
              ? (tpCandidates.filter(n => n >= cp).sort((a,b)=>a-b)[0] ?? tpCandidates.sort((a,b)=>a-b)[0] ?? null)
              : (tpCandidates.sort((a,b)=>a-b)[0] ?? null)
          }
        } catch {}

        // Leverage and cost context
        const lev = Number(pos?.leverage)
        const avgEntry = Number(pos?.entryPrice)
        const positionNotional = (Number.isFinite(avgEntry) && avgEntry > 0) ? (existingSize * avgEntry) : null
        const marginUsd = (Number.isFinite(positionNotional as any) && Number.isFinite(lev) && lev > 0) ? ((positionNotional as number) / lev) : null

        const aiInput = {
          symbol: entry.symbol,
          pilot: {
            size: existingSize,
            entryPrice: entry.pilotEntryPrice,
            avgEntryPrice: Number.isFinite(avgEntry) && avgEntry > 0 ? avgEntry : entry.pilotEntryPrice,
            markPrice: Number(marketData?.price || pos?.markPrice || 0),
            sl: exits.currentSL ?? (Number(pos?.liquidationPrice || pos?.stopLoss || 0) || null),
            tpLevels: Array.isArray((pos as any)?.tpLevels) ? (pos as any).tpLevels : [],
            openedAt: entry.since,
            leverage: Number.isFinite(lev) && lev > 0 ? Math.floor(lev) : null,
            positionNotional: Number.isFinite(positionNotional as any) ? (positionNotional as number) : null,
            marginUsd: Number.isFinite(marginUsd as any) ? (marginUsd as number) : null
          },
          plan: {
            plannedTotalSize: totalTargetSize,
            multiplier,
            desiredSize,
            sizeRemaining
          },
          exits,
          watcherEvent: {
            reason_code: entry.watcherReasonCode ?? 'UNKNOWN',
            confidence: entry.watcherConfidence ?? null,
            snapshot_ts: new Date().toISOString()
          },
          marketData,
          context: {
            cycle: Math.max(1, Number(entry.cycleIndex || 1)),
            ttl_minutes_left: ttlMinutesLeft,
            time_in_position_sec: Math.max(0, Math.floor((Date.now() - new Date(entry.since).getTime()) / 1000)),
            topUpsAlreadySent
          }
        }

        const decision = await runTopUpExecutorDecision(aiInput)
        if (!decision.ok || !decision.data) {
          markError(entry.symbol, decision.code || 'ai_failed')
          rescheduleTopUpExecutor(entry.symbol, Math.min(600, Number(cfg?.intervalMinutes || 2) * 60))
          if (isAuditEnabled()) appendAudit({ id: `tup_${Date.now()}_${entry.symbol}`, symbol: entry.symbol, phase: 'ai_failed', code: decision.code })
          continue
        }

        const result = decision.data
        const ratio = Number(result.top_up_ratio || 0)
        const sizeToBuy = Number(result.top_up_size || (ratio > 0 ? existingSize * ratio : 0))

        if (result.action === 'top_up' && sizeToBuy > 0) {
          const execMeta = await placeTopUpOrder(entry.symbol, sizeToBuy, result.limit_price ?? null).catch(() => null)
          incrementTopUps(entry.symbol)
          if (isAuditEnabled()) appendAudit({ id: `tup_${Date.now()}_${entry.symbol}`, symbol: entry.symbol, phase: execMeta?.qty_sent ? 'executed' : 'no_op_below_step', top_up_ratio: ratio, top_up_size: sizeToBuy, rationale: result.rationale, confidence: result.confidence ?? null, qty_requested: execMeta?.qty_requested ?? null, qty_sent: execMeta?.qty_sent ?? null, position_size_before: execMeta?.pos_before ?? existingSize, position_size_after: execMeta?.pos_after ?? null, watcher_reason_code: entry.watcherReasonCode, watcher_confidence: entry.watcherConfidence })
        } else if (result.action === 'abort') {
          markCompleted(entry.symbol)
          if (isAuditEnabled()) appendAudit({ id: `tup_${Date.now()}_${entry.symbol}`, symbol: entry.symbol, phase: 'aborted', rationale: result.rationale, confidence: result.confidence ?? null, watcher_reason_code: entry.watcherReasonCode, watcher_confidence: entry.watcherConfidence })
          continue
        } else {
          if (isAuditEnabled()) appendAudit({ id: `tup_${Date.now()}_${entry.symbol}`, symbol: entry.symbol, phase: 'skipped', rationale: result.rationale, confidence: result.confidence ?? null })
        }

        rescheduleTopUpExecutor(entry.symbol, Number(cfg?.intervalMinutes || 2) * 60)
      } catch (err: any) {
        markError(entry.symbol, err?.message || 'unknown_error')
        rescheduleTopUpExecutor(entry.symbol, Number(cfg?.intervalMinutes || 2) * 60)
        try { if (isAuditEnabled()) appendAudit({ id: `tup_${Date.now()}_${entry.symbol}`, symbol: entry.symbol, phase: 'process_error', error: err?.message || String(err) }) } catch {}
      }
    }
  } catch (e) {
    try { console.error('[TOPUP_EXEC_PROCESS_ERR]', (e as any)?.message || e) } catch {}
  }
}

async function placeTopUpOrder(symbol: string, quantity: number, limitPrice: number | null): Promise<{ qty_requested: number; qty_sent: number; pos_before: number; pos_after: number | null }> {
  const api = getBinanceAPI()
  const info = await api.getSymbolInfo(symbol)
  const lot = (info?.filters || []).find((f: any) => f?.filterType === 'LOT_SIZE')
  const stepSize = Number(lot?.stepSize || '0.001')
  const dec = countStepDecimals(stepSize)
  const rawQty = quantity
  const floored = Math.floor(rawQty / stepSize) * stepSize
  const qty = Number(floored.toFixed(Number.isFinite(dec) ? dec : 3))
  const positions = await api.getPositions()
  const pos = (Array.isArray(positions) ? positions : []).find((p: any) => String(p?.symbol) === symbol)
  const posBefore = Number.isFinite(pos?.positionAmt) ? Math.abs(Number(pos?.positionAmt)) : NaN
  if (!(qty > 0)) {
    return { qty_requested: rawQty, qty_sent: 0, pos_before: posBefore, pos_after: null }
  }

  // SHORT: Top-up = SELL (adding to short position)
  const params = {
    symbol,
    side: 'SELL' as const,
    type: limitPrice ? 'LIMIT' as const : 'MARKET' as const,
    quantity: String(qty),
    reduceOnly: false,
    newOrderRespType: 'RESULT' as const,
    timeInForce: limitPrice ? 'GTC' as const : undefined,
    price: limitPrice ? String(limitPrice) : undefined,
    __engine: 'top_up_executor'
  }
  await api.placeOrder(params as any)
  let posAfter: number | null = null
  try {
    const updatedPositions = await api.getPositions()
    const updated = (Array.isArray(updatedPositions) ? updatedPositions : []).find((p: any) => String(p?.symbol) === symbol)
    const amt = Number(updated?.positionAmt)
    posAfter = Number.isFinite(amt) ? Math.abs(amt) : null
  } catch {}
  return { qty_requested: rawQty, qty_sent: qty, pos_before: posBefore, pos_after: posAfter }
}

function countStepDecimals(step: number): number {
  const s = String(step)
  const idx = s.indexOf('.')
  return idx >= 0 ? (s.length - idx - 1) : 0
}

export function getTopUpExecutorStatus(): { enabled: boolean; entries: any[] } {
  const cfg = getConfig()
  return { enabled: Boolean(cfg?.enabled), entries: getTopUpExecutorList() }
}
