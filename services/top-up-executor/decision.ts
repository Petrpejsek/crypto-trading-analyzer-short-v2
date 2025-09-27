import OpenAI from 'openai'
import fs from 'node:fs'
import path from 'node:path'
import { resolvePromptPathShort } from '../prompts/guard'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

export type TopUpExecutorInput = {
  symbol: string
  pilot: {
    size: number
    entryPrice: number
    avgEntryPrice?: number
    markPrice: number
    sl: number | null
    tpLevels: Array<{ tag: 'tp1' | 'tp2' | 'tp3'; price: number; allocation_pct: number }>
    openedAt: string
    leverage?: number | null
    positionNotional?: number | null
    marginUsd?: number | null
  }
  plan: {
    plannedTotalSize: number
    multiplier: number
    desiredSize: number
    sizeRemaining: number
  }
  exits?: { currentSL: number | null; currentTP: number | null }
  watcherEvent: {
    reason_code: string
    confidence: number
    reasoning: string
    snapshot_ts: string
    riskSnapshot?: Record<string, any>
  }
  marketData: any
  context: {
    cycle: number
    ttl_minutes_left: number
    time_in_position_sec: number
    topUpsAlreadySent: number
  }
}

export type TopUpExecutorDecision = {
  action: 'top_up' | 'skip' | 'abort'
  symbol: string
  top_up_ratio?: number
  top_up_size?: number
  limit_price?: number | null
  rationale: string
  confidence?: number
  safety_checks?: {
    spread_ok?: boolean
    slippage_ok?: boolean
    pump_ok?: boolean
    posture_ok?: boolean
    leverage_ok?: boolean
  }
  watcher_reason_code?: string
  watcher_confidence?: number
  ttl_minutes_left?: number
}

const ajv = new Ajv({ allErrors: true, removeAdditional: true, strict: false })
addFormats(ajv)

const schema = JSON.parse(fs.readFileSync(path.resolve('schemas/top_up_executor.schema.json'), 'utf8'))
const validate = ajv.compile(schema as any)

const cfg = JSON.parse(fs.readFileSync(path.resolve('config/top_up_executor.json'), 'utf8'))
const SYSTEM_PROMPT = fs.readFileSync(resolvePromptPathShort('top_up_executor.md'), 'utf8')

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }

export async function runTopUpExecutorDecision(input: TopUpExecutorInput): Promise<{
  ok: boolean
  code?: 'no_api_key' | 'invalid_json' | 'schema' | 'empty_output' | 'timeout' | 'http' | 'unknown'
  latencyMs: number
  data?: TopUpExecutorDecision | null
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

    const payloadStr = (() => { try { return JSON.stringify(input) } catch { return '{}' } })()
    try { console.info('[TUP_GPT_PAYLOAD_BYTES]', payloadStr.length) } catch {}

    const body: any = {
      model: cfg?.openai?.model || 'gpt-5',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: payloadStr }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'top_up_executor_decision',
          schema: schema as any,
          strict: true
        }
      },
      max_completion_tokens: 4096
    }

    for (let attempt = 0; attempt < (Number(cfg?.maxRetries) || 2); attempt++) {
      try {
        const resp = await client.chat.completions.create(body)
        const text = resp?.choices?.[0]?.message?.content || ''
        try { console.info('[TUP_GPT_TEXT_LEN]', text ? text.length : 0) } catch {}
        if (!text || !String(text).trim()) {
          return { ok: false, code: 'empty_output', latencyMs: Date.now() - t0, data: null, meta: { request_id: (resp as any)?.id ?? null } }
        }
        let parsed: any
        try { parsed = JSON.parse(text) } catch (e: any) {
          try { console.error('[TUP_GPT_JSON_PARSE_ERR]', { len: text.length, start: text.slice(0, 200) }) } catch {}
          return { ok: false, code: 'invalid_json', latencyMs: Date.now() - t0, data: null, meta: { request_id: (resp as any)?.id ?? null, parse_error: String((e && e.message) || e) } }
        }
        if (!validate(parsed)) {
          try { console.error('[TUP_GPT_SCHEMA_ERR]', { keys: Object.keys(parsed || {}), errors: validate.errors?.slice(0, 3) }) } catch {}
          return { ok: false, code: 'schema', latencyMs: Date.now() - t0, data: null, meta: { errors: validate.errors } }
        }
        return { ok: true, latencyMs: Date.now() - t0, data: parsed as TopUpExecutorDecision }
      } catch (e: any) {
        const code = e?.status === 401
          ? 'no_api_key'
          : (e?.name === 'AbortError'
            ? 'timeout'
            : (e?.response?.status ? 'http' : 'unknown'))
        try { console.error('[TUP_GPT_ERR]', { code, name: e?.name, message: e?.message, status: e?.status, http_status: e?.response?.status }) } catch {}
        if ((code === 'http' || code === 'timeout') && attempt < (Number(cfg?.maxRetries) || 2) - 1) {
          await sleep(200 + Math.floor(Math.random() * 400))
          continue
        }
        throw e
      }
    }

    return { ok: false, code: 'unknown', latencyMs: Date.now() - t0, data: null, meta: { reason: 'no_decision_generated' } }
  } catch (e: any) {
    const code = e?.status === 401
      ? 'no_api_key'
      : (e?.name === 'AbortError'
        ? 'timeout'
        : (e?.response?.status ? 'http' : 'unknown'))
    try { console.error('[TUP_GPT_ERR]', { code, name: e?.name, message: e?.message, status: e?.status, http_status: e?.response?.status }) } catch {}
    return {
      ok: false,
      code,
      latencyMs: Date.now() - t0,
      data: null,
      meta: { message: e?.message || String(e), status: e?.status ?? null, http_status: e?.response?.status ?? null }
    }
  }
}

export type { TopUpExecutorInput as TopUpExecutorPayload }
