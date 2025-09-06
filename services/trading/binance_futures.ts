import crypto from 'crypto'
import fs from 'node:fs'
import path from 'node:path'
import tradingCfg from '../../config/trading.json'
import { wrapBinanceFuturesApi } from '../exchange/binance/safeSender'
import { noteApiCall, setBanUntilMs } from '../../server/lib/rateLimits'

// SAFE_BOOT log pro identifikaci procesu
console.log('[SAFE_BOOT]', { pid: process.pid, file: __filename })

export interface OrderParams {
  symbol: string
  side: 'BUY' | 'SELL'
  type: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP' | 'TAKE_PROFIT' | 'TAKE_PROFIT_MARKET'
  quantity?: string
  price?: string
  stopPrice?: string
  timeInForce?: 'GTC' | 'IOC' | 'FOK'
  leverage?: number
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE'
  closePosition?: boolean
  positionSide?: 'LONG' | 'SHORT'
  reduceOnly?: boolean
  newClientOrderId?: string
  newOrderRespType?: 'ACK' | 'RESULT'
  __engine?: string // For debugging
}

export interface PlaceOrdersRequest {
  orders: Array<{
    symbol: string
    side: 'LONG' | 'SHORT'
    strategy: 'conservative' | 'aggressive'
    tpLevel: 'tp1' | 'tp2' | 'tp3'
    orderType?: 'market' | 'limit' | 'stop' | 'stop_limit'
    amount: number // USD amount to invest
    leverage: number
    useBuffer: boolean
    bufferPercent?: number
    entry?: number
    sl: number
    tp: number
  }>
}

class BinanceFuturesAPI {
  private apiKey: string
  private secretKey: string
  private baseURL = 'https://fapi.binance.com'

  constructor() {
    this.apiKey = process.env.BINANCE_API_KEY || 'mock_api_key'
    this.secretKey = process.env.BINANCE_SECRET_KEY || 'mock_secret_key'
    
    // In production, uncomment this check:
    // if (!this.apiKey || !this.secretKey) {
    //   throw new Error('Missing Binance API credentials')
    // }
  }

  private sign(queryString: string): string {
    return crypto
      .createHmac('sha256', this.secretKey)
      .update(queryString)
      .digest('hex')
  }

  private async request(method: string, endpoint: string, params: Record<string, any> = {}): Promise<any> {

    const timestamp = Date.now()
    // Last-mile global sanitization for all order-sending endpoints
    try {
      const methodUp = String(method || '').toUpperCase()
      const isOrderPost = methodUp === 'POST' && (endpoint === '/fapi/v1/order' || endpoint === '/fapi/v1/batchOrders')
      if (isOrderPost) {
        const raw = ((tradingCfg as any)?.RAW_PASSTHROUGH === true)
        if (raw) {
          // V RAW režimu nesahejte na parametry – pouze log a pošli dál
          try {
            console.info('[RAW_OUTGOING_ORDER]', {
              engine: String((params as any)?.__engine || 'unknown'),
              symbol: String((params as any)?.symbol),
              side: String((params as any)?.side),
              type: String((params as any)?.type),
              price: (params as any)?.price ?? null,
              stopPrice: (params as any)?.stopPrice ?? null,
              reduceOnly: (params as any)?.reduceOnly === true,
              closePosition: (params as any)?.closePosition === true
            })
          } catch {}
          // žádná sanitizace, žádný whitelist
        } else {
        const safeMode = ((tradingCfg as any)?.SAFE_MODE_LONG_ONLY === true)
        // === LAST-MILE SANITIZE (nutné vložit těsně před HTTP volání) ===
        const cpAllowed = (t: string) => t === 'STOP_MARKET' || t === 'TAKE_PROFIT_MARKET'

        const forceMarketTP = (o: any) => {
          if (!o || typeof o !== 'object') return o
          const engineTag = (()=>{ try { return String(o.__engine || params.__engine || 'unknown') } catch { return 'unknown' } })()
          
          // DEBUG: Co přichází do sanitizace
          try { console.error('[DEBUG_SANITIZE_IN]', { symbol: o.symbol, type: o.type, closePosition: o.closePosition, reduceOnly: o.reduceOnly }) } catch {}
          
          // (removed legacy test injector)
          
          // 1) SANITIZACE TP: pokud je LIMIT_ON_FILL nebo je přítomná quantity+reduceOnly, nepřevádět na MARKET
          const tpModeCfg = ((tradingCfg as any)?.TP_MODE === 'LIMIT_ON_FILL')
          if (o?.type === 'TAKE_PROFIT') {
            const hasQtyReduceOnly = !!o?.quantity && o?.reduceOnly === true
            if (tpModeCfg || hasQtyReduceOnly) {
              // Ujisti se o konzistenci LIMIT TP
              o.closePosition = false
              o.timeInForce = o.timeInForce || 'GTC'
              if (!o.price && o.stopPrice) o.price = o.stopPrice
              if (!o.stopPrice && o.price) o.stopPrice = o.price
            } else if (o?.closePosition === true) {
              console.error('[EMERGENCY_TP_CONVERSION]', { symbol: o.symbol, converting: 'TAKE_PROFIT_closePosition_true_to_MARKET' })
              o.type = 'TAKE_PROFIT_MARKET'
              o.stopPrice = o.stopPrice ?? o.price
              delete o.price
              delete o.timeInForce
              delete o.quantity
              o.side = 'SELL'
              o.closePosition = true
              o.workingType = 'MARK_PRICE'
            }
          }
          
          // 2) Pokud je stále TAKE_PROFIT s closePosition=true a bez quantity, konvertuj na MARKET
          if (o?.type === 'TAKE_PROFIT' && o?.closePosition === true && !o?.quantity) {
            console.error('[EMERGENCY_TP_CONVERSION]', { symbol: o.symbol, converting: 'TAKE_PROFIT_closePosition_true_to_MARKET' })
            o.type = 'TAKE_PROFIT_MARKET'
            o.stopPrice = o.stopPrice ?? o.price
            delete o.price
            delete o.timeInForce
            delete o.quantity
            o.side = 'SELL'
            o.closePosition = true
            o.workingType = 'MARK_PRICE'
          }
          
          // 2) closePosition:true dovoleno jen pro SL MARKET a TP MARKET
          if (o?.closePosition === true && !cpAllowed(o.type)) {
            o.closePosition = false
          }
          
          // 3) TP MARKET nikdy nemá mít price
          if (o?.type === 'TAKE_PROFIT_MARKET' && o.price != null) {
            delete o.price
          }
          
          // 4) Binance neumožňuje kombinaci closePosition:true + reduceOnly:true — parametr reduceOnly proto vždy odstraňujeme,
          //    ať už je quantity přítomná nebo ne.  Tím eliminujeme chybu „Parameter 'reduceonly' sent when not required.“
          if (o?.closePosition === true && o?.reduceOnly === true) {
            console.error('[FIXING_REDUCEONLY_CLOSEPOSITION]', { symbol: o.symbol, type: o.type, removing_reduceOnly_from_closePosition: true })
            delete o.reduceOnly
          }

          // SAFE mode whitelist LONG-only (block anything else) - pouze pokud je SAFE mode zapnutý
          if (safeMode) {
            const allowed = (
              (String(o.side) === 'BUY' && String(o.type) === 'LIMIT' && o.closePosition !== true) ||
              (String(o.side) === 'SELL' && String(o.type) === 'STOP_MARKET' && o.closePosition === true) ||
              (String(o.side) === 'SELL' && String(o.type) === 'TAKE_PROFIT_MARKET' && o.closePosition === true) ||
              (String(o.side) === 'SELL' && String(o.type) === 'TAKE_PROFIT')
            )
            if (!allowed) {
              try { console.error('[BLOCKED_ORDER]', { symbol: String(o.symbol), side: String(o.side), type: String(o.type), closePosition: !!o.closePosition }) } catch {}
              throw new Error('SAFE_MODE: blocked non-whitelisted order')
            }
          }

          // OUTGOING log (one per order)
          try {
            console.info('[OUTGOING_ORDER]', {
              engine: engineTag,
              symbol: String(o.symbol),
              side: String(o.side),
              type: String(o.type),
              price: o.price !== undefined ? Number(o.price) : null,
              stopPrice: o.stopPrice !== undefined ? Number(o.stopPrice) : null,
              reduceOnly: o.reduceOnly === true,
              closePosition: o.closePosition === true
            })
          } catch {}
          
          try { delete o.__engine } catch {}
          return o
        }

        if (endpoint === '/fapi/v1/order') {
          // — single order —
          params = forceMarketTP(params)
          
          // Tvrdé asserty (pro případ, že by se to ještě někde zvrhlo)
          if (params?.type === 'TAKE_PROFIT' && params?.closePosition === true) {
            console.error('[ASSERT_FAIL] TP_LIMIT_with_closePosition_true', params)
            throw new Error('ASSERT: TP_LIMIT with closePosition:true blocked')
          }
          if (params?.closePosition === true && !cpAllowed(params?.type)) {
            console.error('[ASSERT_FAIL] closePosition_true_invalid_type', params)
            throw new Error('ASSERT: closePosition true only for SL/TP_MARKET')
          }
          
        } else if (endpoint === '/fapi/v1/batchOrders') {
          // — batch —
          const raw = (params as any).batchOrders
          let orders: any[] | null = null
          try {
            if (Array.isArray(raw)) orders = raw as any[]
            else if (typeof raw === 'string') orders = JSON.parse(raw)
          } catch {}
          if (Array.isArray(orders)) {
            orders = orders.map(forceMarketTP)
            
            // Tvrdé asserty pro každou položku v batchi
            for (const o of orders) {
              if (o?.type === 'TAKE_PROFIT' && o?.closePosition === true) {
                console.error('[ASSERT_FAIL] TP_LIMIT_with_closePosition_true', o)
                throw new Error('ASSERT: TP_LIMIT with closePosition:true blocked')
              }
              if (o?.closePosition === true && !cpAllowed(o?.type)) {
                console.error('[ASSERT_FAIL] closePosition_true_invalid_type', o)
                throw new Error('ASSERT: closePosition true only for SL/TP_MARKET')
              }
            }
            
            try { (params as any).batchOrders = JSON.stringify(orders) } catch {}
          }
        }
        }
      }
    } catch {}
    // Filter out undefined/null/false values. Allow reduceOnly only if === true
    const filteredParams = Object.fromEntries(
      Object.entries(params)
        .filter(([k, v]) => {
          const key = String(k || '')
          if (key.toLowerCase() === 'reduceonly' && v !== true) return false
          if (v === undefined || v === null) return false
          if (typeof v === 'boolean' && v === false) return false
          return true
        })
        .map(([k, v]) => [k, String(v)])
    ) as Record<string, string>
    const queryParams: Record<string,string> = { ...filteredParams, timestamp: String(timestamp) }
    const queryString = new URLSearchParams(queryParams).toString()
    const signature = this.sign(queryString)
    const url = `${this.baseURL}${endpoint}?${queryString}&signature=${signature}`

    const DEBUG = String(process.env.DEBUG_BINANCE ?? '1').toLowerCase() !== '0'
    if (DEBUG) {
      const safe = { method, endpoint, params: { ...params, timestamp: '<ts>' }, filtered_keys: Object.keys(filteredParams) }
      // eslint-disable-next-line no-console
      console.info('[BINANCE_REQ]', safe)
      if (method === 'POST' && endpoint === '/fapi/v1/order') {
        try {
          // eslint-disable-next-line no-console
          console.info('[BINANCE_ORDER_REQ_PARAMS]', filteredParams)
        } catch {}
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    })

    const text = await response.text()
    try {
      const headersLike: Record<string, string> = {}
      try { (response.headers as any).forEach((v: string, k: string) => { headersLike[String(k)] = String(v) }) } catch {}
      const statusNum = Number(response.status)
      let errCode: number | null = null
      let errMsg: string | null = null
      if (!response.ok) {
        try { const j = JSON.parse(text); if (typeof j?.code !== 'undefined') errCode = Number(j.code); if (typeof j?.msg !== 'undefined') errMsg = String(j.msg) } catch {}
      }
      try { noteApiCall({ method, path: endpoint, status: statusNum, headers: headersLike, errorCode: errCode, errorMsg: errMsg }) } catch {}
      if (errCode === -1003) {
        try {
          const m = String(errMsg || '').match(/banned\s+until\s+(\d{10,})/i)
          if (m && m[1]) setBanUntilMs(Number(m[1]))
        } catch {}
      }
    } catch {}
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.info('[BINANCE_RES]', { status: response.status, ok: response.ok, body_start: text.slice(0, 200) })
    }
    if (!response.ok) {
      throw new Error(`Binance API error: ${response.status} ${text}`)
    }
    try { return JSON.parse(text) } catch { return text }
  }

  async getLastPrice(symbol: string): Promise<number> {
    const r = await this.request('GET', '/fapi/v1/ticker/price', { symbol })
    const p = Number(r?.price)
    if (!Number.isFinite(p) || p <= 0) throw new Error('Bad price')
    return p
  }

  async getSymbolInfo(symbol: string): Promise<any> {
    const exchangeInfo = await this.request('GET', '/fapi/v1/exchangeInfo')
    const info = (exchangeInfo.symbols || []).find((s: any) => s.symbol === symbol)
    if (!info) throw new Error(`Symbol ${symbol} not found`)
    return info
  }

  async getHedgeMode(): Promise<boolean> {
    const r = await this.request('GET', '/fapi/v1/positionSide/dual')
    return Boolean(r?.dualSidePosition)
  }

  async getAccountInfo(): Promise<any> {
    return this.request('GET', '/fapi/v2/account')
  }

  async setLeverage(symbol: string, leverage: number): Promise<any> {
    return this.request('POST', '/fapi/v1/leverage', {
      symbol,
      leverage
    })
  }

  async placeOrder(params: OrderParams): Promise<any> {
    // Last-mile sanitization of closePosition and shape before hitting Binance API
    const p: OrderParams = { ...params }
    const engineTag = (()=>{ try { return String((params as any).__engine || 'unknown') } catch { return 'unknown' } })()
    try {
      const raw = ((tradingCfg as any)?.RAW_PASSTHROUGH === true)
      if (!raw) {
        const t = String(p.type || '')
        const isStopMarket = t === 'STOP_MARKET'
        const isTpMarket = t === 'TAKE_PROFIT_MARKET'
        const isTpLimit = t === 'TAKE_PROFIT'
        const wasClosePositionTrue = p.closePosition === true

        // A) Limit TP nesmí mít closePosition:true - pokročilá logika
        if (isTpLimit && wasClosePositionTrue) {
          let pos = 0
          try {
            // Zkus získat aktuální pozici (pokud máme)
            const positions = await this.getPositions()
            const position = (Array.isArray(positions) ? positions : []).find((pos: any) => String(pos?.symbol) === String(p.symbol))
            pos = Math.abs(Number(position?.positionAmt || 0))
          } catch {}

          if (pos > 0) {
            // on-fill varianta: nech TP LIMIT, ale closePosition=false a qty = pos
            p.closePosition = false
            p.quantity = String(pos)
            // reduceOnly zůstává true
            try { console.info('[CP_REWRITE]', { symbol: String(p.symbol), prevType: 'TAKE_PROFIT', newType: p.type, prevCP: true, newCP: p.closePosition, quantity: p.quantity }) } catch {}
          } else {
            // pre-entry varianta: přepni na TP MARKET (bez price) – jediná povolená close-only forma
            p.type = 'TAKE_PROFIT_MARKET'
            delete (p as any).price
            p.closePosition = true
            // p.reduceOnly = true // REMOVED: causes origQty=0 with closePosition
            p.workingType = 'MARK_PRICE'
            try { console.info('[CP_REWRITE]', { symbol: String(p.symbol), prevType: 'TAKE_PROFIT', newType: p.type, prevCP: true, newCP: p.closePosition }) } catch {}
          }
        }

        // B) Obecně: closePosition = true dovoleno JEN pro STOP_MARKET a TAKE_PROFIT_MARKET
        if (p.closePosition === true && p.type !== 'STOP_MARKET' && p.type !== 'TAKE_PROFIT_MARKET') {
          p.closePosition = false
          try { console.info('[CP_SANITIZED]', { symbol: String(p.symbol), type: p.type, reason: 'closePosition_forbidden_for_this_type' }) } catch {}
        }

        // Optional: For TAKE_PROFIT_MARKET remove price if present
        if (isTpMarket && (p as any).price !== undefined) {
          try { delete (p as any).price } catch {}
        }

        // Fail-fast pojistka (už nikdy -4136)
        if (p.type === 'TAKE_PROFIT' && p.closePosition === true) {
          try { console.error('[ASSERT_FAIL]', { symbol: String(p.symbol), type: p.type, closePosition: p.closePosition }) } catch {}
          throw new Error('ASSERT: TAKE_PROFIT limit with closePosition:true blocked')
        }
      }
    } catch (e) {
      // Pokud sanitizace selže, zaloguj a propaguj chybu
      try { console.error('[SANITIZE_ERROR]', { symbol: String(p.symbol), error: (e as any)?.message || e }) } catch {}
      throw e
    }

    // Ensure meta fields are not sent to Binance
    try { delete (p as any).__engine } catch {}

    // Unified OUTGOING log right before hitting Binance
    try {
      console.info('[OUTGOING_ORDER]', {
        symbol: String(p.symbol),
        side: String(p.side),
        type: String(p.type),
        price: (p as any).price !== undefined ? Number(p.price) : null,
        stopPrice: (p as any).stopPrice !== undefined ? Number(p.stopPrice) : null,
        reduceOnly: p.reduceOnly === true,
        closePosition: p.closePosition === true,
        engine: engineTag
      })
    } catch {}

    try {
      return await this.request('POST', '/fapi/v1/order', p)
    } catch (e: any) {
      const msg = String(e?.message || '')
      let parsedCode: number | null = null
      let parsedMsg: string | null = null
      try {
        const idx = msg.indexOf('{')
        if (idx >= 0) {
          const jsonStr = msg.slice(idx)
          const j = JSON.parse(jsonStr)
          if (typeof j?.code !== 'undefined') parsedCode = Number(j.code)
          if (typeof j?.msg !== 'undefined') parsedMsg = String(j.msg)
        }
      } catch {}
      try {
        console.error('[BINANCE_ERROR]', {
          code: parsedCode,
          msg: parsedMsg || msg,
          engine: engineTag,
          payload: {
            symbol: String(p.symbol), side: String(p.side), type: String(p.type),
            price: (p as any).price !== undefined ? Number(p.price) : null,
            stopPrice: (p as any).stopPrice !== undefined ? Number(p.stopPrice) : null,
            reduceOnly: p.reduceOnly === true,
            closePosition: p.closePosition === true
          }
        })
      } catch {}
      throw e
    }
  }

  async cancelAllOrders(symbol: string): Promise<any> {
    return this.request('DELETE', '/fapi/v1/allOpenOrders', { symbol })
  }

  async getPositions(): Promise<any> {
    return this.request('GET', '/fapi/v2/positionRisk')
  }

  async getOpenOrders(symbol: string): Promise<any[]> {
    const res = await this.request('GET', '/fapi/v1/openOrders', { symbol })
    return Array.isArray(res) ? res : []
  }

  async getAllOpenOrders(): Promise<any[]> {
    const res = await this.request('GET', '/fapi/v1/openOrders')
    return Array.isArray(res) ? res : []
  }

  async getMarkPrice(symbol: string): Promise<number> {
    const r = await this.request('GET', '/fapi/v1/premiumIndex', { symbol })
    const p = Number(r?.markPrice)
    if (!Number.isFinite(p) || p <= 0) throw new Error('Bad mark price')
    return p
  }

// moved below class

  async calculateQuantity(symbol: string, usdAmount: number, price: number): Promise<string> {
    // Get symbol info for precision
    const exchangeInfo = await this.request('GET', '/fapi/v1/exchangeInfo')
    const symbolInfo = exchangeInfo.symbols.find((s: any) => s.symbol === symbol)
    
    if (!symbolInfo) {
      throw new Error(`Symbol ${symbol} not found`)
    }

    const quantity = usdAmount / price
    const stepSize = parseFloat(symbolInfo.filters.find((f: any) => f.filterType === 'LOT_SIZE')?.stepSize || '0.001')
    
    // Round to step size
    const roundedQuantity = Math.floor(quantity / stepSize) * stepSize
    
    const qty = roundedQuantity.toFixed(symbolInfo.quantityPrecision || 3)
    const DEBUG = String(process.env.DEBUG_BINANCE ?? '1').toLowerCase() !== '0'
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.info('[BINANCE_QTY]', { symbol, usdAmount, price, qty, stepSize })
    }
    return qty
  }
}

export async function fetchMarkPrice(symbol: string): Promise<number> {
  const api = getBinanceAPI()
  return api.getMarkPrice(symbol)
}

export async function fetchLastTradePrice(symbol: string): Promise<number> {
  const api = getBinanceAPI()
  return api.getLastPrice(symbol)
}

export async function fetchAllOpenOrders(): Promise<any[]> {
  const api = getBinanceAPI()
  return api.getAllOpenOrders()
}

export async function fetchPositions(): Promise<any[]> {
  const api = getBinanceAPI()
  return api.getPositions()
}

export async function cancelOrder(symbol: string, orderId: number | string): Promise<any> {
  const api = getBinanceAPI()
  return (api as any).request('DELETE', '/fapi/v1/order', { symbol, orderId })
}

// Initialize only when needed to avoid startup errors
let binanceAPI: BinanceFuturesAPI | null = null

export function getBinanceAPI(): BinanceFuturesAPI {
  if (!binanceAPI) {
    binanceAPI = new BinanceFuturesAPI()
    try {
      const raw = (tradingCfg as any)?.RAW_PASSTHROUGH === true
      if (!raw) {
        wrapBinanceFuturesApi(binanceAPI, (tradingCfg as any)?.SAFE_MODE_LONG_ONLY === true)
      } else {
        console.error('[RAW_MODE] Binance client without safe wrapper')
      }
    } catch {}
  }
  return binanceAPI
}

// In-memory registry for deferred TP LIMIT orders (waiting until position exists)
export type WaitingTpEntry = {
  symbol: string
  tp: number
  qtyPlanned: string | null
  since: string
  lastCheck: string | null
  checks: number
  positionSize: number | null
  status: 'waiting'
  positionSide?: 'LONG' | 'SHORT' | null
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE'
  lastError?: string | null
  lastErrorAt?: string | null
}

const waitingTpBySymbol: Record<string, WaitingTpEntry> = {}
const WAITING_STATE_DIR = path.resolve(process.cwd(), 'runtime')
const WAITING_STATE_FILE = path.resolve(WAITING_STATE_DIR, 'waiting_tp.json')

function persistWaitingState(): void {
  try {
    if (!fs.existsSync(WAITING_STATE_DIR)) fs.mkdirSync(WAITING_STATE_DIR, { recursive: true })
    const payload = Object.values(waitingTpBySymbol)
      .filter(w => w.status === 'waiting')
      .sort((a,b)=> new Date(a.since).getTime() - new Date(b.since).getTime())
    fs.writeFileSync(WAITING_STATE_FILE, JSON.stringify({ ts: new Date().toISOString(), waiting: payload }, null, 2), 'utf8')
  } catch {}
}

export function getWaitingTpList(): WaitingTpEntry[] {
  try {
    return Object.values(waitingTpBySymbol)
      .filter(w => w.status === 'waiting')
      .sort((a, b) => (new Date(a.since).getTime() - new Date(b.since).getTime()))
  } catch { return [] }
}

function waitingTpSchedule(symbol: string, tp: number, qtyPlanned: string | null, positionSide?: 'LONG'|'SHORT'|undefined, workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE'): void {
  try {
    waitingTpBySymbol[symbol] = {
      symbol,
      tp: Number(tp),
      qtyPlanned,
      since: new Date().toISOString(),
      lastCheck: null,
      checks: 0,
      positionSize: null,
      status: 'waiting',
      positionSide: positionSide ?? null,
      workingType: workingType ?? 'MARK_PRICE',
      lastError: null,
      lastErrorAt: null
    }
    persistWaitingState()
  } catch {}
}

function waitingTpOnCheck(symbol: string, positionSize: number | null): void {
  try {
    const w = waitingTpBySymbol[symbol]
    if (!w) return
    w.lastCheck = new Date().toISOString()
    if (Number.isFinite(positionSize as any)) w.positionSize = positionSize as number
    // přepnuto: "checks" nyní znamená po sobě jdoucí nenulové checky
    if (Number.isFinite(positionSize as any) && (positionSize as number) > 0) {
      w.checks = (w.checks || 0) + 1
    } else {
      w.checks = 0
    }
    // nezapisujeme každé kolo kvůli IO; stačí při schedule/sent/chybě
  } catch {}
}

function waitingTpOnSent(symbol: string): void {
  try { delete waitingTpBySymbol[symbol] } catch {}
  try { persistWaitingState() } catch {}
}

function waitingTpCleanupIfNoEntry(symbol: string): void {
  try {
    if (!waitingTpBySymbol[symbol]) return
    // Check if there's still an ENTRY order for this symbol
    getBinanceAPI().getOpenOrders(symbol).then(orders => {
      const hasEntry = (Array.isArray(orders) ? orders : []).some((o: any) => 
        String(o?.side) === 'BUY' && 
        String(o?.type) === 'LIMIT' && 
        !(o?.reduceOnly || o?.closePosition)
      )
      if (!hasEntry) {
        console.error('[WAITING_AUTO_CLEANUP]', { symbol, reason: 'no_entry_order_found' })
        delete waitingTpBySymbol[symbol]
        persistWaitingState()
      }
    }).catch(() => {})
  } catch {}
}

export function cleanupWaitingTpForSymbol(symbol: string): void {
  try {
    console.error('[WAITING_MANUAL_CLEANUP]', { symbol })
    delete waitingTpBySymbol[symbol]
    persistWaitingState()
  } catch {}
}

// Jediný pass přes všechny waiting TP: využijeme již získané pozice (např. z /api/positions)
export async function waitingTpProcessPassFromPositions(positionsRaw: any[]): Promise<void> {
  const api = getBinanceAPI()
  try {
    const list = Array.isArray(positionsRaw) ? positionsRaw : []
    const sizeBySymbol: Record<string, { size: number; side: 'LONG' | 'SHORT' | null }> = {}
    for (const p of list) {
      try {
        const sym = String(p?.symbol || '')
        if (!sym) continue
        const amt = Number(p?.positionAmt)
        const size = Number.isFinite(amt) ? Math.abs(amt) : 0
        const side: 'LONG' | 'SHORT' | null = Number.isFinite(amt) ? (amt < 0 ? 'SHORT' : 'LONG') : null
        sizeBySymbol[sym] = { size, side }
      } catch {}
    }
    const entries = Object.entries(waitingTpBySymbol)
    for (const [symbol, w] of entries) {
      const rec = sizeBySymbol[symbol] || { size: 0, side: null }
      const size = rec.size
      waitingTpOnCheck(symbol, size)
      // Žádné REST dotazy na openOrders – cleanup řeší server na základě WS snapshotu
      // Place TP MARKET (closePosition) as soon as pozice existuje (bez čekání na druhý průchod)
      if (size > 0 && w.checks >= 1) {
        const workingType = (w.workingType === 'CONTRACT_PRICE') ? 'CONTRACT_PRICE' : 'MARK_PRICE'
        const positionSide = (w.positionSide === 'SHORT' || rec.side === 'SHORT') ? 'SHORT' : 'LONG'
        const tpParams: OrderParams & { __engine?: string } = positionSide === 'SHORT'
          ? { symbol, side: 'BUY', type: 'TAKE_PROFIT_MARKET', stopPrice: String(w.tp), closePosition: true, workingType, positionSide, newClientOrderId: `x_tp_tm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`, newOrderRespType: 'RESULT', __engine: 'v3_batch_2s' }
          : { symbol, side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: String(w.tp), closePosition: true, workingType, positionSide, newClientOrderId: `x_tp_tm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`, newOrderRespType: 'RESULT', __engine: 'v3_batch_2s' }
        try { console.info('[BATCH_TP_PARAMS]', { symbol, type: tpParams.type, stopPrice: tpParams.stopPrice, closePosition: true }) } catch {}
        try {
          const tpRes = await (api as any).placeOrder(tpParams)
          console.error('[TP_DELAY_SENT]', { symbol, orderId: tpRes?.orderId })
          waitingTpOnSent(symbol)
        } catch (e: any) {
          const msg = String(e?.message || e)
          try {
            const ww = waitingTpBySymbol[symbol]
            if (ww) {
              ww.lastError = msg
              ww.lastErrorAt = new Date().toISOString()
              persistWaitingState()
            }
          } catch {}
          try { console.error('[TP_DELAY_ERROR]', { symbol, error: msg }) } catch {}
        }
      }
    }
  } catch {}
}

async function spawnDeferredTpPoller(symbol: string, tpStr: string, qtyHint: string | null, positionSide: 'LONG' | 'SHORT' | undefined, workingType: 'MARK_PRICE' | 'CONTRACT_PRICE') {
  try {
    const waitingCheckMs = Number((tradingCfg as any)?.WAITING_TP_CHECK_MS ?? 3000)
    console.error('[TP_DELAY_SCHEDULED]', { symbol, tp: tpStr, qty_planned: qtyHint, interval_ms: waitingCheckMs })
    // Pouze zaregistruj waiting – žádná vlastní smyčka. Zpracování probíhá při /api/positions passu.
    waitingTpSchedule(symbol, Number(tpStr), qtyHint, positionSide, workingType)
    // Bez extra REST dotazu; spolehni se na pravidelný pass z /api/orders_console
  } catch {}
}

let __rehydrateStarted = false
async function rehydrateWaitingFromDisk(): Promise<void> {
  if (__rehydrateStarted) return
  __rehydrateStarted = true
  try {
    if (!fs.existsSync(WAITING_STATE_FILE)) return
    const raw = fs.readFileSync(WAITING_STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const arr: WaitingTpEntry[] = Array.isArray(parsed?.waiting) ? parsed.waiting : []
    if (!arr.length) return
    const api = getBinanceAPI()
    for (const w of arr) {
      try {
        // Validate whether it's still relevant: keep if entry exists or position exists
        let keep = false
        let posSize = 0
        try {
          const positions = await api.getPositions()
          const pos = (Array.isArray(positions) ? positions : []).find((p: any) => String(p?.symbol) === w.symbol)
          const amt = Number(pos?.positionAmt)
          posSize = Number.isFinite(amt) ? Math.abs(amt) : 0
        } catch {}
        if (posSize > 0) keep = true
        if (!keep) {
          try {
            const open = await api.getOpenOrders(w.symbol)
            const hasEntry = (Array.isArray(open) ? open : []).some((o: any) => String(o?.side) === 'BUY' && String(o?.type) === 'LIMIT')
            keep = hasEntry
          } catch {}
        }
        if (keep) {
          waitingTpBySymbol[w.symbol] = { ...w, status: 'waiting' }
          // Re-spawn poller
          const workingType = (w.workingType === 'CONTRACT_PRICE') ? 'CONTRACT_PRICE' : 'MARK_PRICE'
          const ps = (w.positionSide === 'SHORT') ? 'SHORT' : 'LONG'
          spawnDeferredTpPoller(w.symbol, String(w.tp), w.qtyPlanned, ps, workingType).catch(()=>{})
          console.error('[WAITING_REHYDRATE_KEEP]', { symbol: w.symbol, tp: w.tp })
        } else {
          console.error('[WAITING_REHYDRATE_DROP]', { symbol: w.symbol })
        }
      } catch {}
    }
    persistWaitingState()
  } catch (e) {
    try { console.error('[WAITING_REHYDRATE_ERR]', (e as any)?.message || e) } catch {}
  }
}

// Public one-shot rehydrate for server startup
export async function rehydrateWaitingFromDiskOnce(): Promise<void> {
  return rehydrateWaitingFromDisk()
}

async function sleep(ms: number): Promise<void> { return new Promise(res => setTimeout(res, ms)) }

async function waitForStopOrdersCleared(symbol: string, timeoutMs = 4000): Promise<void> {
  const api = getBinanceAPI()
  const deadline = Date.now() + timeoutMs
  const isStopType = (t: string) => ['STOP','STOP_MARKET','TAKE_PROFIT','TAKE_PROFIT_MARKET'].includes(String(t||''))
  while (Date.now() < deadline) {
    try {
      const open = await api.getOpenOrders(symbol)
      const pending = open.filter(o => isStopType(o?.type))
      if (pending.length === 0) return
    } catch {}
    await sleep(200)
  }
}

async function waitForPositionSize(symbol: string, {
  sideLong,
  positionSide
}: { sideLong: boolean; positionSide?: 'LONG' | 'SHORT' }, timeoutMs = 5000): Promise<number> {
  const api = getBinanceAPI()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const positions = await api.getPositions()
      const pos = (Array.isArray(positions) ? positions : []).find((p: any) => String(p?.symbol) === symbol)
      if (pos) {
        const amt = Number(pos.positionAmt)
        const ps = String(pos.positionSide || '').toUpperCase()
        if (positionSide) {
          if (ps === positionSide && Number.isFinite(amt) && Math.abs(amt) > 0) return Math.abs(amt)
        } else {
          // One-way mode: sign encodes side
          if (Number.isFinite(amt) && Math.abs(amt) > 0) {
            if ((sideLong && amt > 0) || (!sideLong && amt < 0)) return Math.abs(amt)
          }
        }
      }
    } catch {}
    await sleep(200)
  }
  return 0
}

export async function executeHotTradingOrders(request: PlaceOrdersRequest): Promise<any> {
  console.log('[BINANCE_ORDERS] Using V3 ENGINE - batch entries then exits after 2s')
  return executeHotTradingOrdersV3_Batch2s(request)
}

export async function executeHotTradingOrdersV1_OLD(request: PlaceOrdersRequest): Promise<any> {
  const api = getBinanceAPI()
  const results: Array<any> = []
  
  for (const order of request.orders) {
    try {
      console.log(`[V1_ORDER] Processing ${order.symbol}`)
      
      // Calculate proper quantity like V3
      const entryPx = Number(order.entry)
      const notionalUsd = order.amount * order.leverage
      const qty = await api.calculateQuantity(order.symbol, notionalUsd, entryPx)
      
      // Simple: send entry, then SL, then TP with exact values from UI
      const entryResult = await api.placeOrder({
        symbol: order.symbol,
        side: 'BUY',
        type: 'LIMIT',
        price: String(order.entry),
        quantity: qty,
        timeInForce: 'GTC',
        positionSide: 'LONG',
        newOrderRespType: 'RESULT'
      })
      
      console.log(`[V1_ENTRY_SUCCESS] ${order.symbol}: ${entryResult?.orderId}`)
      
      // Wait 2s
      await sleep(2000)
      
      // SL
      const slResult = await api.placeOrder({
        symbol: order.symbol,
        side: 'SELL',
        type: 'STOP_MARKET',
        stopPrice: String(order.sl),
        closePosition: true,
        positionSide: 'LONG',
        newOrderRespType: 'RESULT'
      })
      
      console.log(`[V1_SL_SUCCESS] ${order.symbol}: ${slResult?.orderId}`)
      
      // TP
      const tpResult = await api.placeOrder({
        symbol: order.symbol,
        side: 'SELL',
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: String(order.tp),
        closePosition: true,
        positionSide: 'LONG',
        newOrderRespType: 'RESULT'
      })
      
      console.log(`[V1_TP_SUCCESS] ${order.symbol}: ${tpResult?.orderId}`)
      
      results.push({
        symbol: order.symbol,
        status: 'executed',
        entry_order: entryResult,
        sl_order: slResult,
        tp_order: tpResult,
        error: null
      })
      
    } catch (e: any) {
      console.error(`[V1_ERROR] ${order.symbol}: ${e?.message}`)
      results.push({
        symbol: order.symbol,
        status: 'error',
        entry_order: null,
        sl_order: null,
        tp_order: null,
        error: e?.message
      })
    }
  }
  
  const success = results.every(r => r.status === 'executed')
  return { success, orders: results, timestamp: new Date().toISOString(), engine: 'v1_simple' }
}

export async function executeHotTradingOrdersV2(request: PlaceOrdersRequest): Promise<any> {
  const results: any[] = []
  const priceLogs: Array<{
    symbol: string
    raw: { symbol: string; side: 'LONG' | 'SHORT'; entryRaw: number | null; slRaw: number | null; tpRaw: number | null }
    payload: {
      symbol: string
      entryPayload: { type: string | null; price: number | null; timeInForce: string | null }
      slPayload: { type: string | null; stopPrice: number | null; workingType: string | null; closePosition: boolean | null }
      tpPayload: { type: string | null; price: number | null; stopPrice: number | null; workingType: string | null; closePosition: boolean | null }
      config: { useBuffer: boolean | null; tpMode: 'MARKET_PREENTRY' | 'LIMIT_ON_FILL'; amountMode: string | null; postOnly: boolean | null }
      filters: { tickSize: number | null; stepSize: number | null; pricePrecision: number | null }
    }
    echo: {
      symbol: string
      entryEcho: { type: string | null; price: number | null; stopPrice: number | null }
      slEcho: { type: string | null; price: number | null; stopPrice: number | null }
      tpEcho: { type: string | null; price: number | null; stopPrice: number | null }
    }
  }> = []
  const api = getBinanceAPI()
  const makeId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  const killLimitTp = ((tradingCfg as any)?.DISABLE_LIMIT_TP === true)
  const safeModeLongOnly = ((tradingCfg as any)?.SAFE_MODE_LONG_ONLY === true)
  const tpMode = ((tradingCfg as any)?.TP_MODE === 'LIMIT_ON_FILL') ? 'LIMIT_ON_FILL' as const : 'MARKET_PREENTRY' as const
  
  // DEBUG: Zkontroluj konfiguraci
  try {
    console.error('[TP_CONFIG_DEBUG]', { 
      killLimitTp, 
      safeModeLongOnly, 
      tpModeFromConfig: (tradingCfg as any)?.TP_MODE,
      finalTpMode: tpMode,
      rawConfig: { DISABLE_LIMIT_TP: (tradingCfg as any)?.DISABLE_LIMIT_TP, SAFE_MODE_LONG_ONLY: (tradingCfg as any)?.SAFE_MODE_LONG_ONLY }
    })
  } catch {}

  for (const order of request.orders) {
    console.error('[DEBUG_PROCESSING_ORDER]', { symbol: order.symbol, side: order.side })
    let entryRes: any, tpRes: any, slRes: any;
    try {
      if (order.side !== 'LONG') { console.warn(`[SIMPLE_BRACKET_SKIP] non-LONG ${order.symbol}`); continue }

      let positionSide: 'LONG' | undefined; try { positionSide = (await api.getHedgeMode()) ? 'LONG' : undefined } catch {}
      const entryPx = Number(order.entry); if (!entryPx || entryPx <= 0) throw new Error(`Invalid entry price for ${order.symbol}`)
      const notionalUsd = order.amount * order.leverage
      const qty = await api.calculateQuantity(order.symbol, notionalUsd, entryPx)
      const workingType: 'MARK_PRICE' = 'MARK_PRICE'
      // Align Binance leverage to UI value before placing orders so margin/equity math matches UI intent
      try {
        const levDesired = Math.max(1, Math.min(125, Math.floor(Number(order.leverage))))
        if (levDesired > 0) {
          await api.setLeverage(order.symbol, levDesired)
          try { console.info('[SET_LEVERAGE]', { symbol: order.symbol, leverage: levDesired }) } catch {}
        }
      } catch (e:any) {
        try { console.error('[SET_LEVERAGE_ERR]', { symbol: order.symbol, error: (e as any)?.message || e }) } catch {}
      }
      
      // RAW passthrough mode: nepoužívej interní zaokrouhlování, pošli čísla z UI
      let symbolFilters = { tickSize: null as number | null, stepSize: null as number | null, pricePrecision: null as number | null }
      try {
        const info = await api.getSymbolInfo(order.symbol)
        const priceFilter = (info?.filters || []).find((f: any) => f?.filterType === 'PRICE_FILTER')
        const lotSize = (info?.filters || []).find((f: any) => f?.filterType === 'LOT_SIZE')
        symbolFilters = {
          tickSize: priceFilter ? Number(priceFilter.tickSize) : null,
          stepSize: lotSize ? Number(lotSize.stepSize) : null,
          pricePrecision: Number.isFinite(Number(info?.pricePrecision)) ? Number(info.pricePrecision) : null
        }
      } catch {}
      const rawMode = ((tradingCfg as any)?.RAW_PASSTHROUGH === true)
      const entryRounded = rawMode ? Number(order.entry) : roundToTickSize(entryPx, Number(symbolFilters.tickSize))
      const slRounded = rawMode ? Number(order.sl) : roundToTickSize(Number(order.sl), Number(symbolFilters.tickSize))
      const tpRounded = rawMode ? Number(order.tp) : roundToTickSize(Number(order.tp), Number(symbolFilters.tickSize))
      
      // Price rounding already done above

      // RAW log (first GPT input values seen by trading engine)
      const rawLog = {
        symbol: String(order.symbol),
        side: String(order.side || 'LONG').toUpperCase() as 'LONG' | 'SHORT',
        entryRaw: Number(order.entry ?? null) as number | null,
        slRaw: Number(order.sl ?? null) as number | null,
        tpRaw: Number(order.tp ?? null) as number | null
      }
      try { console.info('[PRICE_RAW]', rawLog) } catch {}

      // ENTRY LIMIT - use rounded price
      const entryParams: OrderParams & { __engine?: string } = {
        symbol: order.symbol,
        side: 'BUY',
        type: 'LIMIT',
        price: String(entryRounded),
        quantity: qty,
        timeInForce: 'GTC',
        closePosition: false,
        positionSide,
        newClientOrderId: makeId('e_l'),
        newOrderRespType: 'RESULT',
        __engine: 'v2_simple_bracket_immediate'
      }
      // SL STOP_MARKET (always) - use rounded price
      const slParams: OrderParams & { __engine?: string } = {
        symbol: order.symbol,
        side: 'SELL',
        type: 'STOP_MARKET',
        stopPrice: String(slRounded),
        closePosition: true,
        workingType,
        positionSide,
        newClientOrderId: makeId('x_sl'),
        newOrderRespType: 'RESULT',
        __engine: 'v2_simple_bracket_immediate'
      }

      // Compute symbol filters for debug (tickSize / stepSize / pricePrecision) — already computed above; keep for visibility
      try {
        const info = await api.getSymbolInfo(order.symbol)
        const priceFilter = (info?.filters || []).find((f: any) => f?.filterType === 'PRICE_FILTER')
        const lotSize = (info?.filters || []).find((f: any) => f?.filterType === 'LOT_SIZE')
        symbolFilters = {
          tickSize: priceFilter ? Number(priceFilter.tickSize) : symbolFilters.tickSize,
          stepSize: lotSize ? Number(lotSize.stepSize) : symbolFilters.stepSize,
          pricePrecision: Number.isFinite(Number(info?.pricePrecision)) ? Number(info.pricePrecision) : symbolFilters.pricePrecision
        }
      } catch {}

      // Prepare PAYLOAD snapshot before any API calls - use rounded prices
      const entryPayload = { type: 'LIMIT' as string | null, price: entryRounded, timeInForce: 'GTC' as string | null }
      const slPayload = { type: 'STOP_MARKET' as string | null, stopPrice: slRounded, workingType: String(workingType), closePosition: true as boolean | null }
      // tpPayload differs by mode; initialize as MARKET variant by default for debug visibility - use rounded price
      let tpPayload: { type: string | null; price: number | null; stopPrice: number | null; workingType: string | null; closePosition: boolean | null } =
        { type: 'TAKE_PROFIT_MARKET' as const, price: null, stopPrice: tpRounded, workingType: String(workingType), closePosition: true }

      const payloadLog = {
        symbol: String(order.symbol),
        entryPayload,
        slPayload,
        tpPayload,
        config: { useBuffer: (order as any)?.useBuffer ?? null, tpMode, amountMode: null, postOnly: null },
        filters: symbolFilters
      }
      try { console.info('[PRICE_PAYLOAD]', payloadLog) } catch {}

      // FORCE SAFE mode only when enabled in config
      console.error('[DEBUG_BEFORE_SEQUENTIAL_BLOCK]', { symbol: order.symbol })
      if (safeModeLongOnly) {
        console.error('[DEBUG_ENTERING_SEQUENTIAL_BLOCK]', { symbol: order.symbol })
        try { console.info('[SAFE_PLAN]', { symbol: order.symbol, entry: entryRounded, sl: slRounded, tp: tpRounded, mode: 'LONG_ONLY', tpDispatch: 'preentry_or_on_fill' }) } catch {}
        


        // 1. ENTRY PRVNÍ
        console.error('[STEP_1_SENDING_ENTRY]', { symbol: order.symbol })
        entryRes = await api.placeOrder(entryParams)
        console.error('[STEP_1_ENTRY_SUCCESS]', { symbol: order.symbol, orderId: entryRes?.orderId })
        
        // 2. POČKAT 3-4 SEKUNDY na naplnění ENTRY
        console.error('[STEP_2_WAITING_FOR_ENTRY_FILL]', { symbol: order.symbol, waiting: '3-4 seconds' })
        await sleep(3500) // 3.5 sekundy
        
        // 3. ZKONTROLUJ, jestli máme pozici a získej quantity
        let hasPosition = false
        let positionQty = qty // Default na původní vypočítanou quantity
        try {
          const size = await waitForPositionSize(order.symbol, { sideLong: true, positionSide }, 2000)
          hasPosition = Number(size) > 0
          if (hasPosition) positionQty = String(size)
          console.error('[STEP_2_POSITION_CHECK]', { symbol: order.symbol, hasPosition, size, positionQty })
        } catch {}
        
        // 4. Rozhodni podle MARK a přítomnosti pozice, aby se zabránilo -2021 (would immediately trigger)
        let markPx: number | null = null
        try { markPx = await api.getMarkPrice(order.symbol) } catch {}
        const tpOk = hasPosition || (tpRounded > Number(markPx))
        const slOk = hasPosition || (slRounded < Number(markPx))

        console.error('[STEP_3_POLICY]', { symbol: order.symbol, phase: 'SAFE', hasPosition, quantity: positionQty, mark: markPx, tp: tpRounded, sl: slRounded, tpOk, slOk })

        // Build params depending on whether we already have a position
        const tpParamsHasPos: OrderParams & { __engine?: string } = {
          symbol: order.symbol,
          side: 'SELL',
          type: 'TAKE_PROFIT',
          price: String(tpRounded),
          quantity: positionQty,
          reduceOnly: true,
          timeInForce: 'GTC',
          workingType,
          positionSide,
          newClientOrderId: makeId('x_tp_tm'),
          newOrderRespType: 'RESULT',
          __engine: 'v2_simple_bracket_immediate'
        }
        const slParamsHasPos: OrderParams & { __engine?: string } = {
          symbol: order.symbol,
          side: 'SELL',
          type: 'STOP_MARKET',
          stopPrice: String(slRounded),
          quantity: positionQty,
          reduceOnly: true,
          workingType,
          positionSide,
          newClientOrderId: makeId('x_sl'),
          newOrderRespType: 'RESULT',
          __engine: 'v2_simple_bracket_immediate'
        }
        const tpParamsPre: OrderParams & { __engine?: string } = {
          symbol: order.symbol,
          side: 'SELL',
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: String(tpRounded),
          closePosition: true,
          workingType,
          positionSide,
          newClientOrderId: makeId('x_tp_tm'),
          newOrderRespType: 'RESULT',
          __engine: 'v2_simple_bracket_immediate'
        }
        const slParamsPre: OrderParams & { __engine?: string } = {
          symbol: order.symbol,
          side: 'SELL',
          type: 'STOP_MARKET',
          stopPrice: String(slRounded),
          closePosition: true,
          workingType,
          positionSide,
          newClientOrderId: makeId('x_sl'),
          newOrderRespType: 'RESULT',
          __engine: 'v2_simple_bracket_immediate'
        }

        try {
          if (hasPosition) {
            // S pozicí: SL + TP LIMIT současně
            ;[slRes, tpRes] = await Promise.all([api.placeOrder(slParamsHasPos), api.placeOrder(tpParamsHasPos)])
          } else {
            // Bez pozice: nejprve SL (pokud OK), pak TP MARKET zvlášť, aby se TP nevynechal při částečném failu
            slRes = slOk ? await api.placeOrder(slParamsPre) : null
            tpRes = tpOk ? await api.placeOrder(tpParamsPre) : null
          }
        } catch (exitError: any) {
          console.error('[SL_TP_ERROR]', { symbol: order.symbol, error: exitError?.message })
          // Pokračuj i když SL/TP selže
        }
        try {
          console.info('[SL_TP_ECHO_BRIEF]', {
            symbol: order.symbol,
            sl: { id: slRes?.orderId ?? null, type: slRes?.type ?? null, stopPrice: slRes?.stopPrice ?? null },
            tp: { id: tpRes?.orderId ?? null, type: tpRes?.type ?? null, stopPrice: tpRes?.stopPrice ?? null }
          })
        } catch {}
        console.error('[STEP_3_SL_TP_SUCCESS]', { symbol: order.symbol, tpId: tpRes?.orderId, slId: slRes?.orderId })
        // Continue to next order in SAFE mode
        results.push({ symbol: order.symbol, status: 'executed', entry_order: entryRes, sl_order: slRes, tp_order: tpRes })
        continue
      }

      // Non-safe path: original policy
      // Send ENTRY first
      entryRes = await api.placeOrder(entryParams)

      // Send exits per policy

      if (tpMode === 'MARKET_PREENTRY') {
        // Change requested: send TP as LIMIT with qty (no reduceOnly) pre-entry
        const tpParams: OrderParams & { __engine?: string } = {
          symbol: order.symbol,
          side: 'SELL',
          type: 'TAKE_PROFIT',
          price: String(tpRounded),
          stopPrice: String(tpRounded),
          timeInForce: 'GTC',
          quantity: qty,
          // reduceOnly removed per user request
          workingType,
          positionSide,
          newClientOrderId: makeId('x_tp_l'),
          newOrderRespType: 'RESULT',
          __engine: 'v2_simple_bracket_immediate'
        }
        tpPayload = { type: 'TAKE_PROFIT', price: tpRounded, stopPrice: tpRounded, workingType: String(workingType), closePosition: false }
        try { console.info('[TP_PAYLOAD]', { engine: 'v2_simple_bracket_immediate', symbol: order.symbol, type: 'TAKE_PROFIT', price: tpRounded, stopPrice: tpRounded }) } catch {}
        ;[tpRes, slRes] = await Promise.all([ api.placeOrder(tpParams), api.placeOrder(slParams) ])
        console.info('[TP_POLICY]', { symbol: order.symbol, mode: 'LIMIT_PREENTRY_NO_RO', decision: 'preentry_forced' })
        try { console.info('[TP_BRIEF]', { symbol: order.symbol, tpType: 'TAKE_PROFIT', price: tpRounded, stopPrice: tpRounded }) } catch {}
      }

      // LIMIT_ON_FILL: SL hned, TP jako TAKE_PROFIT (limit) pre-entry (bez reduceOnly)
      if (tpMode === 'LIMIT_ON_FILL') {
        // 1) SL hned
        slRes = await api.placeOrder(slParams)
        // 2) TP LIMIT hned (bez reduceOnly, bez closePosition)
        const tpLimitParams: OrderParams & { __engine?: string } = {
          symbol: order.symbol,
          side: 'SELL',
          type: 'TAKE_PROFIT',
          price: String(tpRounded),
          stopPrice: String(tpRounded),
          timeInForce: 'GTC',
          quantity: qty,
          // reduceOnly removed per user request
          workingType,
          positionSide,
          newClientOrderId: makeId('x_tp_l'),
          newOrderRespType: 'RESULT',
          __engine: 'v2_simple_bracket_immediate'
        }
        try { tpRes = await api.placeOrder(tpLimitParams) } catch (e) { console.error('[TP_LIMIT_ERROR]', { symbol: order.symbol, error: (e as any)?.message }) }
        results.push({ symbol: order.symbol, status: 'executed', entry_order: entryRes, sl_order: slRes, tp_order: tpRes })
        continue
      }

      // Debug & open orders snapshot
      try {
        const pickKeys = (o:any)=>({ type:o?.type??null, price:o?.price??null, stopPrice:o?.stopPrice??null, timeInForce:o?.timeInForce??null, closePosition:o?.closePosition??null, workingType:o?.workingType??null, positionSide:o?.positionSide??null, quantity:o?.quantity??o?.origQty??null })
        console.info('[ORDER_DEBUG]', { symbol: order.symbol, phase: 'ENTRY', intended: pickKeys(entryParams), echo: pickKeys(entryRes) })
        if (tpRes) console.info('[ORDER_DEBUG]', { symbol: order.symbol, phase: 'TP', intended: (tpMode==='MARKET_PREENTRY'
          ? { type:'TAKE_PROFIT', price:String(tpRounded), stopPrice:String(tpRounded), timeInForce:'GTC', quantity:qty, workingType, positionSide }
          : { type:'TAKE_PROFIT', price:String(tpRounded), stopPrice:String(tpRounded), timeInForce:'GTC', quantity:qty, workingType, positionSide }
        ), echo: pickKeys(tpRes) })
        if (slRes) console.info('[ORDER_DEBUG]', { symbol: order.symbol, phase: 'SL', intended: pickKeys(slParams), echo: pickKeys(slRes) })
        const open = await api.getOpenOrders(order.symbol)
        const oo = (Array.isArray(open)?open:[]).map((o:any)=>({ orderId:Number(o?.orderId)||null,type:String(o?.type||''),side:String(o?.side||''),price:Number(o?.price)||null,stopPrice:Number(o?.stopPrice)||null,timeInForce:o?.timeInForce?String(o.timeInForce):null,workingType:o?.workingType?String(o.workingType):null,positionSide:o?.positionSide?String(o.positionSide):null }))
        console.info('[OPEN_ORDERS_SNAPSHOT]', { symbol: order.symbol, count: oo.length, orders: oo })
      } catch {}

      // ECHO snapshot after API replies
      const pickEcho = (r: any) => ({
        type: r && r.type ? String(r.type) : null,
        price: Number.isFinite(Number(r?.price)) ? Number(r.price) : null,
        stopPrice: Number.isFinite(Number(r?.stopPrice)) ? Number(r.stopPrice) : null
      })
      const echoLog = {
        symbol: String(order.symbol),
        entryEcho: pickEcho(entryRes),
        slEcho: pickEcho(slRes),
        tpEcho: pickEcho(tpRes)
      }
      try { console.info('[PRICE_ECHO]', echoLog) } catch {}

      priceLogs.push({ symbol: String(order.symbol), raw: rawLog, payload: payloadLog, echo: echoLog })

      results.push({ symbol: order.symbol, status: 'executed', entry_order: entryRes, sl_order: slRes, tp_order: tpRes })
    } catch (e:any) {
      console.error(`[SIMPLE_BRACKET_ERROR] ${order.symbol}:`, e?.message || e)
      results.push({ symbol: order.symbol, status: 'error', error: e?.message || 'unknown', entry_order: entryRes, sl_order: slRes, tp_order: tpRes })
    }
  }

  const success = results.every(r => r.status === 'executed')
  return { success, orders: results, timestamp: new Date().toISOString(), engine: 'v2_simple_bracket_immediate', price_logs: priceLogs }
}

// Helper: count decimals from step like 0.001 -> 3
function countStepDecimals(step: number): number {
  const s = String(step)
  const idx = s.indexOf('.')
  return idx >= 0 ? (s.length - idx - 1) : 0
}

// Helper: precise quantization to step using integer math
function quantizeToStep(value: number, step: number, mode: 'round' | 'floor' = 'round'): number {
  const decimals = countStepDecimals(step)
  const factor = Math.pow(10, decimals)
  const v = Math.round(value * factor)
  const st = Math.round(step * factor)
  let q: number
  if (mode === 'floor') q = Math.floor(v / st) * st
  else q = Math.round(v / st) * st
  return q / factor
}

// Keep legacy signature
function roundToTickSize(price: number, tickSize: number): number {
  return quantizeToStep(price, tickSize, 'round')
}

// V3: Batch flow requested by user
// 1) Send ALL ENTRY orders immediately in parallel
// 2) Wait 2 seconds
// 3) Send ALL SL and TP orders in parallel
async function executeHotTradingOrdersV3_Batch2s(request: PlaceOrdersRequest): Promise<any> {
  const api = getBinanceAPI()
  const results: Array<any> = []
  const priceLogs: Array<any> = []
  const makeId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const workingType: 'MARK_PRICE' = 'MARK_PRICE'

  // Prepare all orders (compute qty, params)
  type Prepared = {
    symbol: string
    order: PlaceOrdersRequest['orders'][number]
    qty: string
    positionSide: 'LONG' | undefined
    entryParams: OrderParams & { __engine?: string }
    rounded: { entry: string, sl: string, tp: string, qty: string }
  }

  const prepared: Prepared[] = []

  for (const order of request.orders) {
    try {
      if (order.side !== 'LONG') { console.warn(`[BATCH_SKIP] non-LONG ${order.symbol}`); continue }

      let positionSide: 'LONG' | undefined
      try { positionSide = (await api.getHedgeMode()) ? 'LONG' : undefined } catch {}

      const entryPx = Number(order.entry); if (!entryPx || entryPx <= 0) throw new Error(`Invalid entry price for ${order.symbol}`)
      const notionalUsd = order.amount * order.leverage
      const qty = await api.calculateQuantity(order.symbol, notionalUsd, entryPx)

      // Get Binance filters for price precision and round prices
      let symbolFilters = { tickSize: null as number | null, stepSize: null as number | null, pricePrecision: null as number | null }
      try {
        const info = await api.getSymbolInfo(order.symbol)
        const priceFilter = (info?.filters || []).find((f: any) => f?.filterType === 'PRICE_FILTER')
        const lotSize = (info?.filters || []).find((f: any) => f?.filterType === 'LOT_SIZE')
        symbolFilters = {
          tickSize: priceFilter ? Number(priceFilter.tickSize) : null,
          stepSize: lotSize ? Number(lotSize.stepSize) : null,
          pricePrecision: Number.isFinite(Number(info?.pricePrecision)) ? Number(info.pricePrecision) : null
        }
      } catch {}

      // RAW passthrough of UI prices: keep EXACT values as provided (no rounding/trimming)
      const entryStr = String(order.entry)
      const slStr = String(order.sl)
      const tpStr = String(order.tp)
      const qtyStr = String(qty)

      const rawLog = {
        symbol: String(order.symbol),
        side: String(order.side || 'LONG').toUpperCase() as 'LONG' | 'SHORT',
        entryRaw: Number(order.entry ?? null) as number | null,
        slRaw: Number(order.sl ?? null) as number | null,
        tpRaw: Number(order.tp ?? null) as number | null
      }
      try { console.info('[PRICE_RAW]', rawLog) } catch {}

      const entryParams: OrderParams & { __engine?: string } = {
        symbol: order.symbol,
        side: 'BUY',
        type: 'LIMIT',
        price: entryStr,
        quantity: qty,
        timeInForce: 'GTC',
        closePosition: false,
        positionSide,
        newClientOrderId: makeId('e_l'),
        newOrderRespType: 'RESULT',
        __engine: 'v3_batch_2s'
      }

      prepared.push({ symbol: order.symbol, order, qty: qtyStr, positionSide, entryParams, rounded: { entry: entryStr, sl: slStr, tp: tpStr, qty: qtyStr } })

      // minimal payload log
      try {
        console.info('[PRICE_PAYLOAD]', {
          symbol: order.symbol,
          entryPayload: { type: 'LIMIT', price: entryStr, timeInForce: 'GTC', quantity: qtyStr },
          slPayload: { type: 'STOP_MARKET', stopPrice: slStr, workingType: String(workingType), closePosition: true },
          tpPayload: { type: 'TAKE_PROFIT', price: tpStr, stopPrice: tpStr, workingType: String(workingType) }
        })
      } catch {}
    } catch (e: any) {
      console.error('[BATCH_PREP_ERROR]', { symbol: order.symbol, error: e?.message })
    }
  }

  // Phase 1: Send ALL ENTRY orders in parallel
  console.error('[BATCH_PHASE_1_ALL_ENTRIES_PARALLEL]', { count: prepared.length, ts: new Date().toISOString() })
  const entrySettled: Array<any> = []
  await Promise.all(prepared.map(async (p) => {
    try {
      // Ensure Binance symbol leverage matches UI-requested leverage before placing entry
      try {
        const levDesiredRaw = Number((p as any)?.order?.leverage)
        const levDesired = Math.max(1, Math.min(125, Math.floor(Number.isFinite(levDesiredRaw) ? levDesiredRaw : 0)))
        if (levDesired > 0) {
          await api.setLeverage(p.symbol, levDesired)
          try { console.info('[SET_LEVERAGE]', { symbol: p.symbol, leverage: levDesired }) } catch {}
        }
      } catch (e:any) {
        try { console.error('[SET_LEVERAGE_ERR]', { symbol: p.symbol, error: (e as any)?.message || e }) } catch {}
        // Continue even if leverage set fails – quantity already reflects requested leverage in notional
      }
      const entryResult = await api.placeOrder(p.entryParams)
      console.error('[ENTRY_SUCCESS]', { symbol: p.symbol, orderId: entryResult?.orderId })
      entrySettled.push({ status: 'fulfilled', value: { symbol: p.symbol, ok: true, res: entryResult } })
    } catch (e: any) {
      console.error('[ENTRY_ERROR]', { symbol: p.symbol, error: e?.message })
      entrySettled.push({ status: 'fulfilled', value: { symbol: p.symbol, ok: false, error: e?.message } })
    }
  }))

  // Phase 2: Wait 3 seconds (per request)
  console.error('[BATCH_PHASE_2_WAIT]', { ms: 3000, ts: new Date().toISOString() })
  await sleep(3000)

  // Phase 3: Send ALL SL immediately; TP policy depends on config (default immediate)
  const tpImmediateMarket = Boolean((tradingCfg as any)?.V3_TP_IMMEDIATE_MARKET !== false)
  console.error('[BATCH_PHASE_3_ALL_EXITS_PARALLEL]', { ts: new Date().toISOString(), tp_policy: tpImmediateMarket ? 'IMMEDIATE_MARKET' : 'WAITING_LIMIT' })
  const exitPromises: Array<Promise<any>> = []
  const exitIndex: Array<{ symbol: string; kind: 'SL' | 'TP' }> = []

  // Start SL now for all symbols (and TP MARKET immediately when enabled)
  for (const p of prepared) {
    const slParams: OrderParams & { __engine?: string } = {
      symbol: p.symbol,
      side: 'SELL',
      type: 'STOP_MARKET',
      stopPrice: p.rounded.sl,
      closePosition: true,
      workingType,
      positionSide: p.positionSide,
      newClientOrderId: makeId('x_sl'),
      newOrderRespType: 'RESULT',
      __engine: 'v3_batch_2s'
    }
    exitPromises.push(api.placeOrder(slParams))
    exitIndex.push({ symbol: p.symbol, kind: 'SL' })

    if (tpImmediateMarket) {
      const tpParams: OrderParams & { __engine?: string } = p.positionSide
        ? { symbol: p.symbol, side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: p.rounded.tp, closePosition: true, workingType, positionSide: p.positionSide, newClientOrderId: makeId('x_tp_tm'), newOrderRespType: 'RESULT', __engine: 'v3_batch_2s' }
        : { symbol: p.symbol, side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: p.rounded.tp, closePosition: true, workingType, newClientOrderId: makeId('x_tp_tm'), newOrderRespType: 'RESULT', __engine: 'v3_batch_2s' }
      exitPromises.push(api.placeOrder(tpParams))
      exitIndex.push({ symbol: p.symbol, kind: 'TP' })
    }
  }

  if (!tpImmediateMarket) {
    // Defer TP LIMIT reduceOnly until a real position exists; schedule background pollers per symbol
    for (const p of prepared) {
      spawnDeferredTpPoller(p.symbol, p.rounded.tp, String(p.rounded.qty), p.positionSide, workingType).catch(()=>{})
    }
  }

  const exitSettledRaw = await Promise.allSettled(exitPromises)
  const combined: Record<string, { sl: any; tp: any; errors: string[] }> = {}
  for (let i = 0; i < exitSettledRaw.length; i += 1) {
    const r = exitSettledRaw[i]
    const idx = exitIndex[i]
    const symbol = idx?.symbol || 'UNKNOWN'
    const kind = idx?.kind || 'SL'
    if (!combined[symbol]) combined[symbol] = { sl: null, tp: null, errors: [] }
    if (r.status === 'fulfilled') {
      if (kind === 'SL') combined[symbol].sl = r.value
      else combined[symbol].tp = r.value
    } else {
      const msg = (r as any)?.reason?.message || 'unknown'
      combined[symbol].errors.push(`${kind}:${msg}`)
    }
  }
  const exitSettled: Array<any> = Object.entries(combined).map(([symbol, v]) => ({ symbol, ok: v.errors.length === 0, sl: v.sl ?? null, tp: v.tp ?? null, error: v.errors.length ? v.errors.join('; ') : null }))

  // Aggregate
  const bySymbol: Record<string, any> = {}
  prepared.forEach(p => { bySymbol[p.symbol] = { symbol: p.symbol } })
  entrySettled.forEach((r: any) => {
    if (r.status === 'fulfilled') {
      const v = r.value
      bySymbol[v.symbol] = { ...bySymbol[v.symbol], entry_order: v.ok ? v.res : null, entry_error: v.ok ? null : v.error }
    }
  })
  // Process exit results (SL + TP are already combined in exitSettled)
  exitSettled.forEach((r: any) => {
    bySymbol[r.symbol] = { ...bySymbol[r.symbol], sl_order: r.sl ?? null, tp_order: r.tp ?? null, exit_error: r.error }
  })

  const final = Object.values(bySymbol)
  final.forEach((r: any) => {
    const status = (!r.entry_error && !r.exit_error) ? 'executed' : 'error'
    results.push({ symbol: r.symbol, status, entry_order: r.entry_order, sl_order: r.sl_order, tp_order: r.tp_order, error: r.entry_error || r.exit_error || null })
  })

  const success = results.every(r => r.status === 'executed')
  return { success, orders: results, timestamp: new Date().toISOString(), engine: 'v3_batch_2s', price_logs: priceLogs }
}
