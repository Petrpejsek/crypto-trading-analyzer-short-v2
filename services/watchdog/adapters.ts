import { fetch as undiciFetch } from 'undici'
import type { OrderLite } from './types'

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))

// Simple in-memory rate limit state for ATR fallback
let lastAtrCallAt = 0

export async function getOpenOrders(): Promise<OrderLite[]> {
  try {
    const r = await undiciFetch('http://localhost:8788/internal/binance/open-orders')
    if (!r.ok) {
      const code = r.status
      console.error(JSON.stringify({ level:'error', type:'WATCHDOG_ERROR', ts: new Date().toISOString(), error:`open_orders_http_${code}` }))
      return []
    }
    const j: any = await r.json().catch(()=>null)
    const items = Array.isArray(j?.items) ? j.items : []
    return items.map((o: any) => ({
      symbol: String(o?.symbol||''),
      orderId: o?.orderId,
      type: String(o?.type||''),
      side: String(o?.side||''),
      time: Number(o?.time||0),
      price: o?.price,
      stopPrice: o?.stopPrice
    }))
  } catch (e: any) {
    console.error(JSON.stringify({ level:'error', type:'WATCHDOG_ERROR', ts: new Date().toISOString(), error: e?.message || 'open_orders_fetch_failed' }))
    return []
  }
}

export async function getMarks(symbols: string[]): Promise<Record<string, { mark: number | null }>> {
  const out: Record<string, { mark: number | null }> = {}
  for (const s of symbols) out[s] = { mark: null }
  try {
    // Minimální batche: voláme náš /api/mark pro každý symbol; budoucí optimalizace = server batch endpoint
    await Promise.all(symbols.map(async (sym) => {
      try {
        const r = await undiciFetch(`http://localhost:8788/api/mark?symbol=${encodeURIComponent(sym)}`)
        if (!r.ok) return
        const j: any = await r.json().catch(()=>null)
        const mk = Number(j?.mark)
        out[sym] = { mark: Number.isFinite(mk) ? mk : null }
      } catch {}
    }))
  } catch {}
  return out
}

export async function getAtrH1(symbols: string[]): Promise<Record<string, { atr_h1_pct: number | null }>> {
  const out: Record<string, { atr_h1_pct: number | null }> = {}
  for (const s of symbols) out[s] = { atr_h1_pct: null }
  // Preferuj /api/intraday?symbol=SYMBOL (vrací atr_h1 v procentech v našem formátu)
  for (const sym of symbols) {
    try {
      const url = `http://localhost:8788/api/intraday?symbol=${encodeURIComponent(sym)}`
      const r = await undiciFetch(url)
      if (r.ok) {
        const j: any = await r.json().catch(()=>null)
        const assets = Array.isArray(j?.assets) ? j.assets : (Array.isArray(j?.coins) ? j.coins : [])
        const a = Array.isArray(assets) ? assets.find((x: any) => x?.symbol === sym) : null
        const atrPct = Number((a?.indicators?.atr_h1 ?? a?.atr?.h1))
        out[sym] = { atr_h1_pct: Number.isFinite(atrPct) ? atrPct : null }
        continue
      }
    } catch {}
    // Fallback: rate-limit 1 req/s – zde jen placeholder (bez dalšího volání), vrací null
    const now = Date.now()
    if (now - lastAtrCallAt < 1000) await sleep(1000 - (now - lastAtrCallAt))
    lastAtrCallAt = Date.now()
    out[sym] = { atr_h1_pct: null }
  }
  return out
}



