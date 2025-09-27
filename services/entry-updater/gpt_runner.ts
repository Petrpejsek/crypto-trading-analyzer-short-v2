import OpenAI from 'openai'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import fs from 'node:fs'
import path from 'node:path'
import type { EntryUpdaterInput, EntryUpdaterResponse } from './types'

const ajv = new Ajv({ strict: false })
addFormats(ajv)

function readPrompt(): string {
  const file = path.resolve('prompts/short/entry_updater.md')
  return fs.readFileSync(file, 'utf8')
}

function makeSchema(): any {
  const schemaFile = path.resolve('schemas/entry_updater_response.schema.json')
  const text = fs.readFileSync(schemaFile, 'utf8')
  return JSON.parse(text)
}

export async function runEntryUpdater(input: EntryUpdaterInput): Promise<{
  ok: boolean
  code?: string
  latencyMs: number
  data: EntryUpdaterResponse | null
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
      project: (process as any)?.env?.OPENAI_PROJECT,
      timeout: 600000
    } as any)

    const model = 'gpt-5'
    const schema = makeSchema()
    const validate = ajv.compile(schema)

    const body: any = {
      model,
      messages: [
        { role: 'system', content: readPrompt() },
        { role: 'user', content: JSON.stringify(input) }
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'EntryUpdater', strict: true, schema } as any },
      max_completion_tokens: 8192
    }

    const resp = await client.chat.completions.create(body)
    const text = resp.choices?.[0]?.message?.content || ''
    if (!text.trim()) return { ok: false, code: 'empty_output', latencyMs: Date.now() - t0, data: null, meta: { request_id: (resp as any)?.id ?? null } }

    let parsed: any
    try { parsed = JSON.parse(text) } catch (e) {
      return { ok: false, code: 'invalid_json', latencyMs: Date.now() - t0, data: null, meta: { preview: text.slice(0, 200) } }
    }

    if (!validate(parsed)) {
      return { ok: false, code: 'schema_validation', latencyMs: Date.now() - t0, data: null, meta: { errors: validate.errors } }
    }

    const data = parsed as EntryUpdaterResponse
    return { ok: true, latencyMs: Date.now() - t0, data, meta: { request_id: (resp as any)?.id ?? null } }
  } catch (error: any) {
    const code = error?.status === 401 ? 'no_api_key' : error?.response?.status ? 'http' : error?.message?.includes('timeout') ? 'timeout' : 'unknown'
    try { console.error('[ENTRY_UPDATER_GPT_ERR]', error?.message || error) } catch {}
    return { ok: false, code, latencyMs: Date.now() - t0, data: null, meta: { error: error?.message || 'unknown' } }
  }
}



