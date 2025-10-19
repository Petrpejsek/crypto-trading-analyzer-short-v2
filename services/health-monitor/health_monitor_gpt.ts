// Health Monitor - GPT Provider
// Uses GPT-4o or gpt-4o-mini for sophisticated health analysis

import path from 'node:path'
import type { MarketPayload, HealthOutput } from './types'
import { validateAndSanitize } from './validator'

/**
 * Load GPT system prompt (DEV: overlay, PROD: registry, NO FALLBACKS)
 */
function loadSystemPrompt(): { text: string; sha256: string } {
  const { resolveAssistantPrompt, notePromptUsage } = require('../lib/dev_prompts')
  const result = resolveAssistantPrompt(
    'health_monitor',
    path.resolve('prompts/short/health_monitor.md')
  )
  notePromptUsage('health_monitor', result.sha256)
  return result
}

/**
 * Build user prompt with market data
 */
function buildUserPrompt(payload: MarketPayload, position?: { entry?: number; sl?: number; tp?: number }): string {
  const lines: string[] = []
  
  lines.push(`# Market Analysis Request`)
  lines.push(``)
  lines.push(`**Symbol:** ${payload.symbol}`)
  lines.push(`**Current Price:** $${payload.price.toFixed(2)}`)
  lines.push(`**Timestamp:** ${payload.price_ts_utc}`)
  lines.push(``)
  
  if (position) {
    lines.push(`**SHORT Position:**`)
    if (position.entry) lines.push(`- Entry: $${position.entry.toFixed(2)}`)
    if (position.sl) lines.push(`- Stop Loss: $${position.sl.toFixed(2)}`)
    if (position.tp) lines.push(`- Take Profit: $${position.tp.toFixed(2)}`)
    lines.push(``)
  }
  
  lines.push(`**Market Indicators:**`)
  lines.push(`- VWAP Today: $${payload.vwap_today.toFixed(2)}`)
  lines.push(`- EMA M15: 20=${payload.ema.m15[20].toFixed(2)}, 50=${payload.ema.m15[50].toFixed(2)}`)
  lines.push(`- EMA H1: 20=${payload.ema.h1[20].toFixed(2)}, 50=${payload.ema.h1[50].toFixed(2)}`)
  lines.push(`- ATR M15: ${payload.atr.m15.toFixed(2)}`)
  lines.push(`- Spread: ${payload.spread_bps.toFixed(1)} bps`)
  lines.push(`- Liquidity: $${(payload.liquidity_usd / 1000).toFixed(0)}k`)
  
  if (payload.rsi) {
    lines.push(`- RSI M15: ${payload.rsi.m15.toFixed(1)}`)
  }
  
  if (payload.support && payload.support.length > 0) {
    lines.push(`- Support: ${payload.support.map(s => `$${s.toFixed(2)}`).join(', ')}`)
  }
  
  if (payload.resistance && payload.resistance.length > 0) {
    lines.push(`- Resistance: ${payload.resistance.map(r => `$${r.toFixed(2)}`).join(', ')}`)
  }
  
  if (payload.funding_8h_pct !== undefined) {
    lines.push(`- Funding 8h: ${(payload.funding_8h_pct * 100).toFixed(4)}%`)
  }
  
  if (payload.oi_change_1h_pct !== undefined) {
    lines.push(`- OI Change 1h: ${payload.oi_change_1h_pct.toFixed(2)}%`)
  }
  
  lines.push(``)
  lines.push(`Analyze this SHORT position health and return semafor.v2 JSON.`)
  
  return lines.join('\n')
}

/**
 * Call GPT-4o API for health analysis
 */
export async function runHealthMonitorGPT(
  payload: MarketPayload,
  position?: { entry?: number; sl?: number; tp?: number }
): Promise<HealthOutput> {
  const t0 = performance.now()
  
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey || apiKey.includes('mock')) {
    throw new Error('OPENAI_API_KEY not configured or is mock')
  }
  
  const model = process.env.HEALTH_MONITOR_MODEL || 'gpt-4o-mini'
  const promptResult = loadSystemPrompt()
  const systemPrompt = promptResult.text
  const userPrompt = buildUserPrompt(payload, position)
  
  const requestBody = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' },
    max_tokens: 1500
  }
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  }
  
  if (process.env.OPENAI_ORG_ID) {
    headers['OpenAI-Organization'] = process.env.OPENAI_ORG_ID
  }
  
  if (process.env.OPENAI_PROJECT) {
    headers['OpenAI-Project'] = process.env.OPENAI_PROJECT
  }
  
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`GPT API error ${response.status}: ${errorText}`)
    }
    
    const data = await response.json()
    const content = data?.choices?.[0]?.message?.content
    
    if (!content) {
      throw new Error('No content in GPT response')
    }
    
    let parsed: any
    try {
      parsed = JSON.parse(content)
    } catch (e) {
      throw new Error(`Failed to parse GPT JSON: ${(e as any)?.message}`)
    }
    
    // Add provider debug info
    if (!parsed._debug) parsed._debug = {}
    parsed._debug.provider = 'gpt'
    parsed._debug.model = model
    parsed._debug.current_price = payload.price
    
    // Validate and sanitize
    const validated = validateAndSanitize(parsed as HealthOutput)
    
    const latency = Math.round(performance.now() - t0)
    console.info('[HEALTH_GPT_SUCCESS]', {
      symbol: payload.symbol,
      health: validated.health_pct,
      success: validated.success_prob_pct,
      model,
      latency_ms: latency
    })
    
    return validated
    
  } catch (e) {
    const latency = Math.round(performance.now() - t0)
    console.error('[HEALTH_GPT_ERR]', {
      symbol: payload.symbol,
      error: (e as any)?.message || e,
      latency_ms: latency
    })
    throw e
  }
}

