import OpenAI from 'openai'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import riskSchemaJson from '../../schemas/entry_risk.schema.json'
import { cleanSchema } from './lib/clean_schema'

const ajv = new Ajv({ allErrors: true, removeAdditional: false, strict: false })
addFormats(ajv)
const validate = ajv.compile(riskSchemaJson as any)

const SYSTEM_PROMPT = fs.readFileSync(path.resolve('prompts/entry_risk_manager.md'), 'utf8')
const PROMPT_HASH = crypto.createHash('sha256').update(SYSTEM_PROMPT).digest('hex')
const SCHEMA_VERSION = String((riskSchemaJson as any).version || '1.0.0')

export type EntryRiskInput = Record<string, any>
export type EntryRiskOutput = {
  symbol: string
  risk_profile: 'conservative' | 'aggressive'
  conservative_score: number
  aggressive_score: number
  prob_success: number
  decision: 'enter' | 'skip'
  chosen_plan: any | null
  reasons: string[]
}

function result(ok: boolean, code: string | undefined, latencyMs: number, data: EntryRiskOutput | null, meta?: any) {
  return { ok, code, latencyMs, data, meta }
}

// helper – bezpečně vytáhni text z různých tvarů odpovědi (chat vs responses)
function extractText(resp: any): string {
  if (resp?.output_text && typeof resp.output_text === 'string') return resp.output_text
  const msg = resp?.choices?.[0]?.message?.content
  if (typeof msg === 'string') return msg
  if (Array.isArray(msg)) {
    const t = msg.map((p: any) => (p?.text ?? '')).join('')
    if (t) return t
  }
  return ''
}

export async function runEntryRisk(input: EntryRiskInput): Promise<{ ok: boolean; code?: string; latencyMs: number; data: EntryRiskOutput | null; meta?: any }> {
  const t0 = Date.now()
  console.log('[ENTRY_RISK_REQUEST]', { symbol: input?.symbol, candidates: input?.candidates?.length })
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw Object.assign(new Error('no_api_key'), { status: 401 })
    }
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      organization: (process as any)?.env?.OPENAI_ORG_ID,
      project: (process as any)?.env?.OPENAI_PROJECT
    } as any)

    const model = process.env.ENTRY_RISK_MODEL || 'gpt-4o'

    // Pro Responses API použijeme zjednodušené schéma bez nullable
    const responsesSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        symbol: { type: "string" },
        risk_profile: { type: "string", enum: ["conservative", "aggressive"] },
        conservative_score: { type: "number" },
        aggressive_score: { type: "number" },
        prob_success: { type: "number" },
        decision: { type: "string", enum: ["enter", "skip"] },
        chosen_plan: {
          type: "object",
          additionalProperties: false,
          properties: {
            style: { type: "string" },
            entry: { type: "number" },
            sl: { type: "number" },
            tp_levels: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  tag: { type: "string" },
                  price: { type: "number" },
                  allocation_pct: { type: "number" }
                },
                required: ["tag", "price", "allocation_pct"]
              }
            },
            reasoning: { type: "string" }
          },
          required: ["style", "entry", "sl", "tp_levels", "reasoning"]
        },
        reasons: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", minLength: 4, maxLength: 200 } }
      },
      required: ["symbol", "risk_profile", "conservative_score", "aggressive_score", "prob_success", "decision", "chosen_plan", "reasons"]
    }

    let text = ''
    try {
      const useResponses = String(model).startsWith('gpt-5')
      if (useResponses) {
        const resp: any = await client.responses.create({
          model,
          input: JSON.stringify(input),
          instructions: SYSTEM_PROMPT,
          temperature: 0.2,
          text: { format: { name: 'entry_risk', type: 'json_schema', schema: responsesSchema as any, strict: true } }
        } as any)
        text = extractText(resp)
      } else {
        // Use the simplified schema for Chat Completions as well to avoid anyOf/null issues
        const resp = await client.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(input) }
          ],
          temperature: 0.2,
          response_format: { type: 'json_schema', json_schema: { name: 'entry_risk', schema: responsesSchema as any, strict: true } as any }
        } as any)
        text = extractText(resp)
      }
    } catch (e: any) {
      const name = String(e?.name || '').toLowerCase()
      const code = name.includes('abort') ? 'timeout' : (e?.status ? 'http' : 'unknown')
      const http_status = e?.status ?? e?.response?.status ?? null
      const http_message = e?.response?.data?.error?.message ?? e?.message ?? null
      try { console.error('[ENTRY_RISK_GPT_ERR]', { code, http_status, http_message }) } catch {}
      throw e
    }

    if (!text || !String(text).trim()) return result(false, 'empty_output', Date.now() - t0, null, { prompt_hash: PROMPT_HASH, schema_version: SCHEMA_VERSION })

    let parsed: any
    try { parsed = JSON.parse(text) } catch { return result(false, 'invalid_json', Date.now() - t0, null, { prompt_hash: PROMPT_HASH, schema_version: SCHEMA_VERSION }) }

    if (!validate(parsed)) {
      try { console.error('[ENTRY_RISK_SCHEMA_FAIL]', validate.errors?.slice(0, 3)) } catch {}
      return result(false, 'schema', Date.now() - t0, null, { prompt_hash: PROMPT_HASH, schema_version: SCHEMA_VERSION })
    }

    const latencyMs = Date.now() - t0
    console.log('[ENTRY_RISK_SUCCESS]', { symbol: input?.symbol, decision: parsed?.decision, profile: parsed?.risk_profile, prob: parsed?.prob_success })
    return result(true, undefined, latencyMs, parsed as EntryRiskOutput, { prompt_hash: PROMPT_HASH, schema_version: SCHEMA_VERSION })
  } catch (e: any) {
    const latencyMs = Date.now() - t0
    const name = String(e?.name || '').toLowerCase()
    const code = name.includes('abort') ? 'timeout' : (e?.status ? 'http' : 'unknown')
    const status = e?.status ?? e?.response?.status ?? null
    const msg = e?.response?.data?.error?.message ?? e?.message ?? null
    return result(false, code, latencyMs, null, { prompt_hash: PROMPT_HASH, schema_version: SCHEMA_VERSION, http_status: status, http_error: msg ? String(msg).slice(0, 160) : null })
  }
}

