import { fetchAllOpenOrders, fetchPositions } from './binance_futures'
import { request as undiciRequest } from 'undici'

type WatchItem = { symbol: string; deadline: number; side: 'LONG'|'SHORT'|null }

const queue: WatchItem[] = []
const TICK_MS = 1000
const TIMEOUT_MS = 20_000

export function scheduleWatch(symbol: string, side: 'LONG'|'SHORT'|null): void {
  const now = Date.now()
  queue.push({ symbol, deadline: now + TIMEOUT_MS, side })
}

async function cancelAllOpenOrders(symbol: string): Promise<void> {
  // direct REST call to avoid cyclic import; uses same env credentials via server
  try {
    const qs = new URLSearchParams({ symbol }).toString()
    const url = `http://localhost:8788/__proxy/binance/cancelAllOpenOrders?${qs}`
    await undiciRequest(url, { method: 'DELETE' })
  } catch {}
}

async function reduceOnlyMarket(symbol: string, side: 'LONG'|'SHORT'): Promise<void> {
  try {
    const qs = new URLSearchParams({ symbol, side }).toString()
    const url = `http://localhost:8788/__proxy/binance/flatten?${qs}`
    await undiciRequest(url, { method: 'POST' })
  } catch {}
}

function hasExitsForSymbol(openOrders: any[], symbol: string, hasPosition: boolean): boolean {
  const bySym = openOrders.filter(o => String(o?.symbol||'') === symbol)
  const hasSL = bySym.some(o => String(o?.type||'').startsWith('STOP'))
  const hasTPLimitReduceOnly = bySym.some(o => String(o?.type||'') === 'LIMIT' && o?.reduceOnly)
  const hasTPMarketCloseOnly = bySym.some(o => String(o?.type||'') === 'TAKE_PROFIT_MARKET' && (o?.closePosition || o?.reduceOnly))
  const hasAnyTP = hasTPLimitReduceOnly || hasTPMarketCloseOnly
  // Policy:
  // - If we already have a position, require both SL and TP present
  // - If we do NOT have a position yet (pre-entry), accept SL-only as sufficient
  return hasPosition ? (hasSL && hasAnyTP) : hasSL
}

export function startWatchdog(): void {
  let ticking = false
  const tick = async () => {
    if (ticking) return
    ticking = true
    const now = Date.now()
    const due = queue.splice(0, queue.length).filter(w => w.deadline <= now)
    const later = queue.filter(w => w.deadline > now)
    queue.length = 0
    queue.push(...later)
    for (const w of due) {
      try {
        const [orders, positions] = await Promise.all([fetchAllOpenOrders(), fetchPositions()])
        const openOrders = Array.isArray(orders) ? orders : []
        const posList = Array.isArray(positions) ? positions : []
        const pos = posList.find(p => String(p?.symbol||'') === w.symbol && Number(p?.size) > 0) || null
        const exitsOk = hasExitsForSymbol(openOrders, w.symbol, !!pos)
        if (pos && !exitsOk) {
          await reduceOnlyMarket(w.symbol, w.side || 'LONG')
          await cancelAllOpenOrders(w.symbol)
          // eslint-disable-next-line no-console
          console.warn('[WATCHDOG_FLATTEN]', w.symbol)
        } else if (!pos && !exitsOk) {
          await cancelAllOpenOrders(w.symbol)
          // eslint-disable-next-line no-console
          console.warn('[WATCHDOG_CANCEL_ENTRY]', w.symbol)
        } else {
          // eslint-disable-next-line no-console
          console.info('[WATCHDOG_OK]', w.symbol)
        }
      } catch (e:any) {
        // eslint-disable-next-line no-console
        console.error('[WATCHDOG_ERR]', w.symbol, e?.message)
      }
    }
    ticking = false
    setTimeout(tick, TICK_MS)
  }
  setTimeout(tick, TICK_MS)
}


