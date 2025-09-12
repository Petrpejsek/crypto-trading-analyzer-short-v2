import OpenAI from 'openai'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { buildMarketRawSnapshot } from '../../server/fetcher/binance'
import { request as undiciRequest } from 'undici'
import cfg from '../../config/fetcher.json'
import type { Kline } from '../../types/market_raw'

// Input type for strategy updater
export type StrategyUpdateInput = {
  symbol: string
  position: {
    side: 'LONG' | 'SHORT'
    size: number
    entryPrice: number
    currentPrice: number
    unrealizedPnl: number
  }
  currentSL: number | null
  currentTP: number | null
  marketData: any // Fresh data from buildMarketRawSnapshot
}

// Output type from OpenAI
export type StrategyUpdateResponse = {
  symbol: string
  newSL: number
  newTP: number
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
    newTP: { type: 'number' },
    reasoning: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    urgency: { type: 'string', enum: ['high', 'medium', 'low'] }
  },
  required: ['symbol', 'newSL', 'newTP', 'reasoning', 'confidence', 'urgency'],
  additionalProperties: false
} as const

const ajv = new Ajv({ strict: false })
addFormats(ajv)
const validateResponse = ajv.compile(responseSchema)

const STRATEGY_UPDATE_PROMPT = `Jsi profesionální intradenní trader kryptoměn.  
Máš otevřenou LONG pozici a každých 5 minut musíš aktualizovat SL a TP tak, aby byl kapitál maximálně chráněn a zisk rychle zajištěn.

### Priority
1. Ochrana kapitálu je nadřazená profitu.  
2. Jakmile je pozice v menším zisku, okamžitě přesunout SL minimálně na break-even.  
3. Při růstu zamykat profit postupně posouváním SL výš.  
4. TP nastavuj blíže – tak, aby se zisk realizoval s vysokou pravděpodobností.  
5. Pokud se bias nebo momentum zhorší, okamžitě přitáhni SL těsně pod aktuální cenu.  
6. SL nikdy neposouvej do horší pozice.

### Vstupní data
- symbol  
- position {side:"LONG", size, entryPrice, currentPrice, unrealizedPnl}  
- currentSL, currentTP  
- marketData {RSI, EMA, VWAP, ATR, objem, bias, momentum}

### Výstupní formát
\`\`\`json
{
  "symbol": "BTCUSDT",
  "newSL": 27850,
  "newTP": 28100,
  "reasoning": "Pozice +1.4 % v zisku, momentum oslabuje. SL přesunut na break-even +0.2 % pro ochranu kapitálu. TP blízký 28100 na lokální rezistenci.",
  "confidence": 0.85,
  "urgency": "high"
}
\`\`\``

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
      project: (process as any)?.env?.OPENAI_PROJECT
    } as any)

    const model = 'gpt-4o'
    const temperature = 0.2
    const timeoutMs = 15000 // 15 seconds timeout

    console.info('[STRATEGY_UPDATE_PAYLOAD_BYTES]', JSON.stringify(input).length)
    console.info('[STRATEGY_UPDATE_SYMBOL]', input.symbol)
    console.info('[STRATEGY_UPDATE_POSITION]', {
      side: input.position.side,
      size: input.position.size,
      pnl: input.position.unrealizedPnl
    })

    const body: any = {
      model,
      temperature,
      messages: [
        { role: 'system', content: STRATEGY_UPDATE_PROMPT },
        { role: 'user', content: JSON.stringify(input) }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'strategy_update_response',
          schema: responseSchema as any,
          strict: true
        }
      }
      // No token limit as requested
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

    // Validate SL/TP direction logic
    if (position.side === 'LONG') {
      if (response.newSL >= currentPrice) {
        return result(false, 'invalid_sl_long', Date.now() - t0, null, {
          reason: `LONG position SL (${response.newSL}) must be below current price (${currentPrice})`
        })
      }
      if (response.newTP <= currentPrice) {
        return result(false, 'invalid_tp_long', Date.now() - t0, null, {
          reason: `LONG position TP (${response.newTP}) must be above current price (${currentPrice})`
        })
      }
    } else if (position.side === 'SHORT') {
      if (response.newSL <= currentPrice) {
        return result(false, 'invalid_sl_short', Date.now() - t0, null, {
          reason: `SHORT position SL (${response.newSL}) must be above current price (${currentPrice})`
        })
      }
      if (response.newTP >= currentPrice) {
        return result(false, 'invalid_tp_short', Date.now() - t0, null, {
          reason: `SHORT position TP (${response.newTP}) must be below current price (${currentPrice})`
        })
      }
    }

    console.info('[STRATEGY_UPDATE_SUCCESS]', {
      symbol: input.symbol,
      confidence: response.confidence,
      urgency: response.urgency,
      newSL: response.newSL,
      newTP: response.newTP
    })

    return result(true, undefined, Date.now() - t0, response, {
      request_id: (resp as any)?.id ?? null
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
      error: error?.message || 'unknown error'
    })
  }
}

// Fetch fresh market data for a specific symbol (NO CACHE)
export async function fetchMarketDataForSymbol(symbol: string): Promise<any> {
  try {
    // Use buildMarketRawSnapshot for a narrow universe (desiredTopN=1) and include the symbol.
    const snapshot = await buildMarketRawSnapshot({ 
      universeStrategy: 'volume', 
      desiredTopN: 1,
      includeSymbols: [symbol], 
      fresh: true, 
      allowPartial: true 
    })

    // Find the symbol data in BTC/ETH (always available) or universe
    let coinData = null
    
    // Check if it's BTC or ETH
    if (symbol === 'BTCUSDT') {
      coinData = snapshot.btc
    } else if (symbol === 'ETHUSDT') {
      coinData = snapshot.eth
    } else {
      // Look in universe
      coinData = snapshot.universe.find((coin: any) => coin.symbol === symbol)
    }
    
    if (!coinData) {
      throw new Error(`Symbol ${symbol} not found in market data`)
    }

    // Enrich with M5 data (last 20 candles) and basic M5 indicators (RSI14, EMA10, EMA20)
    const m5 = await fetchM5(symbol, 20)
    if (!Array.isArray(m5) || m5.length === 0) throw new Error('M5_EMPTY')
    const m5Close = m5.map(k => k.close)
    const ema10 = ema(m5Close, 10)
    const ema20 = ema(m5Close, 20)
    const rsi14 = rsi(m5Close, 14)
    ;(coinData as any).klines = (coinData as any).klines || {}
    ;(coinData as any).klines.M5 = m5
    ;(coinData as any).ema10_M5 = ema10
    ;(coinData as any).ema20_M5 = ema20
    ;(coinData as any).rsi_M5 = rsi14

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
  const to = setTimeout(() => ac.abort(), (cfg as any)?.timeoutMs ?? 12000)
  try {
    const res = await undiciRequest(url, { method: 'GET', signal: ac.signal })
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`HTTP ${res.statusCode} for ${url}`)
    }
    const text = await res.body.text()
    const raw = JSON.parse(text)
    if (!Array.isArray(raw)) return []
    const toNum = (v: any): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
    const toIso = (n: number): string => new Date(n > 1e12 ? n : n * 1000).toISOString()
    return raw.map((k: any) => ({
      openTime: toIso(k[0]),
      open: toNum(k[1]),
      high: toNum(k[2]),
      low: toNum(k[3]),
      close: toNum(k[4]),
      volume: toNum(k[5]),
      closeTime: toIso(k[6])
    })).filter(k => Number.isFinite(k.open) && Number.isFinite(k.close))
  } finally {
    clearTimeout(to)
  }
}

function ema(values: number[], period: number): number | null {
  if (!Array.isArray(values) || values.length === 0) return null
  const k = 2 / (period + 1)
  let e = values[0]
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k)
  return Number.isFinite(e) ? e : null
}

function rsi(values: number[], period = 14): number | null {
  if (!Array.isArray(values) || values.length <= period) return null
  let gains = 0
  let losses = 0
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1]
    if (diff >= 0) gains += diff; else losses -= diff
  }
  let avgGain = gains / period
  let avgLoss = losses / period
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1]
    const gain = diff > 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
  }
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}
