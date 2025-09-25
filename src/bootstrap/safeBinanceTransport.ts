// src/bootstrap/safeBinanceTransport.ts
type AnyObj = Record<string, any>

const isFapiOrderUrl = (url: string) => /\/fapi\/.+\/(order|batchOrders)(\?|$)/.test(url)
const isAllowedCP = (t: string) => t === 'STOP_MARKET' || t === 'TAKE_PROFIT_MARKET'

function sanitizeOrder(o: AnyObj): AnyObj {
  if (!o || typeof o !== 'object') return o
  const p = { ...o }
  // Remove any shape inconsistencies but DO NOT convert types here
  if (p.type === 'TAKE_PROFIT_MARKET' && p.price != null) {
    delete p.price
  }
  return p
}

function sanitizeBody(body: any): any {
  if (!body) return body
  try {
    if (Array.isArray(body.orders)) {
      body.orders = body.orders.map(sanitizeOrder)
    } else if (typeof body === 'object') {
      Object.assign(body, sanitizeOrder(body))
    }
  } catch {}
  return body
}

function safeLog(prefix: string, o: any) {
  try {
    const pick = (x: any) => x && ({
      symbol: x.symbol, side: x.side, type: x.type,
      price: x.price, stopPrice: x.stopPrice,
      reduceOnly: x.reduceOnly, closePosition: x.closePosition
    })
    if (Array.isArray(o?.orders)) {
      o.orders.forEach((ord: any) => console.log(prefix, pick(ord)))
    } else {
      console.log(prefix, pick(o))
    }
  } catch {}
}

export function installSafeBinanceTransportPatch() {
  if (typeof globalThis.fetch === 'function') {
    const _fetch = globalThis.fetch.bind(globalThis)
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url || ''
      if (isFapiOrderUrl(url) && init?.body) {
        try {
          const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
          sanitizeBody(body)
          safeLog('[OUTGOING_ORDER_FETCH]', body)
          init.body = JSON.stringify(body)
        } catch {}
      }
      const res = await _fetch(input, init)
      if (!res.ok) {
        try {
          const err = await res.clone().json()
          console.error('[BINANCE_ERROR_FETCH]', { url, code: err?.code, msg: err?.msg })
        } catch {}
      }
      return res
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const axios = require('axios')
    if (axios?.Axios?.prototype?.request) {
      const _req = axios.Axios.prototype.request
      axios.Axios.prototype.request = function(cfg: any) {
        const url = cfg?.url || ''
        if (isFapiOrderUrl(url)) {
          if (cfg?.data) {
            try {
              const dataObj = typeof cfg.data === 'string' ? JSON.parse(cfg.data) : cfg.data
              sanitizeBody(dataObj)
              safeLog('[OUTGOING_ORDER_AXIOS]', dataObj)
              cfg.data = typeof cfg.data === 'string' ? JSON.stringify(dataObj) : dataObj
            } catch {}
          }
        }
        return _req.call(this, cfg).catch((e: any) => {
          try {
            console.error('[BINANCE_ERROR_AXIOS]', {
              url,
              code: e?.response?.data?.code ?? e?.code,
              msg: e?.response?.data?.msg ?? e?.message
            })
          } catch {}
          throw e
        })
      }
    }
  } catch {}
}


