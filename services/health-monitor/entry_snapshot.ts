// Health Monitor - Entry Snapshots
// Capture initial health at position entry for P&L reporting

import fs from 'node:fs'
import path from 'node:path'
import type { EntrySnapshot, SnapshotsData } from './types'
import { SNAPSHOT_RETENTION_DAYS } from './types'
import { buildMarketRawSnapshot } from '../../server/fetcher/binance'
import { buildHealthPayload, validatePayload } from './payload_builder'
import { calculateHealth } from './calculator'
import { runHealthMonitorGPT } from './health_monitor_gpt'

const SNAPSHOTS_DIR = path.resolve(process.cwd(), 'runtime')
const SNAPSHOTS_FILE = path.resolve(SNAPSHOTS_DIR, 'health_entry_snapshots.json')

/**
 * Load snapshots from disk
 */
function loadSnapshots(): SnapshotsData {
  try {
    if (!fs.existsSync(SNAPSHOTS_FILE)) {
      return {}
    }
    const raw = fs.readFileSync(SNAPSHOTS_FILE, 'utf8')
    const data = JSON.parse(raw)
    return typeof data === 'object' && data !== null ? data : {}
  } catch (e) {
    console.error('[ENTRY_SNAPSHOT_LOAD_ERR]', (e as any)?.message || e)
    return {}
  }
}

/**
 * Save snapshots to disk with auto-cleanup
 */
function saveSnapshots(data: SnapshotsData): void {
  try {
    // Ensure directory exists
    if (!fs.existsSync(SNAPSHOTS_DIR)) {
      fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true })
    }
    
    // Cleanup old snapshots (retention policy)
    const now = Date.now()
    const retentionMs = SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000
    const cleaned: SnapshotsData = {}
    
    for (const [key, snapshot] of Object.entries(data)) {
      const age = now - snapshot.entryTime
      if (age <= retentionMs) {
        cleaned[key] = snapshot
      }
    }
    
    fs.writeFileSync(SNAPSHOTS_FILE, JSON.stringify(cleaned, null, 2), 'utf8')
  } catch (e) {
    console.error('[ENTRY_SNAPSHOT_SAVE_ERR]', (e as any)?.message || e)
  }
}

/**
 * Determine health color based on percentage
 */
function getHealthColor(health: number): 'green' | 'orange' | 'red' {
  if (health >= 70) return 'green'
  if (health >= 40) return 'orange'
  return 'red'
}

/**
 * Capture entry snapshot when position is opened
 */
export async function captureEntrySnapshot(symbol: string, side: 'SHORT'): Promise<void> {
  const t0 = performance.now()
  
  try {
    console.info('[ENTRY_SNAPSHOT_START]', { symbol, side })
    
    // Fetch fresh market data
    const snapshot = await buildMarketRawSnapshot({
      includeSymbols: [symbol],
      fresh: true,
      allowPartial: true,
      desiredTopN: 20
    })
    
    // Build payload
    const payload = buildHealthPayload(snapshot, symbol)
    validatePayload(payload)
    
    // Calculate health (use configured provider)
    const provider = process.env.HEALTH_MONITOR_PROVIDER || 'server'
    let healthOutput
    
    if (provider === 'gpt') {
      healthOutput = await runHealthMonitorGPT(payload)
    } else {
      healthOutput = calculateHealth(payload)
    }
    
    // Create snapshot entry
    const entrySnapshot: EntrySnapshot = {
      symbol,
      health_pct: healthOutput.health_pct,
      success_pct: healthOutput.success_prob_pct,
      color: getHealthColor(healthOutput.health_pct),
      timestamp: new Date().toISOString(),
      entryTime: Date.now()
    }
    
    // Save to file
    const snapshots = loadSnapshots()
    const key = `${symbol}_${entrySnapshot.entryTime}`
    snapshots[key] = entrySnapshot
    saveSnapshots(snapshots)
    
    const latency = Math.round(performance.now() - t0)
    console.info('[ENTRY_SNAPSHOT_DONE]', {
      symbol,
      health: entrySnapshot.health_pct,
      success: entrySnapshot.success_pct,
      color: entrySnapshot.color,
      latency_ms: latency
    })
    
  } catch (e) {
    const latency = Math.round(performance.now() - t0)
    console.error('[ENTRY_SNAPSHOT_ERR]', {
      symbol,
      error: (e as any)?.message || e,
      latency_ms: latency
    })
    // Don't throw - snapshots are non-critical
  }
}

/**
 * Get entry snapshot for symbol (returns most recent)
 */
export function getEntrySnapshot(symbol: string): EntrySnapshot | null {
  try {
    const snapshots = loadSnapshots()
    
    // Find all snapshots for this symbol
    const matching = Object.entries(snapshots)
      .filter(([key]) => key.startsWith(`${symbol}_`))
      .map(([, snapshot]) => snapshot)
      .sort((a, b) => b.entryTime - a.entryTime) // newest first
    
    return matching[0] || null
  } catch {
    return null
  }
}

/**
 * Get all entry snapshots
 */
export function getAllEntrySnapshots(): SnapshotsData {
  try {
    return loadSnapshots()
  } catch {
    return {}
  }
}

/**
 * Delete entry snapshot for symbol
 */
export function deleteEntrySnapshot(symbol: string): void {
  try {
    const snapshots = loadSnapshots()
    const filtered: SnapshotsData = {}
    
    for (const [key, snapshot] of Object.entries(snapshots)) {
      if (!key.startsWith(`${symbol}_`)) {
        filtered[key] = snapshot
      }
    }
    
    saveSnapshots(filtered)
    console.info('[ENTRY_SNAPSHOT_DELETE]', { symbol })
  } catch (e) {
    console.error('[ENTRY_SNAPSHOT_DELETE_ERR]', (e as any)?.message || e)
  }
}

