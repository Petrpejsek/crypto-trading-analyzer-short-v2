import OpenAI from 'openai'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import entryStrategySchemaJson from '../../schemas/entry_strategy.schema.json'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { cleanSchema } from './lib/clean_schema'

export type StrategyPlan = {
  entry: number
  sl: number
  tp1: number
  tp2: number
  tp3: number
  risk: string
  reasoning: string
}

export type EntryStrategyResponse = {
  symbol: string
  conservative: StrategyPlan
  aggressive: StrategyPlan
}

export type EntryStrategyInput = {
  symbol: string
  asset_data: Record<string, any>
}

const ajv = new Ajv({ allErrors: true, removeAdditional: true, strict: false })
addFormats(ajv)
const validate = ajv.compile(entryStrategySchemaJson as any)

const SYSTEM_PROMPT = fs.readFileSync(path.resolve('prompts/entry_strategy.md'), 'utf8')
const PROMPT_HASH = crypto.createHash('sha256').update(SYSTEM_PROMPT).digest('hex')
const SCHEMA_VERSION = String((entryStrategySchemaJson as any).version || '2.0.0')
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

    const instructions = fs.readFileSync(path.resolve('prompts/entry_strategy.md'), 'utf8')
    const model = 'gpt-4o'
    const timeoutMs = 15000 // 15 seconds timeout

    console.info('[ENTRY_STRATEGY_PAYLOAD_BYTES]', JSON.stringify(input).length)

    const body: any = {
      model,
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: JSON.stringify(input) }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'entry_strategy_response',
          schema: schema as any,
          strict: true
        }
      },
      temperature: (()=>{ try { const t = Number(process.env.ENTRY_STRATEGY_TEMPERATURE); return Number.isFinite(t) ? t : 0.2 } catch { return 0.2 } })(),
      max_completion_tokens: 1024
    }

    const resp = await client.chat.completions.create(body)
    const text = resp.choices?.[0]?.message?.content || ''

    if (!text || !String(text).trim()) {
      return result(false, 'empty_output', Date.now() - t0, null, {
        prompt_hash: PROMPT_HASH,
        schema_version: SCHEMA_VERSION,
        request_id: (resp as any)?.id ?? null
      })
    }

    let parsed: any
    try { 
      parsed = JSON.parse(text) 
    } catch { 
      try { 
        console.error('[ENTRY_STRATEGY_JSON_FAIL]', { 
          response_length: text.length, 
          response_start: text.slice(0, 200) 
        }) 
      } catch {}
      return result(false, 'invalid_json', Date.now() - t0, null, {
        prompt_hash: PROMPT_HASH,
        schema_version: SCHEMA_VERSION,
        request_id: (resp as any)?.id ?? null
      })
    }

    if (!validate(parsed)) {
      try { 
        console.error('[ENTRY_STRATEGY_SCHEMA_FAIL]', { 
          parsed_keys: Object.keys(parsed),
          symbol: parsed?.symbol,
          has_conservative: !!parsed?.conservative,
          has_aggressive: !!parsed?.aggressive,
          validation_errors: validate.errors?.slice(0, 3) 
        }) 
      } catch {}
      return result(false, 'schema', Date.now() - t0, null, {
        prompt_hash: PROMPT_HASH,
        schema_version: SCHEMA_VERSION
      })
    }

    const latencyMs = Date.now() - t0
    return result(true, undefined, latencyMs, parsed as EntryStrategyResponse, {
      prompt_hash: PROMPT_HASH,
      schema_version: SCHEMA_VERSION,
      request_id: (resp as any)?.id ?? null
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
      prompt_hash: PROMPT_HASH,
      schema_version: SCHEMA_VERSION,
      http_status: status,
      http_error: msg ? String(msg).slice(0, 160) : null
    })
  }
}

// Už nepotřebujeme parsování – výstup je numerický.
