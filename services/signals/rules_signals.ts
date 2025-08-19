import Ajv from 'ajv'
import schema from '../../schemas/signal_set.schema.json'
import type { FeaturesSnapshot, CoinRow } from '../../types/features'
import type { MarketDecision } from '../decider/rules_decider'
import signalsCfg from '../../config/signals.json'

const ajv = new Ajv({ allErrors: true })
const validate = ajv.compile(schema as any)

export type SignalSetup = {
  symbol: string
  mode: 'intraday' | 'swing'
  side: 'LONG' | 'SHORT'
  entry: string
  sl: string
  tp: string[]
  trailing: string
  sizing: { risk_pct: number }
  expires_in_min: number
  why: string[]
}

export type SignalSet = { setups: SignalSetup[] }

export function buildSignalSet(f: FeaturesSnapshot, decision: MarketDecision, candidates: CoinRow[], limit?: number): SignalSet {
  const setups: SignalSetup[] = []
  const lim: any = (signalsCfg as any).limits || {}
  const riskMap: Record<string, number> = (signalsCfg as any).risk_pct_by_posture || { OK: 0.7, CAUTION: 0.5, 'NO-TRADE': 0 }
  const expires = (signalsCfg as any).expires_in_min ?? 45

  for (const r of candidates) {
    const isLong = r.ema_order_H1 === '20>50>200' && (r.vwap_rel_M15 ?? 0) > 0 && (r.RSI_M15 ?? 0) >= 45 && (r.RSI_M15 ?? 0) <= 70
    const isShort = r.ema_order_H1 === '200>50>20' && (r.vwap_rel_M15 ?? 0) < 0 && (r.RSI_M15 ?? 0) >= 30 && (r.RSI_M15 ?? 0) <= 55
    if (!isLong && !isShort) continue
    const side = isLong ? 'LONG' : 'SHORT'
    const risk_pct = riskMap[decision.flag] ?? 0.5
    const entry = 'limit @ last_close'
    const slMult = Math.max(1.0, lim.min_sl_atr_mult ?? 1.0)
    const sl = side === 'LONG' ? `${slMult.toFixed(1)}x ATR(H1) below` : `${slMult.toFixed(1)}x ATR(H1) above`
    const tp = ['1.0R','1.8R','3.0R']
    const trailing = '1x ATR after TP1'
    const why: string[] = []
    if (isLong) why.push('H1 trend up (20>50>200)')
    if (isShort) why.push('H1 trend down (200>50>20)')
    if ((r.vwap_rel_M15 ?? 0) > 0) why.push('VWAP M15 above')
    if ((r.vwap_rel_M15 ?? 0) < 0) why.push('VWAP M15 below')
    if ((r.RSI_M15 ?? 0) >= 45 && (r.RSI_M15 ?? 0) <= 70) why.push('RSI M15 ok')
    if ((r.RSI_M15 ?? 0) >= 30 && (r.RSI_M15 ?? 0) <= 55) why.push('RSI M15 ok')

    // Sanity guard: TP1 >= min_tp1_R (textová kontrola – ponecháme 1.0R min., vyšší prahy propustíme jen pokud splněny)
    const minTp1 = lim.min_tp1_R ?? 0.8
    const tp1Num = parseFloat(tp[0])
    if (!Number.isFinite(tp1Num) || tp1Num < minTp1) continue

    const setup: SignalSetup = { symbol: r.symbol, mode: 'intraday', side, entry, sl, tp, trailing, sizing: { risk_pct }, expires_in_min: expires, why: why.slice(0, 3) }
    setups.push(setup)
  }

  const maxSetups = lim.max_setups ?? 3
  const hardLimit = Math.max(1, Math.min(limit ?? maxSetups, 5))
  const set: SignalSet = { setups: setups.slice(0, hardLimit) }
  const ok = validate(set as any)
  if (!ok) {
    // eslint-disable-next-line no-console
    console.warn('SignalSet validation failed', validate.errors)
    return { setups: [] }
  }
  return set
}


