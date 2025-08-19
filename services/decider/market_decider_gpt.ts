import OpenAI from 'openai'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import type { MarketDecision } from './rules_decider'
import { decideFromFeatures } from './rules_decider'
import type { FeaturesSnapshot } from '../../types/features'
import type { MarketCompact } from './market_compact'
import decisionSchemaJson from '../../schemas/market_decision.schema.json'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readResponsesJson } from './lib/read_responses_json'
import { cleanSchema } from './lib/clean_schema'

const ajv = new Ajv({ allErrors: true, removeAdditional: true, strict: false })
addFormats(ajv)
const validateDecision = ajv.compile(decisionSchemaJson as any)
const cfg = JSON.parse(fs.readFileSync(path.resolve('config/decider.json'), 'utf8'))
const SYSTEM = fs.readFileSync(path.resolve('prompts/market_decider.md'), 'utf8')
const PROMPT_HASH = crypto.createHash('sha256').update(SYSTEM).digest('hex')
const SCHEMA_VERSION = String((decisionSchemaJson as any).version || '1')
const decisionSchema = cleanSchema(decisionSchemaJson as any)

function failClosed(code: string): MarketDecision {
  return {
    flag: 'NO-TRADE',
    posture: 'RISK-OFF',
    market_health: 0,
    expiry_minutes: 30,
    reasons: [`gpt_error:${code}`],
    risk_cap: { max_concurrent: 0, risk_per_trade_max: 0 },
  }
}

// helper – bezpečně vytáhni text z různých tvarů odpovědi (chat vs responses)
function extractText(resp: any): string {
  // Responses API
  if (resp?.output_text && typeof resp.output_text === 'string') return resp.output_text
  // Chat Completions
  const msg = resp?.choices?.[0]?.message?.content
  if (typeof msg === 'string') return msg
  if (Array.isArray(msg)) {
    const t = msg.map((p: any) => (p?.text ?? '')).join('')
    if (t) return t
  }
  return ''
}

export async function runMarketDecider(input: MarketCompact): Promise<{ ok: boolean; code?: 'timeout'|'http'|'invalid_json'|'schema'|'unknown'|'empty_output'; latencyMs: number; data?: MarketDecision; meta?: any }> {
  const t0 = Date.now()
  try {
    if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error('no_api_key'), { status: 401 })
    const m3 = cfg?.m3 || {}
    const model = m3.model || cfg.model || 'gpt-4o'
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, organization: (process as any)?.env?.OPENAI_ORG_ID, project: (process as any)?.env?.OPENAI_PROJECT } as any)
    const instructions = 'Reply with JSON only. No prose. Follow the JSON schema exactly.'
    const timeoutMs = Number(m3.timeoutMs ?? cfg.timeoutMs ?? 6000)
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: JSON.stringify(input) }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'market_decision',
          schema: decisionSchema as any,
          strict: true
        }
      },
      max_tokens: Number(m3.max_output_tokens ?? 512)
    })
    const text = resp.choices?.[0]?.message?.content || ''
    let parsed: any
    try { parsed = JSON.parse(text) } catch { throw new Error('invalid_json') }
    const valid = validateDecision(parsed)
    if (!valid) {
      const err = new Error('schema') as any; err.ajv = true; throw err
    }
    const latencyMs = Date.now() - t0
    return { ok: true, latencyMs, data: parsed, meta: { prompt_hash: PROMPT_HASH, schema_version: SCHEMA_VERSION } }
  } catch (e: any) {
    const latencyMs = Date.now() - t0
    const code = (e?.name === 'AbortError') ? 'timeout' : (e?.status ? 'http' : (e?.message === 'invalid_json' ? 'invalid_json' : ((e?.message === 'empty_output' || e?.message === 'empty_output_text') ? 'empty_output' : (e?.ajv ? 'schema' : 'unknown'))))
    const status = e?.status ?? e?.response?.status ?? null
    const errObj = (e?.response && e.response.data && e.response.data.error) ? e.response.data.error : null
    const msg = (errObj && errObj.message) ? errObj.message : (e?.message ?? null)
    const typ = errObj?.type ?? null
    const cod = errObj?.code ?? null
    const http_error = (msg ? String(msg).slice(0,160) : null)
    try { const body = e?.response?.data ?? null; console.error('[M3_GPT_ERR]', { http_status: status, http_msg: msg, body_keys: body ? Object.keys(body).slice(0,10) : null }) } catch {}
    return { ok: false, code, latencyMs, meta: { prompt_hash: PROMPT_HASH, schema_version: SCHEMA_VERSION, http: { status, message: msg, type: typ, code: cod }, http_status: status, http_error } }
  }
}

export async function decideMarketStrict(opts: { mode: 'gpt' | 'mock'; compact: MarketCompact; features: FeaturesSnapshot; openaiKey?: string | null; timeoutMs: number }): Promise<any> {
  const { mode, compact, features, timeoutMs } = opts
  if (mode !== 'gpt') return decideFromFeatures(features)
  const res = await runMarketDecider(compact)
  if (!res.ok || !res.data) {
    const reason = `gpt_error:${res.code || 'unknown'}`
    return { flag: 'NO-TRADE', posture: 'RISK-OFF', market_health: 0, expiry_minutes: 30, reasons: [reason], risk_cap: { max_concurrent: 0, risk_per_trade_max: 0 }, meta: { ...(res.meta||{}), latencyMs: res.latencyMs, error_code: res.code } }
  }
  return { ...(res.data as any), meta: { ...(res.meta||{}), latencyMs: res.latencyMs } }
}


