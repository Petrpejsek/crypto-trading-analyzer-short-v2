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
  reduceOnly?: boolean
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

// Initialize only when needed to avoid startup errors
let binanceAPI: BinanceFuturesAPI | null = null

function getBinanceAPI(): BinanceFuturesAPI {
  if (!binanceAPI) {
    binanceAPI = new BinanceFuturesAPI()
  }
  return binanceAPI
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
        // Interpret 'amount' jako margin v USD; notional = amount * leverage
        const notionalUsd = order.amount * order.leverage

        const info = await api.getSymbolInfo(order.symbol)
        const priceFilter = (info.filters || []).find((f: any) => f.filterType === 'PRICE_FILTER')
        const rawTick = priceFilter?.tickSize
        const tickSize = Number(rawTick)
        const minPrice = Number(priceFilter?.minPrice)
        const maxPrice = Number(priceFilter?.maxPrice)
        if (!Number.isFinite(tickSize) || tickSize <= 0) {
          throw new Error('tick_mismatch:missing_price_filter')
        }
        if (!Number.isFinite(minPrice) || minPrice <= 0) {
          throw new Error('min_price_missing')
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
        const assertBounds = (p: number, label: string) => {
          if (!Number.isFinite(p) || p <= 0) throw new Error(`${label}_invalid`)
          if (p < minPrice - 1e-12) throw new Error(`${label}_lt_min:${minPrice}`)
          if (Number.isFinite(maxPrice) && maxPrice > 0 && p > (maxPrice + 1e-12)) throw new Error(`${label}_gt_max:${maxPrice}`)
        }
        const fmt = (p: number) => p.toFixed(tickDecimals)

        const slNum = Number(order.sl)
        const tpNum = Number(order.tp)
        assertOnTick(slNum, 'sl')
        assertOnTick(tpNum, 'tp')
        assertBounds(slNum, 'sl')
        assertBounds(tpNum, 'tp')
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
        let qtyForEntry: string = '0'
        if (resolvedType === 'limit') {
          if (!hasEntry) throw new Error('limit_entry_missing')
          const entryVal = Number(order.entry)
          assertOnTick(entryVal, 'entry')
          assertBounds(entryVal, 'entry')
          const entryPx = fmt(entryVal)
          try { console.info('[ORDER_VALUES]', { symbol: order.symbol, mode: 'LIMIT', entry: entryPx, sl: slPrice, tp: tpPrice }) } catch {}
          qtyForEntry = await api.calculateQuantity(order.symbol, notionalUsd, Number(entryPx))
          entryRes = await api.placeOrder({ symbol: order.symbol, side: entrySide, type: 'LIMIT', price: entryPx, timeInForce: 'GTC', quantity: qtyForEntry, positionSide })
        } else if (resolvedType === 'stop') {
          if (!hasEntry) throw new Error('stop_entry_missing')
          const trigVal = Number(order.entry)
          assertOnTick(trigVal, 'entry')
          assertBounds(trigVal, 'entry')
          const trig = fmt(trigVal)
          // STRICT: žádný fallback na MARKET – STOP_MARKET přesně na GPT triggeru
          try { console.info('[ORDER_VALUES]', { symbol: order.symbol, mode: 'STOP_MARKET', entry: trig, sl: slPrice, tp: tpPrice }) } catch {}
          qtyForEntry = await api.calculateQuantity(order.symbol, notionalUsd, Number(trig))
          entryRes = await api.placeOrder({ symbol: order.symbol, side: entrySide, type: 'STOP_MARKET', stopPrice: trig, workingType: 'MARK_PRICE', quantity: qtyForEntry, positionSide })
        } else if (resolvedType === 'stop_limit') {
          if (!hasEntry) throw new Error('stop_limit_entry_missing')
          const trigVal = Number(order.entry)
          assertOnTick(trigVal, 'entry')
          assertBounds(trigVal, 'entry')
          const trig = fmt(trigVal)
          // STRICT: žádný fallback na MARKET – STOP (stop-limit) na GPT triggeru
          try { console.info('[ORDER_VALUES]', { symbol: order.symbol, mode: 'STOP_LIMIT', entry: trig, sl: slPrice, tp: tpPrice }) } catch {}
          qtyForEntry = await api.calculateQuantity(order.symbol, notionalUsd, Number(trig))
          entryRes = await api.placeOrder({ symbol: order.symbol, side: entrySide, type: 'STOP', stopPrice: trig, price: trig, timeInForce: 'GTC', quantity: qtyForEntry, positionSide, workingType: 'MARK_PRICE' })
        } else {
          // MARKET je povolen pouze pokud klient poslal 'market'
          qtyForEntry = await api.calculateQuantity(order.symbol, notionalUsd, markPrice)
          entryRes = await api.placeOrder({ symbol: order.symbol, side: entrySide, type: 'MARKET', quantity: qtyForEntry, positionSide })
        }
        // Binance UM Futures: reduceOnly není povoleno pro STOP_MARKET/TP_MARKET – použij closePosition
        const slRes = await api.placeOrder({ symbol: order.symbol, side: exitSide, type: 'STOP_MARKET', stopPrice: slPrice, workingType: 'MARK_PRICE', closePosition: true, positionSide })
        const tpRes = await api.placeOrder({ symbol: order.symbol, side: exitSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, workingType: 'MARK_PRICE', closePosition: true, positionSide })

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
      const raw = String(error?.message || '')
      let friendly = raw
      try {
        if (raw.includes('-4045') || /reach\s+max\s+stop\s+order\s+limit/i.test(raw)) {
          friendly = 'binance_limit_stop_orders: Reach max stop order limit. Zrušte otevřené STOP/TP/SL příkazy nebo snižte počet.'
        } else if (/-4013/.test(raw) || /price\s+less\s+than\s+min\s+price/i.test(raw) || /_lt_min:/i.test(raw)) {
          friendly = 'price_lt_min: Cena je pod minimální cenou pro symbol (PRICE_FILTER.minPrice). Upravte vstup (GPT) na ≥ minPrice.'
        } else if (/_gt_max:/i.test(raw) || /price\s+greater\s+than\s+max\s+price/i.test(raw)) {
          friendly = 'price_gt_max: Cena je nad maximální cenou pro symbol (PRICE_FILTER.maxPrice).'
        } else if (/tick_mismatch/i.test(raw)) {
          friendly = 'tick_mismatch: Cena musí být násobkem tickSize. Upravte vstup dle exchange tickSize.'
        } else if (/sl_would_trigger|tp_would_trigger/i.test(raw)) {
          friendly = 'protection_trigger: SL/TP by se okamžitě aktivoval podle MARK. Upravte hodnoty.'
        } else if (/order_type_invalid/i.test(raw)) {
          friendly = 'order_type_invalid: Nepodporovaný typ příkazu.'
        } else if (/min_price_missing/i.test(raw)) {
          friendly = 'min_price_missing: Nebyl načten minPrice z exchangeInfo. Zkuste znovu.'
        }
      } catch {}
      console.error(`[BINANCE_ORDER_ERROR] ${order.symbol}:`, raw)
      results.push({
        symbol: order.symbol,
        status: 'error',
        error: friendly
      })
    }
  }
  
  const executedOk = results.every((r: any) => r.status === 'executed' || r.status === 'mock_success')
  return { success: executedOk, orders: results, timestamp: new Date().toISOString() }
}
