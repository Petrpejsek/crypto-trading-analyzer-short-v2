// Health Monitor - Audit Logging
// Structured logging for health checks and worker activity

import fs from 'node:fs'
import path from 'node:path'
import type { HealthOutput } from './types'

const AUDIT_DIR = path.resolve(process.cwd(), 'runtime', 'audit')
const AUDIT_FILE = path.resolve(AUDIT_DIR, 'health_monitor.log')

// Ensure audit directory exists
try {
  if (!fs.existsSync(AUDIT_DIR)) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true })
  }
} catch (e) {
  console.error('[HEALTH_AUDIT_INIT_ERR]', (e as any)?.message || e)
}

/**
 * Append audit entry to log file
 */
function appendAuditLog(entry: Record<string, any>): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
    fs.appendFileSync(AUDIT_FILE, line, 'utf8')
  } catch (e) {
    // Silent fail - don't disrupt health checks
    console.error('[HEALTH_AUDIT_WRITE_ERR]', (e as any)?.message || e)
  }
}

/**
 * Log successful health check
 */
export function auditHealthCheck(output: HealthOutput, latencyMs: number, provider: 'server' | 'gpt'): void {
  try {
    appendAuditLog({
      type: 'health_check',
      symbol: output.symbol,
      version: output.version,
      provider,
      health_pct: output.health_pct,
      success_prob_pct: output.success_prob_pct,
      tp1: output.tp_hit_probs_pct.tp1,
      tp2: output.tp_hit_probs_pct.tp2,
      tp3: output.tp_hit_probs_pct.tp3,
      sl_touch: output.sl_touch_prob_pct,
      bias_score: output.bias_score,
      bias_label: output.bias_label,
      momentum_score: output.momentum_score,
      momentum_label: output.momentum_label,
      segments: output.segments,
      reasons_count: output.reasons.length,
      hard_fail: output.hard_fail,
      latency_ms: latencyMs,
      debug: output._debug
    })
    
    console.info('[HEALTH_AUDIT]', {
      symbol: output.symbol,
      ver: output.version,
      provider,
      health_pct: output.health_pct,
      bias_score: output.bias_score,
      momentum_score: output.momentum_score,
      latency_ms: latencyMs
    })
  } catch (e) {
    console.error('[HEALTH_AUDIT_ERR]', (e as any)?.message || e)
  }
}

/**
 * Log health check error
 */
export function auditHealthError(symbol: string, error: string, latencyMs: number, provider?: 'server' | 'gpt'): void {
  try {
    appendAuditLog({
      type: 'health_error',
      symbol,
      provider: provider || 'unknown',
      error,
      latency_ms: latencyMs
    })
    
    console.error('[HEALTH_CHECK_ERR]', {
      symbol,
      error,
      provider,
      latency_ms: latencyMs
    })
  } catch (e) {
    console.error('[HEALTH_AUDIT_ERR]', (e as any)?.message || e)
  }
}

/**
 * Log worker sync
 */
export function auditWorkerSync(positionsCount: number, pendingOrdersCount: number, totalEntries: number): void {
  try {
    appendAuditLog({
      type: 'worker_sync',
      positions_count: positionsCount,
      pending_orders_count: pendingOrdersCount,
      total_entries: totalEntries
    })
    
    console.info('[HEALTH_WORKER_SYNC]', {
      open_positions: positionsCount,
      pending_orders: pendingOrdersCount,
      total_entries: totalEntries
    })
  } catch (e) {
    console.error('[HEALTH_AUDIT_ERR]', (e as any)?.message || e)
  }
}

/**
 * Log batch processing start
 */
export function auditBatchStart(symbols: string[]): void {
  try {
    appendAuditLog({
      type: 'batch_start',
      symbols,
      count: symbols.length
    })
    
    console.info('[HEALTH_BATCH_START]', {
      symbols,
      count: symbols.length
    })
  } catch (e) {
    console.error('[HEALTH_AUDIT_ERR]', (e as any)?.message || e)
  }
}

/**
 * Log batch processing complete
 */
export function auditBatchComplete(successCount: number, errorCount: number, totalMs: number): void {
  try {
    appendAuditLog({
      type: 'batch_complete',
      success_count: successCount,
      error_count: errorCount,
      total_ms: totalMs
    })
    
    console.info('[HEALTH_BATCH_COMPLETE]', {
      success: successCount,
      errors: errorCount,
      total_ms: totalMs
    })
  } catch (e) {
    console.error('[HEALTH_AUDIT_ERR]', (e as any)?.message || e)
  }
}

/**
 * Log worker lifecycle event
 */
export function auditWorkerEvent(event: 'start' | 'stop', details?: Record<string, any>): void {
  try {
    appendAuditLog({
      type: 'worker_event',
      event,
      ...details
    })
    
    console.info(`[HEALTH_WORKER_${event.toUpperCase()}]`, details || {})
  } catch (e) {
    console.error('[HEALTH_AUDIT_ERR]', (e as any)?.message || e)
  }
}

/**
 * Log health monitor sync trigger
 */
export function auditHealthSyncTrigger(source: 'websocket' | 'periodic' | 'rehydrate', pendingOrdersCount: number): void {
  try {
    appendAuditLog({
      type: 'sync_trigger',
      source,
      pending_orders_count: pendingOrdersCount,
      timestamp: new Date().toISOString()
    })
    
    console.info('[HEALTH_SYNC_TRIGGER]', {
      source,
      pending_orders: pendingOrdersCount
    })
  } catch (e) {
    console.error('[HEALTH_SYNC_AUDIT_ERR]', (e as any)?.message || e)
  }
}

