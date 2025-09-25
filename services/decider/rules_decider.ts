import type { FeaturesSnapshot } from '../../types/features'

export type MarketDecision = {
  flag: 'NO-TRADE' | 'CAUTION' | 'OK'
  posture: 'RISK-ON' | 'NEUTRAL' | 'RISK-OFF'
  market_health: number
  expiry_minutes: number
  reasons: string[]
  risk_cap: { max_concurrent: number; risk_per_trade_max: number }
}

export function decideFromFeatures(f: FeaturesSnapshot): MarketDecision {
  const br = f.breadth.pct_above_EMA50_H1
  const btc = f.btc
  const eth = f.eth

  const btcAbove = btc.flags.H1_above_VWAP === true
  const ethAbove = eth.flags.H1_above_VWAP === true

  if (br < 25 && (!btcAbove || !ethAbove)) {
    return {
      flag: 'NO-TRADE', posture: 'RISK-OFF', market_health: 20, expiry_minutes: 60,
      reasons: ['nízká šířka trhu (breadth)', 'BTC/ETH pod VWAP'], risk_cap: { max_concurrent: 0, risk_per_trade_max: 0 }
    }
  }

  if (((btc.atr_pct_H1 ?? 0) > 3.5 || (eth.atr_pct_H1 ?? 0) > 3.5) && br < 40) {
    return {
      flag: 'CAUTION', posture: 'NEUTRAL', market_health: 45, expiry_minutes: 60,
      reasons: ['vysoká volatilita', 'slabá šířka trhu'], risk_cap: { max_concurrent: 2, risk_per_trade_max: 0.5 }
    }
  }

  const riskOn = (btc.flags.H4_ema50_gt_200 === true) && (eth.flags.H4_ema50_gt_200 === true) && br >= 60
  return {
    flag: riskOn ? 'OK' : 'CAUTION',
    posture: riskOn ? 'RISK-ON' : 'NEUTRAL',
    market_health: riskOn ? 70 : 55,
    expiry_minutes: 60,
    reasons: riskOn ? ['trend na H4 (EMA50>EMA200)', 'šířka trhu ≥ 60%'] : ['smíšené podmínky'],
    risk_cap: riskOn ? { max_concurrent: 3, risk_per_trade_max: 1.0 } : { max_concurrent: 2, risk_per_trade_max: 0.5 }
  }
}


