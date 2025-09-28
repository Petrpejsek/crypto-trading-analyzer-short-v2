import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { runStrategyUpdate, type StrategyUpdateInput } from '../services/strategy-updater/strategy_updater_gpt'
import { getBinanceAPI } from '../services/trading/binance_futures'

async function main() {
  try { dotenv.config({ path: path.resolve(process.cwd(), '.env.local') }) } catch {}
  try { dotenv.config({ path: path.resolve(process.cwd(), '.env') }) } catch {}
  const symbol = process.env.SYMBOL || 'BTCUSDT_260327'
  const api = getBinanceAPI()

  // Load live position and open orders
  const positions = await api.getPositions().catch(() => [])
  const position = (Array.isArray(positions) ? positions : []).find((p: any) => String(p?.symbol) === symbol)
  if (!position) {
    console.log(JSON.stringify({ ok: false, error: 'position_not_found', symbol }, null, 2))
    process.exit(0)
  }
  const amt = Number(position?.positionAmt || 0)
  const side: 'LONG'|'SHORT' = amt > 0 ? 'LONG' : 'SHORT'
  const size = Math.abs(amt)
  const entryPrice = Number(position?.entryPrice || position?.averagePrice || 0)
  const currentPrice = Number(position?.markPrice || 0)
  const unrealizedPnl = Number(position?.unrealizedPnl || 0)

  const open = await api.getOpenOrders(symbol).catch(() => [])
  const exitSide = side === 'LONG' ? 'SELL' : 'BUY'
  // Derive most protective SL around mark
  let currentSL: number | null = null
  try {
    const mark = await api.getMarkPrice(symbol).catch(() => null)
    const stops = (Array.isArray(open) ? open : []).filter((o: any) => String(o?.side) === exitSide && /STOP/i.test(String(o?.type || '')) && !/TAKE_PROFIT/i.test(String(o?.type || '')))
    const candidates: number[] = []
    for (const o of stops) {
      const sp = Number((o && (o.stopPrice ?? o.price)) ?? 0)
      if (!Number.isFinite(sp) || sp <= 0) continue
      if (Number.isFinite(mark as any)) {
        if (side === 'LONG') { if (sp < (mark as number)) candidates.push(sp) }
        else { if (sp > (mark as number)) candidates.push(sp) }
      } else candidates.push(sp)
    }
    if (candidates.length) currentSL = side === 'LONG' ? Math.max(...candidates) : Math.min(...candidates)
  } catch {}

  // Build StrategyUpdateInput (minimal, like trigger)
  const input: StrategyUpdateInput = {
    symbol,
    position: {
      side,
      size,
      entryPrice,
      currentPrice: Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : entryPrice,
      unrealizedPnl,
      unrealizedPnlPct: (entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * (side === 'LONG' ? 100 : -100) : 0)
    },
    currentSL: currentSL ?? null,
    currentTP: null,
    posture: 'OK',
    exchange_filters: { maxSlippagePct: Number(process.env.MAX_SLIPPAGE_PCT || 0.05) }
  }

  const res = await runStrategyUpdate(input)
  if (!res.ok || !res.data) {
    console.log(JSON.stringify({ ok: false, code: res.code || 'failed', meta: res.meta || null }, null, 2))
    process.exit(0)
  }
  const out = {
    ok: true,
    symbol,
    newSL: res.data.newSL,
    tp_levels: res.data.tp_levels,
    confidence: res.data.confidence,
    urgency: res.data.urgency
  }
  console.log(JSON.stringify(out, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })


