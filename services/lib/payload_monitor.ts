/**
 * Payload Size Monitor - Track and alert on large AI payloads
 * 
 * Monitors payload sizes sent to AI assistants and alerts when
 * they exceed recommended thresholds.
 */

export type PayloadSizeInfo = {
  assistant: string
  symbol: string | null
  size_bytes: number
  size_kb: number
  size_mb: number
  is_large: boolean
  is_too_large: boolean
  timestamp: number
}

// Thresholds
const SIZE_WARNING_BYTES = 500000 // 500KB - warn
const SIZE_CRITICAL_BYTES = 1000000 // 1MB - too large

/**
 * Log payload size and alert if too large
 * 
 * @param assistant - AI assistant name (e.g., 'hot_screener')
 * @param payload - Payload object to measure
 * @param symbol - Optional symbol for context
 * @returns Size info
 */
export function logPayloadSize(
  assistant: string,
  payload: any,
  symbol: string | null = null
): PayloadSizeInfo {
  const payloadStr = JSON.stringify(payload)
  const sizeBytes = payloadStr.length
  const sizeKb = sizeBytes / 1024
  const sizeMb = sizeKb / 1024
  
  const isLarge = sizeBytes >= SIZE_WARNING_BYTES
  const isTooLarge = sizeBytes >= SIZE_CRITICAL_BYTES
  
  const info: PayloadSizeInfo = {
    assistant,
    symbol,
    size_bytes: sizeBytes,
    size_kb: parseFloat(sizeKb.toFixed(2)),
    size_mb: parseFloat(sizeMb.toFixed(3)),
    is_large: isLarge,
    is_too_large: isTooLarge,
    timestamp: Date.now()
  }
  
  // Log info
  console.info('[PAYLOAD_SIZE]', {
    assistant,
    symbol: symbol || null,
    size_kb: info.size_kb,
    size_mb: info.size_mb
  })
  
  // Warn if large
  if (isLarge && !isTooLarge) {
    console.warn('[PAYLOAD_SIZE_LARGE]', {
      assistant,
      symbol: symbol || null,
      size_kb: info.size_kb,
      threshold_kb: (SIZE_WARNING_BYTES / 1024).toFixed(0)
    })
  }
  
  // Alert if too large
  if (isTooLarge) {
    console.error('[PAYLOAD_SIZE_TOO_LARGE]', {
      assistant,
      symbol: symbol || null,
      size_kb: info.size_kb,
      size_mb: info.size_mb,
      threshold_mb: (SIZE_CRITICAL_BYTES / 1024 / 1024).toFixed(1),
      recommendation: 'Consider reducing candles count or removing unnecessary fields'
    })
  }
  
  return info
}

/**
 * Estimate token count from payload (rough approximation)
 * GPT models use ~4 chars per token on average
 * 
 * @param payload - Payload object
 * @returns Estimated token count
 */
export function estimateTokenCount(payload: any): number {
  const payloadStr = JSON.stringify(payload)
  const chars = payloadStr.length
  
  // Rough estimate: 1 token ≈ 4 characters for English text
  // JSON is denser, so use 3.5 chars per token
  const estimatedTokens = Math.ceil(chars / 3.5)
  
  return estimatedTokens
}

/**
 * Log estimated token usage
 * 
 * @param assistant - AI assistant name
 * @param payload - Payload object
 * @param symbol - Optional symbol
 */
export function logEstimatedTokens(
  assistant: string,
  payload: any,
  symbol: string | null = null
): void {
  const tokens = estimateTokenCount(payload)
  
  console.info('[PAYLOAD_TOKENS_ESTIMATED]', {
    assistant,
    symbol: symbol || null,
    estimated_tokens: tokens,
    cost_usd_gpt4o: ((tokens / 1000) * 0.0025).toFixed(4) // $2.50 per 1M input tokens
  })
  
  // Warn if high token count
  if (tokens > 100000) {
    console.warn('[PAYLOAD_TOKENS_HIGH]', {
      assistant,
      symbol: symbol || null,
      estimated_tokens: tokens,
      warning: 'High token count may increase latency and cost'
    })
  }
}

