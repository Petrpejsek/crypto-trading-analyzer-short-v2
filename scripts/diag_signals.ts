import { computeFeatures } from '../services/features/compute'
import type { FeaturesSnapshot, CoinRow } from '../types/features'
import type { MarketRawSnapshot } from '../types/market_raw'
import { decideFromFeatures, type MarketDecision } from '../services/decider/rules_decider'
import { selectCandidates } from '../services/signals/candidate_selector'
import signalsCfg from '../config/signals.json'
import Ajv from 'ajv'
import signalSchema from '../schemas/signal_set.schema.json'

const ajv = new Ajv({ allErrors: true })
const validateSignalSet = ajv.compile(signalSchema as any)

function isFiniteNum(n: any): boolean { return Number.isFinite(n) }

function basicCounts(f: FeaturesSnapshot) {
  const total = f.universe.length
  const missingEssential = f.universe.filter(u => (
    u.price == null || !isFiniteNum(u.atr_pct_H1) || !isFiniteNum(u.volume24h_usd) || u.ema_order_H1 == null
  )).length
  const maxAtr = (signalsCfg as any).limits?.max_atr_pct_h1 ?? 5.0
  const tooVolatile = f.universe.filter(u => (u.atr_pct_H1 ?? Infinity) > maxAtr).length
  const eligible = total - missingEssential - tooVolatile
  return { total, missingEssential, tooVolatile, eligible }
}

function setupRuleCounts(f: FeaturesSnapshot) {
  let shortOk = 0
  for (const r of f.universe) {
    const isShort = r.ema_order_H1 === '200>50>20' && (r.vwap_rel_M15 ?? 0) < 0 && (r.RSI_M15 ?? 0) >= 30 && (r.RSI_M15 ?? 0) <= 55
    if (isShort) shortOk++
  }
  return { longOk: 0, shortOk }
}

async function main() {
  // Fetch latest snapshot from local server
  const res = await fetch('http://localhost:8888/api/snapshot', { cache: 'no-store' })
  if (!res.ok) {
    const body = await res.text()
    console.error('SNAPSHOT_ERROR', res.status, body)
    process.exit(1)
  }
  const snapshot: MarketRawSnapshot = await res.json()
  const features = computeFeatures(snapshot)
  const dec: MarketDecision = decideFromFeatures(features)

  const counts = basicCounts(features)
  const rules = setupRuleCounts(features)

  // Candidate selection (use preview limit to see what would be top picks)
  const previewLimit = ((signalsCfg as any)?.limits?.max_setups_no_trade ?? 5)
  const cands = selectCandidates(features, dec, previewLimit)
  // CSV breakdown export
  const lean = (()=>{ try { return (await import('../config/candidates.json')).default?.profiles?.[((await import('../config/candidates.json')).default?.profile||'lean')] } catch { return null } })()
  const diagEnabled = (lean?.diag_enabled !== false)
  const rows = diagEnabled ? (cands as any[]).map((c, i) => ({
    rank: i+1,
    symbol: c.symbol,
    S: c.score,
    S_after_sticky: c.S_after_sticky,
    prev_rank: c.prev_rank,
    ret_m15_pct: c.ret_m15_pct,
    ret_h1_pct: c.ret_h1_pct,
    rvol_h1: c.rvol_h1,
    atr_pct_h1: c.atr_pct_H1 ?? c.atrPctH1,
    vwap_rel_m15: c.vwap_rel_M15 ?? c.vwap_rel_m15,
    oi_change_pct_h1: c.oi_change_pct_h1,
    funding_z: c.funding_z,
    ema_stack: c.ema_stack,
    is_new: c.is_new,
    h1_range_pos_pct: c.h1_range_pos_pct,
    oi_delta_unreliable: c.oi_delta_unreliable === true,
    oi_delta_reliable: !(c.oi_delta_unreliable === true),
    burst_m15_pct: c.burst_m15_pct,
    // contributions (approx): weights * ranks — kept simple for CSV
    contrib_ret_m15: c.ret_m15_pct,
    contrib_rvol_h1: c.rvol_h1,
    contrib_ret_h1: c.ret_h1_pct,
    contrib_atr_pct_h1: c.atr_pct_H1 ?? c.atrPctH1,
    contrib_vwap_rel_m15: c.vwap_rel_M15 ?? c.vwap_rel_m15,
    contrib_oi_delta: c.oi_change_pct_h1,
    contrib_funding_z: c.funding_z,
    contrib_ema_stack: c.ema_stack,
    contrib_is_new: c.is_new,
    contrib_burst_m15: c.burst_m15_pct,
    contrib_body_ratio_m15: c.body_ratio_m15,
    contrib_consec_above_vwap: c.consec_above_vwap_m15,
    contrib_oi_divergence: c.oi_price_div_h1,
    contrib_rvol_liq_product: c.rvol_liq_product,
    penalty_cooldown: c.cooldown_factor,
    penalty_missing_oi: (c.oi_change_pct_h1 == null),
    penalty_oi_unreliable_total: (c.oi_delta_unreliable === true),
    gated_by: c.gated_by || ''
  })) : (cands as any[]).map((c:any,i:number)=>({ rank:i+1, symbol:c.symbol, S:c.score }))
  const header = Object.keys(rows[0]||{symbol:'',S:''})
  const fs = await import('node:fs')
  let csv = [header.join(','), ...rows.map(r=>header.map(k=>r[k]??'').join(','))].join('\n')
  if (diagEnabled) {
    try {
      const gateRaw = localStorage.getItem('cand_gate_stats')
      if (gateRaw) {
        const g = JSON.parse(gateRaw)
        csv += '\nSUMMARY,,,'
        const entries = Object.entries(g.counts||{})
        for (const [k,v] of entries) csv += `\n${k},${v}`
        csv += `\nuniverse_size,${g.universe||0}`
        csv += `\ntopK_size,${rows.length}`
      }
    } catch {}
  }
  fs.writeFileSync('candidates_s_breakdown.csv', csv)

  // Build a hypothetical SignalSet with minimal valid risk to test AJV acceptance
  const minimalRisk = Math.max(0.25, ((signalsCfg as any).risk_pct_by_posture?.[dec.flag] ?? 0.5))
  const expires = (signalsCfg as any).expires_in_min ?? 45
  const lim = (signalsCfg as any).limits || {}
  const slMult = Math.max(1.0, lim.min_sl_atr_mult ?? 1.0)
  const tp = ['1.0R','1.8R','3.0R']
  const hypothetical = {
    setups: cands.slice(0, previewLimit).map(r => {
      const isShort = r.ema_order_H1 === '200>50>20' && (r.vwap_rel_M15 ?? 0) < 0 && (r.RSI_M15 ?? 0) >= 30 && (r.RSI_M15 ?? 0) <= 55
      const side = 'SHORT' // SHORT only system
      return {
        symbol: r.symbol,
        mode: 'intraday',
        side,
        entry: 'limit @ last_close',
        sl: `${slMult.toFixed(1)}x ATR(H1) above`,
        tp,
        trailing: '1x ATR after TP1',
        sizing: { risk_pct: minimalRisk },
        expires_in_min: expires,
        why: ['diag']
      }
    })
  }
  const okDiag = validateSignalSet(hypothetical as any)

  // Real risk according to decision (may be 0 for NO-TRADE)
  const realRisk = (signalsCfg as any).risk_pct_by_posture?.[dec.flag] ?? 0.5
  const hypotheticalReal = JSON.parse(JSON.stringify(hypothetical))
  for (const s of (hypotheticalReal as any).setups) s.sizing.risk_pct = realRisk
  const okWithReal = validateSignalSet(hypotheticalReal as any)

  console.table([
    { key: 'symbols_total', value: counts.total },
    { key: 'missing_essential', value: counts.missingEssential },
    { key: 'too_volatile_atr', value: counts.tooVolatile },
    { key: 'eligible_after_filters', value: counts.eligible },
    { key: 'rule_ok_long', value: rules.longOk },
    { key: 'rule_ok_short', value: rules.shortOk },
    { key: 'candidates_scored', value: cands.length },
    { key: 'decision_flag', value: dec.flag },
    { key: 'decision_posture', value: dec.posture },
    { key: 'risk_pct_by_flag', value: realRisk },
    { key: 'ajv_ok_minimalRisk(>=0.25)', value: String(okDiag) },
    { key: 'ajv_ok_realRisk', value: String(okWithReal) },
  ])

  if (!okWithReal && okDiag) {
    console.log('\nLikely cause: schema rejects risk_pct for current decision. With minimal valid risk (>=0.25) setups would validate; with real risk it fails. Consider either allowing risk_pct=0 in schema for NO-TRADE preview or using a preview-only minimal risk.')
    if (validateSignalSet.errors) console.log('AJV errors (realRisk):', validateSignalSet.errors)
  } else if (!okDiag) {
    console.log('\nSchema rejects even minimal preview setups. See AJV errors:')
    if (validateSignalSet.errors) console.log(validateSignalSet.errors)
  } else if (cands.length === 0) {
    console.log('\nLikely cause: candidate filters too strict (ATR limit or missing essential fields).')
  } else if (rules.longOk + rules.shortOk === 0) {
    console.log('\nLikely cause: rule conditions (trend/VWAP/RSI) did not match any candidate.')
  }
}

main().catch(err => { console.error(err); process.exit(1) })


