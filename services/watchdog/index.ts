// Entry loop: interval, načtení pending orderů, mark/ATR, vyhodnocení, logy, in-memory cache posledních evaluací
// Shadow-only: nikdy neruší, pouze loguje a ukládá poslední evaluace do paměti

import { getOpenOrders, getMarks, getAtrH1 } from './adapters'
import { evaluate } from './rules'
import type { EvalRecord, OrderLite, WatchdogMode } from './types'

function envFlag(name: string, def = false): boolean {
  try { const v = String(process.env[name] || '').toLowerCase(); return v==='true'||v==='1'||v==='yes' } catch { return def }
}

function envNum(name: string, def: number): number { try { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def } catch { return def } }
function envStr(name: string, def: string): string { try { const v = process.env[name]; return (v && v.length) ? v : def } catch { return def } }

const WATCHDOG_ENABLED = envFlag('WATCHDOG_ENABLED', false)
const WATCHDOG_MODE = (envStr('WATCHDOG_MODE', 'shadow') as WatchdogMode)
const WATCHDOG_ALLOW_CANCEL = envFlag('WATCHDOG_ALLOW_CANCEL', false)
const WATCHDOG_INTERVAL_SEC = envNum('WATCHDOG_INTERVAL_SEC', 60)
const SESSION_CUTOFF_UTC = envStr('SESSION_CUTOFF_UTC', '21:00')
const DIVERGENCE_ATR_MULTIPLIER = Number.isFinite(Number(process.env.DIVERGENCE_ATR_MULTIPLIER)) ? Number(process.env.DIVERGENCE_ATR_MULTIPLIER) : 1.5

// in-memory ring buffer (globálně sdílený přes server)
const MAX_RECORDS = 200
;(globalThis as any).__watchdog_last_evals = Array.isArray((globalThis as any).__watchdog_last_evals) ? (globalThis as any).__watchdog_last_evals : []

function pushRecord(rec: EvalRecord) {
  const arr: EvalRecord[] = (globalThis as any).__watchdog_last_evals
  arr.push(rec)
  while (arr.length > MAX_RECORDS) arr.shift()
}

function nowISO(): string { return new Date().toISOString() }

async function oneCycle(): Promise<{ total: number; keep: number; counts: Record<string, number> } | void> {
  try {
    const orders: OrderLite[] = await getOpenOrders()
    if (!orders || orders.length === 0) {
      console.info(JSON.stringify({ level:'info', type:'WATCHDOG_EVAL_SUMMARY', ts: nowISO(), count: 0 }))
      return { total: 0, keep: 0, counts: {} }
    }
    const symbols = Array.from(new Set(orders.map(o => String(o.symbol||'')).filter(Boolean)))
    const [marks, atrs] = await Promise.all([ getMarks(symbols), getAtrH1(symbols) ])
    let cancelCandidates = 0
    let keepCount = 0
    const reasonCounts: Record<string, number> = {}
    for (const o of orders) {
      const tsMs = Number.isFinite(o.updateTime as any) ? Number(o.updateTime) : (Number.isFinite(o.time as any) ? Number(o.time) : null)
      const age_min = tsMs ? Math.max(0, Math.round((Date.now() - tsMs) / 60000)) : null
      const entry = (() => { const p = Number((o.price as any) ?? (o.stopPrice as any)); return Number.isFinite(p) ? p : null })()
      const mark = (() => { const m = marks[o.symbol]?.mark; return Number.isFinite(m as any) ? (m as number) : null })()
      const atr_h1_pct = (() => { const a = atrs[o.symbol]?.atr_h1_pct; return Number.isFinite(a as any) ? (a as number) : null })()
      const pDiff_pct = (Number.isFinite(entry as any) && Number.isFinite(mark as any) && (entry as number) > 0)
        ? (Math.abs((mark as number) - (entry as number)) / (entry as number)) * 100
        : null

      if (atr_h1_pct == null) {
        console.warn(JSON.stringify({ level:'warn', type:'WATCHDOG_SKIPPED_NO_ATR', ts: nowISO(), symbol: o.symbol, orderId: o.orderId }))
      }

      const decision = evaluate({
        type: String(o.type || ''),
        age_min: age_min,
        pDiff_pct: pDiff_pct,
        atr_h1_pct: atr_h1_pct,
        nowUTC: nowISO(),
        cutoffUTC: SESSION_CUTOFF_UTC,
        divergenceMultiplier: DIVERGENCE_ATR_MULTIPLIER
      })

      const wouldCancel = decision.action === 'cancel'
      if (wouldCancel) cancelCandidates++
      else keepCount++
      if (decision.reason) reasonCounts[decision.reason] = (reasonCounts[decision.reason] || 0) + (wouldCancel ? 1 : 0)

      const rec: EvalRecord = {
        tsISO: nowISO(),
        symbol: o.symbol,
        orderId: o.orderId,
        type: String(o.type||''),
        side: (o.side as any) || '',
        age_min: age_min,
        entry: entry,
        mark: mark,
        atr_h1_pct: atr_h1_pct,
        pDiff_pct: pDiff_pct,
        decision: wouldCancel ? 'WOULD_CANCEL' : 'KEEP',
        reason: (decision.reason as any) || null,
        mode: WATCHDOG_MODE
      }
      pushRecord(rec)
      console.info(JSON.stringify({
        type:'WATCHDOG_EVAL', ts: rec.tsISO, symbol: rec.symbol, orderId: rec.orderId,
        age_min: rec.age_min, entry: rec.entry, mark: rec.mark, atr_h1_pct: rec.atr_h1_pct, pDiff_pct: rec.pDiff_pct,
        action: wouldCancel ? 'WOULD_CANCEL' : 'KEEP', reason: rec.reason, mode: WATCHDOG_MODE,
        allowCancelFlag: WATCHDOG_ALLOW_CANCEL
      }))
    }
    console.info(JSON.stringify({ level:'info', type:'WATCHDOG_EVAL_SUMMARY', ts: nowISO(), count: orders.length, cancelCandidates, keepCount, reasons: reasonCounts }))
    return { total: orders.length, keep: keepCount, counts: reasonCounts }
  } catch (e: any) {
    console.error(JSON.stringify({ level:'error', type:'WATCHDOG_ERROR', ts: nowISO(), error: e?.message || 'unknown' }))
    ;(globalThis as any).__watchdog_meta = { ...(globalThis as any).__watchdog_meta, lastError: e?.message || 'unknown' }
  }
}

async function main() {
  // fail-fast na cutoff formát – rules.evaluate vyhodí pokud je špatně; otestujeme předem
  try { evaluate({ type:'LIMIT', age_min:0, pDiff_pct:0, atr_h1_pct:1, nowUTC: nowISO(), cutoffUTC: SESSION_CUTOFF_UTC, divergenceMultiplier: DIVERGENCE_ATR_MULTIPLIER }) }
  catch (e: any) { console.error(JSON.stringify({ level:'error', type:'WATCHDOG_ERROR', ts: nowISO(), error: 'SESSION_CUTOFF_UTC_invalid' })); return }

  if (!WATCHDOG_ENABLED) {
    console.info(JSON.stringify({ level:'info', type:'WATCHDOG_INFO', ts: nowISO(), message:'disabled' }))
    return
  }
  // immediate run then interval
  const t0 = Date.now()
  const r = await oneCycle()
  ;(globalThis as any).__watchdog_meta = { lastRunISO: nowISO(), lastRunDurationMs: Date.now() - t0, lastError: null }
  ;(globalThis as any).__watchdog_run_once = async () => {
    const t = Date.now(); const out = await oneCycle(); (globalThis as any).__watchdog_meta = { lastRunISO: new Date().toISOString(), lastRunDurationMs: Date.now() - t, lastError: null }; return out || { total: 0, keep: 0, counts: {} }
  }
  setInterval(async () => {
    const t = Date.now()
    await oneCycle()
    ;(globalThis as any).__watchdog_meta = { lastRunISO: nowISO(), lastRunDurationMs: Date.now() - t, lastError: null }
  }, Math.max(5, WATCHDOG_INTERVAL_SEC) * 1000)
}

main().catch(()=>{})



