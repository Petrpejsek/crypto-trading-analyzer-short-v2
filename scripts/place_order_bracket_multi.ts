import http from 'node:http'
import path from 'node:path'
import dotenv from 'dotenv'
import { getBinanceAPI } from '../services/trading/binance_futures'

function usage(): void {
  console.log('Usage: tsx scripts/place_order_bracket_multi.ts SYMBOL1 SYMBOL2 SYMBOL3 amountUSD leverage')
  console.log('Example: tsx scripts/place_order_bracket_multi.ts DOGEUSDT BIOUSDT LPTUSDT 12 3')
}

async function httpJson<T=any>(method: string, url: string, body?: any): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const u = new URL(url)
    const req = http.request({
      hostname: u.hostname,
      port: Number(u.port || 8888),
      path: u.pathname + (u.search || ''),
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c as Buffer))
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8')
        try { resolve(JSON.parse(txt)) } catch { resolve(txt as any) }
      })
    })
    req.on('error', reject)
    if (body) req.end(JSON.stringify(body))
    else req.end()
  })
}

async function main(): Promise<void> {
  try { dotenv.config({ path: path.resolve(process.cwd(), '.env.local') }) } catch {}
  try { dotenv.config({ path: path.resolve(process.cwd(), '.env') }) } catch {}

  const [,, s1, s2, s3, amtArg, levArg] = process.argv
  if (!s1 || !s2 || !s3 || !amtArg || !levArg) { usage(); process.exit(1) }
  const toSym = (s: string) => s.toUpperCase().endsWith('USDT') ? s.toUpperCase() : `${s.toUpperCase()}USDT`
  const symbols = [toSym(s1), toSym(s2), toSym(s3)]
  const amount = Number(amtArg)
  const leverage = Math.max(1, Math.floor(Number(levArg)))
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Bad amount')
  if (!Number.isFinite(leverage) || leverage <= 0) throw new Error('Bad leverage')

  // Fetch marks
  const marks: Record<string, number> = {}
  const tick: Record<string, number> = {}
  for (const sym of symbols) {
    const r: any = await httpJson('GET', `http://localhost:8888/api/mark?symbol=${sym}`)
    const m = Number((r as any)?.mark)
    if (!Number.isFinite(m) || m <= 0) throw new Error(`Bad mark for ${sym}`)
    marks[sym] = m
    // Fetch tickSize for proper price precision
    try {
      const api: any = getBinanceAPI()
      const info = await api.getSymbolInfo(sym)
      const pf = (info?.filters || []).find((f: any) => f?.filterType === 'PRICE_FILTER')
      const ts = pf ? Number(pf.tickSize) : NaN
      if (Number.isFinite(ts) && ts > 0) tick[sym] = ts
    } catch {}
  }

  const quantize = (value: number, step: number): number => {
    const s = String(step)
    const idx = s.indexOf('.')
    const decimals = idx >= 0 ? (s.length - idx - 1) : 0
    const factor = Math.pow(10, decimals)
    return Math.round(value * factor) / factor
  }

  const orders = symbols.map((symbol) => {
    const m = marks[symbol]
    const ts = Number(tick[symbol])
    const baseEntry = m * 0.998
    const baseSl = m * 0.970
    const baseTp = m * 1.030
    const entry = Number.isFinite(ts) && ts > 0 ? quantize(baseEntry, ts) : +baseEntry.toFixed(6)
    const sl = Number.isFinite(ts) && ts > 0 ? quantize(baseSl, ts) : +baseSl.toFixed(6)
    const tp = Number.isFinite(ts) && ts > 0 ? quantize(baseTp, ts) : +baseTp.toFixed(6)
    return { symbol, side: 'SHORT' as const, strategy: 'conservative' as const, tpLevel: 'tp1' as const, amount, leverage, useBuffer: false, entry, sl, tp }
  })

  const payload = { orders }
  console.log('[PLACE_ORDERS_PAYLOAD]', payload)
  const res: any = await httpJson('POST', 'http://localhost:8888/api/place_orders', payload)
  console.log('[PLACE_ORDERS_RES]', res)

  await new Promise(r => setTimeout(r, 4000))
  const open: any = await httpJson('GET', 'http://localhost:8888/api/open_orders')
  const brief = Array.isArray(open?.orders)
    ? open.orders.map((o: any) => ({ symbol: o.symbol, side: o.side, type: o.type, price: o.price, stopPrice: o.stopPrice, reduceOnly: o.reduceOnly, closePosition: o.closePosition, positionSide: o.positionSide }))
    : open
  console.log('[OPEN_ORDERS_BRIEF]', brief)
}

main().catch((e) => { console.error('ERR', e?.message || e); process.exit(1) })


