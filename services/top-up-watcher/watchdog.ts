// ====================================================================
// DISABLED: Top-Up Watcher je natvrdo vypnutý - žere OpenAI kredity
// Timer není spuštěn nikde v server/index.ts
// ====================================================================

import { fetchWatcherSnapshot } from './fetch'
import { evaluateWatcherTick } from './logic'
import { emitWatcherEvent } from './events'
import { logWatcherTick } from './telemetry'
import {
  scheduleWatcher,
  getDueWatchers,
  updateWatcher,
  completeWatcher,
  removeWatcher,
  getWatcher
} from './registry'
import type { WatcherContext, WatcherEvent } from './types'

async function enqueueExecutorFromWatcher(payload: {
  symbol: string
  pilotEntryPrice: number
  pilotSize: number
  plannedTotalSize: number
  multiplier: number
  reason_code: string
  confidence: number
  snapshot_ts: string
  riskSnapshot?: Record<string, any>
}): Promise<void> {
  try {
    const mod = await import('../top-up-executor/trigger')
    if (typeof mod.enqueueFromWatcher === 'function') {
      mod.enqueueFromWatcher(payload)
    }
  } catch (err) {
    try { console.error('[TOPUP_WATCH_ENQUEUE_ERR]', payload.symbol, (err as any)?.message || err) } catch {}
  }
}

let ticking = false
let watcherEnabled = true
const runningSymbols = new Set<string>()
const fetchErrorCounts: Record<string, number> = {}

export function setWatcherEnabled(enabled: boolean): void {
  watcherEnabled = enabled
  if (!watcherEnabled) {
    ticking = false
    runningSymbols.clear()
  }
}

async function processEntry(symbol: string): Promise<void> {
  const entry = getWatcher(symbol)
  if (!entry || entry.status !== 'running') return
  if (runningSymbols.has(symbol)) return
  runningSymbols.add(symbol)

  try {
    if (!watcherEnabled) return
    const snapshot = await fetchWatcherSnapshot(symbol)
    fetchErrorCounts[symbol] = 0
    const decision = evaluateWatcherTick(entry, snapshot)
    logWatcherTick(entry, decision, snapshot)

    // Map legacy actions to candidate nomenclature for UI/AI
    const actionUi = (() => {
      if (decision.action === 'TOP_UP_ELIGIBLE') return 'TOP_UP_CANDIDATE'
      if (decision.action === 'ABORT_TOPUP') return 'ABORT_CANDIDATE'
      return 'HOLD'
    })()

    const mark = snapshot.indicators.markPrice
    const entryPx = entry.pilot.entry_price
    const size = entry.pilot.size
    const pnlPct = (() => {
      try { if (Number.isFinite(mark as any) && Number.isFinite(entryPx as any) && (entryPx as number) > 0) return ((mark as number) / (entryPx as number) - 1) * 100 } catch {}
      return null
    })()

    const event: any = {
      symbol,
      action: actionUi,
      reason_code: decision.reason_code,
      reasoning: decision.reasoning,
      confidence: decision.confidence,
      snapshot_ts: snapshot.timestamp,
      position: {
        entry: entryPx,
        currentPrice: mark ?? null,
        size: size,
        unrealizedPnlPct: pnlPct
      },
      indicators: {
        atr_m15: snapshot.indicators.atr_m15 ?? null,
        ema: { m5: { 20: snapshot.indicators.ema_m5[20] ?? null, 50: snapshot.indicators.ema_m5[50] ?? null } },
        vwap_m15: snapshot.indicators.vwap_m15 ?? null,
        rsi: { m5: snapshot.indicators.rsi_m5 ?? null, m15: snapshot.indicators.rsi_m15 ?? null },
        obi: { obi5: snapshot.orderbook?.obi5 ?? null, obi20: snapshot.orderbook?.obi20 ?? null },
        microprice: snapshot.orderbook?.micropriceBias ?? null
      },
      orderbook: {
        nearestBidWall: { price: snapshot.orderbook?.nearestBidWallPrice ?? null, consume3s_pct: snapshot.orderbook?.consumeBidWallPct3s ?? null },
        nearestAskWall: { price: snapshot.orderbook?.nearestAskWallPrice ?? null, consume3s_pct: snapshot.orderbook?.consumeAskWallPct3s ?? null },
        spread_bps: snapshot.market.spread_bps ?? null,
        estSlippageBps: snapshot.market.estSlippageBps ?? null
      },
      patterns: (() => {
        const arr: string[] = []
        try {
          if (decision.reason_code === 'ABSORB_CONFIRMED') arr.push('ABSORB_BID_RECLAIM')
          if (decision.reason_code === 'SPRING_RECLAIM_CONFIRMED') arr.push('SPRING_RECLAIM')
        } catch {}
        return arr
      })(),
      ttl_minutes_left: (() => { try { const d = Date.parse(entry.deadlineAt); return Number.isFinite(d) ? Math.max(0, Math.floor((d - Date.now())/60000)) : null } catch { return null } })()
    }
    await emitWatcherEvent(event as any)

    const nowIso = new Date().toISOString()
    const nowMs = Date.now()
    const deadlineMs = Date.parse(entry.deadlineAt)
    if (Number.isFinite(deadlineMs) && nowMs >= deadlineMs) {
      await emitWatcherEvent({
        symbol,
        action: 'HOLD',
        reason_code: 'TTL_EXPIRED',
        reasoning: 'ttl_expired_hold',
        confidence: 0.5,
        snapshot_ts: snapshot.timestamp
      } as any)
      updateWatcher(symbol, {
        lastTickAt: nowIso,
        nextRunAt: new Date(nowMs + Math.max(5000, (entry.limits.poll_interval_sec || 12) * 1000)).toISOString(),
        lastResult: 'HOLD' as any
      })
      return
    }
    const needDebounce = Math.max(1, entry.limits.debounce_required)
    if (decision.action === 'TOP_UP_ELIGIBLE') {
      const nextCount = entry.lastResult === 'TOP_UP_ELIGIBLE' ? entry.debounceCounter + 1 : 1
      if (nextCount >= needDebounce) {
        const multiplier = (() => {
          const explicit = Number(entry.plan?.planned_total_size) / (entry.pilot.size || 1)
          if (Number.isFinite(explicit) && explicit > 0) return explicit
          const envVal = Number(process.env.TOP_UP_MULTIPLIER)
          if (Number.isFinite(envVal) && envVal > 0) return envVal
          try {
            const cfgVal = Number(process.env.TOP_UP_MULTIPLIER_DEFAULT)
            if (Number.isFinite(cfgVal) && cfgVal > 0) return cfgVal
          } catch {}
          return 1
        })()
        const plannedTotal = Number(entry.plan?.planned_total_size || (entry.pilot.size * multiplier))
        await enqueueExecutorFromWatcher({
          symbol,
          pilotEntryPrice: entry.pilot.entry_price,
          pilotSize: entry.pilot.size,
          plannedTotalSize: entry.plan?.planned_total_size && entry.plan.planned_total_size > 0 ? entry.plan.planned_total_size : entry.pilot.size * multiplier,
          multiplier,
          reason_code: decision.reason_code,
          confidence: decision.confidence,
          snapshot_ts: snapshot.timestamp,
          riskSnapshot: decision.telemetry
        })
        completeWatcher(symbol)
        return
      }
      updateWatcher(symbol, {
        lastTickAt: nowIso,
        nextRunAt: new Date(Date.now() + entry.limits.poll_interval_sec * 1000).toISOString(),
        checks: entry.checks + 1,
        lastResult: 'TOP_UP_ELIGIBLE',
        debounceCounter: nextCount
      })
      return
    }
    if (decision.action === 'ABORT_TOPUP') {
      completeWatcher(symbol)
      return
    }

    const base = entry.limits.poll_interval_sec
    const jitter = entry.limits.poll_interval_jitter_sec
    const lo = Math.max(1, base - jitter)
    const hi = base + jitter
    const delaySec = lo + Math.random() * Math.max(1, hi - lo)
    const nextRunAt = new Date(Date.now() + delaySec * 1000).toISOString()

    updateWatcher(symbol, {
      lastTickAt: nowIso,
      nextRunAt,
      checks: entry.checks + 1,
      lastResult: decision.action,
      debounceCounter: 0
    })
  } catch (err) {
    const msg = (() => { try { return String((err as any)?.message || err) } catch { return 'unknown_error' } })()
    try { console.error('[TOPUP_WATCH_ERR]', symbol, msg) } catch {}
    try {
      await emitWatcherEvent({
        symbol,
        action: 'HOLD',
        reason_code: 'TECH_ERROR',
        reasoning: msg,
        confidence: 0.4,
        snapshot_ts: new Date().toISOString()
      } as any)
    } catch {}
    try {
      const entryNow = getWatcher(symbol)
      updateWatcher(symbol, {
        lastTickAt: new Date().toISOString(),
        nextRunAt: new Date(Date.now() + 15000).toISOString(),
        lastResult: 'HOLD' as any,
        debounceCounter: 0,
        checks: ((entryNow as any)?.checks || 0) + 1,
        lastError: msg as any
      })
    } catch {}
  }
  finally {
    runningSymbols.delete(symbol)
  }
}

async function tick(): Promise<void> {
  if (ticking || !watcherEnabled) {
    setTimeout(tick, 1200)
    return
  }
  ticking = true
  try {
    const due = getDueWatchers()
    for (const entry of due) {
      await processEntry(entry.symbol)
    }
  } finally {
    ticking = false
    setTimeout(tick, 1200)
  }
}

export function startTopUpWatcher(): void {
  syncWatcherEnabledFromEnv()
  setTimeout(tick, 1000)
}

export function syncWatcherEnabledFromEnv(): void {
  const env = String(process.env.TOPUP_WATCHER_ENABLED || '').toLowerCase()
  if (env) {
    watcherEnabled = env === '1' || env === 'true'
  } else {
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      const path = require('node:path') as typeof import('node:path')
      const file = path.resolve('config/top_up_watcher.json')
      if (fs.existsSync(file)) {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'))
        watcherEnabled = j?.enabled !== false
      }
    } catch {}
  }
}

export function stopWatcher(symbol: string): void {
  removeWatcher(symbol)
}
