import { runFinalPicker, type FinalPickInput } from '../../services/decider/final_picker_gpt'
import fs from 'node:fs'
import path from 'node:path'

function readCfg() {
  const raw = fs.readFileSync(path.resolve('config/decider.json'), 'utf8')
  return JSON.parse(raw)
}

async function main() {
  const modeArg = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : ''
  const fixtureArg = process.argv.includes('--fixture') ? process.argv[process.argv.indexOf('--fixture') + 1] : ''
  const writeArg = process.argv.includes('--write') ? process.argv[process.argv.indexOf('--write') + 1] : ''
  const mode = (modeArg || (fixtureArg ? `fixture:${fixtureArg}` : '') || process.env.FP_TEST_MODE || '').trim() as any
  if (!mode) throw new Error('Missing --mode')
  process.env.FP_TEST_MODE = mode
  const cfg = readCfg()
  const fp = cfg?.final_picker || {}

  const input: FinalPickInput = {
    now_ts: Date.now(),
    posture: 'NO-TRADE',
    risk_policy: { ok: 0.5, caution: 0.25, no_trade: 0.0 },
    side_policy: 'both',
    settings: {
      max_picks: 6,
      expiry_minutes: [60, 90],
      tp_r_momentum: [1.2, 2.5],
      tp_r_reclaim: [1.0, 2.0],
      max_leverage: 20,
      max_picks_no_trade: Number(fp.max_picks_no_trade ?? 3),
      confidence_floor_no_trade: Number(fp.confidence_floor_no_trade ?? 0.65),
      risk_pct_no_trade_default: Number(fp.risk_pct_no_trade_default ?? 0.0)
    } as any,
    candidates: [
      {
        symbol: 'ALTUSDT',
        price: 1.234,
        atr_pct_h1: 3.0,
        vwap_m15: 1.233,
        rvol_h1: 2.1,
        ret_m15_pct: 1.9,
        h1_range_pos_pct: 85,
        ema_stack: 1,
        oi_change_pct_h1: 6
      }
    ]
  }

  // For side_policy negative case, force long_only both at top-level and in settings (server reads top-level)
  if (fixtureArg === 'side_policy_violation') {
    input.side_policy = 'long_only'
    ;(input as any).settings.side_policy = 'long_only'
  }
  if (fixtureArg === 'reclaim_vwap_fail') {
    // Ensure vwap proximity check triggers only vwap_limit, not entry_price
    input.candidates[0].price = 1.260
    input.candidates[0].vwap_m15 = 1.200
    input.candidates[0].atr_pct_h1 = 1.0
  }

  const res = await runFinalPicker(input)
  const picksCount = Array.isArray(res?.data?.picks) ? res.data.picks.length : 0
  const out = {
    mode,
    ok: res.ok,
    code: res.code,
    picksCount,
    meta: {
      post_validation_checks: (res as any).meta?.post_validation_checks ?? null,
      filtered_counts: (res as any).meta?.filtered_counts ?? null,
      latencyMs: res.latencyMs
    }
  }
  const isErrorExpected = mode === 'error'
  const shouldOk = mode === 'success_notrade' || mode === 'no_picks'

  // Negative fixtures expectations
  if (mode.startsWith('fixture:')) {
    const fixture = fixtureArg
    const checks = (res as any).meta?.post_validation_checks || {}
    const counts = (res as any).meta?.filtered_counts || {}
    const failMap: Record<string, { check: string; counter: string }> = {
      dup_symbols: { check: 'unique', counter: 'duplicates' },
      side_policy_violation: { check: 'side_policy', counter: 'side_policy' },
      rrr_fail_tp1: { check: 'rrr', counter: 'rrr' },
      entry_far_from_price: { check: 'entry_price', counter: 'entry_price' },
      reclaim_vwap_fail: { check: 'vwap_limit', counter: 'vwap_limit' },
      advisory_flags_missing: { check: 'advisory_flags', counter: 'advisory_flags' },
      confidence_floor_fail: { check: 'confidence_floor', counter: 'confidence_floor' },
      leverage_cap_fail: { check: 'leverage_cap', counter: 'leverage_cap' }
    }
    const expected = failMap[fixture]
    let pass = true
    pass = pass && res.ok === false && res.code === 'post_validation' && picksCount === 0
    if (expected) {
      pass = pass && checks[expected.check] === false && Number(counts[expected.counter] ?? 0) > 0
      const allChecks = ['unique','side_policy','rrr','entry_price','vwap_limit','advisory_flags','confidence_floor','leverage_cap']
      const allCounters = ['rrr','entry_price','vwap_limit','duplicates','side_policy','advisory_flags','confidence_floor','leverage_cap']
      for (const k of allChecks) { if (k !== expected.check) pass = pass && checks[k] === true }
      for (const k of allCounters) { if (k !== expected.counter) pass = pass && Number(counts[k] ?? 0) === 0 }
    }
    const printed = { fixture, ...out }
    console.log(JSON.stringify(printed))
    if (writeArg) {
      try {
        const lean = { fixture, ok: out.ok, code: out.code, post_validation_checks: out.meta.post_validation_checks, filtered_counts: out.meta.filtered_counts }
        const dir = path.dirname(writeArg)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.appendFileSync(writeArg, JSON.stringify(lean) + "\n", 'utf8')
      } catch (e) {
        console.error('write_failed', e)
      }
    }
    process.exit(pass ? 0 : 1)
    return
  }

  const ok = shouldOk ? res.ok === true : (isErrorExpected ? res.ok === false : res.ok)
  if (!ok) {
    console.log(JSON.stringify(out))
    process.exit(1)
  }
  console.log(JSON.stringify(out))
}

main().catch((e) => { console.error(e); process.exit(1) })


