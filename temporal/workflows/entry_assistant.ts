import { proxyActivities, sleep, setHandler, condition, defineQuery, defineSignal } from '@temporalio/workflow'
import type { Activities } from '../activities/types'

export type EntryAssistantInput = {
  symbol: string
  side: 'LONG' | 'SHORT'
  strategy: 'conservative' | 'aggressive'
  amountUsd: number
  leverage: number
  orderType?: 'market' | 'limit' | 'stop' | 'stop_limit'
  entry?: number
  sl: number
  tp: number
  // Fast path from UI: when provided, skip AI calls and place orders directly
  riskApproved?: boolean
  skipAi?: boolean
  // Required: queue names must be provided by the caller (no defaults)
  openaiQueue: string
  binanceQueue: string
}

type Status = {
  step: 'starting' | 'strategy' | 'risk' | 'prepare' | 'entry_sent' | 'exits_sent' | 'done' | 'failed'
  info?: string
  entryOrderId?: string | number
  slOrderId?: string | number
  tpOrderId?: string | number
  symbol?: string
  strategyResult?: any
  riskResult?: any
  planned?: { entry: number|null; sl: number|null; tp: number|null; orderType: string; side: 'BUY'|'SELL' }
}

const statusQuery = defineQuery<Status>('status')
const cancelSignal = defineSignal('cancel')

export async function EntryAssistantWorkflow(input: EntryAssistantInput): Promise<{ entryId?: any; slId?: any; tpId?: any; ok: boolean; error?: string }>{
  let cancelled = false
  let status: Status = { step: 'starting', symbol: input.symbol }
  setHandler(cancelSignal, () => { cancelled = true })
  setHandler(statusQuery, () => status)

  // Validate queues are present
  if (!input.openaiQueue || !input.binanceQueue) {
    status = { step: 'failed', info: 'queue_names_missing', symbol: input.symbol }
    return { ok: false, error: 'queue_names_missing' }
  }

  // Route OpenAI calls and Binance calls to provided queues
  const ai = proxyActivities<Pick<Activities, 'openaiRunEntryStrategy' | 'openaiRunEntryRisk'>>({
    taskQueue: input.openaiQueue,
    startToCloseTimeout: '10 minutes',
    retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 3, maximumInterval: '1 minute' }
  })
  const bx = proxyActivities<Pick<Activities,
    'binanceCalculateQuantity' | 'binancePlaceOrder' | 'binanceGetMarkPrice' | 'binanceSetLeverage'
  >>({
    taskQueue: input.binanceQueue,
    startToCloseTimeout: '5 minutes',
    retry: { initialInterval: '2s', backoffCoefficient: 2, maximumAttempts: 5, maximumInterval: '30 seconds' }
  })

  try {
    let entryPx: number | null = null
    if (input.skipAi && input.riskApproved && Number.isFinite(input.entry as any) && Number.isFinite(input.sl as any) && Number.isFinite(input.tp as any)) {
      // Fast-path: trust UI provided numbers
      status = { step: 'prepare', info: 'Using provided plan (skip AI)', symbol: input.symbol, strategyResult: { skipped: true }, riskResult: { skipped: true } }
      entryPx = Number(input.entry)
    } else {
      status = { step: 'strategy', info: 'Running Entry Strategy', symbol: input.symbol }
      const stratPromise = ai.openaiRunEntryStrategy({ symbol: input.symbol, side: input.side, leverage: input.leverage, amount: input.amountUsd })
      status = { step: 'risk', info: 'Running Entry Risk', symbol: input.symbol }
      const riskPromise = ai.openaiRunEntryRisk({ symbol: input.symbol, candidates: [{ symbol: input.symbol }] })
      const [strat, risk] = await Promise.all([stratPromise, riskPromise])
      if (!strat?.ok) return { ok: false, error: `strategy:${strat?.code || 'unknown'}` }
      if (!risk?.ok || !risk?.data || risk.data.decision !== 'enter') return { ok: false, error: `risk:${risk?.code || 'skip'}` }
      try { status = { ...status, strategyResult: strat, riskResult: risk } } catch {}
      entryPx = Number((strat as any)?.data?.[input.strategy]?.entry ?? input.entry ?? input.tp)
    }

    // SHORT-only project: reject LONG trades
    if (input.side === 'LONG') throw new Error('LONG trades not allowed in SHORT project')
    if (input.side !== 'SHORT') throw new Error(`Invalid side: ${input.side} - must be SHORT`)
    const sideBuy = false  // Always false (SHORT = SELL)
    const qty = await bx.binanceCalculateQuantity(input.symbol, input.amountUsd * input.leverage, Number(entryPx))

    const positionSide = 'SHORT'
    const workingType = 'MARK_PRICE'

    const entryParams: any = (() => {
      const ot = String(input.orderType || (input.strategy === 'aggressive' ? 'stop_limit' : 'limit'))
      // SHORT: entry always = SELL
      if (ot === 'market') return { symbol: input.symbol, side: 'SELL', type: 'MARKET', quantity: qty, positionSide }
      if (ot === 'limit') return { symbol: input.symbol, side: 'SELL', type: 'LIMIT', price: String(entryPx), timeInForce: 'GTC', quantity: qty, positionSide }
      // SHORT: entry always = SELL
      if (ot === 'stop') return { symbol: input.symbol, side: 'SELL', type: 'STOP_MARKET', stopPrice: String(entryPx), quantity: qty, positionSide, workingType }
      return { symbol: input.symbol, side: 'SELL', type: 'STOP', price: String(entryPx), stopPrice: String(entryPx), timeInForce: 'GTC', quantity: qty, positionSide, workingType }
    })()

    // SHORT: SL/TP = BUY (closing short position)
    const slParams: any = { symbol: input.symbol, side: 'BUY', type: 'STOP_MARKET', stopPrice: String(input.sl), closePosition: true, workingType, positionSide }
    const tpParams: any = { symbol: input.symbol, side: 'BUY', type: 'TAKE_PROFIT_MARKET', stopPrice: String(input.tp), closePosition: true, workingType, positionSide }

    // Align leverage first (best effort)
    try { await bx.binanceSetLeverage(input.symbol, Math.max(1, Math.floor(Number(input.leverage)))) } catch {}

    status = {
      step: 'prepare',
      info: 'Preparing orders',
      symbol: input.symbol,
      // SHORT: side always = SELL for entry
      planned: { entry: Number(entryPx||0)||null, sl: Number(input.sl||0)||null, tp: Number(input.tp||0)||null, orderType: String(input.orderType || (input.strategy === 'aggressive' ? 'stop_limit' : 'limit')), side: 'SELL' }
    }

    status = { step: 'entry_sent', info: 'Placing entry', symbol: input.symbol, planned: status.planned }
    const entryRes = await bx.binancePlaceOrder({ ...entryParams, __engine: 'temporal-entry' })
    status.entryOrderId = entryRes?.orderId

    // Short pause for potential partial fill; real impl. should use signals/WS
    await sleep('1 seconds')

    status = { ...status, step: 'exits_sent', info: 'Placing exits', entryOrderId: entryRes?.orderId }
    const [slRes, tpRes] = await Promise.all([
      bx.binancePlaceOrder({ ...slParams, __engine: 'temporal-entry' }),
      bx.binancePlaceOrder({ ...tpParams, __engine: 'temporal-entry' })
    ])
    status.slOrderId = slRes?.orderId
    status.tpOrderId = tpRes?.orderId

    status = { ...status, step: 'done' }
    return { ok: true, entryId: entryRes?.orderId, slId: slRes?.orderId, tpId: tpRes?.orderId }
  } catch (e: any) {
    status = { step: 'failed', info: String(e?.message || e), symbol: input.symbol }
    return { ok: false, error: String(e?.message || e) }
  }
}

export const queries = { status: statusQuery }
export const signals = { cancel: cancelSignal }


