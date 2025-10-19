import fs from 'node:fs'
import path from 'node:path'
import type { ReactiveEntryConfig } from './types'

let cachedConfig: ReactiveEntryConfig | null = null

const DEFAULT_CONFIG: ReactiveEntryConfig = {
  enabled: true,
  min_edge_bps_default: 15,
  min_edge_ticks_default: 5,
  anchor_vwap_threshold_bps: 200,
  anchor_ema50_threshold_bps: 200,
  anchor_resistance_age_max_mins: 30,
  openai_timeout_ms: 60000,
  openai_retry_count: 1,
  openai_retry_backoff_ms: 250,
  rate_limit_per_minute: 6
}

export function loadConfig(): ReactiveEntryConfig {
  if (cachedConfig) return cachedConfig

  const configPath = path.resolve(process.cwd(), 'config/reactive_entry.json')
  
  // STRICT: Config file must exist - no fallback to defaults
  if (!fs.existsSync(configPath)) {
    throw new Error(`[REACTIVE_ENTRY_CONFIG] Config file not found: ${configPath}`)
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ReactiveEntryConfig>
    cachedConfig = { ...DEFAULT_CONFIG, ...parsed }
    console.log('[REACTIVE_ENTRY_CONFIG_LOADED]', { path: configPath })
    return cachedConfig
  } catch (e: any) {
    console.error('[REACTIVE_ENTRY_CONFIG_ERROR]', { 
      message: e?.message || String(e),
      path: configPath 
    })
    throw new Error(`Failed to load reactive entry config: ${e?.message || String(e)}`)
  }
}

export function getSymbolConfig(symbol: string): { min_edge_bps: number; min_edge_ticks: number } {
  const config = loadConfig()
  const override = config.symbol_overrides?.[symbol]
  
  return {
    min_edge_bps: override?.min_edge_bps ?? config.min_edge_bps_default,
    min_edge_ticks: override?.min_edge_ticks ?? config.min_edge_ticks_default
  }
}

export function reloadConfig(): void {
  cachedConfig = null
  loadConfig()
}

