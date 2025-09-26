import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'

async function main() {
  const file = path.resolve('runtime/waiting_tp.json')
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  j.waiting = j.waiting || []
  j.waiting.push({ symbol: 'ZZZNULLUSDT', tp: null, qtyPlanned: '1', since: new Date().toISOString(), lastCheck: null, checks: 0, positionSize: 0, status: 'waiting', positionSide: 'SHORT', workingType: 'MARK_PRICE' })
  fs.writeFileSync(file, JSON.stringify(j, null, 2), 'utf8')

  const { rehydrateWaitingFromDiskOnce, getWaitingTpList } = await import('../services/trading/binance_futures') as any
  await rehydrateWaitingFromDiskOnce()
  const list = getWaitingTpList()
  const hasInvalid = list.some((w: any) => w.symbol === 'ZZZNULLUSDT')
  console.log(JSON.stringify({ count: list.length, hasInvalid }, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })


