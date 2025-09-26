import 'dotenv/config'
import { runStrategyUpdate, type StrategyUpdateInput } from '../services/strategy-updater/strategy_updater_gpt'

async function main() {
  const model = process.env.STRATEGY_UPDATER_MODEL || 'gpt-5'
  const symbol = process.env.SYMBOL || 'BTCUSDT'

  const input: StrategyUpdateInput = {
    symbol,
    position: {
      side: 'SHORT',
      size: 0.01,
      entryPrice: 60000,
      currentPrice: 59800,
      unrealizedPnl: 40,
      unrealizedPnlPct: 0.07
    },
    currentSL: 60200,
    currentTP: [{ tag: 'tp', price: 59000, allocation_pct: 1 }],
    posture: 'OK',
    exchange_filters: { maxSlippagePct: 0.15 }
  }

  const t0 = Date.now()
  const res = await runStrategyUpdate(input)
  const ms = Date.now() - t0
  console.log(JSON.stringify({
    ok: res.ok,
    code: res.code || null,
    latencyMs: res.latencyMs,
    measuredMs: ms,
    meta: res.meta,
    model
  }, null, 2))
  if (!res.ok) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exit(1) })


