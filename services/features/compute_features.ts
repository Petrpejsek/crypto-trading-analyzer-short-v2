import type { FeaturesSnapshot, CoinRow } from '../../types/features'
import type { MarketRawSnapshot, Kline } from '../../types/market_raw'
import { ema as emaShared } from '../lib/indicators'
import candCfg from '../../config/candidates.json'

function last(arr: number[]): number | null { return arr.length ? arr[arr.length - 1] : null }
function mean(arr: number[]): number | null { if (!arr.length) return null; return arr.reduce((a,b)=>a+b,0)/arr.length }

function atrPctH1(k: Kline[]): number | null {
  if (!k?.length) return null
  if (k.length < 15) return null
  const highs = k.map(x=>x.high), lows = k.map(x=>x.low), closes = k.map(x=>x.close)
  const tr: number[] = []
  for (let i=1;i<highs.length;i++) {
    const hl = highs[i]-lows[i]
    const hc = Math.abs(highs[i]-closes[i-1])
    const lc = Math.abs(lows[i]-closes[i-1])
    tr.push(Math.max(hl,hc,lc))
  }
  let atr = tr.slice(0,14).reduce((a,b)=>a+b,0)/14
  for (let i=14;i<tr.length;i++) atr = (atr*13 + tr[i]) / 14
  const close = last(closes)
  return close ? (atr/close)*100 : null
}

const ema = emaShared

export function computeM2Lite(snapshot: MarketRawSnapshot): FeaturesSnapshot {
  const lookN = (candCfg as any)?.h1_range_lookback ?? 12
  const nowMs = Date.now()
  const oiPrevRaw = (() => { try { return JSON.parse(localStorage.getItem('oi_prev_map') || '{}') } catch { return {} } })() as Record<string, { v: number, ts: number }>
  const oiNext: Record<string,{v:number,ts:number}> = {}
  const uni: CoinRow[] = snapshot.universe.map(u => {
    const h1 = u.klines.H1 ?? []
    const m15 = u.klines.M15 ?? []
    const closeH1 = h1.map(x=>x.close)
    const closeM15 = m15.map(x=>x.close)
    const volH1 = h1.map(x=>x.volume)
    const volM15 = m15.map(x=>x.volume)
    const price = last(closeH1)
    const pricePrevH1 = closeH1.length>1 ? closeH1[closeH1.length-2] : null
    const pricePrevM15 = closeM15.length>1 ? closeM15[closeM15.length-2] : null
    const ret_h1_pct = (price != null && pricePrevH1) ? ((price/pricePrevH1)-1)*100 : null
    const ret_m15_pct = (last(closeM15) != null && pricePrevM15) ? ((last(closeM15)!/pricePrevM15)-1)*100 : null
    const rvol_h1 = (volH1.length>=21) ? (volH1[volH1.length-1] / (mean(volH1.slice(-21,-1)) || 1)) : null
    const rvol_m15 = (volM15.length>=21) ? (volM15[volM15.length-1] / (mean(volM15.slice(-21,-1)) || 1)) : null
    const atr_pct_H1 = atrPctH1(h1)
    const ema8 = ema(closeH1,8), ema21 = ema(closeH1,21), ema50 = ema(closeH1,50)
    const ema_stack = (ema8!=null && ema21!=null && ema50!=null) ? ((ema8>ema21 && ema21>ema50) ? 1 : (ema8<ema21 && ema21<ema50) ? -1 : 0) : null
    const vwap_m15_a = (() => {
      if (!m15.length) return null
      let pv=0, vv=0; for (const k of m15) { pv += ((k.high+k.low+k.close)/3)*k.volume; vv+=k.volume }
      if (vv<=0) return null; return pv/vv
    })()
    const vwap_rel_M15 = (vwap_m15_a!=null && last(closeM15)!=null) ? ((last(closeM15)! - vwap_m15_a)/vwap_m15_a) : null
    const funding = u.funding ?? null
    const funding_z = null // computed later across universe
    // OI delta vs >=60 min ago from localStorage
    const prev = oiPrevRaw[u.symbol]
    let oi_change_pct_h1: number | null = null
    let oi_delta_unreliable = false
    let oi_prev_age_min: number | null = null
    if (!prev || !Number.isFinite(prev.v) || prev.v <= 0) {
      oi_delta_unreliable = true
    } else if ((nowMs - prev.ts) < 60*60*1000) {
      oi_delta_unreliable = true
      oi_prev_age_min = Math.max(0, Math.floor((nowMs - prev.ts) / 60000))
    } else if (!Number.isFinite(u.oi_now as any)) {
      oi_delta_unreliable = true
    } else {
      const base = Math.max(1e-9, prev.v)
      const val = (((u.oi_now as any) - base) / base) * 100
      if (!Number.isFinite(val)) {
        oi_delta_unreliable = true
      } else {
        oi_change_pct_h1 = val
        oi_prev_age_min = Math.max(0, Math.floor((nowMs - prev.ts) / 60000))
      }
    }
    oiNext[u.symbol] = { v: (u.oi_now as any) ?? 0, ts: nowMs }
    const tradesCount = null
    const volume24h_usd = u.volume24h_usd ?? null
    // Burst M15: current ret - mean(prev4)
    const burst_m15_pct = (() => {
      if (closeM15.length < 5) return null
      const curr = ((closeM15[closeM15.length-1] / closeM15[closeM15.length-2]) - 1) * 100
      const prev4: number[] = []
      for (let i=closeM15.length-2; i>=1 && prev4.length<4; i--) {
        prev4.push(((closeM15[i] / closeM15[i-1]) - 1) * 100)
      }
      const mu = mean(prev4)
      if (!Number.isFinite(curr) || !Number.isFinite(mu as any)) return null
      return curr - (mu as number)
    })()
    // Breakout quality (M15)
    const body_ratio_m15 = (() => {
      if (!m15.length) return null
      const k = m15[m15.length-1]
      const range = Math.max(1e-9, k.high - k.low)
      const body = Math.abs(k.close - k.open)
      return Math.max(0, Math.min(1, body / range))
    })()
    const upper_wick_ratio_m15 = (() => {
      if (!m15.length) return null
      const k = m15[m15.length-1]
      const range = Math.max(1e-9, k.high - k.low)
      const wick = Math.max(0, k.high - Math.max(k.open, k.close))
      return Math.max(0, Math.min(1, wick / range))
    })()
    const lower_wick_ratio_m15 = (() => {
      if (!m15.length) return null
      const k = m15[m15.length-1]
      const range = Math.max(1e-9, k.high - k.low)
      const wick = Math.max(0, Math.min(k.open, k.close) - k.low)
      return Math.max(0, Math.min(1, wick / range))
    })()
    const consec_above_vwap_m15 = (() => {
      // compute vwap first for comparison
      const vwapTmp = (()=>{
        if (!m15.length) return null
        let pv=0, vv=0; for (const k of m15) { pv += ((k.high+k.low+k.close)/3)*k.volume; vv+=k.volume }
        return vv>0 ? pv/vv : null
      })()
      if (!(m15.length && Number.isFinite(vwapTmp as any))) return null
      let cnt = 0
      for (let i=m15.length-1; i>=0 && cnt<5; i--) {
        const close = m15[i].close
        if (!Number.isFinite(close) || (vwapTmp as any) == null) break
        if (close > (vwapTmp as any)) cnt++; else break
      }
      return cnt
    })()
    // OI × Price divergence (H1)
    const oi_price_div_h1 = (Number.isFinite(oi_change_pct_h1 as any) && Number.isFinite(ret_h1_pct as any))
      ? Math.sign(oi_change_pct_h1 as any) * Math.sign(ret_h1_pct as any)
      : null
    // Liquidity sanity
    const avg_trade_usdt = (Number.isFinite(volume24h_usd as any) && Number.isFinite((u as any).trades)) ? ((volume24h_usd as any) / Math.max(1, (u as any).trades)) : null
    const rvol_liq_product = (Number.isFinite(rvol_h1 as any) && Number.isFinite(volume24h_usd as any)) ? (rvol_h1 as any) * ((volume24h_usd as any)/1e6) : null
    // Cooldown
    const cooldown_factor = (() => {
      try {
        const raw = localStorage.getItem('m4FinalPicks')
        if (!raw) return 0
        const arr = JSON.parse(raw)
        const last = Array.isArray(arr) ? (arr.find((p:any)=>p?.symbol===u.symbol) ?? null) : null
        if (!last?.ts) return 0
        const minutes = Math.max(0, Math.floor((Date.now() - Number(last.ts)) / 60000))
        const cd = Number((candCfg as any)?.cooldown_minutes ?? 90)
        return Math.max(0, Math.min(1, (cd - minutes) / cd))
      } catch { return 0 }
    })()
    // H1 range context for Final Picker
    const slice = closeH1.slice(-lookN)
    const ll_h1 = slice.length ? Math.min(...slice) : null
    const hh_h1 = slice.length ? Math.max(...slice) : null
    const h1_range_pos_pct = (slice.length && price!=null && ll_h1!=null && hh_h1!=null && hh_h1>ll_h1)
      ? ((price - ll_h1) / (hh_h1 - ll_h1)) * 100
      : null
    const vwap_m15 = (()=>{
      if (!m15.length) return null
      let pv=0, vv=0; for (const k of m15) { pv += ((k.high+k.low+k.close)/3)*k.volume; vv+=k.volume }
      return vv>0 ? pv/vv : null
    })()
    const age_hours = (()=>{
      const first = h1.length ? h1[0].openTime : null
      if (!first) return null
      return Math.max(0, (nowMs - Date.parse(first)) / 3_600_000)
    })()
    const is_new = age_hours!=null ? (age_hours < 72) : null
    return { symbol: u.symbol, price, atr_pct_H1, volume24h_usd, ema_order_H1: null, ema_order_M15: null, RSI_M15: null, vwap_rel_M15, funding, OI_chg_1h: oi_change_pct_h1, OI_chg_4h: null,
      // M2-Lite fields
      ret_m15_pct, ret_h1_pct, rvol_m15, rvol_h1, ema_stack, funding_z, oi_change_pct_h1, is_new,
      h1_range_pos_pct, hh_h1, ll_h1, vwap_m15, oi_delta_unreliable, oi_prev_age_min, burst_m15_pct,
      body_ratio_m15, upper_wick_ratio_m15, lower_wick_ratio_m15, consec_above_vwap_m15, oi_price_div_h1,
      avg_trade_usdt, rvol_liq_product, cooldown_factor }
  })
  try { localStorage.setItem('oi_prev_map', JSON.stringify(oiNext)) } catch {}
  // funding_z across universe (z-score of funding)
  const fundVals = uni.map(u => u.funding).filter((x): x is number => Number.isFinite(x as any))
  if (fundVals.length >= 3) {
    const mu = fundVals.reduce((a,b)=>a+b,0) / fundVals.length
    const sd = Math.sqrt(fundVals.map(x => (x-mu)**2).reduce((a,b)=>a+b,0) / fundVals.length) || 1
    for (const r of uni) {
      if (Number.isFinite(r.funding as any)) (r as any).funding_z = ((r.funding as any) - mu) / sd
    }
  }
  // clamp h1_range_pos_pct into [0,100]
  for (const r of uni) {
    if (r.h1_range_pos_pct != null) {
      (r as any).h1_range_pos_pct = Math.max(0, Math.min(100, r.h1_range_pos_pct as any))
    }
  }
  return {
    timestamp: snapshot.timestamp,
    btc: {} as any,
    eth: {} as any,
    universe: uni,
    breadth: { pct_above_EMA50_H1: 0 }
  }
}


