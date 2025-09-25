import WebSocket from 'ws'

type H1Bar = { openTime: number; closeTime: number; open: number; high: number; low: number; close: number; volume: number }

let ws: WebSocket | null = null
let connected = false
let subscribedSymbols: string[] = []
const barCache: Map<string, H1Bar> = new Map()

let dropsNoH1: string[] = []
let lastBackfillCount = 0

// Reconnect control: exponential backoff with jitter and global budget (IP safety)
let reconnectAttempts = 0
const FIVE_MIN_MS = 5 * 60 * 1000
;(globalThis as any).__ws_reconnect_times = Array.isArray((globalThis as any).__ws_reconnect_times) ? (globalThis as any).__ws_reconnect_times : []
function recordReconnectAttempt() {
  try {
    const list: number[] = (globalThis as any).__ws_reconnect_times
    const now = Date.now()
    while (list.length && (now - list[0]) > FIVE_MIN_MS) list.shift()
    list.push(now)
  } catch {}
}
function recentReconnects(): number {
  try { const list: number[] = (globalThis as any).__ws_reconnect_times; const now = Date.now(); while (list.length && (now - list[0]) > FIVE_MIN_MS) list.shift(); return list.length } catch { return 0 }
}
function scheduleReconnect(opts: { onBar?: (sym: string, bar: H1Bar) => void }) {
  recordReconnectAttempt()
  const budget = recentReconnects()
  // Base exp backoff up to 10s
  const exp = Math.min(10000, 500 * Math.pow(2, reconnectAttempts++))
  // If budget is high (>220 in 5min), slow down aggressively to protect 300/5min IP limit
  const slow = budget > 220 ? 60000 : 0
  const jitter = 200 + Math.floor(Math.random() * 300)
  const delay = slow || (exp + jitter)
  setTimeout(() => { ws = null as any; startAltH1Collector({ symbols: subscribedSymbols, onBar: opts.onBar }) }, delay)
}

export function reportBackfillMetrics(drops: string[], count: number) {
  dropsNoH1 = drops.slice(0)
  lastBackfillCount = count
}

function symbolToStream(sym: string): string {
  return `${sym.toLowerCase()}@kline_1h`
}

function subscribeAll(symbols: string[]) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const params = symbols.map(symbolToStream)
  if (params.length === 0) return
  const msg = { method: 'SUBSCRIBE', params, id: Date.now() }
  ws.send(JSON.stringify(msg))
}

export function updateAltSymbols(symbols: string[]) {
  subscribedSymbols = symbols.filter(s => s !== 'BTCUSDT' && s !== 'ETHUSDT')
  if (connected) subscribeAll(subscribedSymbols)
}

export function startAltH1Collector(opts: { symbols: string[]; onBar?: (sym: string, bar: H1Bar) => void }) {
  if (ws) {
    updateAltSymbols(opts.symbols)
    return
  }
  subscribedSymbols = opts.symbols.filter(s => s !== 'BTCUSDT' && s !== 'ETHUSDT')
  ws = new WebSocket('wss://fstream.binance.com/ws')
  ws.on('open', () => {
    connected = true
    reconnectAttempts = 0
    subscribeAll(subscribedSymbols)
  })
  ws.on('message', (data: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(String(data))
      const payload = msg?.data?.k ? msg.data : msg?.k ? msg : null
      if (!payload) return
      const k = payload.k
      if (k?.x === true) {
        const sym: string = String(k.s)
        const bar: H1Bar = {
          openTime: Number(k.t),
          closeTime: Number(k.T),
          open: Number(k.o),
          high: Number(k.h),
          low: Number(k.l),
          close: Number(k.c),
          volume: Number(k.v),
        }
        barCache.set(sym, bar)
        if (opts.onBar) opts.onBar(sym, bar)
      }
    } catch {}
  })
  ws.on('close', () => { connected = false; scheduleReconnect({ onBar: opts.onBar }) })
  ws.on('error', () => { try { ws?.close() } catch {}; scheduleReconnect({ onBar: opts.onBar }) })
}

export function getLastClosedH1(symbol: string): H1Bar | undefined {
  return barCache.get(symbol)
}

export function getStats() {
  const ready = Array.from(barCache.keys()).length
  return {
    altH1Subscribed: subscribedSymbols.length,
    altH1Ready: ready,
    drops_noH1: dropsNoH1,
    lastBackfillCount,
  }
}





