import OpenAI from 'openai'
import type { ReactiveEntryInput, ReactiveEntryDecision } from './types'
import { validateSnapshot } from './validate'
import { loadConfig } from './config'
import { validateSnapshotFreshness, validateCandleFreshness } from '../lib/freshness_guard'
import { logPayloadSize } from '../lib/payload_monitor'

/**
 * Run Reactive Entry decision with GPT-4o
 * Returns decision with latency and metadata
 */
export async function runReactiveEntryDecision(input: ReactiveEntryInput): Promise<{
  ok: boolean
  code?: 'no_api_key' | 'invalid_json' | 'schema' | 'empty_output' | 'timeout' | 'http' | 'context_insufficient' | 'validation_failed' | 'unknown'
  latencyMs: number
  data?: ReactiveEntryDecision | null
  meta?: any
  raw_request?: any
  raw_response?: any
}> {
  const t0 = Date.now()
  
  try {
    // FRESHNESS VALIDATION: Check timestamp and candles
    if (input.ts_utc) {
      const freshness = validateSnapshotFreshness({ timestamp: input.ts_utc }, 60000)
      console.info('[REACTIVE_ENTRY_FRESHNESS]', {
        symbol: input.symbol,
        ok: freshness.ok,
        age_seconds: freshness.age_seconds,
        error: freshness.error || null
      })
      
      if (!freshness.ok) {
        console.warn('[REACTIVE_ENTRY_STALE_DATA]', {
          symbol: input.symbol,
          age_seconds: freshness.age_seconds
        })
      }
    }
    
    // Validate last candle freshness
    if (input.candles) {
      const m5 = input.candles.m5
      if (Array.isArray(m5) && m5.length > 0) {
        const lastCandle = m5[m5.length - 1]
        if (lastCandle && lastCandle.t) {
          const candleFreshness = validateCandleFreshness({ closeTime: lastCandle.t }, 300000)
          console.info('[REACTIVE_ENTRY_CANDLE_FRESHNESS]', {
            symbol: input.symbol,
            ok: candleFreshness.ok,
            age_seconds: candleFreshness.age_seconds
          })
        }
      }
    }
    
    // VALIDATE SNAPSHOT BEFORE CALLING LLM (saves tokens!)
    const validation = validateSnapshot(input)
    if (!validation.valid) {
      console.log('[REACTIVE_ENTRY_VALIDATION_FAIL]', { 
        symbol: input.symbol, 
        code: validation.code, 
        details: validation.details 
      })
      
      // Return early with specific error (DON'T call LLM!)
      if (validation.code === 'context_insufficient') {
        const uiLang = input.ui_lang || 'cs'
        const reasoningLang = uiLang === 'cs' 
          ? `Kontext nedostatečný: ${validation.details}`
          : `Context insufficient: ${validation.details}`
        
        return {
          ok: true,
          code: validation.code,
          latencyMs: Date.now() - t0,
          data: {
            decision: 'skip',
            confidence: 0,
            mode: 'none',
            class: 'none',
            size_hint_pct: 0,
            entry: null,
            reasoning: reasoningLang,
            diagnostics: {
              edge_from_current_bps: 0,
              edge_min_required_bps: 0
            }
          },
          meta: { validation_error: validation.details, missing: validation.missing }
        }
      }
      
      // Other validation errors
      return {
        ok: false,
        code: 'validation_failed',
        latencyMs: Date.now() - t0,
        data: null,
        meta: { validation_error: validation.details }
      }
    }
    
    // Check API key
    if (!process.env.OPENAI_API_KEY) {
      throw Object.assign(new Error('no_api_key'), { status: 401 })
    }
    
    const uiLang = input.ui_lang || 'cs'
    const prompt = getPrompt(uiLang)

    // Initialize OpenAI client
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      organization: process.env.OPENAI_ORG_ID,
      project: process.env.OPENAI_PROJECT
    })

    // PAYLOAD SIZE MONITORING
    logPayloadSize('reactive_entry', input, input.symbol)

    // Build request
    const body: any = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: payloadStr }
      ],
      temperature: 0.1, // CRITICAL: Low temp for consistent decisions
      response_format: {
        type: 'json_object' // Force JSON response
      },
      max_completion_tokens: 4096
    }

    const config = loadConfig()
    const maxAttempts = 1 + config.openai_retry_count
    const timeout = config.openai_timeout_ms
    
    // Retry loop
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Create timeout controller
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeout)
        
        // Call OpenAI
        const resp = await client.chat.completions.create(body, { 
          signal: controller.signal as any 
        })
        clearTimeout(timeoutId)
        
        const text = resp?.choices?.[0]?.message?.content || ''
        
        if (!text || !String(text).trim()) {
          return { 
            ok: false, 
            code: 'empty_output', 
            latencyMs: Date.now() - t0, 
            data: null 
          }
        }
        
        // Parse JSON
        let parsed: any
        try { 
          parsed = JSON.parse(text) 
        } catch (e: any) {
          return { 
            ok: false, 
            code: 'invalid_json', 
            latencyMs: Date.now() - t0, 
            data: null,
            meta: { parse_error: String(e.message || e) }
          }
        }
        
        // Note prompt usage
        try {
          const { notePromptUsage } = require('../lib/dev_prompts')
          notePromptUsage('reactive_entry_assistant', 'sha256_placeholder')
        } catch {}
        
        return { 
          ok: true, 
          latencyMs: Date.now() - t0, 
          data: parsed as ReactiveEntryDecision,
          raw_request: body,
          raw_response: resp
        }
      } catch (err: any) {
        const code = err?.status === 401
          ? 'no_api_key'
          : (err?.name === 'AbortError' || String(err?.message || '').includes('abort')
            ? 'timeout'
            : (err?.response?.status ? 'http' : 'unknown'))
        
        if ((code === 'http' || code === 'timeout') && attempt < maxAttempts - 1) {
          const backoffMs = config.openai_retry_backoff_ms + Math.floor(Math.random() * config.openai_retry_backoff_ms)
          console.log('[REACTIVE_ENTRY_RETRY]', { attempt, backoffMs })
          await new Promise(resolve => setTimeout(resolve, backoffMs))
          continue
        }
        throw err
      }
    }

    return { ok: false, code: 'unknown', latencyMs: Date.now() - t0, data: null }
  } catch (e: any) {
    const code = e?.status === 401
      ? 'no_api_key'
      : (e?.name === 'AbortError'
        ? 'timeout'
        : (e?.response?.status ? 'http' : 'unknown'))
    
    console.error('[REACTIVE_ENTRY_ERR]', { 
      code, 
      message: e?.message, 
      status: e?.status 
    })
    
    return {
      ok: false,
      code,
      latencyMs: Date.now() - t0,
      data: null,
      meta: { message: e?.message || String(e) }
    }
  }
}

function getPrompt(uiLang: string = 'en'): string {
  const { resolveAssistantPrompt, notePromptUsage } = require('../lib/dev_prompts')
  const resolved = resolveAssistantPrompt(
    'reactive_entry_assistant', 
    'prompts/short/reactive_entry_assistant.md'
  )
  notePromptUsage('reactive_entry_assistant', resolved.sha256)
  const langLabel = uiLang === 'cs' ? 'Czech (cs-CZ)' : 'English (en-US)'
  return resolved.text.replace(/\{\{UI_LANG\}\}/g, langLabel)
}

