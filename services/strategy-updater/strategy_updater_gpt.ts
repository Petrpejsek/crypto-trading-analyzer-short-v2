import OpenAI from 'openai'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import fs from 'node:fs'
import path from 'node:path'
// Dynamic import for buildMarketRawSnapshot to avoid module resolution issues
import { request as undiciRequest } from 'undici'
import type { Kline } from '../../types/market_raw'
import cfg from '../../config/fetcher.json'

// Input type for strategy updater
export type StrategyUpdateInput = {
  symbol: string
  position: {
    side: 'LONG' | 'SHORT'
    size: number
    initialSize?: number
    sizeRemainingPct?: number
    entryPrice: number
    currentPrice: number
    unrealizedPnl: number
    unrealizedPnlPct?: number
  }
  currentSL: number | null
  // Single TP only (tp)
  currentTP: number | null | Array<{ tag: 'tp'; price: number; allocation_pct: number }>
  // Risk-aligned inputs
  current_plan?: {
    style: 'conservative' | 'aggressive'
    entry: number
    sl: number
    // Accept any tags from risk manager; Strategy Updater itself uses only 'tp'
    tp_levels: Array<{ tag: 'tp'|'tp1'|'tp2'|'tp3'; price: number; allocation_pct: number }>
    reasoning?: string
  }
  market_snapshot?: any
  posture?: 'OK' | 'CAUTION' | 'NO-TRADE'
  exchange_filters?: { maxSlippagePct: number; minNotional?: number }
  // Legacy raw marketData kept for compatibility
  marketData?: any
  lastDecision?: { newSL: number; tp_levels: TpLevel[] } | null
  // New: fills metadata for adaptive TP logic
  fills?: {
    tp_hits_count: number
    last_tp_hit_tag: 'tp' | null
    realized_pct_of_initial: number
  }
}

// Output type from OpenAI
export type TpLevel = { tag: 'tp'; price: number; allocation_pct: number }
export type StrategyUpdateResponse = {
  symbol: string
  newSL: number
  tp_levels: TpLevel[]
  reasoning: string
  confidence: number
  urgency: 'high' | 'medium' | 'low'
}

// JSON Schema for OpenAI response validation
const responseSchema = {
  type: 'object',
  properties: {
    symbol: { type: 'string' },
    newSL: { type: 'number' },
    tp_levels: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tag: { type: 'string', enum: ['tp'] },
          price: { type: 'number' },
          allocation_pct: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: ['tag', 'price', 'allocation_pct']
      }
    },
    reasoning: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    urgency: { type: 'string', enum: ['high', 'medium', 'low'] }
  },
  required: ['symbol', 'newSL', 'tp_levels', 'reasoning', 'confidence', 'urgency'],
  additionalProperties: false
} as const

const ajv = new Ajv({ strict: false })
addFormats(ajv)
const validateResponse = ajv.compile(responseSchema)

function readStrategyUpdaterPrompt(): { text: string; sha256: string } {
  const { resolveAssistantPrompt, notePromptUsage } = require('../lib/dev_prompts')
  const fallback = path.resolve('prompts/short/strategy_updater.md')
  const result = resolveAssistantPrompt('strategy_updater', fallback)
  notePromptUsage('strategy_updater', result.sha256)
  return result
}

function result(ok: boolean, code: string | undefined, latencyMs: number, data: StrategyUpdateResponse | null, meta?: any) {
  return { ok, code, latencyMs, data, meta }
}

export async function runStrategyUpdate(input: StrategyUpdateInput): Promise<{
  ok: boolean
  code?: string
  latencyMs: number
  data: StrategyUpdateResponse | null
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
      timeout: 600000  // 10 minut timeout pro GPT-5
    } as any)
    
    // Strategy Updater policy: POUZE gpt-4o (žádné fallbacky, žádné jiné modely)
    const requestedModel = String(process.env.STRATEGY_UPDATER_MODEL || 'gpt-4o').trim()
    if (!['gpt-4o'].includes(requestedModel)) {
      return result(false, 'invalid_model', Date.now() - t0, null, { model: requestedModel, allowed: ['gpt-4o'] })
    }
    const model = requestedModel
    // temperature intentionally omitted for gpt-5; default will be used by API
    // No timeout needed - let API handle its own timeouts

    console.info('[STRATEGY_UPDATE_PAYLOAD_BYTES]', JSON.stringify(input).length)
    console.info('[STRATEGY_UPDATE_SYMBOL]', input.symbol)
    console.info('[STRATEGY_UPDATE_POSITION]', {
      side: input.position.side,
      size: input.position.size,
      pnl: input.position.unrealizedPnl
    })
    
    // DEBUG: Log key data being sent to AI
    console.info('[STRATEGY_UPDATE_DEBUG_DATA]', {
      symbol: input.symbol,
      side: input.position.side,
      entryPrice: input.position.entryPrice,
      currentPrice: input.position.currentPrice,
      currentSL: input.currentSL,
      currentTP: input.currentTP,
      marketDataPrice: input.marketData?.price,
      marketSnapshotPrice: input.market_snapshot?.price
    })

    const schemaUpdater = {
      name: 'StrategyUpdate',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['symbol','newSL','tp_levels','reasoning','confidence','urgency'],
        properties: {
          symbol: { type: 'string' },
          newSL: { type: 'number' },
          tp_levels: {
            type: 'array', minItems: 1, maxItems: 1,
            items: {
              type: 'object', additionalProperties: false,
              required: ['tag','price','allocation_pct'],
              properties: {
                tag: { type: 'string', enum: ['tp'] },
                price: { type: 'number' },
                allocation_pct: { type: 'number', minimum: 0, maximum: 1 }
              }
            }
          },
          reasoning: { type: 'string', maxLength: 1200 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          urgency: { type: 'string', enum: ['low','medium','high'] }
        }
      }
    } as const

    const promptResult = readStrategyUpdaterPrompt()
    const body: any = {
      model,
      messages: [
        { role: 'system', content: promptResult.text },
        { role: 'user', content: JSON.stringify(input) }
      ],
      response_format: { type: 'json_schema', json_schema: schemaUpdater as any },
      max_completion_tokens: 8192
    }

    const resp = await client.chat.completions.create(body)
    const text = resp.choices?.[0]?.message?.content || ''

    if (!text || !String(text).trim()) {
      return result(false, 'empty_output', Date.now() - t0, null, {
        request_id: (resp as any)?.id ?? null
      })
    }

    let parsed: any
    try {
      parsed = JSON.parse(text)
    } catch (parseErr) {
      console.error('[STRATEGY_UPDATE_JSON_PARSE_ERR]', {
        symbol: input.symbol,
        response_length: text.length,
        response_start: text.slice(0, 200),
        error: (parseErr as any)?.message || parseErr
      })
      return result(false, 'invalid_json', Date.now() - t0, null, {
        request_id: (resp as any)?.id ?? null
      })
    }

    if (!validateResponse(parsed)) {
      console.error('[STRATEGY_UPDATE_SCHEMA_ERR]', {
        symbol: input.symbol,
        errors: validateResponse.errors,
        response: parsed
      })
      return result(false, 'schema_validation', Date.now() - t0, null, {
        request_id: (resp as any)?.id ?? null,
        schema_errors: validateResponse.errors
      })
    }

    // Validate business logic
    const response = parsed as StrategyUpdateResponse
    const { position } = input
    const currentPrice = position.currentPrice

    // Validate SL/TP direction logic + tp_levels integrity
    // Prompt allows immediate exit: for LONG, newSL may be set to markPrice (>= currentPrice)
    // Monotonicity and execution semantics are enforced later during order placement.
    // Therefore, we do not reject LONG newSL >= currentPrice here.

    // Validate tp_levels shape (exactly 1), tags, allocations for any side (LONG/SHORT)
    if (!Array.isArray(response.tp_levels) || response.tp_levels.length !== 1) {
      return result(false, 'invalid_tp_levels_count', Date.now() - t0, null, {
        reason: 'tp_levels must have exactly 1 item'
      })
    }
    const tagSet = new Set<string>()
    for (const lvl of response.tp_levels) {
      if (tagSet.has(lvl.tag)) {
        return result(false, 'duplicate_tp_tag', Date.now() - t0, null, { reason: `duplicate tag ${lvl.tag}` })
      }
      tagSet.add(lvl.tag)
        if (!(lvl && typeof lvl.price === 'number' && lvl.price > 0)) {
        return result(false, 'invalid_tp_price', Date.now() - t0, null, {
            reason: `TP ${lvl?.tag} price (${lvl?.price}) must be a positive number`
          })
        }
        if (!(typeof lvl.allocation_pct === 'number' && lvl.allocation_pct >= 0 && lvl.allocation_pct <= 1)) {
          return result(false, 'invalid_tp_alloc', Date.now() - t0, null, {
            reason: `TP ${lvl.tag} allocation_pct must be in [0,1]`
          })
        }
    }
    const sumAlloc = response.tp_levels.reduce((s, l) => s + (Number(l.allocation_pct) || 0), 0)
    if (Math.abs(sumAlloc - 1) > 0.01) {
      return result(false, 'invalid_tp_alloc_sum', Date.now() - t0, null, {
        reason: `Sum of allocation_pct must be 1.0 (+/- 0.01), got ${sumAlloc}`
      })
    }

    console.info('[STRATEGY_UPDATE_SUCCESS]', {
      symbol: input.symbol,
      confidence: response.confidence,
      urgency: response.urgency,
      newSL: response.newSL,
      tp_levels: response.tp_levels
    })

    return result(true, undefined, Date.now() - t0, response, {
      request_id: (resp as any)?.id ?? null,
      model,
      prompt_sha256: promptResult.sha256
    })

  } catch (error: any) {
    const code = error?.status === 401 ? 'no_api_key' :
                 error?.code === 'ECONNABORTED' || error?.message?.includes('timeout') ? 'timeout' :
                 error?.response?.status ? 'http' : 'unknown'

    console.error('[STRATEGY_UPDATE_ERROR]', {
      symbol: input.symbol,
      code,
      error: error?.message || error
    })

    return result(false, code, Date.now() - t0, null, {
      error: error?.message || 'unknown error',
      model: (process.env.STRATEGY_UPDATER_MODEL || 'gpt-4o')
    })
  }
}

// Fetch single-coin market data (same as entry strategy conservative)
export async function fetchMarketDataForSymbol(symbol: string): Promise<any> {
  try {
    // Normalize delivery/quarterly-like symbols (e.g., BTCUSDT_260327 -> BTCUSDT)
    const normalize = (sym: string): string => {
      try {
        const s = String(sym)
        const idx = s.indexOf('_')
        return idx > 0 ? s.slice(0, idx) : s
      } catch { return symbol }
    }
    const baseSymbol = normalize(symbol)

    // CRITICAL: Use FUTURES API for futures trading, NOT spot data!
    let snapshot: any = null
    try {
      // Get futures mark price directly from Binance Futures API
      const { getBinanceAPI } = await import('../../services/trading/binance_futures')
      const api = getBinanceAPI()
      const markPrice = await api.getMarkPrice(symbol) // Use exact symbol (e.g., BTCUSDT_260327)
      
      snapshot = {
        bySymbol: {
          [baseSymbol]: {
            symbol: baseSymbol,
            price: Number(markPrice), // FUTURES mark price from exact symbol
            priceChangePercent: 0,
            volume: 0
          }
        }
      }
      console.info('[SU_FUTURES_PRICE_USED]', { symbol, baseSymbol, markPrice })
    } catch (e) {
      console.warn('[SU_MARKET_DATA_FALLBACK]', { symbol, error: (e as any)?.message })
      // Fallback: create minimal snapshot for SU to work
      snapshot = {
        bySymbol: {
          [baseSymbol]: {
            symbol: baseSymbol,
            price: 0, // Will be updated from API
            priceChangePercent: 0,
            volume: 0
          }
        }
      }
    }

    // Resolve symbol: prefer direct BTC/ETH mapping, then bySymbol map, then universe
    let coinData: any = null
    try {
      if (baseSymbol === 'BTCUSDT' && (snapshot as any)?.btc) coinData = (snapshot as any).btc
      else if (baseSymbol === 'ETHUSDT' && (snapshot as any)?.eth) coinData = (snapshot as any).eth
    } catch {}
    if (!coinData) {
      try {
        const bySym = (snapshot as any)?.bySymbol || {}
        if (bySym && bySym[baseSymbol]) coinData = bySym[baseSymbol]
      } catch {}
    }
    if (!coinData) {
      try {
        const uni = Array.isArray((snapshot as any)?.universe) ? (snapshot as any).universe : []
        coinData = uni.find((c: any) => String(c?.symbol) === baseSymbol) || null
      } catch {}
    }

    if (!coinData) {
      console.error('[SU_MARKET_DATA_NOT_FOUND]', { symbol: baseSymbol })
      throw new Error(`symbol_not_found_in_snapshot:${baseSymbol}`)
    }

    // Enrich with M5 data (last 60 candles) and basic indicators
    try {
      const m5 = await fetchM5(baseSymbol, 60)
      if (Array.isArray(m5) && m5.length > 0) {
        const m5Close = m5.map(k => k.close)
        const ema20 = ema(m5Close, 20)
        const ema50 = ema(m5Close, 50)
        const rsi14 = rsi(m5Close, 14)
        const m5High = m5.map(k => k.high)
        const m5Low = m5.map(k => k.low)
        const atrAbs = atr(m5High, m5Low, m5Close, 14)
        const lastClose = m5Close[m5Close.length - 1]
        const atr_m5 = atrAbs != null && Number.isFinite(lastClose) ? atrAbs : null
        const atr_pct_m5 = atrAbs != null && Number.isFinite(lastClose) && lastClose > 0 ? (atrAbs / lastClose) * 100 : null
        ;(coinData as any).klines = (coinData as any).klines || {}
        ;(coinData as any).klines.M5 = m5
        ;(coinData as any).ema20_M5 = ema20
        ;(coinData as any).ema50_M5 = ema50
        ;(coinData as any).rsi_M5 = rsi14
        ;(coinData as any).atr_m5 = atr_m5
        ;(coinData as any).atr_pct_m5 = atr_pct_m5
      }
    } catch {}

    return coinData
  } catch (error) {
    console.error('[FETCH_MARKET_DATA_ERR]', {
      symbol,
      error: (error as any)?.message || error
    })
    throw error
  }
}

// --- Local helpers (M5 fetch + indicators) ---

async function fetchM5(symbol: string, limit: number): Promise<Kline[]> {
  const qs = new URLSearchParams({ symbol, interval: '5m', limit: String(limit) }).toString()
  const url = `https://fapi.binance.com/fapi/v1/klines?${qs}`
  const ac = new AbortController()
  const to = setTimeout(() => ac.abort(), (cfg as any)?.timeoutMs ?? 120000) // 2 minuty pro Binance klines fetch
  try {
    const res = await undiciRequest(url, { method: 'GET', signal: ac.signal })
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`HTTP ${res.statusCode} for ${url}`)
    }
    const text = await (res as any).body.text()
    const raw = JSON.parse(text)
    if (!Array.isArray(raw)) return []
    const toNum = (v: any): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
    const toIso = (n: number): string => new Date(n > 1e12 ? n : n * 1000).toISOString()
    return raw.map((k: any) => ({
      openTime: toIso(k[0]), open: toNum(k[1]), high: toNum(k[2]), low: toNum(k[3]), close: toNum(k[4]), volume: toNum(k[5]), closeTime: toIso(k[6])
    })).filter(k => Number.isFinite(k.open) && Number.isFinite(k.close))
  } finally {
    clearTimeout(to)
  }
}

async function fetchKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
  const qs = new URLSearchParams({ symbol, interval, limit: String(limit) }).toString()
  const url = `https://fapi.binance.com/fapi/v1/klines?${qs}`
  const ac = new AbortController()
  const to = setTimeout(() => ac.abort(), (cfg as any)?.timeoutMs ?? 120000)
  try {
    const res = await undiciRequest(url, { method: 'GET', signal: ac.signal })
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`HTTP ${res.statusCode} for ${url}`)
    }
    const text = await (res as any).body.text()
    const raw = JSON.parse(text)
    if (!Array.isArray(raw)) return []
    const toNum = (v: any): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
    const toIso = (n: number): string => new Date(n > 1e12 ? n : n * 1000).toISOString()
    return raw.map((k: any) => ({
      openTime: toIso(k[0]), open: toNum(k[1]), high: toNum(k[2]), low: toNum(k[3]), close: toNum(k[4]), volume: toNum(k[5]), closeTime: toIso(k[6])
    })).filter(k => Number.isFinite(k.open) && Number.isFinite(k.close))
  } finally {
    clearTimeout(to)
  }
}

import { ema, rsi, atr } from '../lib/indicators'
