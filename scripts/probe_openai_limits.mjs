import { fetch } from 'undici'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import dotenv from 'dotenv'

// Load environment variables from .env.local if present (non-fatal if missing)
try {
  const envLocalPath = path.resolve(process.cwd(), '.env.local')
  if (fs.existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath })
  }
} catch (_) {}

/**
 * Minimal CLI args parser for --model and --timeout
 */
function parseArgs(argv) {
  const args = { model: 'gpt-5', timeoutMs: 10000 }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--model' && i + 1 < argv.length) args.model = argv[++i]
    else if (a.startsWith('--model=')) args.model = a.split('=')[1]
    else if (a === '--timeout' && i + 1 < argv.length) args.timeoutMs = Number(argv[++i])
    else if (a.startsWith('--timeout=')) args.timeoutMs = Number(a.split('=')[1])
  }
  return args
}

function getEnv(name, fallback = undefined) {
  const v = process.env[name]
  return (v === undefined || v === null || v === '') ? fallback : v
}

function pickRateLimitHeaders(res) {
  const h = res.headers
  const get = (k) => h.get(k) || null
  return {
    request_id: get('x-request-id'),
    limit_requests: get('x-ratelimit-limit-requests'),
    remaining_requests: get('x-ratelimit-remaining-requests'),
    reset_requests: get('x-ratelimit-reset-requests'),
    limit_tokens: get('x-ratelimit-limit-tokens'),
    remaining_tokens: get('x-ratelimit-remaining-tokens'),
    reset_tokens: get('x-ratelimit-reset-tokens'),
    processing_ms: get('openai-processing-ms'),
    model_header: get('openai-model')
  }
}

async function withTimeout(promise, ms, label = 'operation') {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    const r = await promise(ac.signal)
    return r
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw Object.assign(new Error(`${label}_timeout`), { status: 408 })
    }
    throw err
  } finally {
    clearTimeout(t)
  }
}

async function main() {
  const { model, timeoutMs } = parseArgs(process.argv)
  const apiKey = getEnv('OPENAI_API_KEY')
  const orgId = getEnv('OPENAI_ORG_ID')
  const projectId = getEnv('OPENAI_PROJECT')

  if (!apiKey) {
    console.error(JSON.stringify({ ok: false, error: 'missing_api_key', message: 'Set OPENAI_API_KEY environment variable (sk-… or sk-proj-…).' }))
    process.exit(1)
  }

  const baseUrl = 'https://api.openai.com/v1'
  const commonHeaders = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  }
  if (orgId) commonHeaders['OpenAI-Organization'] = orgId
  if (projectId) commonHeaders['OpenAI-Project'] = projectId

  // Step 1: List models (captures headers + availability of gpt-5*)
  let models = []
  let modelsHeaders = null
  let modelsStatus = null
  try {
    const res = await withTimeout((signal) => fetch(`${baseUrl}/models`, { method: 'GET', headers: commonHeaders, signal }), timeoutMs, 'models')
    modelsStatus = res.status
    modelsHeaders = pickRateLimitHeaders(res)
    const body = await res.json()
    if (res.ok && body && Array.isArray(body.data)) {
      models = body.data.map(x => x.id)
    } else {
      throw Object.assign(new Error(body?.error?.message || 'models_error'), { status: res.status })
    }
  } catch (err) {
    console.error(JSON.stringify({ ok: false, stage: 'models', status: err?.status ?? null, message: err?.message || String(err) }))
    process.exit(1)
  }

  const gpt5Related = models.filter(id => id.startsWith('gpt-5'))
  const gpt5Available = gpt5Related.includes(model)

  // Step 2: Probe chat.completions on the requested model (captures rate-limit headers)
  let chatHeaders = null
  let chatStatus = null
  let chatOk = false
  let chatResponse = null
  try {
    const payload = {
      model,
      messages: [
        { role: 'system', content: 'Reply with JSON only.' },
        { role: 'user', content: JSON.stringify({ ping: 'health' }) }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'health',
          strict: true,
          schema: {
            type: 'object',
            properties: { ping: { type: 'string' } },
            required: ['ping'],
            additionalProperties: false
          }
        }
      },
      max_completion_tokens: 4
    }

    const res = await withTimeout((signal) => fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: commonHeaders,
      body: JSON.stringify(payload),
      signal
    }), timeoutMs, 'chat')
    chatStatus = res.status
    chatHeaders = pickRateLimitHeaders(res)
    const body = await res.json()
    if (!res.ok) {
      throw Object.assign(new Error(body?.error?.message || 'chat_error'), { status: res.status })
    }
    chatOk = true
    chatResponse = body
  } catch (err) {
    const out = {
      ok: false,
      models: {
        status: modelsStatus,
        rate_limits: modelsHeaders,
        found_gpt5: gpt5Related,
        gpt5_available: gpt5Available
      },
      chat_probe: {
        ok: false,
        model,
        status: err?.status ?? null,
        message: err?.message || String(err)
      }
    }
    console.log(JSON.stringify(out, null, 2))
    process.exit(1)
  }

  const result = {
    ok: true,
    models: {
      status: modelsStatus,
      rate_limits: modelsHeaders,
      found_gpt5: gpt5Related,
      gpt5_available: gpt5Available
    },
    chat_probe: {
      ok: chatOk,
      model,
      status: chatStatus,
      rate_limits: chatHeaders,
      usage: chatResponse?.usage || null,
      sample: chatResponse?.choices?.[0]?.message?.content || null
    }
  }
  console.log(JSON.stringify(result, null, 2))
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, fatal: true, message: e?.message || String(e) }))
  process.exit(1)
})
