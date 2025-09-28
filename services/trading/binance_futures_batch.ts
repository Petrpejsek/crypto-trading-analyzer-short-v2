import crypto from 'crypto'
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
  }

  private sign(queryString: string): string {
    return crypto
      .createHmac('sha256', this.secretKey)
      .update(queryString)
      .digest('hex')
  }

  private async request(method: string, endpoint: string, params: Record<string, any> = {}): Promise<any> {
    // Best-effort server time sync
    let timestamp = Date.now()
    try {
      const res = await fetch('https://fapi.binance.com/fapi/v1/time')
      const j = await res.json().catch(()=>null)
      const srv = Number(j?.serverTime)
      if (Number.isFinite(srv)) timestamp = srv
    } catch {}
    // Last-mile global sanitization for all order-sending endpoints
    try {
      const methodUp = String(method || '').toUpperCase()
      const isOrderPost = methodUp === 'POST' && (endpoint === '/fapi/v1/order' || endpoint === '/fapi/v1/batchOrders')
      if (isOrderPost) {
        const safeMode = ((tradingCfg as any)?.SAFE_MODE_LONG_ONLY === true)
        const tpModeCfg = ((tradingCfg as any)?.TP_MODE === 'LIMIT_ON_FILL')
          // === LAST-MILE SANITIZACE (AGRESIVNÍ OPRAVY PRO 100% FUNKČNOST) ===
          const cpAllowed = (t: string) => t === 'STOP_MARKET' || t === 'TAKE_PROFIT_MARKET'

          const forceMarketTP = (o: any) => {
            if (!o || typeof o !== 'object') return o
            const engineTag = (()=>{ try { return String(o.__engine || params.__engine || 'unknown') } catch { return 'unknown' } })()
            
            // DEBUG: Co přichází do sanitizace
            try { console.error('[DEBUG_SANITIZE_IN]', { symbol: o.symbol, type: o.type, closePosition: o.closePosition, reduceOnly: o.reduceOnly }) } catch {}
            
            // 1) SELEKTIVNÍ SANITIZACE: Jen TAKE_PROFIT s closePosition=true → MARKET
            if (o?.type === 'TAKE_PROFIT' && o?.closePosition === true && !o?.quantity) {
              console.error('[HOTFIX_CONVERTING_TP_TO_MARKET]', { symbol: o.symbol, from: 'TAKE_PROFIT_closePosition', to: 'TAKE_PROFIT_MARKET' })
              o.type = 'TAKE_PROFIT_MARKET'
              o.stopPrice = o.stopPrice ?? o.price
              delete o.price
              delete o.timeInForce
              o.closePosition = true
              o.side = 'SELL'
              o.workingType = 'MARK_PRICE'
            }
            
            // 2) DODATEČNÁ SANITIZACE: Pokud je stále TAKE_PROFIT s closePosition=true, FORCE na MARKET
            if (o?.type === 'TAKE_PROFIT' && o?.closePosition === true) {
              console.error('[EMERGENCY_TP_CONVERSION]', { symbol: o.symbol, converting: 'TAKE_PROFIT_closePosition_true_to_MARKET' })
              o.type = 'TAKE_PROFIT_MARKET'
              o.stopPrice = o.stopPrice ?? o.price
              delete o.price
              delete o.timeInForce
              // Nemaž quantity pokud už je nastavena (batch mode)
              if (!o.quantity) {
                o.closePosition = true
              }
              o.side = 'SELL'
              o.workingType = 'MARK_PRICE'
            }
            
            // 3) closePosition:true dovoleno jen pro SL MARKET a TP MARKET
            if (o?.closePosition === true && !cpAllowed(o.type)) {
              o.closePosition = false
            }
            
            // 4) TP MARKET nikdy nemá mít price
            if (o?.type === 'TAKE_PROFIT_MARKET' && o.price != null) {
              delete o.price
            }
            
            // 5) BATCH MODE: Pro TP_MARKET s quantity+reduceOnly je to OK, nemaž reduceOnly
            // Maž reduceOnly jen u closePosition bez quantity (starý problém)
            if (o?.closePosition === true && o?.reduceOnly === true && !o?.quantity) {
              console.error('[FIXING_REDUCEONLY_CLOSEPOSITION]', { symbol: o.symbol, type: o.type, removing_reduceOnly_from_closePosition: true })
              delete o.reduceOnly
            }

          // SAFE mode whitelist
          if (safeMode) {
            const allowed = (
              (String(o.side) === 'BUY' && (String(o.type) === 'LIMIT' || String(o.type) === 'MARKET') && o.closePosition !== true) ||
              (String(o.side) === 'SELL' && String(o.type) === 'STOP_MARKET' && (o.closePosition === true || o.reduceOnly === true)) ||
              (String(o.side) === 'SELL' && String(o.type) === 'TAKE_PROFIT_MARKET' && (o.closePosition === true || o.reduceOnly === true)) ||
              (String(o.side) === 'SELL' && String(o.type) === 'TAKE_PROFIT')
            )
            if (!allowed) {
              try { console.error('[BLOCKED_ORDER]', { engine: engineTag, symbol: String(o.symbol), side: String(o.side), type: String(o.type), closePosition: !!o.closePosition, reduceOnly: !!o.reduceOnly }) } catch {}
              throw new Error('SAFE_MODE: blocked non-whitelisted order')
            }
          }

          try {
            console.info('[OUTGOING_ORDER]', {
              engine: engineTag,
              symbol: String(o.symbol), side: String(o.side), type: String(o.type),
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
          params = forceMarketTP(params)
          if (params?.type === 'TAKE_PROFIT' && params?.closePosition === true) {
            console.error('[ASSERT_FAIL] TP_LIMIT_with_closePosition_true', params)
            throw new Error('ASSERT: TP_LIMIT with closePosition:true blocked')
          }
          if (params?.closePosition === true && !cpAllowed(params?.type)) {
            console.error('[ASSERT_FAIL] closePosition_true_invalid_type', params)
            throw new Error('ASSERT: closePosition true only for SL/TP_MARKET')
          }
        } else if (endpoint === '/fapi/v1/batchOrders') {
          if (Array.isArray(params?.batchOrders)) {
            params.batchOrders = params.batchOrders.map(forceMarketTP)
          }
        }
      }
    } catch {}

    const defaultRecvWindow = (() => {
      const env = Number(process.env.BINANCE_RECV_WINDOW_MS)
      if (Number.isFinite(env) && env > 0) return Math.min(120000, Math.floor(env))
      return 60000
    })()
    const queryString = `${Object.entries({ ...params, timestamp, recvWindow: defaultRecvWindow }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`
    const signature = this.sign(queryString)
    const finalQueryString = `${queryString}&signature=${signature}`

    const url = `${this.baseURL}${endpoint}?${finalQueryString}`
    const headers = {
      'X-MBX-APIKEY': this.apiKey,
      'Content-Type': 'application/x-www-form-urlencoded'
    }

    try {
      const response = await fetch(url, { method, headers })
      const responseText = await response.text()
      try {
        const headersLike: Record<string, string> = {}
        try { (response.headers as any).forEach((v: string, k: string) => { headersLike[String(k)] = String(v) }) } catch {}
        const statusNum = Number(response.status)
        let errCode: number | null = null
        let errMsg: string | null = null
        if (!response.ok) {
          try { const j = JSON.parse(responseText); if (typeof j?.code !== 'undefined') errCode = Number(j.code); if (typeof j?.msg !== 'undefined') errMsg = String(j.msg) } catch {}
        }
        try { noteApiCall({ method, path: endpoint, status: statusNum, headers: headersLike, errorCode: errCode, errorMsg: errMsg }) } catch {}
        if (errCode === -1003) {
          try { const m = String(errMsg || '').match(/banned\s+until\s+(\d{10,})/i); if (m && m[1]) setBanUntilMs(Number(m[1])) } catch {}
        }
      } catch {}
      
      if (!response.ok) {
        // Enhanced error parsing for Binance API
        let parsedError: any = null
        try {
          parsedError = JSON.parse(responseText)
        } catch {}
        
        const code = parsedError?.code || null
        const msg = parsedError?.msg || responseText || 'Unknown error'
        
        // Log full payload on API errors for debugging
        try {
          console.error('[BINANCE_ERROR]', {
            status: response.status,
            code,
            message: msg,
            endpoint,
            method,
            payload: params
          })
        } catch {}
        
        throw new Error(`Binance API error: ${response.status} ${responseText}`)
      }
      
      return JSON.parse(responseText)
    } catch (error: any) {
      if (error.message?.includes('Binance API error:')) {
        throw error
      }
      throw new Error(`Network error: ${error.message}`)
    }
  }

  async getMarkPrice(symbol: string): Promise<string> {
    const response = await this.request('GET', '/fapi/v1/premiumIndex', { symbol })
    return response.markPrice
  }

  async getSymbolInfo(symbol: string): Promise<any> {
    const response = await this.request('GET', '/fapi/v1/exchangeInfo')
    const symbols = response.symbols || []
    return symbols.find((s: any) => s.symbol === symbol)
  }

  async getHedgeMode(): Promise<boolean> {
    try {
      const response = await this.request('GET', '/fapi/v1/positionSide/dual')
      return response.dualSidePosition === true
    } catch {
      return false
    }
  }

  async calculateQuantity(symbol: string, notionalUsd: number, price: number): Promise<string> {
    const info = await this.getSymbolInfo(symbol)
    const lotSizeFilter = info?.filters?.find((f: any) => f.filterType === 'LOT_SIZE')
    const stepSize = Number(lotSizeFilter?.stepSize || '0.001')
    
    const rawQty = notionalUsd / price
    const adjustedQty = Math.floor(rawQty / stepSize) * stepSize
    
    return adjustedQty.toFixed(8).replace(/\.?0+$/, '')
  }

  async placeOrder(params: OrderParams): Promise<any> {
    return this.request('POST', '/fapi/v1/order', params)
  }

  async getOpenOrders(symbol?: string): Promise<any> {
    const params = symbol ? { symbol } : {}
    return this.request('GET', '/fapi/v1/openOrders', params)
  }

  // Add position risk method for waitForPositionSize
  async getPositionRisk(): Promise<any> {
    return this.request('GET', '/fapi/v2/positionRisk')
  }
}

const getBinanceAPI = () => wrapBinanceFuturesApi(new BinanceFuturesAPI())

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitForPositionSize(symbol: string, options: { sideLong?: boolean; positionSide?: string }, timeoutMs = 5000): Promise<string> {
  const api = getBinanceAPI()
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const positions = await api.getPositionRisk()
      const position = positions.find((p: any) => p.symbol === symbol && Number(p.positionAmt) !== 0)
      if (position) {
        const size = Math.abs(Number(position.positionAmt))
        if (size > 0) return String(size)
      }
    } catch {}
    await sleep(100)
  }
  return '0'
}

export async function executeHotTradingOrdersV2(request: PlaceOrdersRequest): Promise<any> {
  const api = getBinanceAPI()
  const results: any[] = []
  const priceLogs: any[] = []
  const PROJECT_CID_PREFIX = 'sv2'
  const makeId = (p: string) => `${PROJECT_CID_PREFIX}_${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  const tpMode = ((tradingCfg as any)?.TP_MODE === 'LIMIT_ON_FILL') ? 'LIMIT_ON_FILL' as const : 'MARKET_PREENTRY' as const
  const disableSl = ((tradingCfg as any)?.DISABLE_SL === true)
  
  // DEBUG: Zkontroluj konfiguraci
  try {
    console.error('[TP_CONFIG_DEBUG]', { 
      finalTpMode: tpMode,
      mode: 'BATCH_SAFE',
      rawConfig: { DISABLE_LIMIT_TP: (tradingCfg as any)?.DISABLE_LIMIT_TP, SAFE_MODE_LONG_ONLY: (tradingCfg as any)?.SAFE_MODE_LONG_ONLY, DISABLE_SL: (tradingCfg as any)?.DISABLE_SL },
      disableSl
    })
  } catch {}

  // BATCH MODE: Prepare all orders first
  const orderData: any[] = []
  
  for (const order of request.orders) {
    try {
      if (order.side !== 'LONG') { console.warn(`[BATCH_SKIP] non-LONG ${order.symbol}`); continue }

      let positionSide: 'LONG' | undefined; try { positionSide = (await api.getHedgeMode()) ? 'LONG' : undefined } catch {}
      const entryPx = Number(order.entry); if (!entryPx || entryPx <= 0) throw new Error(`Invalid entry price for ${order.symbol}`)
      const notionalUsd = order.amount * order.leverage
      const qty = await api.calculateQuantity(order.symbol, notionalUsd, entryPx)
      const workingType: 'MARK_PRICE' = 'MARK_PRICE'

      const rawLog = {
        symbol: String(order.symbol),
        entryRaw: Number(order.entry ?? null) as number | null,
        slRaw: Number(order.sl ?? null) as number | null,
        tpRaw: Number(order.tp ?? null) as number | null
      }
      try { console.info('[PRICE_RAW]', rawLog) } catch {}

      // Compute symbol filters for debug (tickSize / stepSize / pricePrecision)
      let filters = { tickSize: null as number | null, stepSize: null as number | null, pricePrecision: null as number | null }
      try {
        const info = await api.getSymbolInfo(order.symbol)
        const priceFilter = (info?.filters || []).find((f: any) => f?.filterType === 'PRICE_FILTER')
        const lotSize = (info?.filters || []).find((f: any) => f?.filterType === 'LOT_SIZE')
        filters = {
          tickSize: priceFilter ? Number(priceFilter.tickSize) : null,
          stepSize: lotSize ? Number(lotSize.stepSize) : null,
          pricePrecision: Number.isFinite(Number(info?.pricePrecision)) ? Number(info.pricePrecision) : null
        }
      } catch {}

      // ENTRY - respektuj orderType z requestu
      const isMarketEntry = (order.orderType === 'market')
      const entryParams: OrderParams & { __engine?: string } = {
        symbol: order.symbol,
        side: 'BUY',
        type: isMarketEntry ? 'MARKET' : 'LIMIT',
        ...(isMarketEntry ? {} : { price: String(order.entry), timeInForce: 'GTC' }),
        quantity: qty,
        closePosition: false,
        positionSide,
        newClientOrderId: makeId(isMarketEntry ? 'e_m' : 'e_l'),
        __engine: 'v2_batch_safe'
      }

      // Prepare PAYLOAD snapshot before any API calls
      const entryPayload = { type: 'LIMIT' as string | null, price: Number(order.entry), timeInForce: 'GTC' as string | null }
      const slPayload = { type: 'STOP_MARKET' as string | null, stopPrice: Number(order.sl), workingType: String(workingType), closePosition: true as boolean | null }
      const tpPayload = (tpMode === 'LIMIT_ON_FILL')
        ? ({ type: 'TAKE_PROFIT' as const, price: Number(order.tp), stopPrice: Number(order.tp), workingType: String(workingType), reduceOnly: true })
        : ({ type: 'TAKE_PROFIT_MARKET' as const, price: null, stopPrice: Number(order.tp), workingType: String(workingType), reduceOnly: true })

      const payloadLog = {
        symbol: String(order.symbol),
        entryPayload,
        slPayload,
        tpPayload,
        config: { useBuffer: (order as any)?.useBuffer ?? null, tpMode, amountMode: null, postOnly: null },
        filters
      }
      try { console.info('[PRICE_PAYLOAD]', payloadLog) } catch {}

      orderData.push({
        order,
        qty,
        entryParams,
        workingType,
        positionSide,
        rawLog,
        payloadLog,
        filters
      })
    } catch (e: any) {
      console.error(`[BATCH_PREP_ERROR] ${order.symbol}:`, e?.message || e)
      results.push({ symbol: order.symbol, status: 'error', error: e?.message || 'prep_failed' })
    }
  }

  if (orderData.length === 0) {
    return { success: false, orders: results, timestamp: new Date().toISOString(), engine: 'v2_batch_safe', price_logs: priceLogs }
  }

  // PHASE 1: Send all ENTRY orders in parallel
  console.error('[BATCH_PHASE_1_START]', { count: orderData.length, action: 'sending_all_entries_parallel' })
  const entryResults = await Promise.allSettled(
    orderData.map(async (data) => {
      try {
        console.info('[SAFE_PLAN]', { symbol: data.order.symbol, entry: Number(data.order.entry), sl: Number(data.order.sl), tp: Number(data.order.tp), mode: 'BATCH_SAFE' })
        const entryRes = await api.placeOrder(data.entryParams)
        console.error('[ENTRY_SUCCESS]', { symbol: data.order.symbol, orderId: entryRes?.orderId })
        return { symbol: data.order.symbol, result: entryRes, data }
      } catch (e: any) {
        console.error('[ENTRY_ERROR]', { symbol: data.order.symbol, error: e?.message })
        return { symbol: data.order.symbol, error: e?.message || 'entry_failed', data }
      }
    })
  )

  // PHASE 2: Wait for fills (global wait)
  console.error('[BATCH_PHASE_2_START]', { action: 'waiting_for_entry_fills', duration: '3.5s' })
  await sleep(3500)

  // PHASE 3: Send all SL+TP orders in parallel
  console.error('[BATCH_PHASE_3_START]', { action: 'sending_all_sl_tp_parallel' })
  const exitResults = await Promise.allSettled(
    entryResults.map(async (entryResult) => {
      if (entryResult.status === 'rejected') {
        return { symbol: 'unknown', error: 'entry_promise_rejected' }
      }
      if ((entryResult.value as any).error) {
        return { symbol: (entryResult.value as any).symbol, error: 'entry_failed_skip_exits' }
      }

      const { symbol, result: entryRes, data } = entryResult.value as any
      
      try {
        // Get position size for this symbol
        let positionQty = data.qty
        let hasPosition = false
        try {
          const size = await waitForPositionSize(symbol, { sideLong: true, positionSide: data.positionSide }, 1000)
          if (Number(size) > 0) {
            positionQty = String(size)
            hasPosition = true
            console.error('[POSITION_FOUND]', { symbol, size, positionQty })
          } else {
            console.error('[POSITION_NOT_FOUND]', { symbol, defaulting_to: data.qty })
          }
        } catch (e: any) {
          console.error('[POSITION_CHECK_ERROR]', { symbol, error: e?.message, defaulting_to: data.qty })
        }

        // STRATEGIE: Pokud není pozice, pošli s closePosition=true (bez reduceOnly) – ale jen pokud tp>mark/sl<mark
        // Pokud je pozice, pošli s reduceOnly=true (bez closePosition)
        let tpParams: OrderParams & { __engine?: string }
        let slParams: OrderParams & { __engine?: string }
        
        if (hasPosition) {
          // S pozicí: quantity + reduceOnly - LIMIT TP (musí být TP > Entry pro LONG!)
          tpParams = { 
            symbol, 
            side: 'SELL', 
            type: 'TAKE_PROFIT', 
            price: String(data.order.tp), 
            quantity: positionQty,
            reduceOnly: true,
            timeInForce: 'GTC',
            positionSide: data.positionSide, 
            newClientOrderId: makeId('x_tp_limit'), 
            __engine: 'v2_batch_safe'
          }
          slParams = { 
            symbol, 
            side: 'SELL', 
            type: 'STOP_MARKET', 
            stopPrice: String(order.sl), 
            quantity: positionQty,
            reduceOnly: true,
            workingType: data.workingType, 
            positionSide: data.positionSide, 
            newClientOrderId: makeId('x_sl'), 
            __engine: 'v2_batch_safe'
          }
        } else {
          // Bez pozice: closePosition=true (bez quantity, bez reduceOnly)
          tpParams = { 
            symbol, 
            side: 'SELL', 
            type: 'TAKE_PROFIT_MARKET', 
            stopPrice: String(order.tp), 
            closePosition: true,
            workingType: data.workingType, 
            positionSide: data.positionSide, 
            newClientOrderId: makeId('x_tp_tm'), 
            __engine: 'v2_batch_safe'
          }
          slParams = { 
          slParams = { 
            symbol, 
            side: 'SELL', 
            type: 'STOP_MARKET', 
            stopPrice: String(order.sl), 
            closePosition: true,
            workingType: data.workingType, 
            positionSide: data.positionSide, 
            newClientOrderId: makeId('x_sl'), 
            __engine: 'v2_batch_safe'
          }
        }

        let slRes: any = null
        let tpRes: any = null
        if (tpMode === 'LIMIT_ON_FILL') {
          // Pošli TP LIMIT hned (bez reduceOnly, bez closePosition); SL jen pokud není vypnut
          if (!disableSl) slRes = await api.placeOrder(slParams)
          const tpLimit: OrderParams & { __engine?: string } = {
            symbol,
            side: 'SELL',
            type: 'TAKE_PROFIT',
            price: String(data.order.tp),
            stopPrice: String(order.tp),
            timeInForce: 'GTC',
            quantity: data.qty,
            // reduceOnly not sent pre-entry
            workingType: data.workingType,
            positionSide: data.positionSide,
            newClientOrderId: makeId('x_tp_l'),
            __engine: 'v2_batch_safe'
          }
          try { tpRes = await api.placeOrder(tpLimit) } catch (e: any) { console.error('[BATCH_TP_LIMIT_ERR]', { symbol, error: e?.message }) }
        } else {
          // MARKET_PREENTRY policy with MARK gating
          let markPx: string | null = null
          try { markPx = await api.getMarkPrice(symbol) } catch {}
          const tpOk = hasPosition || (Number(data.order.tp) > Number(markPx))
          const slOk = hasPosition || (Number(data.order.sl) < Number(markPx))
          console.error('[BATCH_TP_SL_POLICY]', { symbol, hasPosition, mark: Number(markPx), tp: Number(data.order.tp), sl: Number(data.order.sl), tpOk, slOk })
          const reqs: Array<Promise<any>> = []
          if (!disableSl && slOk) reqs.push(api.placeOrder(slParams))
          if (tpOk) reqs.push(api.placeOrder(tpParams))
          const pair = await Promise.all(reqs)
          if (reqs.length === 2) { slRes = pair[0]; tpRes = pair[1] }
          else if (reqs.length === 1) { slRes = null; tpRes = pair[0] }
        }
        try {
          console.info('[BATCH_SL_TP_ECHO_BRIEF]', {
            symbol,
            sl: { id: slRes?.orderId ?? null, type: slRes?.type ?? null, stopPrice: slRes?.stopPrice ?? null },
            tp: { id: tpRes?.orderId ?? null, type: tpRes?.type ?? null, stopPrice: tpRes?.stopPrice ?? null }
          })
        } catch {}

        console.error('[SL_TP_SUCCESS]', { symbol, tpId: tpRes?.orderId, slId: slRes?.orderId })
        
        // Create echo log
        const pickEcho = (r: any) => ({
          type: r && r.type ? String(r.type) : null,
          price: Number.isFinite(Number(r?.price)) ? Number(r.price) : null,
          stopPrice: Number.isFinite(Number(r?.stopPrice)) ? Number(r.stopPrice) : null
        })
        const echoLog = {
          symbol: String(symbol),
          entryEcho: pickEcho(entryRes),
          slEcho: pickEcho(slRes),
          tpEcho: pickEcho(tpRes)
        }
        try { console.info('[PRICE_ECHO]', echoLog) } catch {}
        priceLogs.push({ symbol: String(symbol), raw: data.rawLog, payload: data.payloadLog, echo: echoLog })

        return { symbol, entryRes, slRes, tpRes }
      } catch (e: any) {
        console.error('[SL_TP_ERROR]', { symbol, error: e?.message })
        return { symbol, error: e?.message || 'sl_tp_failed', entryRes }
      }
    })
  )

  // Compile final results
  for (const exitResult of exitResults) {
    if (exitResult.status === 'rejected') {
      results.push({ symbol: 'unknown', status: 'error', error: 'exit_promise_rejected' })
      continue
    }

    const { symbol, entryRes, slRes, tpRes, error } = exitResult.value as any
    if (error) {
      results.push({ symbol, status: 'error', error, entry_order: entryRes || null })
    } else {
      results.push({ symbol, status: 'executed', entry_order: entryRes, sl_order: slRes, tp_order: tpRes })
    }
  }

  const success = results.every(r => r.status === 'executed')
  return { success, orders: results, timestamp: new Date().toISOString(), engine: 'v2_batch_safe', price_logs: priceLogs }
}
