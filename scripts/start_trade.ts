import 'dotenv/config'
import { Connection, Client } from '@temporalio/client'

async function main() {
  const address = process.env.TEMPORAL_ADDRESS
  if (!address) throw new Error('TEMPORAL_ADDRESS is required')
  const taskQueue = process.env.TASK_QUEUE || 'trader'

  const connection = await Connection.connect({ address })
  const client = new Client({ connection })

  const symbol = String(process.env.SYMBOL || 'BTCUSDT')
  const notionalUsd = Number(process.env.NOTIONAL_USD || 100)
  const leverage = Number(process.env.LEVERAGE || 5)
  const entryType = String(process.env.ENTRY_TYPE || 'LIMIT') as any
  const entryPrice = process.env.ENTRY_PRICE ? Number(process.env.ENTRY_PRICE) : undefined
  const sl = Number(process.env.SL || 0)
  const tp = Number(process.env.TP || 0)
  const side = String(process.env.SIDE || 'LONG') as any

  const wfId = `trade_${symbol}_${Date.now()}`
  const handle = await client.workflow.start('TradeLifecycleWorkflow', {
    taskQueue,
    workflowId: wfId,
    args: [{ symbol, side, notionalUsd, leverage, entryType, entryPrice, sl, tp, workingType: 'MARK_PRICE', binanceQueue: String(process.env.TASK_QUEUE_BINANCE || '') }]
  })

  console.log('[WF_STARTED]', { id: handle.workflowId })
  await handle.result()
  console.log('[WF_COMPLETED]', { id: handle.workflowId })
}

main().catch((err) => { console.error(err); process.exit(1) })


