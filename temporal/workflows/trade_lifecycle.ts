import { proxyActivities, sleep, workflowInfo } from '@temporalio/workflow'
import type { Activities } from '../activities/types'
import { applyEntryMultiplier } from '../../services/lib/entry_price_adjuster_workflow'

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
  // SHORT-only project: reject LONG trades
  if (params.side === 'LONG') throw new Error('LONG trades not allowed in SHORT project')
  if (params.side !== 'SHORT') throw new Error(`Invalid side: ${params.side} - must be SHORT`)
  
  const a = makeActivities(params.binanceQueue)
  const symbol = params.symbol.toUpperCase()
  const isLong = false  // Always false in SHORT project
  const positionSide = 'SHORT'
  const workingType = params.workingType === 'CONTRACT_PRICE' ? 'CONTRACT_PRICE' : 'MARK_PRICE'

  // Získej tickSize a pricePrecision pro správné zaokrouhlení entry ceny
  let tickSize: number | undefined = undefined
  let pricePrecision: number | undefined = undefined
  try {
    const symbolInfo = await a.binanceGetSymbolInfo(symbol)
    const priceFilter = (symbolInfo?.filters || []).find((f: any) => f?.filterType === 'PRICE_FILTER')
    if (priceFilter && Number.isFinite(Number(priceFilter.tickSize))) {
      tickSize = Number(priceFilter.tickSize)
    }
    if (symbolInfo && Number.isFinite(Number(symbolInfo.pricePrecision))) {
      pricePrecision = Number(symbolInfo.pricePrecision)
    }
  } catch (e) {
    console.warn('[TRADE_LIFECYCLE] Failed to get symbol filters, proceeding without rounding:', e)
  }

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
  // SHORT: isLong is always false, so side = SELL for entry
  const commonEntry = {
    symbol,
    side: 'SELL' as const,  // isLong=false → SELL (opening short)
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
      // WORKFLOW: neaplikuj multiplier zde (workflows nemají fs access)
      // Multiplier se aplikuje až v Activity (binance API)
      const adjustedPrice = applyEntryMultiplier(params.entryPrice!, tickSize, pricePrecision, 100.0)
      return { ...commonEntry, type: 'LIMIT', price: String(adjustedPrice), timeInForce: 'GTC' as const, quantity: qty }
    }
    if (params.entryType === 'STOP_MARKET') {
      // SHORT: stopPrice should be below current price
      const baseStopPrice = params.entryPrice && Number.isFinite(params.entryPrice) ? params.entryPrice : refPrice * 0.999
      const adjustedStopPrice = applyEntryMultiplier(baseStopPrice, tickSize, pricePrecision, 100.0)
      return { ...commonEntry, type: 'STOP_MARKET', stopPrice: String(adjustedStopPrice), quantity: qty, workingType }
    }
    // STOP (stop-limit)
    const basePrice = params.entryPrice && Number.isFinite(params.entryPrice) ? params.entryPrice : refPrice
    const adjustedPrice = applyEntryMultiplier(basePrice, tickSize, pricePrecision, 100.0)
    const baseStopPrice = refPrice * 0.999  // SHORT: below current price
    const adjustedStopPrice = applyEntryMultiplier(baseStopPrice, tickSize, pricePrecision, 100.0)
    return { ...commonEntry, type: 'STOP' as const, price: String(adjustedPrice), stopPrice: String(adjustedStopPrice), timeInForce: 'GTC' as const, quantity: qty, workingType }
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
  // SHORT: SL/TP = BUY (closing short position)
  const slCpParams = {
    symbol,
    side: 'BUY' as const,  // isLong=false → BUY (closing short at loss)
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
    side: 'BUY' as const,  // isLong=false → BUY (closing short at loss)
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
    side: 'BUY' as const,  // isLong=false → BUY (closing short at profit)
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


