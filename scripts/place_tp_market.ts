import path from 'node:path'
import dotenv from 'dotenv'
import { getBinanceAPI } from '../services/trading/binance_futures'

function usage(): void {
  console.log('Usage: tsx scripts/place_tp_market.ts SYMBOL [multiplier]')
  console.log('Example: tsx scripts/place_tp_market.ts DOGEUSDT 1.03')
}

function countStepDecimals(step: number): number {
  const s = String(step)
  const idx = s.indexOf('.')
  return idx >= 0 ? (s.length - idx - 1) : 0
}

function quantizeToStep(value: number, step: number, mode: 'round'|'floor'='round'): number {
  const decimals = countStepDecimals(step)
  const factor = Math.pow(10, decimals)
  const v = Math.round(value * factor)
  const st = Math.round(step * factor)
  let q: number
  if (mode === 'floor') q = Math.floor(v / st) * st
  else q = Math.round(v / st) * st
  return q / factor
}

async function main(): Promise<void> {
  // Load env like server does
  try {
    const tryLoad = (p: string) => { try { dotenv.config({ path: p }) } catch {} }
    tryLoad(path.resolve(process.cwd(), '.env.local'))
    tryLoad(path.resolve(process.cwd(), '.env'))
  } catch {}
  const [,, symArg, multArg] = process.argv
  if (!symArg) { usage(); process.exit(1) }
  const symbol = symArg.toUpperCase().endsWith('USDT') ? symArg.toUpperCase() : `${symArg.toUpperCase()}USDT`
  const mult = Number(multArg || '1.03')
  if (!Number.isFinite(mult) || mult <= 0) { console.error('Bad multiplier'); process.exit(1) }

  const api: any = getBinanceAPI()

  // Fetch mark and filters
  const mark = await api.getMarkPrice(symbol)
  const info = await api.getSymbolInfo(symbol)
  const pf = (info?.filters || []).find((f: any) => f?.filterType === 'PRICE_FILTER')
  const tickSize = pf ? Number(pf.tickSize) : null
  const hedgeMode = Boolean(await api.getHedgeMode())

  let stop = mark * mult
  if (Number.isFinite(tickSize as any) && (tickSize as number) > 0) {
    stop = quantizeToStep(stop, tickSize as number, 'round')
  }
  const stopStr = Number.isFinite(stop) ? String(stop) : String(mark * mult)

  const params: any = hedgeMode
    ? { symbol, side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: stopStr, closePosition: true, workingType: 'MARK_PRICE', positionSide: 'LONG', newOrderRespType: 'RESULT' }
    : { symbol, side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: stopStr, closePosition: true, workingType: 'MARK_PRICE', newOrderRespType: 'RESULT' }

  console.log('[TPM_REQ]', { symbol, stop: stopStr, hedgeMode })
  const r = await api.placeOrder(params)
  console.log('[TPM_RES]', { orderId: r?.orderId ?? null, type: r?.type ?? null, stopPrice: r?.stopPrice ?? null })
}

main().catch((e) => { console.error('ERR', e?.message || e); process.exit(1) })


