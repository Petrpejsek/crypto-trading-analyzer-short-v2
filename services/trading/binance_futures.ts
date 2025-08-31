import crypto from 'crypto'

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
    const queryParams: Record<string,string> = { ...Object.fromEntries(Object.entries(params).map(([k,v]) => [k, String(v)])), timestamp: String(timestamp) }
    const queryString = new URLSearchParams(queryParams).toString()
    const signature = this.sign(queryString)
    const url = `${this.baseURL}${endpoint}?${queryString}&signature=${signature}`

    const DEBUG = String(process.env.DEBUG_BINANCE ?? '1').toLowerCase() !== '0'
    if (DEBUG) {
      const safe = { method, endpoint, params: { ...params, timestamp: '<ts>' } }
      // eslint-disable-next-line no-console
      console.info('[BINANCE_REQ]', safe)
    }

    const response = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    })

    const text = await response.text()
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
    return this.request('POST', '/fapi/v1/order', params)
  }

  async cancelAllOrders(symbol: string): Promise<any> {
    return this.request('DELETE', '/fapi/v1/allOpenOrders', { symbol })
  }

  async getPositions(): Promise<any> {
    return this.request('GET', '/fapi/v2/positionRisk')
  }

  async getMarkPrice(symbol: string): Promise<number> {
    const r = await this.request('GET', '/fapi/v1/premiumIndex', { symbol })
    const p = Number(r?.markPrice)
    if (!Number.isFinite(p) || p <= 0) throw new Error('Bad mark price')
    return p
  }

export async function fetchMarkPrice(symbol: string): Promise<number> {
  const api = getBinanceAPI()
  return api.getMarkPrice(symbol)
}

export async function fetchLastTradePrice(symbol: string): Promise<number> {
  const api = getBinanceAPI()
  return api.getLastPrice(symbol)
}

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

// Initialize only when needed to avoid startup errors
let binanceAPI: BinanceFuturesAPI | null = null

function getBinanceAPI(): BinanceFuturesAPI {
  if (!binanceAPI) {
    binanceAPI = new BinanceFuturesAPI()
  }
  return binanceAPI
}

export async function executeHotTradingOrders(request: PlaceOrdersRequest): Promise<any> {
  console.log('[BINANCE_ORDERS] Executing orders for', request.orders.length, 'symbols')
  
  const results = []
  
  // Resolve hedge mode once
  let hedgeMode = false
  try {
    const api = getBinanceAPI()
    hedgeMode = await api.getHedgeMode()
  } catch {}

  for (const order of request.orders) {
    try {
      console.log(`[BINANCE_ORDER] Processing ${order.symbol} - ${order.side} - ${order.strategy} - ${order.tpLevel}`)
      
      // Check if real API keys are configured (not mock ones)
      const hasRealKeys = process.env.BINANCE_API_KEY && 
                         process.env.BINANCE_SECRET_KEY && 
                         !process.env.BINANCE_API_KEY.includes('mock') &&
                         !process.env.BINANCE_SECRET_KEY.includes('mock')
      
      if (hasRealKeys) {
        // Real Binance API call (when keys are configured)
        const api = getBinanceAPI()
        await api.setLeverage(order.symbol, order.leverage)

        const sideLong = (order.side || 'LONG') === 'LONG'
        const entrySide: 'BUY' | 'SELL' = sideLong ? 'BUY' : 'SELL'
        const exitSide: 'BUY' | 'SELL' = sideLong ? 'SELL' : 'BUY'
        const positionSide: 'LONG' | 'SHORT' | undefined = hedgeMode ? (sideLong ? 'LONG' : 'SHORT') : undefined

        const lastPrice = await api.getLastPrice(order.symbol)
        const markPrice = await api.getMarkPrice(order.symbol)
        // Interpret 'amount' as margin in USD; notional = amount * leverage
        const notionalUsd = order.amount * order.leverage
        const qty = await api.calculateQuantity(order.symbol, notionalUsd, lastPrice)

        const info = await api.getSymbolInfo(order.symbol)
        const priceFilter = (info.filters || []).find((f: any) => f.filterType === 'PRICE_FILTER')
        const rawTick = priceFilter?.tickSize
        const tickSize = Number(rawTick)
        if (!Number.isFinite(tickSize) || tickSize <= 0) {
          throw new Error('tick_mismatch:missing_price_filter')
        }
        const tickDecimals = (() => {
          const s = String(rawTick)
          const i = s.indexOf('.')
          return i >= 0 ? (s.length - i - 1) : 0
        })()
        const assertOnTick = (p: number, label: string) => {
          if (!Number.isFinite(p) || p <= 0) throw new Error(`${label}_invalid`)
          const q = p / tickSize
          if (Math.abs(q - Math.round(q)) > 1e-9) throw new Error(`${label}_tick_mismatch`)
        }
        const fmt = (p: number) => p.toFixed(tickDecimals)

        const slNum = Number(order.sl)
        const tpNum = Number(order.tp)
        assertOnTick(slNum, 'sl')
        assertOnTick(tpNum, 'tp')
        const slPrice = fmt(slNum)
        const tpPrice = fmt(tpNum)

        // Guard against immediate trigger (use MARK_PRICE because workingType='MARK_PRICE')
        if (sideLong) {
          // SL must be strictly < markPrice by at least 1 tick; TP must be strictly > markPrice by at least 1 tick
          if (!((markPrice - slNum) > tickSize - 1e-12)) {
            throw new Error(`sl_would_trigger: sl=${slNum} mark=${markPrice}`)
          }
          if (!((tpNum - markPrice) > tickSize - 1e-12)) {
            throw new Error(`tp_would_trigger: tp=${tpNum} mark=${markPrice}`)
          }
        } else {
          if (!((slNum - markPrice) > tickSize - 1e-12)) {
            throw new Error(`sl_would_trigger: sl=${slNum} mark=${markPrice}`)
          }
          if (!((markPrice - tpNum) > tickSize - 1e-12)) {
            throw new Error(`tp_would_trigger: tp=${tpNum} mark=${markPrice}`)
          }
        }

        // Entry order mode (STRICT: nikdy nespadni na MARKET, pokud bylo vyžádáno LIMIT/STOP a chybí entry)
        const tRaw = String(order.orderType||'').toLowerCase()
        const allowed = ['market','limit','stop','stop_limit']
        if (!allowed.includes(tRaw)) {
          throw new Error(`order_type_invalid:${order.orderType}`)
        }
        const resolvedType = tRaw as 'market'|'limit'|'stop'|'stop_limit'
        const hasEntry = Number.isFinite(order.entry)
        console.info('[ENTRY_ROUTING]', { symbol: order.symbol, requested: order.orderType || null, strategy: order.strategy, resolvedType, entry: order.entry, hasEntry })

        let entryRes: any
        if (resolvedType === 'limit') {
          if (!hasEntry) throw new Error('limit_entry_missing')
          const entryVal = Number(order.entry)
          assertOnTick(entryVal, 'entry')
          const entryPx = fmt(entryVal)
          entryRes = await api.placeOrder({ symbol: order.symbol, side: entrySide, type: 'LIMIT', price: entryPx, timeInForce: 'GTC', quantity: qty, positionSide })
        } else if (resolvedType === 'stop') {
          if (!hasEntry) throw new Error('stop_entry_missing')
          const trigVal = Number(order.entry)
          assertOnTick(trigVal, 'entry')
          const trig = fmt(trigVal)
          // If entry trigger je už aktivní (mark >= entry pro LONG; mark <= entry pro SHORT), přepni na MARKET
          const entryWouldTrigger = sideLong ? (markPrice >= Number(trig)) : (markPrice <= Number(trig))
          if (entryWouldTrigger) {
            entryRes = await api.placeOrder({ symbol: order.symbol, side: entrySide, type: 'MARKET', quantity: qty, positionSide })
          } else {
            entryRes = await api.placeOrder({ symbol: order.symbol, side: entrySide, type: 'STOP', stopPrice: trig, price: trig, timeInForce: 'GTC', quantity: qty, positionSide, workingType: 'MARK_PRICE' })
          }
        } else if (resolvedType === 'stop_limit') {
          if (!hasEntry) throw new Error('stop_limit_entry_missing')
          const trigVal = Number(order.entry)
          assertOnTick(trigVal, 'entry')
          const trig = fmt(trigVal)
          const entryWouldTrigger = sideLong ? (markPrice >= Number(trig)) : (markPrice <= Number(trig))
          if (entryWouldTrigger) {
            entryRes = await api.placeOrder({ symbol: order.symbol, side: entrySide, type: 'MARKET', quantity: qty, positionSide })
          } else {
            entryRes = await api.placeOrder({ symbol: order.symbol, side: entrySide, type: 'STOP', stopPrice: trig, price: trig, timeInForce: 'GTC', quantity: qty, positionSide, workingType: 'MARK_PRICE' })
          }
        } else {
          // MARKET je povolen pouze pokud klient poslal 'market'
          entryRes = await api.placeOrder({ symbol: order.symbol, side: entrySide, type: 'MARKET', quantity: qty, positionSide })
        }
        const slRes = await api.placeOrder({ symbol: order.symbol, side: exitSide, type: 'STOP_MARKET', stopPrice: slPrice, workingType: 'MARK_PRICE', timeInForce: 'GTC', quantity: qty, positionSide })
        const tpRes = await api.placeOrder({ symbol: order.symbol, side: exitSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, workingType: 'MARK_PRICE', timeInForce: 'GTC', quantity: qty, positionSide })

        results.push({
          symbol: order.symbol,
          status: 'executed',
          strategy: order.strategy,
          side: order.side,
          tpLevel: order.tpLevel,
          amount: order.amount,
          leverage: order.leverage,
          entry_order: entryRes,
          sl_order: slRes,
          tp_order: tpRes
        })
      } else {
        // Mock response when no real keys
        results.push({
          symbol: order.symbol,
          status: 'mock_success',
          side: order.side,
          strategy: order.strategy,
          tpLevel: order.tpLevel,
          amount: order.amount,
          leverage: order.leverage,
          sl: order.sl,
          tp: order.tp,
          message: 'Mock order - Add BINANCE_API_KEY & BINANCE_SECRET_KEY to .env.local for real trading'
        })
      }
      
    } catch (error: any) {
      console.error(`[BINANCE_ORDER_ERROR] ${order.symbol}:`, error.message)
      results.push({
        symbol: order.symbol,
        status: 'error',
        error: error.message
      })
    }
  }
  
  const executedOk = results.every((r: any) => r.status === 'executed' || r.status === 'mock_success')
  return { success: executedOk, orders: results, timestamp: new Date().toISOString() }
}
