import WebSocket from 'ws'
import { RingBuffer, type Bar } from './ring'

type StreamsConfig = {
  coreSymbols: string[]
  altSymbols: string[]
}

export class WsCollector {
  private ws: WebSocket | null = null
  private rings: Map<string, RingBuffer> = new Map()
  private reconnectAttempts = 0
  private connected = false
  private altSet: Set<string> = new Set()
  constructor(private cfg: StreamsConfig, private capacity = 200) {
    this.altSet = new Set(cfg.altSymbols || [])
  }

  private streamNameFor(symbol: string, interval: string): string {
    return `${symbol.toLowerCase()}@kline_${interval}`
  }

  private buildUrl(): string {
    const streams: string[] = []
    for (const s of this.cfg.coreSymbols) {
      for (const itv of ['4h', '1h', '15m']) streams.push(this.streamNameFor(s, itv))
    }
    for (const s of this.cfg.altSymbols) {
      streams.push(this.streamNameFor(s, '1h'))
    }
    const path = streams.join('/')
    return `wss://fstream.binance.com/stream?streams=${path}`
  }

  start() {
    const url = this.buildUrl()
    this.ws = new WebSocket(url)
    this.ws.on('open', () => { 
      this.connected = true; 
      this.reconnectAttempts = 0
      // ensure subscriptions exist
      const params: string[] = []
      for (const s of this.cfg.coreSymbols) {
        for (const itv of ['4h','1h','15m']) params.push(this.streamNameFor(s, itv))
      }
      for (const s of this.altSet) params.push(this.streamNameFor(s, '1h'))
      if (params.length) this.send({ method: 'SUBSCRIBE', params, id: Date.now() })
    })
    this.ws.on('close', () => { this.connected = false; this.scheduleReconnect() })
    this.ws.on('error', () => { this.connected = false; this.scheduleReconnect() })
    this.ws.on('message', (data) => this.onMessage(data))
  }

  private send(obj: any) {
    try { this.ws?.send(JSON.stringify(obj)) } catch {}
  }

  setAltUniverse(symbols: string[]) {
    const next = new Set(symbols)
    const toSubscribe: string[] = []
    const toUnsubscribe: string[] = []
    for (const s of next) if (!this.altSet.has(s)) toSubscribe.push(this.streamNameFor(s, '1h'))
    for (const s of Array.from(this.altSet)) if (!next.has(s)) toUnsubscribe.push(this.streamNameFor(s, '1h'))
    if (toSubscribe.length) this.send({ method: 'SUBSCRIBE', params: toSubscribe, id: Date.now() })
    if (toUnsubscribe.length) this.send({ method: 'UNSUBSCRIBE', params: toUnsubscribe, id: Date.now() })
    this.altSet = next
  }

  private scheduleReconnect() {
    const delay = Math.min(5000, 500 * Math.pow(2, this.reconnectAttempts++))
    setTimeout(() => this.start(), delay)
  }

  private onMessage(data: WebSocket.RawData) {
    try {
      const msg = JSON.parse(String(data))
      const ev = msg?.data
      if (!ev || ev.e !== 'kline') return
      const k = ev.k
      if (!k?.x) return // only closed
      const symbol: string = String(ev.s)
      const interval: string = String(k.i)
      const key = `${symbol}:${interval}`
      let ring = this.rings.get(key)
      if (!ring) { ring = new RingBuffer(this.capacity); this.rings.set(key, ring) }
      const bar: Bar = {
        openTime: Number(k.t),
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        volume: Number(k.v)
      }
      ring.pushClosedBar(bar)
    } catch {}
  }

  getBars(symbol: string, interval: '4h'|'1h'|'15m', need: number): Bar[] {
    const key = `${symbol}:${interval}`
    const ring = this.rings.get(key)
    if (!ring) return []
    return ring.lastN(need)
  }

  health() {
    const out: Record<string, number | null> = {}
    const now = Date.now()
    for (const [key, ring] of this.rings.entries()) out[key] = ring.lastAgeMs(now)
    return { connected: this.connected, streams: this.rings.size, lastClosedAgeMsByKey: out }
  }

  ingestClosed(symbol: string, interval: '4h'|'1h'|'15m', bar: Bar) {
    const key = `${symbol}:${interval}`
    let ring = this.rings.get(key)
    if (!ring) { ring = new RingBuffer(this.capacity); this.rings.set(key, ring) }
    ring.pushClosedBar(bar)
  }
}


