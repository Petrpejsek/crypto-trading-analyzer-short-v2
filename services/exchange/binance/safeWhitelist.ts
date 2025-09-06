// services/exchange/binance/safeWhitelist.ts
type Any = Record<string, any>

const isFapiOrderUrl = (url: string) => /\/fapi\/.+\/(order|batchOrders)(\?|$)/.test(url)
const cpAllowed = (t: string) => t === 'STOP_MARKET' || t === 'TAKE_PROFIT_MARKET'

function sanitizeOrder(o: Any): Any {
  const p = { ...o }
  // 1) TP MARKET never has price
  if (p.type === 'TAKE_PROFIT_MARKET' && p.price != null) {
    delete p.price
  }

  // 2) Whitelist (LONG ONLY) – fail-fast místo konverzí
  const allowed =
    (p.side === 'BUY' && p.type === 'LIMIT' && p.closePosition !== true) ||
    (p.side === 'SELL' && p.type === 'STOP_MARKET' && p.closePosition === true) ||
    (p.side === 'SELL' && p.type === 'TAKE_PROFIT_MARKET' && p.closePosition === true)

  if (!allowed) {
    // eslint-disable-next-line no-console
    console.error('[BLOCKED_ORDER]', { symbol: p.symbol, side: p.side, type: p.type, closePosition: p.closePosition })
    throw new Error('SAFE_MODE: blocked non-whitelisted order')
  }

  return p
}

export function installAxiosWhitelist(axios: any): void {
  if (!axios?.Axios?.prototype?.request) return
  const _req = axios.Axios.prototype.request
  axios.Axios.prototype.request = function (cfg: any) {
    const url = cfg?.url || ''
    if (isFapiOrderUrl(url)) {
      const asObj = (x: any) => (typeof x === 'string' ? JSON.parse(x) : x)

      if (Array.isArray(cfg?.data?.orders)) {
        cfg.data.orders = cfg.data.orders.map(sanitizeOrder)
        for (const o of cfg.data.orders) {
          // eslint-disable-next-line no-console
          console.log('[OUTGOING_ORDER]', { symbol: o.symbol, side: o.side, type: o.type, price: o.price, stopPrice: o.stopPrice, reduceOnly: o.reduceOnly, closePosition: o.closePosition })
          if (o.type === 'TAKE_PROFIT' && o.closePosition === true) throw new Error('ASSERT: TP_LIMIT with closePosition:true')
          if (o.closePosition === true && !cpAllowed(o.type)) throw new Error('ASSERT: closePosition only for SL/TP_MARKET')
        }
      } else if (cfg?.data) {
        const o = sanitizeOrder(asObj(cfg.data))
        // eslint-disable-next-line no-console
        console.log('[OUTGOING_ORDER]', { symbol: o.symbol, side: o.side, type: o.type, price: o.price, stopPrice: o.stopPrice, reduceOnly: o.reduceOnly, closePosition: o.closePosition })
        if (o.type === 'TAKE_PROFIT' && o.closePosition === true) throw new Error('ASSERT: TP_LIMIT with closePosition:true')
        if (o.closePosition === true && !cpAllowed(o.type)) throw new Error('ASSERT: closePosition only for SL/TP_MARKET')
        cfg.data = typeof cfg.data === 'string' ? JSON.stringify(o) : o
      }
    }

    return _req.call(this, cfg).catch((e: any) => {
      // eslint-disable-next-line no-console
      console.error('[BINANCE_ERROR]', { url, code: e?.response?.data?.code ?? e?.code, msg: e?.response?.data?.msg ?? e?.message })
      throw e
    })
  }
}


