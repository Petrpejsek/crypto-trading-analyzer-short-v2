import fs from 'node:fs'
import path from 'node:path'
import { computeM2Lite } from '../../services/features/compute_features'
import type { MarketRawSnapshot } from '../../types/market_raw'

type TopItem = { rank: number; symbol: string; S: number }

type Args = { doExport: boolean; kOverride?: number; failOnEmpty: boolean }

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  let doExport = true
  let kOverride: number | undefined
  let failOnEmpty = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--export') doExport = true
    else if (a === '--no-export') doExport = false
    else if (a === '--k') { const v = Number(argv[i+1]); if (Number.isFinite(v)) kOverride = v; i++ }
    else if (a === '--fail-on-empty' || a === '--fail-on-empty=true') failOnEmpty = true
    else if (a === '--fail-on-empty=false') failOnEmpty = false
  }
  return { doExport, kOverride, failOnEmpty }
}

async function ensureExport(): Promise<void> {
  const snapPath = path.resolve('fixtures/last_snapshot.json')
  if (fs.existsSync(snapPath)) return
  const { execSync } = await import('node:child_process')
  execSync('npm run -s export:m1m2', { stdio: 'inherit' })
  // After export, copy most recent into last_*
  try {
    const dir = path.resolve('fixtures')
    const snapsDir = path.join(dir, 'market_raw')
    const featsDir = path.join(dir, 'features')
    const snaps = fs.readdirSync(snapsDir).filter(f=>f.startsWith('snapshot_') && f.endsWith('.json')).sort()
    const feats = fs.readdirSync(featsDir).filter(f=>f.startsWith('features_') && f.endsWith('.json')).sort()
    const lastSnap = snaps[snaps.length-1]
    const lastFeat = feats[feats.length-1]
    if (lastSnap) fs.copyFileSync(path.join(snapsDir, lastSnap), path.join(dir, 'last_snapshot.json'))
    if (lastFeat) fs.copyFileSync(path.join(featsDir, lastFeat), path.join(dir, 'last_features.json'))
  } catch {}
}

function readSnapshot(): MarketRawSnapshot {
  const snapPath = path.resolve('fixtures/last_snapshot.json')
  const raw = fs.readFileSync(snapPath, 'utf8')
  return JSON.parse(raw)
}

function backupConfig(): string {
  const p = path.resolve('config/candidates.json')
  return fs.readFileSync(p, 'utf8')
}

function writeConfig(text: string): void {
  const p = path.resolve('config/candidates.json')
  fs.writeFileSync(p, text)
}

function makeLeanConfig(base: any): any {
  const cfg = JSON.parse(JSON.stringify(base))
  // Apply lean overrides directly to base fields used by selector
  cfg.topK = 8
  cfg.quantile_gates = { enabled: false, ret_m15_q_min: 0.65, rvol_h1_q_min: 0.7, h1_range_pos_q_min: 0.7, apply_only_in_no_trade: true }
  cfg.sticky = { enabled: false, sticky_minutes: 30, bonus_max: 0.015, delta_s_max: 0.02 }
  cfg.cooldown_minutes = 60
  cfg.score = cfg.score || {}
  cfg.score.penalty_oi_unreliable = 0.012
  cfg.score.penalty_oi_unreliable_by_age = { enabled: true, max_additional: 0.010 }
  cfg.score.w_burst_m15 = 0.04
  cfg.score_extra = cfg.score_extra || {}
  cfg.score_extra.w_body_ratio_m15 = 0.04
  cfg.score_extra.w_consec_above_vwap_m15 = 0.03
  cfg.score_extra.w_rvol_liq_product = 0.04
  cfg.score_extra.w_oi_divergence = 0.03
  cfg.score_extra.penalty_cooldown_max = 0.02
  return cfg
}

async function selectTopK(features: any, snapshot: MarketRawSnapshot): Promise<TopItem[]> {
  // Bust module cache by importing with unique query
  const mod = await import(`../../services/signals/candidate_selector.ts?ts=${Date.now()}`)
  const { selectCandidates } = mod
  // Respect TopK via env override for deterministic cuts in runner
  const arr = selectCandidates(features, snapshot, {
    decisionFlag: 'NO-TRADE',
    allowWhenNoTrade: true,
    limit: Number.MAX_SAFE_INTEGER,
    cfg: { atr_pct_min: 0, atr_pct_max: 100, min_liquidity_usdt: 0 },
  }) as any[]
  return arr.map((c: any, i: number) => ({ rank: i + 1, symbol: c.symbol, S: Number(c.score || 0) }))
}

function overlapAtK(a: TopItem[], b: TopItem[]): { K: number; overlap: number; diffs: Array<{ symbol: string; delta_rank: number; delta_S: number }> } {
  const K = Math.min(a.length, b.length)
  const setB = new Map(b.slice(0, K).map(x => [x.symbol, x]))
  let same = 0
  const diffs: Array<{ symbol: string; delta_rank: number; delta_S: number }> = []
  for (const it of a.slice(0, K)) {
    const other = setB.get(it.symbol)
    if (other) {
      same += 1
      diffs.push({ symbol: it.symbol, delta_rank: it.rank - other.rank, delta_S: Number((it.S - other.S).toFixed(4)) })
    }
  }
  return { K, overlap: K ? Number((same / K).toFixed(4)) : 0, diffs }
}

async function main() {
  const args = parseArgs()
  if (args.doExport) await ensureExport()
  const snapshot = readSnapshot()
  const features = computeM2Lite(snapshot)
  const original = backupConfig()
  const base = JSON.parse(original)
  // LEAN run
  const leanCfg = makeLeanConfig(base)
  writeConfig(JSON.stringify(leanCfg, null, 2))
  // Enforce TopK from lean profile for this process
  try { process.env.CAND_TOPK = String(leanCfg.topK || 8) } catch {}
  let leanTop = await selectTopK(features, snapshot)
  // FULL run (restore original)
  writeConfig(JSON.stringify(base, null, 2))
  try { delete (process as any).env.CAND_TOPK } catch {}
  let fullTop = await selectTopK(features, snapshot)
  // If both empty and export allowed, try re-export once
  if (args.doExport && leanTop.length === 0 && fullTop.length === 0) {
    const { execSync } = await import('node:child_process')
    try { execSync('npm run -s export:m1m2', { stdio: 'ignore' }) } catch {}
    await ensureExport()
    const snap2 = readSnapshot()
    const feats2 = computeM2Lite(snap2)
    writeConfig(JSON.stringify(leanCfg, null, 2))
    leanTop = await selectTopK(feats2, snap2)
    writeConfig(JSON.stringify(base, null, 2))
    fullTop = await selectTopK(feats2, snap2)
  }
  // Restore original config
  writeConfig(original)

  // Metrics
  const met = overlapAtK(leanTop, fullTop)
  const K = (typeof args.kOverride === 'number' && args.kOverride > 0) ? Math.min(args.kOverride, met.K) : met.K
  if (K === 0) {
    // Print gates summary for context
    try {
      const cfg = JSON.parse(original)
      const gates = {
        min_avg_trade_usdt: cfg?.gates?.min_avg_trade_usdt ?? null,
        min_body_ratio_m15: cfg?.gates?.min_body_ratio_m15 ?? null,
        max_upper_wick_ratio_m15: cfg?.gates?.max_upper_wick_ratio_m15 ?? null,
        atr_pct_h1: { min: cfg?.hard_gates?.atr_pct_h1_min ?? null, max: cfg?.hard_gates?.atr_pct_h1_max ?? null }
      }
      console.log(JSON.stringify({ K: 0, reason: 'no candidates after gates', gates, profile: 'lean' }))
    } catch {
      console.log(JSON.stringify({ K: 0, reason: 'no candidates after gates', profile: 'lean' }))
    }
    if (args.failOnEmpty) process.exit(1)
    process.exit(0)
  }
  const slicedLean = leanTop.slice(0, K)
  const slicedFull = fullTop.slice(0, K)
  const { overlap, diffs } = overlapAtK(slicedLean, slicedFull)
  console.log(JSON.stringify({ K, overlap, lean_topK: slicedLean, full_topK: slicedFull, diffs }))
  if (overlap >= 0.9) process.exit(0)
  console.error(`overlap<0.90 (${overlap})`)
  process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })


