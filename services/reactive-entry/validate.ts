import type { ReactiveEntryInput, ValidationResult } from './types'

const MIN_M5 = 300
const MIN_M15 = 200
const MIN_H1 = 200

/**
 * Pre-LLM validation - saves tokens and money!
 * Checks snapshot validity BEFORE calling OpenAI
 */
export function validateSnapshot(snapshot: ReactiveEntryInput): ValidationResult {
  // 1. Check required fields
  if (!snapshot.symbol || !snapshot.tradingRules || !snapshot.prices || !snapshot.bars_meta) {
    return {
      valid: false,
      code: 'missing_fields',
      details: 'Missing required fields: symbol, tradingRules, prices, or bars_meta'
    }
  }

  // 2. Validate tradingRules
  const { tickSize, stepSize, minNotional } = snapshot.tradingRules
  if (!tickSize || tickSize <= 0 || !stepSize || stepSize <= 0 || !minNotional || minNotional <= 0) {
    return {
      valid: false,
      code: 'invalid_tradingRules',
      details: 'tradingRules must have positive tickSize, stepSize, and minNotional'
    }
  }

  // 3. Validate minimum context (CRITICAL!)
  const { m5, m15, h1 } = snapshot.bars_meta || {}
  const missing: Record<string, { required: number; actual: number }> = {}
  let insufficient = false

  if (!m5 || m5 < MIN_M5) {
    missing.m5 = { required: MIN_M5, actual: m5 || 0 }
    insufficient = true
  }
  if (!m15 || m15 < MIN_M15) {
    missing.m15 = { required: MIN_M15, actual: m15 || 0 }
    insufficient = true
  }
  if (!h1 || h1 < MIN_H1) {
    missing.h1 = { required: MIN_H1, actual: h1 || 0 }
    insufficient = true
  }

  if (insufficient) {
    const parts: string[] = []
    if (missing.m5) parts.push(`m5≥${MIN_M5} (have ${missing.m5.actual})`)
    if (missing.m15) parts.push(`m15≥${MIN_M15} (have ${missing.m15.actual})`)
    if (missing.h1) parts.push(`h1≥${MIN_H1} (have ${missing.h1.actual})`)

    return {
      valid: false,
      code: 'context_insufficient',
      details: `Context insufficient: need ${parts.join(', ')}`,
      missing
    }
  }

  // 4. Validate ranges
  if (snapshot.range) {
    if (snapshot.range.h1 && snapshot.range.h1.low >= snapshot.range.h1.high) {
      return {
        valid: false,
        code: 'invalid_ranges',
        details: 'range.h1: low must be < high'
      }
    }
    if (snapshot.range.h4 && snapshot.range.h4.low >= snapshot.range.h4.high) {
      return {
        valid: false,
        code: 'invalid_ranges',
        details: 'range.h4: low must be < high'
      }
    }
  }

  // 5. Validate micro_range
  if (snapshot.micro_range && snapshot.micro_range.low >= snapshot.micro_range.high) {
    return {
      valid: false,
      code: 'invalid_ranges',
      details: 'micro_range: low must be < high'
    }
  }

  return { valid: true }
}

