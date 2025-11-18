/**
 * AI Profit Taker - Decision Logic
 * 
 * OpenAI GPT-4o integration pro inteligentní úpravu SL/TP orderů
 * - Runtime-editable prompts (overlay system)
 * - Strict JSON schema validation (Ajv)
 * - Retry logic pro network errors
 * - aiTap broadcasting pro monitoring
 */

import OpenAI from 'openai'
import fs from 'node:fs'
import path from 'node:path'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { getBinanceAPI } from '../trading/binance_futures'
import { fetchMarketDataForSymbol } from '../strategy-updater/strategy_updater_gpt'
import { resolvePromptPathShort } from '../prompts/guard'
import { executeAIProfitTaker } from './executor'
import type { AIProfitTakerInput, AIProfitTakerDecision, AIProfitTakerResult } from './types'

// Ajv validator setup
const ajv = new Ajv({ allErrors: true, removeAdditional: true, strict: false })
addFormats(ajv)

const schema = JSON.parse(
  fs.readFileSync(path.resolve('schemas/ai_profit_taker.schema.json'), 'utf8')
)
const validate = ajv.compile(schema as any)

/**
 * Load system prompt (DEV: overlay, PROD: registry, NO FALLBACKS)
 */
function loadPrompt(): { text: string; sha256: string } {
  const { resolveAssistantPrompt, notePromptUsage } = require('../lib/dev_prompts')
  const result = resolveAssistantPrompt(
    'ai_profit_taker',
    path.resolve('prompts/short/ai_profit_taker.md')
  )
  notePromptUsage('ai_profit_taker', result.sha256)
  return result
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Build AI input payload from position data
 */
async function buildAIInput(symbol: string): Promise<AIProfitTakerInput | null> {
  const api = getBinanceAPI()
  
  try {
    // 1. Get position - ALWAYS use REST API (no WebSocket dependency)
    console.log('[AI_PT_FETCH_POSITION]', { symbol })
    
    // Clear cache AND request coalescer to ensure fresh data
    const { binanceCache } = await import('../../server/lib/apiCache')
    const { requestCoalescer } = await import('../../server/lib/requestCoalescer')
    
    // 1. Clear pending requests (critical - otherwise we get stale in-flight data)
    requestCoalescer.clear()
    
    // 2. Clear cache entries
    binanceCache.invalidatePattern('/fapi/v2/positionRisk')
    
    console.log('[AI_PT_CACHE_CLEARED]', { 
      endpoint: '/fapi/v2/positionRisk',
      coalescer_cleared: true
    })
    
    // Direct REST API call
    const positions = await api.getPositions()
    console.log('[AI_PT_REST_API_RESPONSE]', { 
      total: Array.isArray(positions) ? positions.length : 0,
      is_array: Array.isArray(positions)
    })
    
    // 🔥 CRITICAL DEBUG: Log ALL BLESSUSDT entries
    const allBless = (Array.isArray(positions) ? positions : []).filter((p: any) => p?.symbol === 'BLESSUSDT')
    console.log('[AI_PT_ALL_BLESSUSDT_ENTRIES]', {
      count: allBless.length,
      entries: allBless.map((p: any, idx: number) => ({
        index: idx,
        symbol: p?.symbol,
        positionAmt: p?.positionAmt,
        positionAmt_type: typeof p?.positionAmt,
        positionAmt_as_number: Number(p?.positionAmt),
        entryPrice: p?.entryPrice,
        markPrice: p?.markPrice,
        unrealizedProfit: p?.unrealizedProfit,
        positionSide: p?.positionSide,
        leverage: p?.leverage,
        updateTime: p?.updateTime
      }))
    })
    
    console.log('[AI_PT_POSITIONS_RAW]', { 
      symbol, 
      total_positions: Array.isArray(positions) ? positions.length : 0,
      is_array: Array.isArray(positions),
      first_3: (Array.isArray(positions) ? positions : []).slice(0, 3).map((p: any) => ({
        symbol: p?.symbol,
        positionAmt: p?.positionAmt,
        entryPrice: p?.entryPrice
      })),
      bless_raw: (Array.isArray(positions) ? positions : []).find((p: any) => p?.symbol === 'BLESSUSDT')
    })
    
    // Find ACTIVE SHORT position (Binance returns both LONG+SHORT entries, we need SHORT with positionAmt != 0)
    const position = (Array.isArray(positions) ? positions : []).find(
      (p: any) => {
        const isSymbol = String(p?.symbol) === symbol
        const isShort = String(p?.positionSide).toUpperCase() === 'SHORT'
        const hasPosition = Math.abs(Number(p?.positionAmt || 0)) > 0
        const match = isSymbol && isShort && hasPosition
        
        if (isSymbol) {
          console.log('[AI_PT_POSITION_CHECK]', { 
            symbol, 
            positionSide: p?.positionSide,
            positionAmt: p?.positionAmt,
            isShort,
            hasPosition,
            match
          })
        }
        
        if (match) {
          console.log('[AI_PT_POSITION_FOUND]', { symbol, position: p })
        }
        return match
      }
    )
    
    if (!position) {
      // Log all available symbols to help debugging
      const availableSymbols = (Array.isArray(positions) ? positions : [])
        .filter((p: any) => {
          const amt = Number(p?.positionAmt || 0)
          return Math.abs(amt) > 0
        })
        .map((p: any) => p?.symbol)
      
      console.warn('[AI_PT_NO_POSITION]', { 
        symbol, 
        available_positions: availableSymbols,
        total_fetched: Array.isArray(positions) ? positions.length : 0
      })
      return null
    }
    
    // CRITICAL: WebSocket uses different format than REST API
    // WebSocket: { positionAmt: -1290 } (negative for SHORT)
    // Need to handle both formats
    const positionAmt = Number(position?.positionAmt || 0)
    const size = Math.abs(positionAmt)
    
    console.log('[AI_PT_POSITION_DATA]', {
      symbol,
      positionAmt,
      size,
      entryPrice: position?.entryPrice,
      positionSide: position?.positionSide,
      raw_keys: Object.keys(position || {})
    })
    
    // Verify SHORT position
    if (!(positionAmt < 0)) {
      console.warn('[AI_PT_NOT_SHORT]', { 
        symbol, 
        positionAmt,
        size,
        positionSide: position?.positionSide,
        hint: 'positionAmt must be negative for SHORT positions'
      })
      return null
    }
    
    const entryPrice = Number(position?.entryPrice || position?.averagePrice || 0)
    const markPrice = Number(position?.markPrice || 0)
    const unrealizedPnl = Number(position?.unrealizedPnl || position?.unRealizedProfit || 0)
    
    if (size <= 0 || entryPrice <= 0) {
      console.warn('[AI_PT_INVALID_POSITION]', { symbol, size, entryPrice })
      return null
    }
    
    // 2. Get current SL/TP from open orders
    const openOrders = await api.getOpenOrders(symbol)
    
    let currentSL: number | null = null
    let currentTP: number | null = null
    
    // Find SL orders (STOP_MARKET, BUY side)
    const slCandidates = (Array.isArray(openOrders) ? openOrders : [])
      .filter((o: any) => {
        const type = String(o?.type || '').toUpperCase()
        const side = String(o?.side || '').toUpperCase()
        return (
          (type === 'STOP_MARKET' || type === 'STOP') &&
          side === 'BUY'
        )
      })
      .map((o: any) => Number(o?.stopPrice || 0))
      .filter((p: number) => p > 0)
    
    if (slCandidates.length > 0) {
      // For SHORT: SL is above entry, pick closest above current price
      currentSL = markPrice > 0
        ? (slCandidates.filter(p => p >= markPrice).sort((a, b) => a - b)[0] ?? slCandidates.sort((a, b) => a - b)[0] ?? null)
        : (slCandidates.sort((a, b) => a - b)[0] ?? null)
    }
    
    // Find TP orders (TAKE_PROFIT_MARKET, BUY side)
    const tpCandidates = (Array.isArray(openOrders) ? openOrders : [])
      .filter((o: any) => {
        const type = String(o?.type || '').toUpperCase()
        const side = String(o?.side || '').toUpperCase()
        return (
          (type === 'TAKE_PROFIT_MARKET' || type === 'TAKE_PROFIT') &&
          side === 'BUY'
        )
      })
      .map((o: any) => {
        const type = String(o?.type || '').toUpperCase()
        if (type === 'TAKE_PROFIT') {
          return Number(o?.price || o?.stopPrice || 0)
        }
        return Number(o?.stopPrice || 0)
      })
      .filter((p: number) => p > 0)
    
    if (tpCandidates.length > 0) {
      // For SHORT: TP is below entry, pick closest below current price
      currentTP = markPrice > 0
        ? (tpCandidates.filter(p => p <= markPrice).sort((a, b) => b - a)[0] ?? tpCandidates.sort((a, b) => b - a)[0] ?? null)
        : (tpCandidates.sort((a, b) => b - a)[0] ?? null)
    }
    
    // 3. Get market data
    const marketData = await fetchMarketDataForSymbol(symbol)
    
    // 4. Build obstacles array for better TP/SL placement
    const obstacles: Array<{ type: 'ema' | 'vwap' | 'level' | 'round'; price: number; strength: 'low' | 'mid' | 'high'; timeframe?: string }> = []
    
    // Add EMA obstacles (M5 for short-term, M15 for medium-term)
    if (marketData.ema20_M5 && Number.isFinite(marketData.ema20_M5)) {
      obstacles.push({
        type: 'ema',
        price: marketData.ema20_M5,
        strength: 'mid',
        timeframe: 'M5'
      })
    }
    
    if (marketData.ema50_M5 && Number.isFinite(marketData.ema50_M5)) {
      obstacles.push({
        type: 'ema',
        price: marketData.ema50_M5,
        strength: 'mid',
        timeframe: 'M5'
      })
    }
    
    if (marketData.ema20_M15 && Number.isFinite(marketData.ema20_M15)) {
      obstacles.push({
        type: 'ema',
        price: marketData.ema20_M15,
        strength: 'high',
        timeframe: 'M15'
      })
    }
    
    if (marketData.ema50_M15 && Number.isFinite(marketData.ema50_M15)) {
      obstacles.push({
        type: 'ema',
        price: marketData.ema50_M15,
        strength: 'high',
        timeframe: 'M15'
      })
    }
    
    // Add VWAP obstacle (high importance for intraday trading)
    if (marketData.vwap_today && Number.isFinite(marketData.vwap_today)) {
      obstacles.push({
        type: 'vwap',
        price: marketData.vwap_today,
        strength: 'high'
      })
    }
    
    // Add Support levels (for SHORT, these are potential TP targets)
    if (Array.isArray(marketData.support)) {
      marketData.support.slice(0, 3).forEach((supportPrice: number) => {
        if (Number.isFinite(supportPrice) && supportPrice > 0) {
          obstacles.push({
            type: 'level',
            price: supportPrice,
            strength: 'high'
          })
        }
      })
    }
    
    // Add Resistance levels (for SHORT, these are potential SL levels)
    if (Array.isArray(marketData.resistance)) {
      marketData.resistance.slice(0, 3).forEach((resistancePrice: number) => {
        if (Number.isFinite(resistancePrice) && resistancePrice > 0) {
          obstacles.push({
            type: 'level',
            price: resistancePrice,
            strength: 'high'
          })
        }
      })
    }
    
    // Add round number obstacles (psychological levels)
    const addRoundNumbers = (currentPrice: number, count: number = 3) => {
      // Find nearest round numbers (multiples of 100, 500, 1000 depending on price scale)
      const scale = currentPrice < 100 ? 10 : currentPrice < 1000 ? 100 : currentPrice < 10000 ? 500 : 1000
      const baseRound = Math.floor(currentPrice / scale) * scale
      
      // Add round numbers above and below current price
      for (let i = -count; i <= count; i++) {
        if (i === 0) continue
        const roundPrice = baseRound + (i * scale)
        if (roundPrice > 0) {
          obstacles.push({
            type: 'round',
            price: roundPrice,
            strength: 'low'
          })
        }
      }
    }
    
    addRoundNumbers(markPrice, 2)
    
    // Sort obstacles by distance from current price (closest first)
    obstacles.sort((a, b) => Math.abs(a.price - markPrice) - Math.abs(b.price - markPrice))
    
    // Keep only top 15 closest obstacles (to avoid payload bloat)
    const topObstacles = obstacles.slice(0, 15)
    
    console.info('[AI_PT_OBSTACLES_BUILT]', {
      symbol,
      total_obstacles: obstacles.length,
      kept_obstacles: topObstacles.length,
      closest_obstacle: topObstacles[0] ? {
        type: topObstacles[0].type,
        price: topObstacles[0].price,
        distance_bps: Math.abs((topObstacles[0].price - markPrice) / markPrice * 10000).toFixed(1)
      } : null
    })
    
    // 🎯 TREND DATA MVP - robustní flagy pro profit taker
    const price = markPrice
    const ema20_M5 = marketData?.ema20_M5
    const ema50_M5 = marketData?.ema50_M5
    const ema20_M15 = marketData?.ema20_M15
    const ema50_M15 = marketData?.ema50_M15
    const vwap_today = marketData?.vwap_today
    
    // Bezpečnostní kontrola: pokud chybí jakákoliv klíčová hodnota → konzervativní fallback
    const hasAllData = (
      Number.isFinite(price) && price > 0 &&
      Number.isFinite(ema20_M5) && Number.isFinite(ema50_M5) &&
      Number.isFinite(ema20_M15) && Number.isFinite(ema50_M15) &&
      Number.isFinite(vwap_today)
    )
    
    let trendData: {
      bearish_m5: boolean
      bearish_m15: boolean
      bearish_score: number
      chop_flag: boolean
    }
    
    if (!hasAllData) {
      // FALLBACK: chybí data → konzervativní hodnoty
      trendData = {
        bearish_m5: false,
        bearish_m15: false,
        bearish_score: 0,
        chop_flag: false
      }
      console.info('[AI_PT_TREND_DATA_FALLBACK]', { 
        symbol, 
        reason: 'missing_data',
        has_price: Number.isFinite(price) && price > 0,
        has_ema20_M5: Number.isFinite(ema20_M5),
        has_ema50_M5: Number.isFinite(ema50_M5),
        has_ema20_M15: Number.isFinite(ema20_M15),
        has_ema50_M15: Number.isFinite(ema50_M15),
        has_vwap_today: Number.isFinite(vwap_today)
      })
    } else {
      // Vypočítáme flagy podle MVP pravidel
      
      // bearish_m5: EMA20 < EMA50 na M5 A price <= VWAP
      const bearish_m5 = (ema20_M5 < ema50_M5) && (price <= vwap_today)
      
      // bearish_m15: EMA20 < EMA50 na M15 A price <= VWAP
      const bearish_m15 = (ema20_M15 < ema50_M15) && (price <= vwap_today)
      
      // bearish_score: sčítáme body (0-3)
      let bearish_score = 0
      if (bearish_m5) bearish_score += 1
      if (bearish_m15) bearish_score += 1
      // +1 pokud price < vwap A ema20_M5 < ema20_M15 (krátkodobé momentum slabší)
      if (price < vwap_today && ema20_M5 < ema20_M15) bearish_score += 1
      
      // chop_flag: detekce placky (EMAs velmi blízko + cena u VWAP)
      const dist_m5 = Math.abs(ema20_M5 - ema50_M5) / price
      const price_vwap_dist = Math.abs(price - vwap_today) / price
      const chop_flag = (dist_m5 < 0.002) && (price_vwap_dist < 0.0025)
      
      trendData = {
        bearish_m5,
        bearish_m15,
        bearish_score,
        chop_flag
      }
      
      console.info('[AI_PT_TREND_DATA_COMPUTED]', {
        symbol,
        price,
        ema20_M5,
        ema50_M5,
        ema20_M15,
        ema50_M15,
        vwap_today,
        dist_m5_pct: (dist_m5 * 100).toFixed(4),
        price_vwap_dist_pct: (price_vwap_dist * 100).toFixed(4),
        trendData
      })
    }
    
    // 5. Build input
    const input: AIProfitTakerInput = {
      symbol,
      position: {
        side: 'SHORT',
        size,
        entryPrice,
        currentPrice: markPrice,
        unrealizedPnl
      },
      currentOrders: {
        sl: currentSL,
        tp: currentTP
      },
      marketData,
      obstacles: topObstacles,
      trendData
    }
    
    console.info('[AI_PT_INPUT_BUILT]', {
      symbol,
      size,
      entryPrice,
      currentPrice: markPrice,
      unrealizedPnl,
      currentSL,
      currentTP,
      trendData
    })
    
    return input
    
  } catch (err: any) {
    console.error('[AI_PT_BUILD_INPUT_ERR]', {
      symbol,
      error: err?.message || String(err)
    })
    return null
  }
}

/**
 * Call OpenAI API with AI Profit Taker prompt
 */
async function callOpenAI(input: AIProfitTakerInput): Promise<{
  ok: boolean
  code?: 'no_api_key' | 'invalid_json' | 'schema' | 'empty_output' | 'timeout' | 'http' | 'unknown'
  data?: AIProfitTakerDecision | null
  meta?: any
}> {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return { ok: false, code: 'no_api_key', data: null }
    }
    
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      organization: (process as any)?.env?.OPENAI_ORG_ID,
      project: (process as any)?.env?.OPENAI_PROJECT
    } as any)
    
    const promptResult = loadPrompt()
    const systemPrompt = promptResult.text
    const payloadStr = JSON.stringify(input)
    
    console.info('[AI_PT_GPT_PAYLOAD_SIZE]', payloadStr.length)
    
    const body: any = {
      model: 'gpt-4o',
      temperature: 0.1,  // Low temperature = consistent decisions
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: payloadStr }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'ai_profit_taker_decision',
          schema: schema as any,
          strict: true
        }
      },
      max_completion_tokens: 4096
    }
    
    // Retry logic (1 attempt)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await client.chat.completions.create(body)
        const text = resp?.choices?.[0]?.message?.content || ''
        
        console.info('[AI_PT_GPT_RESPONSE_LEN]', text ? text.length : 0)
        
        if (!text || !String(text).trim()) {
          return {
            ok: false,
            code: 'empty_output',
            data: null,
            meta: { request_id: (resp as any)?.id ?? null }
          }
        }
        
        // Parse JSON
        let parsed: any
        try {
          parsed = JSON.parse(text)
        } catch (e: any) {
          console.error('[AI_PT_JSON_PARSE_ERR]', {
            len: text.length,
            start: text.slice(0, 200)
          })
          return {
            ok: false,
            code: 'invalid_json',
            data: null,
            meta: {
              request_id: (resp as any)?.id ?? null,
              parse_error: String((e && e.message) || e)
            }
          }
        }
        
        // Validate schema
        if (!validate(parsed)) {
          console.error('[AI_PT_SCHEMA_ERR]', {
            keys: Object.keys(parsed || {}),
            errors: validate.errors?.slice(0, 3)
          })
          return {
            ok: false,
            code: 'schema',
            data: null,
            meta: { errors: validate.errors }
          }
        }
        
        return { ok: true, data: parsed as AIProfitTakerDecision }
        
      } catch (e: any) {
        const code = e?.status === 401
          ? 'no_api_key'
          : (e?.name === 'AbortError' ? 'timeout' : (e?.response?.status ? 'http' : 'unknown'))
        
        console.error('[AI_PT_GPT_ERR]', {
          code,
          attempt,
          name: e?.name,
          message: e?.message,
          status: e?.status,
          http_status: e?.response?.status
        })
        
        // Retry on HTTP/timeout errors
        if ((code === 'http' || code === 'timeout') && attempt === 0) {
          await sleep(200 + Math.floor(Math.random() * 400))
          continue
        }
        
        throw e
      }
    }
    
    // Exhausted attempts
    return {
      ok: false,
      code: 'unknown',
      data: null,
      meta: { reason: 'no_decision_generated' }
    }
    
  } catch (e: any) {
    const code = e?.status === 401
      ? 'no_api_key'
      : (e?.name === 'AbortError' ? 'timeout' : (e?.response?.status ? 'http' : 'unknown'))
    
    console.error('[AI_PT_GPT_CATCH_ERR]', {
      code,
      name: e?.name,
      message: e?.message,
      status: e?.status,
      http_status: e?.response?.status
    })
    
    return {
      ok: false,
      code,
      data: null,
      meta: {
        message: e?.message || String(e),
        status: e?.status ?? null,
        http_status: e?.response?.status ?? null
      }
    }
  }
}

/**
 * Main entry point - Run AI Profit Taker for a symbol
 * 
 * @param symbol - Trading symbol (e.g., BTCUSDT)
 * @returns Result with decision and execution details
 */
export async function runAIProfitTaker(symbol: string): Promise<AIProfitTakerResult> {
  const t0 = Date.now()
  
  try {
    console.info('[AI_PT_START]', { symbol })
    
    // 1. Build input payload
    const input = await buildAIInput(symbol)
    
    if (!input) {
      return {
        ok: false,
        code: 'no_position',
        latencyMs: Date.now() - t0,
        data: null,
        meta: { reason: 'No SHORT position found or invalid position data' }
      }
    }
    
    // 2. Call OpenAI
    const aiResult = await callOpenAI(input)
    
    if (!aiResult.ok || !aiResult.data) {
      return {
        ok: false,
        code: aiResult.code || 'unknown',
        latencyMs: Date.now() - t0,
        data: null,
        meta: aiResult.meta
      }
    }
    
    const decision = aiResult.data
    
    console.info('[AI_PT_DECISION]', {
      symbol,
      action: decision.action,
      new_sl: decision.new_sl,
      new_tp: decision.new_tp,
      confidence: decision.confidence,
      rationale: decision.rationale
    })
    
    // 3. Execute orders (if action = adjust_exits)
    let execution = undefined
    
    if (decision.action === 'adjust_exits') {
      try {
        execution = await executeAIProfitTaker(symbol, input.position, decision)
        console.info('[AI_PT_EXECUTION_OK]', { symbol, execution })
      } catch (err: any) {
        console.error('[AI_PT_EXECUTION_ERR]', {
          symbol,
          error: err?.message || String(err)
        })
        return {
          ok: false,
          code: 'execution_error',
          latencyMs: Date.now() - t0,
          data: null,
          meta: { execution_error: err?.message || String(err) }
        }
      }
    }
    
    // 4. Success
    return {
      ok: true,
      latencyMs: Date.now() - t0,
      data: {
        input,
        decision,
        execution
      }
    }
    
  } catch (err: any) {
    console.error('[AI_PT_ERROR]', {
      symbol,
      error: err?.message || String(err),
      stack: err?.stack
    })
    
    return {
      ok: false,
      code: 'unknown',
      latencyMs: Date.now() - t0,
      data: null,
      meta: {
        error: err?.message || String(err)
      }
    }
  }
}

