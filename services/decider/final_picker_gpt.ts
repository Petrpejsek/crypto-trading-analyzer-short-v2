import OpenAI from 'openai'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import schemaJson from '../../schemas/final_pick.schema.json'
import { readResponsesJson } from './lib/read_responses_json'
import { cleanSchema } from './lib/clean_schema'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { buildFinalPickerCandidates } from './build_final_picker_candidates'

export type FinalPickInput = {
  now_ts: number
  posture: 'OK' | 'CAUTION' | 'NO-TRADE'
  risk_policy: { ok: number; caution: number; no_trade: number }
  side_policy: 'long_only' | 'both'
  settings: {
    max_picks: number
    expiry_minutes: [number, number]
    tp_r_momentum: [number, number]
    tp_r_reclaim: [number, number]
    max_leverage: number
  }
  candidates: Array<Record<string, any>>
}

export type FinalPickSet = { picks: Array<Record<string, any>> }

const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
const validate = ajv.compile((schemaJson as any))

function result(ok: boolean, code: string | undefined, latencyMs: number, data: FinalPickSet, meta?: any) {
  return { ok, code, latencyMs, data, meta }
}

export async function runFinalPicker(input: FinalPickInput): Promise<{ ok: boolean; code?: string; latencyMs: number; data: FinalPickSet; meta?: any }> {
  const t0 = Date.now()
  try {
    // DEV test hook (strictly no effect in production CI): FP_TEST_MODE
    const nodeEnv = (() => { try { return String((process as any)?.env?.NODE_ENV || '') } catch { return '' } })()
    const allowDevHook = nodeEnv !== 'production'
    const testMode = allowDevHook ? process.env.FP_TEST_MODE : undefined
    let parsed: any | null = null
    if (testMode === 'success_notrade') {
      try { parsed = JSON.parse(fs.readFileSync(path.resolve('fixtures/finalpicker/success_notrade.json'), 'utf8')) } catch { return result(false, 'invalid_json', Date.now() - t0, { picks: [] }) }
    } else if (testMode === 'no_picks') {
      parsed = { picks: [] }
    } else if (testMode === 'error') {
      throw new Error('forced_error')
    } else if (testMode && testMode.startsWith('fixture:')) {
      const name = testMode.split(':')[1]
      try { parsed = JSON.parse(fs.readFileSync(path.resolve(`fixtures/finalpicker/${name}.json`), 'utf8')) } catch { return result(false, 'invalid_json', Date.now() - t0, { picks: [] }) }
    }
    // Advisory mode allowed via config; do not early-return here
    const cfgRaw = fs.readFileSync(path.resolve('config/decider.json'), 'utf8')
    const cfg = JSON.parse(cfgRaw)
    const fpCfg = cfg?.final_picker || {}
    const model = fpCfg?.model || 'gpt-5'
    const timeoutMs = Number(cfg?.timeoutMs ?? 10000)
    const system = fs.readFileSync(path.resolve('prompts/final_picker.md'), 'utf8')
    const promptHash = crypto.createHash('sha256').update(system).digest('hex')
    const schemaVersion = String((schemaJson as any).version || '1')
    const schema = cleanSchema(schemaJson as any)
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, organization: (process as any)?.env?.OPENAI_ORG_ID, project: (process as any)?.env?.OPENAI_PROJECT } as any)

    const adapted = { ...input, candidates: buildFinalPickerCandidates(input.candidates as any) }

    if (!parsed) {
      try { console.info('[FP_PAYLOAD_BYTES]', JSON.stringify(adapted).length) } catch {}
      const body: any = {
        model,
        messages: [
          { role: 'system', content: 'Reply with JSON only. No prose. Follow the JSON schema exactly. If unsure, return an empty picks:[]' },
          { role: 'user', content: JSON.stringify(adapted) }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'final_pick_set',
            schema: schema as any,
            strict: true
          }
        }
      }
      const outTokens = Number(fpCfg?.max_output_tokens ?? 16384)
      if (String(model).startsWith('gpt-5')) body.max_completion_tokens = outTokens
      else body.max_completion_tokens = outTokens
      const resp = await client.chat.completions.create(body)
      const txt = resp.choices?.[0]?.message?.content || ''
      if (!txt || !String(txt).trim()) return result(false, 'empty_output', Date.now() - t0, { picks: [] }, { prompt_hash: promptHash, schema_version: schemaVersion, request_id: (resp as any)?.id ?? null })
      try { parsed = JSON.parse(txt) } catch { 
        try { console.error('[FP_JSON_FAIL]', { response_length: txt.length, response_start: txt.slice(0, 200) }) } catch {}
        return result(false, 'invalid_json', Date.now() - t0, { picks: [] }, { prompt_hash: promptHash, schema_version: schemaVersion, request_id: (resp as any)?.id ?? null }) 
      }
    }
    if (!validate(parsed)) {
      try { console.error('[FP_SCHEMA_FAIL]', { parsed_keys: Object.keys(parsed), picks_count: Array.isArray(parsed?.picks) ? parsed.picks.length : 0, validation_errors: validate.errors?.slice(0, 3) }) } catch {}
      return result(false, 'schema', Date.now() - t0, { picks: [] }, { post_validation_checks: null, filtered_counts: null, prompt_hash: promptHash, schema_version: schemaVersion })
    }
    // Sort hygiene: label (SUPER_HOT>HOT>WATCH), confidence desc, symbol asc; trim reasons/warnings
    try {
      const order: Record<string, number> = { SUPER_HOT: 3, HOT: 2, WATCH: 1, IGNORE: 0 }
      const picks0 = Array.isArray((parsed as any)?.picks) ? (parsed as any).picks : []
      for (const p of picks0) {
        if (Array.isArray(p.reasons)) p.reasons = p.reasons.slice(0, 3)
        if (Array.isArray(p.warnings)) p.warnings = p.warnings.slice(0, 2)
      }
      ;(parsed as any).picks = picks0.sort((a:any,b:any)=> (order[b.label]??0)-(order[a.label]??0) || (b.confidence??0)-(a.confidence??0) || String(a.symbol).localeCompare(String(b.symbol)))
    } catch {}
    // Post validation (strict)
    const cfg2 = JSON.parse(fs.readFileSync(path.resolve('config/decider.json'), 'utf8'))
    const fp = cfg2?.final_picker || {}
    const picks: any[] = Array.isArray((parsed as any)?.picks) ? (parsed as any).picks : []
    const checks = { unique: true, side_policy: true, rrr: true, entry_price: true, vwap_limit: true, advisory_flags: true, confidence_floor: true, leverage_cap: true }
    const filtered = { rrr: 0, entry_price: 0, vwap_limit: 0, duplicates: 0, side_policy: 0, advisory_flags: 0, confidence_floor: 0, leverage_cap: 0 }
    // 1) unique symbols
    const syms = new Set<string>()
    for (const p of picks) { if (syms.has(p.symbol)) { checks.unique = false; filtered.duplicates += 1 } syms.add(p.symbol) }
    // 2) side policy
    if (input.side_policy === 'long_only' && picks.some(p=>p.side==='SHORT')) { checks.side_policy = false; filtered.side_policy += 1 }
    // side_policy currently supports 'long_only' | 'both'
    // 3) RRR minimums
    const r1 = Number(fp.rrr_min_tp1 ?? 1.0)
    const r2 = Number(fp.rrr_min_tp2 ?? 2.0)
    for (const p of picks) {
      const rr1 = Math.abs((p.tp1 - p.entry) / (p.entry - p.sl))
      const rr2 = Math.abs((p.tp2 - p.entry) / (p.entry - p.sl))
      if (!(Number.isFinite(rr1) && Number.isFinite(rr2) && rr1 >= r1 && rr2 >= r2)) { checks.rrr = false; filtered.rrr += 1 }
    }
    // 4) Entry vs price sanity (if provided via candidates)
    const atrOk = Number(fp.entry_price_atr_mult_ok ?? 0.6)
    const atrNt = Number(fp.entry_price_atr_mult_notrade ?? 0.5)
    const vwLim = Number(fp.limit_reclaim_vwap_atr_mult ?? 0.25)
    // build candidate map if caller provided extended fields
    const cMap: Record<string, any> = {}
    try { for (const c of input.candidates) cMap[c.symbol] = c } catch {}
    for (const p of picks) {
      const c = cMap[p.symbol]
      if (!c) continue
      const atr = Number(c.atr_pct_h1)
      const price = Number(c.price)
      const vwap = Number(c.vwap_m15)
      if (Number.isFinite(atr) && Number.isFinite(price)) {
        const lim = (input.posture === 'NO-TRADE') ? atrNt : atrOk
        if (Math.abs(p.entry - price) > lim * (atr/100) * price) { checks.entry_price = false; filtered.entry_price += 1 }
      }
      if (p.entry_type === 'LIMIT' && p.setup_type === 'RECLAIM' && Number.isFinite(vwap) && Number.isFinite(atr) && Number.isFinite(price)) {
        if (Math.abs(p.entry - vwap) > vwLim * (atr/100) * price) { checks.vwap_limit = false; filtered.vwap_limit += 1 }
      }
    }
    if (input.posture === 'NO-TRADE') {
      const maxPicks = Math.max(0, Number(fp.max_picks_no_trade ?? 3))
      const confFloor = Number(fp.confidence_floor_no_trade ?? 0.65)
      const riskDefault = Number(fp.risk_pct_no_trade_default ?? 0.0)
      if (picks.length > maxPicks) return result(false, 'post_validation', Date.now() - t0, { picks: [] }, { post_validation_checks: { unique: false }, filtered_counts: { duplicates: 0 } })
      for (const p of picks) {
        if (p.posture_context !== 'NO-TRADE' || p.advisory !== true) { checks.advisory_flags = false; filtered.advisory_flags += 1 }
        if (!(Number.isFinite(p.confidence) && p.confidence >= confFloor)) { checks.confidence_floor = false; filtered.confidence_floor += 1 }
        if (Number(p.risk_pct ?? -1) !== riskDefault) { checks.confidence_floor = false }
      }
    }
    // leverage cap (optional)
    if (Number.isFinite((input as any)?.settings?.max_leverage)) {
      for (const p of picks) {
        if (Number(p.leverage_hint ?? 0) > Number((input as any).settings.max_leverage)) { checks.leverage_cap = false; filtered.leverage_cap += 1; break }
      }
    }
    // If no picks and success, return checks true/zero
    if (picks.length === 0) {
      const allTrue = { unique: true, side_policy: true, rrr: true, entry_price: true, vwap_limit: true, advisory_flags: true, confidence_floor: true, leverage_cap: true }
      const zeros = { rrr: 0, entry_price: 0, vwap_limit: 0, duplicates: 0, side_policy: 0, advisory_flags: 0, confidence_floor: 0, leverage_cap: 0 }
      return result(true, undefined, Date.now() - t0, parsed as FinalPickSet, { post_validation_checks: allTrue, filtered_counts: zeros, prompt_hash: promptHash, schema_version: schemaVersion })
    }
    const anyFail = false === Object.values(checks).every(v => v === true)
    if (anyFail) {
      const failedChecks = Object.entries(checks).filter(([k, v]) => v !== true)
      try { console.error('[FP_VALIDATION_FAIL]', { failed_checks: failedChecks.map(([k,v]) => k), filtered_counts: filtered, picks_count: picks.length }) } catch {}
      return result(false, 'post_validation', Date.now() - t0, { picks: [] }, { post_validation_checks: checks, filtered_counts: filtered, prompt_hash: promptHash, schema_version: schemaVersion })
    }
    return result(true, undefined, Date.now() - t0, parsed as FinalPickSet, { post_validation_checks: checks, filtered_counts: filtered, prompt_hash: promptHash, schema_version: schemaVersion })
  } catch (e: any) {
    const name = String(e?.name || '').toLowerCase()
    const code = name.includes('abort') ? 'timeout' : (e?.status ? 'http' : (e?.message === 'invalid_json' ? 'invalid_json' : 'unknown'))
    const status = e?.status ?? e?.response?.status ?? null
    const body = e?.response?.data ?? null
    const msg = e?.response?.data?.error?.message ?? e?.message ?? null
    try { console.error('[FP_GPT_ERR]', { http_status: status, http_msg: msg, body_keys: body ? Object.keys(body).slice(0,10) : null }) } catch {}
    return result(false, code, Date.now() - t0, { picks: [] }, { post_validation_checks: null, filtered_counts: null, prompt_hash: null, schema_version: String((schemaJson as any).version || '1'), http_status: status, http_error: msg ? String(msg).slice(0,160) : null })
  }
}



