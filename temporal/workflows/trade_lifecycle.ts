import { proxyActivities, sleep, workflowInfo } from '@temporalio/workflow'
import type { Activities } from '../activities/types'

export interface TradeLifecycleParams {
  symbol: string
  side: 'LONG' | 'SHORT'
  notionalUsd: number
  leverage: number
  entryType: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP'
  entryPrice?: number
  sl: number
  tp: number
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE'
  binanceQueue: string
}

function makeActivities(binanceQueue: string) {
  return proxyActivities<Activities>({
    taskQueue: binanceQueue,
    // Hard timeouts per activity call
    startToCloseTimeout: '60 seconds'
  })
}

function makeClientOrderId(prefix: string): string {
  const base = workflowInfo().workflowId.replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 24)
  const id = `${prefix}_${base}`
  // Binance allows up to 36 chars; trim just in case
  return id.slice(0, 36)
}

export async function TradeLifecycleWorkflow(params: TradeLifecycleParams): Promise<void> {
  if (!params.binanceQueue) throw new Error('binanceQueue missing')
  const a = makeActivities(params.binanceQueue)
  const symbol = params.symbol.toUpperCase()
  const isLong = params.side === 'LONG'
  const positionSide = isLong ? 'LONG' : 'SHORT'
  const workingType = params.workingType === 'CONTRACT_PRICE' ? 'CONTRACT_PRICE' : 'MARK_PRICE'

  // 1) Align leverage
  if (Number.isFinite(params.leverage) && params.leverage > 0) {
    await a.binanceSetLeverage(symbol, Math.floor(params.leverage))
  }

  // 2) Compute quantity from notional and price
  const refPrice = (() => params.entryType === 'LIMIT' && Number.isFinite(params.entryPrice as any) && (params.entryPrice as number) > 0)
    ? (params.entryPrice as number)
    : await a.binanceGetMarkPrice(symbol)
  const qty = await a.binanceCalculateQuantity(symbol, Math.max(1, Math.floor(params.notionalUsd * params.leverage)), refPrice)

  // 3) Place ENTRY
  const commonEntry = {
    symbol,
    side: isLong ? 'BUY' : 'SELL',
    closePosition: false,
    positionSide,
    newClientOrderId: makeClientOrderId('e_l'),
    newOrderRespType: 'RESULT'
  } as const

  const entryParams = (() => {
    if (params.entryType === 'MARKET') {
      return { ...commonEntry, type: 'MARKET', quantity: qty }
    }
    if (params.entryType === 'LIMIT') {
      if (!Number.isFinite(params.entryPrice as any)) throw new Error('LIMIT entry requires entryPrice')
      return { ...commonEntry, type: 'LIMIT', price: String(params.entryPrice), timeInForce: 'GTC' as const, quantity: qty }
    }
    if (params.entryType === 'STOP_MARKET') {
      const stopPrice = params.entryPrice && Number.isFinite(params.entryPrice) ? String(params.entryPrice) : String(refPrice * (isLong ? 1.001 : 0.999))
      return { ...commonEntry, type: 'STOP_MARKET', stopPrice, quantity: qty, workingType }
    }
    // STOP (stop-limit)
    const price = params.entryPrice && Number.isFinite(params.entryPrice) ? String(params.entryPrice) : String(refPrice)
    const stopPrice = String(isLong ? refPrice * 1.001 : refPrice * 0.999)
    return { ...commonEntry, type: 'STOP' as const, price, stopPrice, timeInForce: 'GTC' as const, quantity: qty, workingType }
  })()

  await a.binancePlaceOrder({ ...entryParams, __engine: 'temporal_lifecycle' })

  // 4) Brief wait and check position
  const deadline = Date.now() + 30_000
  let positionQtyAbs = 0
  while (Date.now() < deadline) {
    const positions = await a.binanceGetPositions()
    const p = Array.isArray(positions) ? positions.find((it: any) => String(it?.symbol) === symbol) : null
    const amt = Number(p?.positionAmt)
    if (Number.isFinite(amt) && Math.abs(amt) > 0) { positionQtyAbs = Math.abs(amt); break }
    await sleep(1000)
  }

  // 5) Place SL + TP (MARKET variants close-only unless we have explicit qty)
  const slStr = String(params.sl)
  const tpStr = String(params.tp)

  // Protective CP SL always
  const slCpParams = {
    symbol,
    side: isLong ? 'SELL' : 'BUY',
    type: 'STOP_MARKET',
    stopPrice: slStr,
    closePosition: true,
    workingType,
    positionSide,
    newClientOrderId: makeClientOrderId('x_sl'),
    newOrderRespType: 'RESULT'
  }

  // Quantitative RO SL when position exists
  const slRoParams = positionQtyAbs > 0 ? {
    symbol,
    side: isLong ? 'SELL' : 'BUY',
    type: 'STOP_MARKET',
    stopPrice: slStr,
    quantity: String(positionQtyAbs),
    workingType,
    positionSide,
    newClientOrderId: makeClientOrderId('x_sl_ro'),
    newOrderRespType: 'RESULT'
  } : null

  // TP MARKET close-only to ensure position gets closed on target
  const tpParams = {
    symbol,
    side: isLong ? 'SELL' : 'BUY',
    type: 'TAKE_PROFIT_MARKET',
    stopPrice: tpStr,
    closePosition: true,
    workingType,
    positionSide,
    newClientOrderId: makeClientOrderId('x_tp_tm'),
    newOrderRespType: 'RESULT'
  }

  await a.binancePlaceOrder({ ...slCpParams, __engine: 'temporal_lifecycle' })
  if (slRoParams) {
    await a.binancePlaceOrder({ ...slRoParams, __engine: 'temporal_lifecycle' })
  }
  await a.binancePlaceOrder({ ...tpParams, __engine: 'temporal_lifecycle' })

  // 6) Monitor until position is closed
  while (true) {
    await sleep(5000)
    const positions = await a.binanceGetPositions()
    const p = Array.isArray(positions) ? positions.find((it: any) => String(it?.symbol) === symbol) : null
    const amt = Number(p?.positionAmt)
    const open = Number.isFinite(amt) && Math.abs(amt) > 0
    if (!open) break
  }
}


