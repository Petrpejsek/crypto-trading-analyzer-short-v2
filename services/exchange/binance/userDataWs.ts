import WebSocket from 'ws'
import { fetch } from 'undici'

export type AuditFn = (evt: { type: 'cancel' | 'filled'; symbol: string; orderId?: number; side?: string | null; otype?: string | null; source: 'binance_ws'; reason?: string | null; payload?: any }) => void

interface StartOpts {
  audit: AuditFn
  apiKey?: string
  keepaliveMinutes?: number
}

// Module-level state (available to helpers)
const positions: Map<string, { symbol: string; positionAmt: number; entryPrice: number | null; positionSide: 'LONG'|'SHORT'|null; leverage: number | null; updatedAt: number }>
  = new Map()
const openOrdersById: Map<number, any> = new Map()
let hadAccountUpdate = false
let hadOrderUpdate = false

export function startBinanceUserDataWs(opts: StartOpts): void {
  const apiKey = opts.apiKey || process.env.BINANCE_API_KEY || ''
  if (!apiKey || apiKey.includes('mock')) return // no real keys, skip
  try { console.info('[USERDATA_WS_START]') } catch {}
  const keepaliveMs = Math.max(1, opts.keepaliveMinutes ?? 30) * 60 * 1000
  let listenKey: string | null = null
  let ws: WebSocket | null = null
  let refreshTimer: NodeJS.Timeout | null = null

  function parseAccountUpdate(msg: any) {
    try {
      const a = msg?.a
      if (!a) return
      const ps = Array.isArray(a?.P) ? a.P : []
      const now = Date.now()
      for (const p of ps) {
        const sym = String(p?.s || '')
        if (!sym) continue
        const pa = Number(p?.pa)
        const ep = Number(p?.ep)
        const psdRaw = String(p?.ps || '')
        const psd = psdRaw === 'LONG' ? 'LONG' : psdRaw === 'SHORT' ? 'SHORT' : null
        const lev = Number(p?.l || p?.leverage)
        positions.set(sym, {
          symbol: sym,
          positionAmt: Number.isFinite(pa) ? pa : 0,
          entryPrice: Number.isFinite(ep) ? ep : null,
          positionSide: psd,
          leverage: Number.isFinite(lev) ? lev : null,
          updatedAt: now
        })
      }
      hadAccountUpdate = true
    } catch {}
  }

  function upsertOrderFromUpdate(o: any) {
    try {
      const id = Number(o?.i)
      const sym = String(o?.s || '')
      if (!id || !sym) return
      const side = String(o?.S || '')
      const otype = String(o?.o || '')
      const price = Number(o?.p)
      const stopPrice = Number(o?.sp)
      const tif = String(o?.f || '')
      const reduceOnly = Boolean(o?.R ?? o?.reduceOnly ?? false)
      const closePosition = Boolean(o?.cp ?? o?.closePosition ?? false)
      const positionSideRaw = String(o?.ps || '')
      const positionSide = positionSideRaw === 'LONG' ? 'LONG' : positionSideRaw === 'SHORT' ? 'SHORT' : null
      const ts = Number(o?.T ?? o?.E ?? Date.now())
      const status = String(o?.X || '')
      const qty = Number(o?.q ?? o?.Q ?? o?.origQty)
      const obj = {
        orderId: id,
        symbol: sym,
        side,
        type: otype,
        qty: Number.isFinite(qty) ? qty : null,
        price: Number.isFinite(price) ? price : null,
        stopPrice: Number.isFinite(stopPrice) ? stopPrice : null,
        timeInForce: tif || null,
        reduceOnly,
        closePosition,
        positionSide,
        createdAt: null as string | null,
        updatedAt: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
        status
      }
      // Update or remove based on status
      if (status === 'NEW' || status === 'PARTIALLY_FILLED') {
        openOrdersById.set(id, obj)
      } else if (['FILLED','CANCELED','EXPIRED','REJECTED'].includes(status)) {
        openOrdersById.delete(id)
      } else {
        // generic update
        openOrdersById.set(id, obj)
      }
      hadOrderUpdate = true
    } catch {}
  }

  function handleOrderTradeUpdate(msg: any) {
    const o = msg?.o
    if (!o) return
    upsertOrderFromUpdate(o)
    try {
      const symbol = String(o?.s || '')
      const status = String(o?.X || '')
      const orderId = Number(o?.i || 0)
      const side = String(o?.S || '')
      const otype = String(o?.o || '')
      if (symbol) {
        if (status === 'CANCELED' || status === 'EXPIRED') {
          opts.audit({ type: 'cancel', symbol, orderId, side, otype, source: 'binance_ws', reason: status.toLowerCase(), payload: o })
        } else if (status === 'FILLED' || status === 'TRADE') {
          opts.audit({ type: 'filled', symbol, orderId, side, otype, source: 'binance_ws', reason: null, payload: o })
        }
      }
    } catch {}
  }

  const fetchListenKey = async (): Promise<string | null> => {
    try {
      const res = await fetch('https://fapi.binance.com/fapi/v1/listenKey', { method: 'POST', headers: { 'X-MBX-APIKEY': apiKey } })
      const j: any = await res.json()
      return j?.listenKey || null
    } catch { return null }
  }
  const keepAlive = async () => {
    if (!listenKey) return
    try { await fetch(`https://fapi.binance.com/fapi/v1/listenKey?listenKey=${listenKey}`, { method: 'PUT', headers: { 'X-MBX-APIKEY': apiKey } }) } catch {}
  }
  const scheduleKeepAlive = () => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = setInterval(() => { keepAlive().catch(()=>{}) }, keepaliveMs)
  }
  const connectWs = async () => {
    listenKey = await fetchListenKey()
    if (!listenKey) { try { console.error('[USERDATA_WS_LISTENKEY_FAIL]') } catch {}; setTimeout(connectWs, 5000); return }
    scheduleKeepAlive()
    const url = `wss://fstream.binance.com/ws/${listenKey}`
    try { console.info('[USERDATA_WS_CONNECT]', { url_end: url.slice(-8) }) } catch {}
    ws = new WebSocket(url)
    ws.on('open', () => { try { console.info('[USERDATA_WS_OPEN]') } catch {} })
    ws.on('close', (code) => { try { console.warn('[USERDATA_WS_CLOSE]', { code }) } catch {}; reconnect() })
    ws.on('error', (e) => { try { console.error('[USERDATA_WS_ERROR]', (e as any)?.message || e) } catch {}; reconnect() })
    ws.on('message', (data) => { handleMessage(String(data)) })
  }
  const reconnect = () => {
    try { ws?.close() } catch {}
    ws = null
    setTimeout(connectWs, 3000)
  }
  const handleMessage = (raw: string) => {
    try {
      const msg = JSON.parse(raw)
      const ev = String(msg?.e || '')
      if (ev === 'ACCOUNT_UPDATE') {
        parseAccountUpdate(msg)
      } else if (ev === 'ORDER_TRADE_UPDATE') {
        handleOrderTradeUpdate(msg)
      }
    } catch {}
  }
  connectWs()
}

// Public accessors for server
export function getPositionsInMemory(): Array<{ symbol: string; positionAmt: number; entryPrice: number | null; positionSide: 'LONG'|'SHORT'|null; leverage: number | null; updatedAt: number }> {
  return Array.from(positions.values())
}
export function getOpenOrdersInMemory(): Array<any> {
  return Array.from(openOrdersById.values())
}
export function isUserDataReady(kind: 'positions' | 'orders' | 'any' = 'any'): boolean {
  if (kind === 'positions') return hadAccountUpdate
  if (kind === 'orders') return hadOrderUpdate
  return hadAccountUpdate || hadOrderUpdate
}
