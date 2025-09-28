import http from 'node:http'
import path from 'node:path'
import dotenv from 'dotenv'

function usage(): void {
  console.log('Usage: tsx scripts/place_exits_once.ts SYMBOL [slMult] [tpMult]')
  console.log('Example: tsx scripts/place_exits_once.ts DOGEUSDT 0.97 1.03')
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

  const [,, symArg, slArg, tpArg] = process.argv
  if (!symArg) { usage(); process.exit(1) }
  const symbol = symArg.toUpperCase().endsWith('USDT') ? symArg.toUpperCase() : `${symArg.toUpperCase()}USDT`
  const slMult = Number(slArg || '0.97')
  const tpMult = Number(tpArg || '1.03')

  const markRes: any = await httpJson('GET', `http://localhost:8888/api/mark?symbol=${symbol}`)
  const mark = Number((markRes as any)?.mark)
  if (!Number.isFinite(mark) || mark <= 0) { throw new Error('Bad mark from /api/mark') }

  const sl = +(mark * slMult).toFixed(6)
  const tp = +(mark * tpMult).toFixed(6)
  const payload: any = { symbol, sl, tp }
  console.log('[PLACE_EXITS_PAYLOAD]', payload)

  const out: any = await httpJson('POST', 'http://localhost:8888/api/place_exits', payload)
  console.log('[PLACE_EXITS_RES]', out)

  const open: any = await httpJson('GET', 'http://localhost:8888/api/open_orders')
  console.log('[OPEN_ORDERS_BRIEF]', Array.isArray(open?.orders) ? open.orders.map((o: any) => ({ symbol: o.symbol, side: o.side, type: o.type, price: o.price, stopPrice: o.stopPrice, reduceOnly: o.reduceOnly, closePosition: o.closePosition, positionSide: o.positionSide })) : open)
}

main().catch((e) => { console.error('ERR', e?.message || e); process.exit(1) })









