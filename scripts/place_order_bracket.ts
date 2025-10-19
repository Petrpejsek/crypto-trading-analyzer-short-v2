import http from 'node:http'
import path from 'node:path'
import dotenv from 'dotenv'

function usage(): void {
  console.log('Usage: tsx scripts/place_order_bracket.ts SYMBOL amountUSD leverage')
  console.log('Example: tsx scripts/place_order_bracket.ts DOGEUSDT 15 3')
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

  const [,, symArg, amtArg, levArg] = process.argv
  if (!symArg || !amtArg || !levArg) { usage(); process.exit(1) }
  const symbol = symArg.toUpperCase().endsWith('USDT') ? symArg.toUpperCase() : `${symArg.toUpperCase()}USDT`
  const amount = Number(amtArg)
  const leverage = Math.max(1, Math.floor(Number(levArg)))
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Bad amount')
  if (!Number.isFinite(leverage) || leverage <= 0) throw new Error('Bad leverage')

  const markRes: any = await httpJson('GET', `http://localhost:8888/api/mark?symbol=${symbol}`)
  const mark = Number((markRes as any)?.mark)
  if (!Number.isFinite(mark) || mark <= 0) throw new Error('Bad mark')

  // Compute entry a bit below mark; SL/TP safety multiples
  const entry = +(mark * 0.998).toFixed(6)
  const sl = +(mark * 0.970).toFixed(6)
  const tp = +(mark * 1.030).toFixed(6)

  const payload = {
    orders: [
      { symbol, side: 'SHORT' as const, strategy: 'conservative' as const, tpLevel: 'tp1' as const,
        amount, leverage, useBuffer: false, entry, sl, tp }
    ]
  }

  console.log('[PLACE_ORDERS_PAYLOAD]', payload)
  const res: any = await httpJson('POST', 'http://localhost:8888/api/place_orders', payload)
  console.log('[PLACE_ORDERS_RES]', res)

  // Wait briefly and read open orders snapshot
  await new Promise(r => setTimeout(r, 4000))
  const open: any = await httpJson('GET', 'http://localhost:8888/api/open_orders')
  const brief = Array.isArray(open?.orders)
    ? open.orders.map((o: any) => ({ symbol: o.symbol, side: o.side, type: o.type, price: o.price, stopPrice: o.stopPrice, reduceOnly: o.reduceOnly, closePosition: o.closePosition, positionSide: o.positionSide }))
    : open
  console.log('[OPEN_ORDERS_BRIEF]', brief)
}

main().catch((e) => { console.error('ERR', e?.message || e); process.exit(1) })









