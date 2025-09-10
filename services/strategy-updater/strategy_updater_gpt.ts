import OpenAI from 'openai'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { buildMarketRawSnapshot } from '../../server/fetcher/binance'

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
Máš otevřenou LONG pozici a každých 5 minut musíš aktualizovat SL a TP tak, aby byl zajištěn profit i ochrana kapitálu.  
Styl se automaticky přizpůsobuje síle trendu a volatilitě.

### Priority
1. **Ochrana kapitálu** – nikdy neposouvej SL do horší pozice.  
2. **Dynamická strategie**:
   - Pokud je bias a momentum silné → použij agresivní přístup (volnější SL, vzdálenější TP).  
   - Pokud bias slábne nebo hrozí obrat → použij konzervativní přístup (utáhnout SL, blízký TP).  
3. **Zamykání zisku** – jakmile je pozice v zisku, SL minimálně na break-even.  
4. **Volatilita (ATR)** – určuj vzdálenosti podle aktuální volatility.  
5. **S/R úrovně** – respektuj nově vzniklé supporty a rezistence pro SL a TP.  
6. **Efektivní profit** – TP nastavuj jen tak daleko, jak je procentuálně realistické vzhledem k momentu a objemu.  

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
  "newTP": 28600,
  "reasoning": "Pozice +2.3 % v zisku. Bias stále silně long (EMA20 pod cenou, RSI 61, rostoucí objem) → volnější nastavení. SL posunut do profitu (27850) pod support. TP dál na 28600, kde je další rezistence a 2× ATR. Pokud bias oslabí, příště SL utáhnu těsně pod aktuální cenu.",
  "confidence": 0.9,
  "urgency": "medium"
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
    // Use buildMarketRawSnapshot with proper backend configuration
    const snapshot = await buildMarketRawSnapshot({ 
      universeStrategy: 'volume', 
      desiredTopN: 50,
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

    return coinData
  } catch (error) {
    console.error('[FETCH_MARKET_DATA_ERR]', {
      symbol,
      error: (error as any)?.message || error
    })
    throw error
  }
}
