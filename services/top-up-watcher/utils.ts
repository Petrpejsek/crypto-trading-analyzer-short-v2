import type { WatcherContext, PilotPosition, TopUpPlan, TopUpLimits } from './types'
import { scheduleWatcher, isWatcherEnabled } from './registry'

const DEFAULT_LIMITS: TopUpLimits = {
  ttl_minutes: 45,
  debounce_required: 2,
  poll_interval_sec: 12,
  poll_interval_jitter_sec: 3
}

function getConfig(): any {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const file = path.resolve('config/top_up_watcher.json')
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    }
  } catch {}
  return {}
}

function normalizeSymbol(symbol: string): string {
  return String(symbol || '').toUpperCase()
}

function buildPilotPosition(position: any): PilotPosition | null {
  try {
    const entryPrice = Number(position?.entryPrice || position?.avgEntryPrice || position?.breakEvenPrice || 0)
    const size = Math.abs(Number(position?.positionAmt || position?.size || 0))
    if (!(entryPrice > 0) || !(size > 0)) return null
    const openedAt = new Date().toISOString()
    const tpLevels = Array.isArray(position?.tpLevels) ? position.tpLevels : []
    const anchor = Number(position?.anchorSupport || position?.support || 0)
    return {
      entry_price: entryPrice,
      size,
      sl: Number(position?.currentSL || position?.sl || 0) || 0,
      tp_levels: tpLevels.map((tp: any) => ({
        tag: String(tp?.tag || 'tp1') as 'tp1' | 'tp2' | 'tp3',
        price: Number(tp?.price || 0),
        allocation_pct: Number(tp?.allocation_pct || 0)
      })),
      opened_at: openedAt,
      anchor_support: Number.isFinite(anchor) && anchor > 0 ? anchor : null
    }
  } catch {
    return null
  }
}

export function scheduleTopUpWatchers(positions: any[]): void {
  try {
    if (!isWatcherEnabled()) {
      try { console.info('[TOPUP_SCHEDULE_CALL]', { enabled: false, count: Array.isArray(positions) ? positions.length : 0 }) } catch {}
      return
    }
    const cfg = getConfig()
    const minSize = Number(cfg?.minPilotSize ?? 0)
    const list = Array.isArray(positions) ? positions : []
    try { console.info('[TOPUP_SCHEDULE_CALL]', { enabled: true, count: list.length, minSize }) } catch {}
    for (const pos of list) {
      const symbol = normalizeSymbol(pos?.symbol)
      if (!symbol) continue
      const pilot = buildPilotPosition(pos)
      if (!pilot) {
        try { console.info('[TOPUP_SCHEDULE_SKIP]', { symbol, reason: 'no_pilot' }) } catch {}
        continue
      }
      if (pilot.size < minSize) {
        try { console.info('[TOPUP_SCHEDULE_SKIP]', { symbol, reason: 'below_min_size', size: pilot.size, minSize }) } catch {}
        continue
      }
      const plan: TopUpPlan = { planned_total_size: Number(pos?.plannedSize || pilot.size) }
      const limits = DEFAULT_LIMITS
      const context: WatcherContext = {
        symbol,
        pilot,
        plan,
        limits,
        maxSlippagePct: Number(process.env.MAX_SLIPPAGE_PCT || 0.05)
      }
      scheduleWatcher(context)
      try { console.info('[TOPUP_SCHEDULE_OK]', { symbol, size: pilot.size, entry: pilot.entry_price, planned_total_size: plan.planned_total_size }) } catch {}
    }
  } catch (err) {
    try { console.error('[TOPUP_UTIL_SCHEDULE_ERR]', (err as any)?.message || err) } catch {}
  }
}
