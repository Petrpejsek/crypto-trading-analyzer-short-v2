import OpenAI from 'openai'
import fs from 'node:fs'
import path from 'node:path'
import { resolvePromptPathShort } from '../prompts/guard'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

type ProfitTakerInput = {
  symbol: string
  position: {
    size: number
    entryPrice: number
    currentPrice: number
    unrealizedPnl: number
  }
  context: { cycle: number; time_in_position_sec: number }
  marketData: any
}

type ProfitTakerDecision = {
  action: 'partial_take_profit' | 'skip'
  symbol: string
  take_percent: number
  rationale: string
  confidence?: number
  cycle?: number
  time_in_position_sec?: number
}

const ajv = new Ajv({ allErrors: true, removeAdditional: true, strict: false })
addFormats(ajv)

const schema = JSON.parse(fs.readFileSync(path.resolve('schemas/profit_taker.schema.json'), 'utf8'))
const validate = ajv.compile(schema as any)

const cfg = JSON.parse(fs.readFileSync(path.resolve('config/profit_taker.json'), 'utf8'))
const SYSTEM_PROMPT = fs.readFileSync(resolvePromptPathShort('profit_taker.md'), 'utf8')

function sleep(ms: number): Promise<void> { return new Promise(res => setTimeout(res, ms)) }

export async function runProfitTakerDecision(input: ProfitTakerInput): Promise<{
  ok: boolean
  code?: 'no_api_key' | 'invalid_json' | 'schema' | 'empty_output' | 'timeout' | 'http' | 'unknown'
  latencyMs: number
  data?: ProfitTakerDecision | null
  meta?: any
}> {
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

    const payloadStr = (()=>{ try { return JSON.stringify(input) } catch { return '{}' } })()
    try { console.info('[PT_GPT_PAYLOAD_BYTES]', payloadStr.length) } catch {}

    const body: any = {
      model: cfg?.openai?.model || 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: payloadStr }
      ],
      temperature: 0.1,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'profit_taker_decision',
          schema: schema as any,
          strict: true
        }
      },
      max_completion_tokens: 4096
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await client.chat.completions.create(body)
        const text = resp?.choices?.[0]?.message?.content || ''
        try { console.info('[PT_GPT_TEXT_LEN]', text ? text.length : 0) } catch {}
        if (!text || !String(text).trim()) {
          return { ok: false, code: 'empty_output', latencyMs: Date.now() - t0, data: null, meta: { request_id: (resp as any)?.id ?? null } }
        }
        let parsed: any
        try { parsed = JSON.parse(text) } catch (e:any) {
          try { console.error('[PT_GPT_JSON_PARSE_ERR]', { len: text.length, start: text.slice(0, 200) }) } catch {}
          return { ok: false, code: 'invalid_json', latencyMs: Date.now() - t0, data: null, meta: { request_id: (resp as any)?.id ?? null, parse_error: String((e&&e.message)||e) } }
        }
        if (!validate(parsed)) {
          try { console.error('[PT_GPT_SCHEMA_ERR]', { keys: Object.keys(parsed||{}), errors: validate.errors?.slice(0,3) }) } catch {}
          return { ok: false, code: 'schema', latencyMs: Date.now() - t0, data: null, meta: { errors: validate.errors } }
        }
        return { ok: true, latencyMs: Date.now() - t0, data: parsed as ProfitTakerDecision }
      } catch (e: any) {
        const code = e?.status === 401 ? 'no_api_key' : (e?.name === 'AbortError' ? 'timeout' : (e?.response?.status ? 'http' : 'unknown'))
        try { console.error('[PT_GPT_ERR]', { code, name: e?.name, message: e?.message, status: e?.status, http_status: e?.response?.status }) } catch {}
        if ((code === 'http' || code === 'timeout') && attempt === 0) {
          await sleep(200 + Math.floor(Math.random() * 400))
          continue
        }
        throw e
      }
    }
    // If we exhausted attempts without returning, fail explicitly
    return { ok: false, code: 'unknown', latencyMs: Date.now() - t0, data: null, meta: { reason: 'no_decision_generated' } }
  } catch (e: any) {
    const code = e?.status === 401 ? 'no_api_key' : (e?.name === 'AbortError' ? 'timeout' : (e?.response?.status ? 'http' : 'unknown'))
    try { console.error('[PT_GPT_ERR]', { code, name: e?.name, message: e?.message, status: e?.status, http_status: e?.response?.status }) } catch {}
    return { ok: false, code, latencyMs: Date.now() - t0, data: null, meta: { message: e?.message || String(e), status: e?.status ?? null, http_status: e?.response?.status ?? null } }
  }
}

export type { ProfitTakerInput, ProfitTakerDecision }


