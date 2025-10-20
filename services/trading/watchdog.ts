import { fetchAllOpenOrders, fetchPositions } from './binance_futures'
import tradingCfg from '../../config/trading.json'
import { request as undiciRequest } from 'undici'

type WatchItem = { symbol: string; deadline: number; side: 'LONG'|'SHORT'|null }

const queue: WatchItem[] = []
const TICK_MS = 1000
const TIMEOUT_MS = 30_000  // 30 sekund - rychlé odhalení missing SL

export function scheduleWatch(symbol: string, side: 'LONG'|'SHORT'|null): void {
  const now = Date.now()
  queue.push({ symbol, deadline: now + TIMEOUT_MS, side })
}

async function cancelAllOpenOrders(symbol: string): Promise<void> {
  // OPRAVA: Ruš všechny ordery pouze pokud NENÍ pozice
  // Pokud je pozice, SL/TP se nesmí rušit!
  try {
    const qs = new URLSearchParams({ symbol }).toString()
    const url = `http://localhost:8888/__proxy/binance/cancelAllOpenOrders?${qs}`
    await undiciRequest(url, { method: 'DELETE' })
  } catch {}
}

async function reduceOnlyMarket(symbol: string, side: 'LONG'|'SHORT'): Promise<void> {
  try {
    const qs = new URLSearchParams({ symbol, side }).toString()
    const url = `http://localhost:8888/__proxy/binance/flatten?${qs}`
    await undiciRequest(url, { method: 'POST' })
  } catch {}
}

async function hasExitsForSymbol(openOrders: any[], symbol: string, hasPosition: boolean, position: any): Promise<boolean> {
  const bySym = openOrders.filter(o => String(o?.symbol||'') === symbol)
  
  // Detect position side for correct SL detection
  const positionAmt = Number(position?.positionAmt || 0)
  const isShort = positionAmt < 0
  const slSide = isShort ? 'BUY' : 'SELL'
  
  // For SHORT: look for BUY STOP orders
  const hasSL = bySym.some(o => {
    const side = String(o?.side || '')
    const type = String(o?.type || '')
    return side === slSide && type.includes('STOP')
  })
  
  const hasTPLimitReduceOnly = bySym.some(o => String(o?.type||'') === 'LIMIT' && o?.reduceOnly)
  const hasTPMarketCloseOnly = bySym.some(o => String(o?.type||'') === 'TAKE_PROFIT_MARKET' && (o?.closePosition || o?.reduceOnly))
  const hasAnyTP = hasTPLimitReduceOnly || hasTPMarketCloseOnly
  
  // Pokud je SL globálně vypnut, nevyžaduj SL a nevypisuj varování
  if (!((tradingCfg as any)?.DISABLE_SL === true)) {
    // KRITICKÁ OCHRANA: Pozice MUSÍ mít SL! Pokud ne, vytvořit emergency SL
    if (hasPosition && !hasSL) {
      console.error('[WATCHDOG_CRITICAL_MISSING_SL]', { symbol, hasPosition, hasSL, hasAnyTP, isShort })
      
      // Import and call emergency SL creation from server
      try {
        const { createEmergencySLFromWatchdog } = await import('../../server/index')
        await createEmergencySLFromWatchdog(symbol, position)
      } catch (err) {
        console.error('[WATCHDOG_EMERGENCY_SL_FAILED]', { symbol, error: String(err) })
      }
    }
  }
  
  // Policy:
  // - If we already have a position, require both SL and TP present
  // - If we do NOT have a position yet (pre-entry), accept SL-only as sufficient
  if ((tradingCfg as any)?.DISABLE_SL === true) {
    // Bez SL: pokud je pozice, stačí mít nějaký TP; pre-entry stačí žádný exit
    return hasPosition ? hasAnyTP : true
  }
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
        console.info('[WATCHDOG_CHECK]', { symbol: w.symbol, deadline: new Date(w.deadline).toISOString() })
        
        const [orders, positions] = await Promise.all([fetchAllOpenOrders(), fetchPositions()])
        const openOrders = Array.isArray(orders) ? orders : []
        const posList = Array.isArray(positions) ? positions : []
        const pos = posList.find(p => String(p?.symbol||'') === w.symbol && Math.abs(Number(p?.positionAmt || 0)) > 0) || null
        const exitsOk = await hasExitsForSymbol(openOrders, w.symbol, !!pos, pos)
        
        if (pos && !exitsOk) {
          // KRITICKÁ SITUACE: Máme pozici ale nemáme exits (SL/TP)
          // Emergency SL je již vytvořen v hasExitsForSymbol
          // Pouze flatten pozici jako poslední záchrana
          console.warn('[WATCHDOG_POSITION_WITHOUT_EXITS]', { 
            symbol: w.symbol, 
            positionAmt: pos?.positionAmt,
            action: 'flatten_last_resort' 
          })
          if (!w.side) throw new Error(`Missing side for watchdog ${w.symbol}`)
          await reduceOnlyMarket(w.symbol, w.side)
          console.warn('[WATCHDOG_EMERGENCY_FLATTEN]', { symbol: w.symbol, reason: 'position_without_exits' })
        } else if (!pos && !exitsOk) {
          // Žádná pozice, žádné exits → můžeme bezpečně zrušit všechny ordery
          await cancelAllOpenOrders(w.symbol)
          // eslint-disable-next-line no-console
          console.warn('[WATCHDOG_CANCEL_ENTRY]', w.symbol)
        } else {
          // eslint-disable-next-line no-console
          console.info('[WATCHDOG_OK]', { symbol: w.symbol, hasPosition: !!pos, exitsOk })
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


