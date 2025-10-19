// Health Monitor - Output Validator
// Validates HealthOutput schema (semafor.v2)

import type { HealthOutput } from './types'
import { 
  HEALTH_VERSION, 
  MAX_REASONS, 
  SEGMENTS_SUM_TOLERANCE,
  INDEPENDENCE_MIN_DELTA 
} from './types'

const ALLOWED_BIAS_LABELS = ['BEARISH', 'NEUTRAL', 'BULLISH']
const ALLOWED_MOMENTUM_LABELS = ['ACCELERATING/DOWN', 'COOLING', 'UP']

/**
 * Validate HealthOutput schema
 * Throws error if validation fails
 */
export function validateHealthOutput(output: HealthOutput): void {
  const errors: string[] = []

  // Version check
  if (output.version !== HEALTH_VERSION) {
    errors.push(`version must be '${HEALTH_VERSION}', got '${output.version}'`)
  }

  // Symbol
  if (typeof output.symbol !== 'string' || !output.symbol) {
    errors.push('symbol must be non-empty string')
  }

  // Health %
  if (!Number.isFinite(output.health_pct) || output.health_pct < 0 || output.health_pct > 100) {
    errors.push(`health_pct must be 0-100, got ${output.health_pct}`)
  }

  // Success %
  if (!Number.isFinite(output.success_prob_pct) || output.success_prob_pct < 0 || output.success_prob_pct > 100) {
    errors.push(`success_prob_pct must be 0-100, got ${output.success_prob_pct}`)
  }

  // TP hit probabilities
  if (!output.tp_hit_probs_pct) {
    errors.push('tp_hit_probs_pct missing')
  } else {
    const { tp1, tp2, tp3 } = output.tp_hit_probs_pct
    if (!Number.isFinite(tp1) || tp1 < 0 || tp1 > 100) {
      errors.push(`tp_hit_probs_pct.tp1 must be 0-100, got ${tp1}`)
    }
    if (!Number.isFinite(tp2) || tp2 < 0 || tp2 > 100) {
      errors.push(`tp_hit_probs_pct.tp2 must be 0-100, got ${tp2}`)
    }
    if (!Number.isFinite(tp3) || tp3 < 0 || tp3 > 100) {
      errors.push(`tp_hit_probs_pct.tp3 must be 0-100, got ${tp3}`)
    }
  }

  // SL touch probability
  if (!Number.isFinite(output.sl_touch_prob_pct) || output.sl_touch_prob_pct < 0 || output.sl_touch_prob_pct > 100) {
    errors.push(`sl_touch_prob_pct must be 0-100, got ${output.sl_touch_prob_pct}`)
  }

  // Segments (must sum to 100 ±1%)
  if (!output.segments) {
    errors.push('segments missing')
  } else {
    const { green_pct, orange_pct, red_pct } = output.segments
    if (!Number.isFinite(green_pct) || green_pct < 0 || green_pct > 100) {
      errors.push(`segments.green_pct must be 0-100, got ${green_pct}`)
    }
    if (!Number.isFinite(orange_pct) || orange_pct < 0 || orange_pct > 100) {
      errors.push(`segments.orange_pct must be 0-100, got ${orange_pct}`)
    }
    if (!Number.isFinite(red_pct) || red_pct < 0 || red_pct > 100) {
      errors.push(`segments.red_pct must be 0-100, got ${red_pct}`)
    }
    
    const sum = green_pct + orange_pct + red_pct
    if (Math.abs(sum - 100) > SEGMENTS_SUM_TOLERANCE) {
      errors.push(`segments must sum to 100 (±${SEGMENTS_SUM_TOLERANCE}%), got ${sum.toFixed(1)}%`)
    }
  }

  // Bias score
  if (!Number.isFinite(output.bias_score) || output.bias_score < 0 || output.bias_score > 100) {
    errors.push(`bias_score must be 0-100, got ${output.bias_score}`)
  }

  // Momentum score
  if (!Number.isFinite(output.momentum_score) || output.momentum_score < 0 || output.momentum_score > 100) {
    errors.push(`momentum_score must be 0-100, got ${output.momentum_score}`)
  }

  // Bias label
  if (!ALLOWED_BIAS_LABELS.includes(output.bias_label)) {
    errors.push(`bias_label must be one of ${ALLOWED_BIAS_LABELS.join(', ')}, got '${output.bias_label}'`)
  }

  // Momentum label
  if (!ALLOWED_MOMENTUM_LABELS.includes(output.momentum_label)) {
    errors.push(`momentum_label must be one of ${ALLOWED_MOMENTUM_LABELS.join(', ')}, got '${output.momentum_label}'`)
  }

  // Reasons
  if (!Array.isArray(output.reasons)) {
    errors.push('reasons must be an array')
  } else if (output.reasons.length > MAX_REASONS) {
    errors.push(`reasons array must have max ${MAX_REASONS} items, got ${output.reasons.length}`)
  } else {
    output.reasons.forEach((reason, i) => {
      if (typeof reason !== 'string' || !reason) {
        errors.push(`reasons[${i}] must be non-empty string`)
      }
    })
  }

  // Hard fail flag
  if (typeof output.hard_fail !== 'boolean') {
    errors.push('hard_fail must be boolean')
  }

  // Updated timestamp
  if (typeof output.updated_at_utc !== 'string' || !output.updated_at_utc) {
    errors.push('updated_at_utc must be non-empty string')
  } else {
    const ts = new Date(output.updated_at_utc).getTime()
    if (!Number.isFinite(ts)) {
      errors.push(`updated_at_utc is invalid ISO timestamp: ${output.updated_at_utc}`)
    }
  }

  // Independence check: health and success should not be identical (GPT provider check)
  // For server calculator this is relaxed
  if (output._debug?.provider === 'gpt') {
    const delta = Math.abs(output.health_pct - output.success_prob_pct)
    if (delta < INDEPENDENCE_MIN_DELTA) {
      errors.push(
        `Independence check failed: |health - success| = ${delta} < ${INDEPENDENCE_MIN_DELTA} (suspicious equality)`
      )
    }
  }

  if (errors.length > 0) {
    throw new Error(`HealthOutput validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`)
  }
}

/**
 * Validate and sanitize HealthOutput
 * Returns sanitized output or throws error
 */
export function validateAndSanitize(output: HealthOutput): HealthOutput {
  validateHealthOutput(output)
  
  // Sanitize: ensure segments sum to exactly 100
  const { green_pct, orange_pct, red_pct } = output.segments
  const sum = green_pct + orange_pct + red_pct
  
  if (Math.abs(sum - 100) > 0.01) {
    // Normalize
    const normalized = {
      green_pct: Math.round((green_pct / sum) * 100),
      orange_pct: Math.round((orange_pct / sum) * 100),
      red_pct: 0
    }
    normalized.red_pct = 100 - normalized.green_pct - normalized.orange_pct
    
    return {
      ...output,
      segments: normalized
    }
  }
  
  return output
}

