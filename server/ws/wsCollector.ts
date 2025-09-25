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
  private marks: Map<string, { price: number; updatedAt: number }> = new Map()
  // Throttled SUB/UNSUB batching to respect Binance 5 msgs/sec limit
  private pendingSubscribe: Set<string> = new Set()
  private pendingUnsubscribe: Set<string> = new Set()
  private flushTimer: NodeJS.Timeout | null = null
  private msgsThisSecond = 0
  private secondTickTimer: NodeJS.Timeout | null = null
  private readonly maxMsgsPerSecond = 4
  private readonly flushIntervalMs = 300
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
      streams.push(`${s.toLowerCase()}@markPrice@1s`)
    }
    for (const s of this.cfg.altSymbols) {
      streams.push(this.streamNameFor(s, '1h'))
      // We will subscribe 15m and markPrice dynamically on open via queue to keep URL shorter
    }
    const path = streams.join('/')
    return `wss://fstream.binance.com/stream?streams=${path}`
  }

  start() {
    const url = this.buildUrl()
    try { console.info('[WS_COLLECTOR_START]', { url }) } catch {}
    this.ws = new WebSocket(url)
    this.ws.on('open', () => { 
      try { console.info('[WS_COLLECTOR_OPEN]') } catch {}
      this.connected = true; 
      this.reconnectAttempts = 0
      // start second tick counter
      if (this.secondTickTimer) clearInterval(this.secondTickTimer)
      this.secondTickTimer = setInterval(() => { this.msgsThisSecond = 0 }, 1000)
      // ensure subscriptions exist (batch: core 4h/1h/15m + markPrice; alt 1h/15m + markPrice)
      const params: string[] = []
      for (const s of this.cfg.coreSymbols) {
        for (const itv of ['4h','1h','15m']) params.push(this.streamNameFor(s, itv))
        params.push(`${s.toLowerCase()}@markPrice@1s`)
      }
      for (const s of this.altSet) {
        params.push(this.streamNameFor(s, '1h'))
        params.push(this.streamNameFor(s, '15m'))
        params.push(`${s.toLowerCase()}@markPrice@1s`)
      }
      if (params.length) this.queueSubscribe(params)
    })
    this.ws.on('close', (code) => { 
      this.connected = false; 
      try { console.warn('[WS_COLLECTOR_CLOSE]', { code }) } catch {}
      this.cleanupTimers(); 
      this.scheduleReconnect() 
    })
    this.ws.on('error', (err) => { 
      this.connected = false; 
      try { console.error('[WS_COLLECTOR_ERROR]', (err as any)?.message || err) } catch {}
      this.cleanupTimers(); 
      this.scheduleReconnect() 
    })
    this.ws.on('message', (data) => this.onMessage(data))
  }

  private sendRaw(obj: any) {
    try { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)) } catch {}
  }

  private scheduleFlush() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flushQueues(), this.flushIntervalMs)
  }

  private flushQueues() {
    this.flushTimer = null
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const canSend = () => this.msgsThisSecond < this.maxMsgsPerSecond
    const drain = (method: 'SUBSCRIBE'|'UNSUBSCRIBE', set: Set<string>) => {
      if (!set.size) return
      if (!canSend()) { this.scheduleFlush(); return }
      const params = Array.from(set)
      set.clear()
      this.sendRaw({ method, params, id: Date.now() })
      this.msgsThisSecond += 1
    }
    // Prefer UNSUB first to quickly reduce stream load, then SUB
    drain('UNSUBSCRIBE', this.pendingUnsubscribe)
    drain('SUBSCRIBE', this.pendingSubscribe)
    if (this.pendingSubscribe.size || this.pendingUnsubscribe.size) this.scheduleFlush()
  }

  private queueSubscribe(streams: string[]) {
    for (const s of streams) {
      this.pendingSubscribe.add(s)
      this.pendingUnsubscribe.delete(s)
    }
    this.scheduleFlush()
  }

  private queueUnsubscribe(streams: string[]) {
    for (const s of streams) {
      this.pendingUnsubscribe.add(s)
      this.pendingSubscribe.delete(s)
    }
    this.scheduleFlush()
  }

  private cleanupTimers() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    if (this.secondTickTimer) { clearInterval(this.secondTickTimer); this.secondTickTimer = null }
  }

  setAltUniverse(symbols: string[]) {
    const next = new Set(symbols)
    const toSubscribe: string[] = []
    const toUnsubscribe: string[] = []
    for (const s of next) if (!this.altSet.has(s)) { toSubscribe.push(this.streamNameFor(s, '1h')); toSubscribe.push(this.streamNameFor(s, '15m')); toSubscribe.push(`${s.toLowerCase()}@markPrice@1s`) }
    for (const s of Array.from(this.altSet)) if (!next.has(s)) { toUnsubscribe.push(this.streamNameFor(s, '1h')); toUnsubscribe.push(this.streamNameFor(s, '15m')); toUnsubscribe.push(`${s.toLowerCase()}@markPrice@1s`) }
    if (toSubscribe.length) this.queueSubscribe(toSubscribe)
    if (toUnsubscribe.length) this.queueUnsubscribe(toUnsubscribe)
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
      if (!ev || !ev.e) return
      // KLINE closed bars
      if (ev.e === 'kline') {
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
        return
      }
      // Mark price updates
      if (ev.e === 'markPriceUpdate') {
        const symbol: string = String(ev.s || '')
        const p = Number(ev.p)
        if (symbol && Number.isFinite(p)) {
          this.marks.set(symbol, { price: p, updatedAt: Date.now() })
        }
        return
      }
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
    const wsOpen = (() => { try { return this.ws && this.ws.readyState === WebSocket.OPEN } catch { return false } })()
    return { connected: Boolean(wsOpen || this.connected), streams: this.rings.size, lastClosedAgeMsByKey: out }
  }

  ingestClosed(symbol: string, interval: '4h'|'1h'|'15m', bar: Bar) {
    const key = `${symbol}:${interval}`
    let ring = this.rings.get(key)
    if (!ring) { ring = new RingBuffer(this.capacity); this.rings.set(key, ring) }
    ring.pushClosedBar(bar)
  }

  getMarks(symbols?: string[]): Record<string, number> {
    const out: Record<string, number> = {}
    if (Array.isArray(symbols) && symbols.length > 0) {
      for (const s of symbols) {
        const rec = this.marks.get(s)
        if (rec && Number.isFinite(rec.price)) out[s] = rec.price
      }
    } else {
      for (const [s, rec] of this.marks.entries()) out[s] = rec.price
    }
    return out
  }
}


