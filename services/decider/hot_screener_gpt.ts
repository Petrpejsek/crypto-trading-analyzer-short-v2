import OpenAI from 'openai'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import hotPicksSchemaJson from '../../schemas/hot_picks.schema.json'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { cleanSchema } from './lib/clean_schema'

export type HotPick = {
  symbol: string
  rating: string
  confidence: string
  reasoning: string
}

export type HotPicksResponse = {
  hot_picks: HotPick[]
}

export type HotScreenerInput = {
  coins: Array<Record<string, any>>
  strategy: 'gainers' | 'volume'
}

const ajv = new Ajv({ allErrors: true, removeAdditional: true, strict: false })
addFormats(ajv)
const validate = ajv.compile(hotPicksSchemaJson as any)

const SYSTEM_PROMPT = fs.readFileSync(path.resolve('prompts/hot_screener.md'), 'utf8')
const PROMPT_HASH = crypto.createHash('sha256').update(SYSTEM_PROMPT).digest('hex')
const SCHEMA_VERSION = String((hotPicksSchemaJson as any).version || '1.0.0')
const schema = cleanSchema(hotPicksSchemaJson as any)

function result(ok: boolean, code: string | undefined, latencyMs: number, data: HotPicksResponse, meta?: any) {
  return { ok, code, latencyMs, data, meta }
}

export async function runHotScreener(input: HotScreenerInput): Promise<{ ok: boolean; code?: string; latencyMs: number; data: HotPicksResponse; meta?: any }> {
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

    const model = 'gpt-4o'

    console.info('[HOT_SCREENER_PAYLOAD_BYTES]', JSON.stringify(input).length)
    console.info('[HOT_SCREENER_COINS_COUNT]', input.coins?.length || 0)
    console.info('[HOT_SCREENER_STRATEGY]', input.strategy)

    // Simplified message for GPT-5 - direct input without duplication
    const body: any = {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(input) }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    }

    const resp = await client.chat.completions.create(body)
    const text = resp.choices?.[0]?.message?.content || ''
    
    // Debug: log full response object
    console.info('[HOT_SCREENER_RAW_RESPONSE]', {
      hasChoices: !!resp.choices,
      choicesLength: resp.choices?.length,
      hasContent: !!resp.choices?.[0]?.message?.content,
      finishReason: resp.choices?.[0]?.finish_reason,
      model: resp.model,
      usage: resp.usage
    })
    
    try { console.info('[HOT_SCREENER_OUTPUT_LEN]', text ? text.length : 0) } catch {}
    
    console.info('[HOT_SCREENER_RESPONSE_LENGTH]', text.length)
    console.info('[HOT_SCREENER_RESPONSE_START]', text.slice(0, 200))

    if (!text || !String(text).trim()) {
      return result(false, 'empty_output', Date.now() - t0, { hot_picks: [] }, {
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
        console.error('[HOT_SCREENER_JSON_FAIL]', { 
          response_length: text.length, 
          response_start: text.slice(0, 200) 
        }) 
      } catch {}
      return result(false, 'invalid_json', Date.now() - t0, { hot_picks: [] }, {
        prompt_hash: PROMPT_HASH,
        schema_version: SCHEMA_VERSION,
        request_id: (resp as any)?.id ?? null
      })
    }

    if (!validate(parsed)) {
      try { 
        console.error('[HOT_SCREENER_SCHEMA_FAIL]', { 
          parsed_keys: Object.keys(parsed),
          picks_count: Array.isArray(parsed?.hot_picks) ? parsed.hot_picks.length : 0,
          validation_errors: validate.errors?.slice(0, 3) 
        }) 
      } catch {}
      return result(false, 'schema', Date.now() - t0, { hot_picks: [] }, {
        prompt_hash: PROMPT_HASH,
        schema_version: SCHEMA_VERSION
      })
    }

    const latencyMs = Date.now() - t0
    return result(true, undefined, latencyMs, parsed as HotPicksResponse, {
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
      console.error('[HOT_SCREENER_GPT_ERR]', { 
        http_status: status, 
        http_msg: msg, 
        body_keys: body ? Object.keys(body).slice(0, 10) : null 
      }) 
    } catch {}
    
    return result(false, code, latencyMs, { hot_picks: [] }, {
      prompt_hash: PROMPT_HASH,
      schema_version: SCHEMA_VERSION,
      http_status: status,
      http_error: msg ? String(msg).slice(0, 160) : null
    })
  }
}
