import OpenAI from 'openai'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import entryStrategySchemaJson from '../../schemas/entry_strategy.schema.json'
import fs from 'node:fs'
import path from 'node:path'
import { resolvePromptPathShort } from '../prompts/guard'
import crypto from 'node:crypto'
import { cleanSchema } from './lib/clean_schema'

export type StrategyPlan = {
  entry: number
  sl: number
  tp1: number
  tp2: number
  tp3: number
  risk?: string
  reasoning?: string
}

export type StrategyPlanOrError = StrategyPlan | { error: string }

export type EntryStrategyResponse = {
  symbol: string
  risk_profile?: 'conservative' | 'aggressive'
  confidence?: number
  conservative_score?: number
  aggressive_score?: number
  conservative: StrategyPlanOrError
  aggressive: StrategyPlanOrError
}

export type EntryStrategyInput = {
  symbol: string
  asset_data: Record<string, any>
  side?: 'LONG' | 'SHORT'
}

const ajv = new Ajv({ allErrors: true, removeAdditional: false, strict: false })
addFormats(ajv)
const validate = ajv.compile(entryStrategySchemaJson as any)

const SYSTEM_PROMPT_CONS = (() => {
  try { return fs.readFileSync(resolvePromptPathShort('entry_strategy_conservative.md'), 'utf8') } catch { return '' }
})()
const SYSTEM_PROMPT_AGGR = (() => {
  try { return fs.readFileSync(resolvePromptPathShort('entry_strategy_aggressive.md'), 'utf8') } catch { return '' }
})()
const PROMPT_CONS_HASH = crypto.createHash('sha256').update(SYSTEM_PROMPT_CONS).digest('hex')
const PROMPT_AGGR_HASH = crypto.createHash('sha256').update(SYSTEM_PROMPT_AGGR).digest('hex')
const SCHEMA_VERSION = String((entryStrategySchemaJson as any).version || '2.1.0')
const schema = cleanSchema(entryStrategySchemaJson as any)

function result(ok: boolean, code: string | undefined, latencyMs: number, data: EntryStrategyResponse | null, meta?: any) {
  return { ok, code, latencyMs, data, meta }
}

export async function runEntryStrategy(input: EntryStrategyInput): Promise<{ ok: boolean; code?: string; latencyMs: number; data: EntryStrategyResponse | null; meta?: any }> {
  const t0 = Date.now()
  
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw Object.assign(new Error('no_api_key'), { status: 401 })
    }

    const client = new OpenAI({ 
      apiKey: process.env.OPENAI_API_KEY,
      organization: (process as any)?.env?.OPENAI_ORG_ID,
      project: (process as any)?.env?.OPENAI_PROJECT
    } as any)
    // Model lze konfigurovat přes ENTRY_STRATEGY_MODEL; default: gpt-4o-mini (stabilní JSON mode)
    const model = String(process.env.ENTRY_STRATEGY_MODEL || 'gpt-4o-mini')

    console.info('[ENTRY_STRATEGY_PAYLOAD_BYTES]', JSON.stringify(input).length)

    type AssistantKind = 'conservative' | 'aggressive'
    // Simplified schema - GPT returns just the plan without wrapper
    const buildSubSchema = (kind: AssistantKind) => ({
      type: 'object',
      additionalProperties: false,
      properties: {
        entry: { type: 'number' },
        sl: { type: 'number' },
        tp1: { type: 'number' },
        tp2: { type: 'number' },
        tp3: { type: 'number' },
        risk: { type: 'string' },
        reasoning: { type: 'string' }
      },
      required: ['entry','sl']
    }) as const

    const callAssistant = async (kind: AssistantKind): Promise<{ ok: true, data: any, requestId?: string } | { ok: false, code: 'no_api_key'|'invalid_json'|'schema'|'empty_output'|'timeout'|'http'|'http_400'|'http_401'|'http_403'|'http_404'|'http_409'|'http_422'|'http_429'|'http_500'|'unknown', requestId?: string } > => {
      try {
        const systemPrompt = kind === 'conservative' ? SYSTEM_PROMPT_CONS : SYSTEM_PROMPT_AGGR
        const body: any = {
          model,
          messages: [
            { role: 'system', content: 'Reply with JSON only. Output must be a single JSON object with numeric fields where applicable. No prose.' },
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(input) }
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' }
        }
        const resp = await client.chat.completions.create(body)
        const text = resp.choices?.[0]?.message?.content || ''
        try { console.info(`[ENTRY_STRATEGY_${kind.toUpperCase()}_OUT_LEN]`, text ? text.length : 0) } catch {}
        try { console.info(`[ENTRY_STRATEGY_${kind.toUpperCase()}_OUT_START]`, text.slice(0, 200)) } catch {}
        const requestId = (resp as any)?.id ?? undefined
        if (!text || !String(text).trim()) return { ok: false, code: 'empty_output', requestId }
        let parsed: any
        try { 
          parsed = JSON.parse(text)
          // Debug: log what GPT actually returned
          console.info(`[ENTRY_STRATEGY_${kind.toUpperCase()}_PARSED]`, {
            symbol: input.symbol,
            kind,
            parsed_keys: Object.keys(parsed),
            has_entry: 'entry' in parsed,
            has_sl: 'sl' in parsed,
            has_tps: (('tp1' in parsed && 'tp2' in parsed && 'tp3' in parsed) || (Array.isArray(parsed.tp_levels) && parsed.tp_levels.length >= 3)),
            has_tp_levels: Array.isArray(parsed.tp_levels),
            tp_levels_count: Array.isArray(parsed.tp_levels) ? parsed.tp_levels.length : 0,
            entry: parsed.entry,
            sl: parsed.sl,
            tp_levels: parsed.tp_levels
          })
        } catch { return { ok: false, code: 'invalid_json', requestId } }

        // Map conservative assistant's new schema → flat plan (entry/sl/tp1/tp2/tp3)
        try {
          if (kind === 'conservative') {
            const looksNew = parsed && typeof parsed === 'object' && parsed.entry && typeof parsed.entry === 'object' && typeof parsed.entry.price === 'number'
            console.info(`[ENTRY_STRATEGY_${kind.toUpperCase()}_CHECK_NEW]`, {
              symbol: input.symbol,
              looksNew,
              hasEntry: !!parsed.entry,
              entryIsObject: typeof parsed.entry === 'object',
              entryPriceIsNumber: typeof parsed.entry?.price === 'number',
              hasTpLevels: Array.isArray(parsed.tp_levels)
            })
            if (looksNew) {
              const findTp = (tag: 'tp1'|'tp2'|'tp3'): number => {
                const list = Array.isArray(parsed.tp_levels) ? parsed.tp_levels : []
                const it = list.find((x: any) => x && String(x.tag) === tag)
                return Number(it?.price)
              }
              const tp1Val = findTp('tp1')
              const tp2Val = findTp('tp2')
              const tp3Val = findTp('tp3')
              
              // Log missing TPs but don't fail - show what we have
              if (!Number.isFinite(tp1Val) || !Number.isFinite(tp2Val) || !Number.isFinite(tp3Val)) {
                console.warn(`[ENTRY_STRATEGY_${kind.toUpperCase()}_MISSING_TP]`, {
                  symbol: input.symbol,
                  tp_levels: parsed.tp_levels,
                  tp1: tp1Val,
                  tp2: tp2Val,
                  tp3: tp3Val,
                  missing_count: [tp1Val, tp2Val, tp3Val].filter(v => !Number.isFinite(v)).length
                })
              }
              
              const mapped = {
                entry: Number(parsed.entry.price),
                sl: Number(parsed.sl),
                ...(Number.isFinite(tp1Val) && tp1Val > 0 ? { tp1: tp1Val } : {}),
                ...(Number.isFinite(tp2Val) && tp2Val > 0 ? { tp2: tp2Val } : {}),
                ...(Number.isFinite(tp3Val) && tp3Val > 0 ? { tp3: tp3Val } : {}),
                reasoning: typeof parsed?.reasoning === 'string' ? parsed.reasoning : undefined
              }
              
              // Guard against NaN from missing entry/sl (TPs optional)
              const finite = (n: any) => typeof n === 'number' && Number.isFinite(n)
              if (!finite(mapped.entry) || !finite(mapped.sl)) {
                return { ok: false, code: 'schema', requestId }
              }

              parsed = mapped
            }
          }
        } catch {}

        // Map aggressive assistant's new schema → flat plan (entry/sl/tp1/tp2/tp3)
        try {
          if (kind === 'aggressive') {
            const looksNew = parsed && typeof parsed === 'object' && parsed.entry && typeof parsed.entry === 'object' && (typeof parsed.entry.price === 'number' || String(parsed.entry.type||'').length>0)
            console.info(`[ENTRY_STRATEGY_${kind.toUpperCase()}_CHECK_NEW]`, {
              symbol: input.symbol,
              looksNew,
              hasEntry: !!parsed.entry,
              entryIsObject: typeof parsed.entry === 'object',
              entryPriceIsNumber: typeof parsed.entry?.price === 'number',
              hasTpLevels: Array.isArray(parsed.tp_levels)
            })
            if (looksNew) {
              const findTp = (tag: 'tp1'|'tp2'|'tp3'): number => {
                const list = Array.isArray(parsed.tp_levels) ? parsed.tp_levels : []
                const it = list.find((x: any) => x && String(x.tag) === tag)
                return Number(it?.price)
              }
              const tp1Val = findTp('tp1')
              const tp2Val = findTp('tp2')
              const tp3Val = findTp('tp3')
              
              // Log missing TPs but don't fail - show what we have
              if (!Number.isFinite(tp1Val) || !Number.isFinite(tp2Val) || !Number.isFinite(tp3Val)) {
                console.warn(`[ENTRY_STRATEGY_${kind.toUpperCase()}_MISSING_TP]`, {
                  symbol: input.symbol,
                  tp_levels: parsed.tp_levels,
                  tp1: tp1Val,
                  tp2: tp2Val,
                  tp3: tp3Val,
                  missing_count: [tp1Val, tp2Val, tp3Val].filter(v => !Number.isFinite(v)).length
                })
              }
              
              const mapped = {
                entry: Number(parsed.entry.price),
                sl: Number(parsed.sl),
                ...(Number.isFinite(tp1Val) && tp1Val > 0 ? { tp1: tp1Val } : {}),
                ...(Number.isFinite(tp2Val) && tp2Val > 0 ? { tp2: tp2Val } : {}),
                ...(Number.isFinite(tp3Val) && tp3Val > 0 ? { tp3: tp3Val } : {}),
                reasoning: typeof parsed?.reasoning === 'string' ? parsed.reasoning : undefined
              }
              
              // Guard against NaN from missing entry/sl (TPs optional)
              const finite = (n: any) => typeof n === 'number' && Number.isFinite(n)
              if (!finite(mapped.entry) || !finite(mapped.sl)) {
                return { ok: false, code: 'schema', requestId }
              }

              parsed = mapped
            }
          }
        } catch {}
        
        // Strict normalization: drop unknown keys and coerce numbers before validation
        try {
          if (parsed && typeof parsed === 'object') {
            const toNum = (v: any): number | undefined => {
              const n = Number(v)
              return Number.isFinite(n) && n > 0 ? n : undefined
            }
            const entryNum = typeof (parsed as any).entry === 'object' && (parsed as any).entry
              ? toNum((parsed as any).entry.price)
              : toNum((parsed as any).entry)
            const slNum = toNum((parsed as any).sl)
            if (entryNum && slNum) {
              const next: any = { entry: entryNum, sl: slNum }
              const tp1n = toNum((parsed as any).tp1); if (tp1n) next.tp1 = tp1n
              const tp2n = toNum((parsed as any).tp2); if (tp2n) next.tp2 = tp2n
              const tp3n = toNum((parsed as any).tp3); if (tp3n) next.tp3 = tp3n
              if (typeof (parsed as any).reasoning === 'string') {
                const r = String((parsed as any).reasoning)
                if (r.length >= 10) next.reasoning = r.slice(0, 4000)
              }
              if (typeof (parsed as any).risk === 'string') {
                const allowed = new Set(['Nízké', 'Střední', 'Vysoké'])
                if (allowed.has((parsed as any).risk)) next.risk = (parsed as any).risk
              }
              parsed = next
            }
          }
        } catch {}
        
        // Validate against subschema for the specific plan
        try {
          const ajvLocal = new Ajv({ allErrors: true, strict: false })
          const v = ajvLocal.compile(cleanSchema(buildSubSchema(kind) as any) as any)
          if (!v(parsed)) {
            console.error(`[ENTRY_STRATEGY_${kind.toUpperCase()}_VALIDATION_FAIL]`, {
              symbol: input.symbol,
              errors: (ajvLocal.errors || []).slice(0, 3)
            })
            return { ok: false, code: 'schema', requestId }
          }
        } catch {}
        return { ok: true, data: parsed, requestId }
      } catch (e: any) {
        const name = String(e?.name || '').toLowerCase()
        const status = Number(e?.status || e?.response?.status)
        const code = name.includes('abort')
          ? 'timeout'
          : (Number.isFinite(status) && status > 0 ? (`http_${status}` as any) : (e?.status ? 'http' : 'unknown'))
        try {
          console.error(`[ENTRY_STRATEGY_${kind.toUpperCase()}_HTTP_ERR]`, {
            status: status || null,
            message: e?.response?.data?.error?.message || e?.message || null
          })
        } catch {}
        return { ok: false, code }
      }
    }

    // Call only conservative planner; aggressively skip aggressive variant
    const cons = await callAssistant('conservative')
    try { console.info('[ENTRY_STRATEGY_AGGRESSIVE_SKIPPED] reason:"temporarily disabled"') } catch {}
    const aggr = { ok: false, code: 'skipped' } as any

    // Now GPT returns the plan directly, not wrapped in a key
    // Sanitize helper: trim reasoning to schema limits and strip unsupported props
    const isPlan = (p: any): boolean => {
      if (!p) return false
      // Only check entry and SL are valid - TPs can be 0 (missing)
      const entry = Number(p.entry)
      const sl = Number(p.sl) 
      return Number.isFinite(entry) && entry > 0 &&
             Number.isFinite(sl) && sl > 0
    }
    const sanitizePlan = (p: any): any => {
      try {
        if (!isPlan(p)) return p
        const out: any = {
          entry: Number(p.entry),
          sl: Number(p.sl)
        }
        // Include only valid TP values (> 0)
        const maybeAddTp = (key: 'tp1'|'tp2'|'tp3') => {
          const v = Number((p as any)[key])
          if (Number.isFinite(v) && v > 0) out[key] = v
        }
        maybeAddTp('tp1')
        maybeAddTp('tp2')
        maybeAddTp('tp3')
        // Optional properties – keep only when valid
        if (typeof p.risk === 'string') {
          const allowed = new Set(['Nízké', 'Střední', 'Vysoké'])
          if (allowed.has(p.risk)) out.risk = p.risk
        }
        if (typeof p.reasoning === 'string') {
          const r = String(p.reasoning)
          // Include only when meeting minLength and clamp to schema maxLength (4000)
          if (r.length >= 10) out.reasoning = r.slice(0, 4000)
        }
        return out
      } catch {
        return p
      }
    }
    const safeSymbol = (() => {
      try {
        const raw = String((input as any)?.symbol || (input as any)?.asset_data?.symbol || '')
        let v = raw.trim().toUpperCase().replace('/', '')
        if (!v.endsWith('USDT') && v.length > 0) v = `${v}USDT`
        return v || (String((input as any)?.asset_data?.symbol || '').toUpperCase())
      } catch { return String(input.symbol || '') }
    })()
    const output: EntryStrategyResponse = {
      symbol: safeSymbol,
      conservative: (cons.ok ? sanitizePlan((cons as any).data) : { error: (cons as any).code || 'unknown' }) as StrategyPlanOrError,
      aggressive: (aggr.ok ? sanitizePlan((aggr as any).data) : { error: (aggr as any).code || 'unknown' }) as StrategyPlanOrError
    }

    // Validate full merged object using main schema
    if (!validate(output)) {
      try {
        console.error('[ENTRY_STRATEGY_FINAL_SCHEMA_FAIL]', {
          symbol: input.symbol,
          errors: validate.errors?.slice(0, 3)
        })
      } catch {}
      return result(false, 'schema', Date.now() - t0, null, {
        prompt_hash_conservative: PROMPT_CONS_HASH,
        prompt_hash_aggressive: PROMPT_AGGR_HASH,
        schema_version: SCHEMA_VERSION
      })
    }

    // SHORT sanity (order and RRR): if side is SHORT, enforce tp3 < tp2 < tp1 < entry < sl and compute RRR for conservative plan
    try {
      const side = String((input as any)?.side || 'SHORT').toUpperCase()
      if (side === 'SHORT') {
        const plan: any = (output as any)?.conservative || null
        if (plan && typeof plan === 'object' && Number.isFinite(plan.entry) && Number.isFinite(plan.sl)) {
          const tp1 = Number(plan.tp1), tp2 = Number(plan.tp2), tp3 = Number(plan.tp3)
          const entry = Number(plan.entry), sl = Number(plan.sl)
          const orderOk = (Number.isFinite(tp3) && Number.isFinite(tp2) && Number.isFinite(tp1)) ? (tp3 < tp2 && tp2 < tp1 && tp1 < entry && entry < sl) : (entry < sl)
          if (!orderOk) {
            return result(false, 'schema', Date.now() - t0, null, { prompt_hash_conservative: PROMPT_CONS_HASH, prompt_hash_aggressive: PROMPT_AGGR_HASH, schema_version: SCHEMA_VERSION })
          }
          const rrr = (Number.isFinite(tp2) ? (entry - tp2) : (Number.isFinite(tp1) ? (entry - tp1) : 0)) / Math.max(1e-9, (sl - entry))
          if (!(Number.isFinite(rrr) && rrr > 0)) {
            return result(false, 'schema', Date.now() - t0, null, { prompt_hash_conservative: PROMPT_CONS_HASH, prompt_hash_aggressive: PROMPT_AGGR_HASH, schema_version: SCHEMA_VERSION })
          }
        }
      }
    } catch {}

    const latencyMs = Date.now() - t0
    return result(true, undefined, latencyMs, output, {
      prompt_hash_conservative: PROMPT_CONS_HASH,
      prompt_hash_aggressive: PROMPT_AGGR_HASH,
      schema_version: SCHEMA_VERSION
    })

  } catch (e: any) {
    const latencyMs = Date.now() - t0
    const name = String(e?.name || '').toLowerCase()
    const code = name.includes('abort') ? 'timeout' : (e?.status ? 'http' : 'unknown')
    const status = e?.status ?? e?.response?.status ?? null
    const body = e?.response?.data ?? null
    const msg = e?.response?.data?.error?.message ?? e?.message ?? null
    
    try { 
      console.error('[ENTRY_STRATEGY_GPT_ERR]', { 
        http_status: status, 
        http_msg: msg, 
        body_keys: body ? Object.keys(body).slice(0, 10) : null 
      }) 
    } catch {}
    
    return result(false, code, latencyMs, null, {
      schema_version: SCHEMA_VERSION,
      http_status: status,
      http_error: msg ? String(msg).slice(0, 160) : null
    })
  }
}

// Už nepotřebujeme parsování – výstup je numerický.
