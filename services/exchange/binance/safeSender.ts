// services/exchange/binance/safeSender.ts
// Safe sender wrappers for Binance Futures HTTP clients

type AnyObj = Record<string, any>

const isAllowedClosePosition = (t: string) => t === 'STOP_MARKET' || t === 'TAKE_PROFIT_MARKET'

function cloneJson<T extends AnyObj>(o: T): T {
  try { return JSON.parse(JSON.stringify(o)) } catch { return { ...(o as any) } }
}

export function sanitizeOne(o: AnyObj): AnyObj {
  const p: AnyObj = { ...o }

  // ŽÁDNÉ AUTOMATICKÉ KONVERZE. Sanitizer jen čistí tvar, ne mění typy.

  // TP MARKET must not have price
  if (p.type === 'TAKE_PROFIT_MARKET' && p.price != null) {
    delete p.price
  }

  // Extra verbose debug for TP/SL path
  try {
    const isExit = String(p.type||'').startsWith('STOP') || String(p.type||'').startsWith('TAKE_PROFIT') || p.reduceOnly || p.closePosition
    if (isExit) {
      console.info('[SAN_EXIT_DEBUG]', {
        symbol: String(p.symbol||''), side: String(p.side||''), type: String(p.type||''),
        stopPrice: p.stopPrice ?? null, price: p.price ?? null,
        reduceOnly: !!p.reduceOnly, closePosition: !!p.closePosition,
        workingType: p.workingType ?? null
      })
    } else {
      console.info('[SAN_ENTRY_DEBUG]', {
        symbol: String(p.symbol||''), side: String(p.side||''), type: String(p.type||''),
        price: p.price ?? null, timeInForce: p.timeInForce ?? null
      })
    }
  } catch {}

  // Never send reduceOnly together with closePosition
  if (p.closePosition === true && p.reduceOnly === true) {
    delete p.reduceOnly
  }

  // EARLY EXIT (musí být hned na začátku):
  // Pro TP SELL LIMIT nechceme, aby sanitizer cokoliv měnil - vracíme nezměněný objekt
  if (p.side === 'SELL' && p.type === 'LIMIT') {
    console.error('[SANITIZE] SELL LIMIT - returning with closePosition preserved', { symbol: p.symbol })
    // Return a clean copy that preserves closePosition if it was set
    const clean = {
      symbol: p.symbol,
      side: p.side,
      type: p.type,
      price: p.price,
      quantity: p.quantity,
      timeInForce: p.timeInForce,
      positionSide: p.positionSide,
      newClientOrderId: p.newClientOrderId,
      newOrderRespType: p.newOrderRespType
    }
    // Only add closePosition if it was explicitly set to true
    if (p.closePosition === true) {
      clean.closePosition = true
    }
    return clean
  }
  // Nikdy uměle nepřidávej reduceOnly pro TAKE_PROFIT (limit) – posílej přesně GPT hodnoty
  if (p.type === 'TAKE_PROFIT' && p.reduceOnly === undefined) {
    // leave as-is
  }

  // Remove reduceOnly when closePosition is true (existing fix)
  if (p.closePosition === true && p.reduceOnly === true) {
    delete p.reduceOnly
  }

  // NEW: For any SELL LIMIT (TP) exit order, remove reduceOnly to avoid -2022 when position not yet open
  if (p.side === 'SELL' && p.type === 'LIMIT' && p.reduceOnly === true) {
    console.error('[SANITIZE] stripping reduceOnly from SELL LIMIT exit order', { symbol: p.symbol })
    delete p.reduceOnly
  }

  return p
}

// Axios-like wrapper (cfg.url, cfg.data)
export function wrapBinanceFuturesClient(futuresHttp: any, safeMode = true) {
  if (!safeMode || !futuresHttp || typeof futuresHttp.request !== 'function') return futuresHttp
  const _request = futuresHttp.request.bind(futuresHttp)

  futuresHttp.request = async (cfg: any) => {
    const url: string = String(cfg?.url || '')
    const isFapiOrder = url.includes('/fapi/') && (url.endsWith('/order') || url.endsWith('/batchOrders'))

    if (isFapiOrder) {
      const logOutgoing = (o: AnyObj) => {
        try {
          console.log('[OUTGOING_ORDER]', {
            symbol: o?.symbol, side: o?.side, type: o?.type,
            price: o?.price, stopPrice: o?.stopPrice,
            reduceOnly: o?.reduceOnly, closePosition: o?.closePosition
          })
        } catch {}
      }

      if (Array.isArray(cfg?.data?.orders)) {
        cfg.data.orders = cfg.data.orders.map(sanitizeOne)
        for (const o of cfg.data.orders) {
          logOutgoing(o)
          if (o.type === 'TAKE_PROFIT' && o.closePosition === true) {
            console.error('[ASSERT_FAIL] TP_LIMIT_with_closePosition_true', cloneJson(o))
            throw new Error('ASSERT: TP_LIMIT with closePosition:true blocked')
          }
          if (o.closePosition === true && !isAllowedClosePosition(String(o.type))) {
            console.error('[ASSERT_FAIL] closePosition_true_invalid_type', cloneJson(o))
            throw new Error('ASSERT: closePosition true only for SL/TP_MARKET')
          }
        }
      } else if (cfg?.data && typeof cfg.data === 'object') {
        cfg.data = sanitizeOne(cfg.data)
        const o = cfg.data
        logOutgoing(o)
        if (o.type === 'TAKE_PROFIT' && o.closePosition === true) {
          console.error('[ASSERT_FAIL] TP_LIMIT_with_closePosition_true', cloneJson(o))
          throw new Error('ASSERT: TP_LIMIT with closePosition:true blocked')
        }
        if (o.closePosition === true && !isAllowedClosePosition(String(o.type))) {
          console.error('[ASSERT_FAIL] closePosition_true_invalid_type', cloneJson(o))
          throw new Error('ASSERT: closePosition true only for SL/TP_MARKET')
        }
      }
    }

    try {
      return await _request(cfg)
    } catch (e: any) {
      try {
        console.error('[BINANCE_ERROR]', {
          url: cfg?.url,
          code: e?.response?.data?.code ?? e?.code,
          msg: e?.response?.data?.msg ?? e?.message,
          payload: cfg?.data ? cloneJson(cfg.data) : undefined
        })
      } catch {}
      throw e
    }
  }

  return futuresHttp
}

// Wrapper for our in-repo BinanceFuturesAPI (signature: request(method, endpoint, params))
export function wrapBinanceFuturesApi(api: any, safeMode = true) {
  if (!api || typeof api.request !== 'function') return api
  if (!safeMode) return api
  const original = api.request.bind(api)
  ;(api as any).__safeWrapped = true

  api.request = async (method: string, endpoint: string, params: AnyObj = {}) => {
    const isOrderPost = String(method || '').toUpperCase() === 'POST' && (endpoint === '/fapi/v1/order' || endpoint === '/fapi/v1/batchOrders')
    if (isOrderPost) {
      const engineTag = (()=>{ try { return String(params?.__engine || 'unknown') } catch { return 'unknown' } })()
      const logOutgoing = (o: AnyObj) => {
        try {
          console.info('[OUTGOING_ORDER]', {
            engine: engineTag,
            symbol: String(o?.symbol), side: String(o?.side), type: String(o?.type),
            price: o?.price != null ? Number(o.price) : null,
            stopPrice: o?.stopPrice != null ? Number(o.stopPrice) : null,
            reduceOnly: o?.reduceOnly === true,
            closePosition: o?.closePosition === true
          })
        } catch {}
      }

      if (endpoint === '/fapi/v1/order') {
        const o = sanitizeOne({ ...params })
        logOutgoing(o)
        if (o.type === 'TAKE_PROFIT' && o.closePosition === true) {
          console.error('[ASSERT_FAIL] TP_LIMIT_with_closePosition_true', cloneJson(o))
          throw new Error('ASSERT: TP_LIMIT with closePosition:true blocked')
        }
        if (o.closePosition === true && !isAllowedClosePosition(String(o.type))) {
          console.error('[ASSERT_FAIL] closePosition_true_invalid_type', cloneJson(o))
          throw new Error('ASSERT: closePosition true only for SL/TP_MARKET')
        }
        try { delete (o as any).__engine } catch {}
        params = o
      } else if (endpoint === '/fapi/v1/batchOrders') {
        const raw = (params as any).batchOrders
        let orders: AnyObj[] | null = null
        try {
          if (Array.isArray(raw)) orders = raw as AnyObj[]
          else if (typeof raw === 'string') orders = JSON.parse(raw)
        } catch {}
        if (Array.isArray(orders)) {
          const sanitized = orders.map(sanitizeOne)
          for (const o of sanitized) {
            logOutgoing(o)
            if (o.type === 'TAKE_PROFIT' && o.closePosition === true) {
              console.error('[ASSERT_FAIL] TP_LIMIT_with_closePosition_true', cloneJson(o))
              throw new Error('ASSERT: TP_LIMIT with closePosition:true blocked')
            }
            if (o.closePosition === true && !isAllowedClosePosition(String(o.type))) {
              console.error('[ASSERT_FAIL] closePosition_true_invalid_type', cloneJson(o))
              throw new Error('ASSERT: closePosition true only for SL/TP_MARKET')
            }
          }
          try { (params as any).batchOrders = JSON.stringify(sanitized) } catch {}
        }
      }
    }

    try {
      return await original(method, endpoint, params)
    } catch (e: any) {
      try {
        const payloadSafe = params ? cloneJson(params) : undefined
        const codeMsg = String(e?.message || '')
        let code: number | null = null
        let msg: string | null = null
        try {
          const idx = codeMsg.indexOf('{')
          if (idx >= 0) {
            const j = JSON.parse(codeMsg.slice(idx))
            if (typeof j?.code !== 'undefined') code = Number(j.code)
            if (typeof j?.msg !== 'undefined') msg = String(j.msg)
          }
        } catch {}
        console.error('[BINANCE_ERROR]', {
          url: endpoint,
          code: code,
          msg: msg || codeMsg,
          payload: payloadSafe
        })
      } catch {}
      throw e
    }
  }

  return api
}


