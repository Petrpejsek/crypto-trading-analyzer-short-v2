import fs from 'node:fs'
import path from 'node:path'
import tradingCfg from '../../config/trading.json'
import { getBinanceAPI } from '../trading/binance_futures'

type CooldownRecord = {
  symbol: string
  consecutiveLosses: number
  cooldownUntilMs: number | null
  lastClosedAtMs: number | null
  lastOpenedAtMs: number | null
}

type CooldownState = {
  updatedAt: string
  items: Record<string, CooldownRecord>
}

const RUNTIME_DIR = path.resolve(process.cwd(), 'runtime')
const STATE_FILE = path.resolve(RUNTIME_DIR, 'cooldowns.json')

function getConfig(): { enabled: boolean; consecutiveLosses: number; minutes: number; persist: boolean; incomeWindowMinutes: number } {
  const cfg: any = (tradingCfg as any)?.COOLDOWN || {}
  return {
    enabled: cfg?.enabled !== false,
    consecutiveLosses: Number.isFinite(Number(cfg?.consecutiveLosses)) ? Number(cfg.consecutiveLosses) : 2,
    minutes: Number.isFinite(Number(cfg?.minutes)) ? Number(cfg.minutes) : 60,
    persist: cfg?.persist !== false,
    incomeWindowMinutes: Number.isFinite(Number(cfg?.incomeWindowMinutes)) ? Number(cfg.incomeWindowMinutes) : 10
  }
}

let state: CooldownState = { updatedAt: new Date().toISOString(), items: {} }
let initialized = false

function persist(): void {
  try {
    const { persist } = getConfig()
    if (!persist) return
    if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
  } catch {}
}

function load(): void {
  try {
    if (!fs.existsSync(STATE_FILE)) return
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.items && typeof parsed.items === 'object') {
      state = { updatedAt: new Date().toISOString(), items: parsed.items as Record<string, CooldownRecord> }
    }
  } catch {}
}

export function initCooldownsFromDisk(): void {
  if (initialized) return
  initialized = true
  try { load() } catch {}
}

export function isCooldownActive(symbol: string): boolean {
  const rec = state.items[symbol]
  if (!rec || !rec.cooldownUntilMs) return false
  return Date.now() < rec.cooldownUntilMs
}

export function getActiveCooldowns(): Array<{ symbol: string; until: string }> {
  const out: Array<{ symbol: string; until: string }> = []
  const now = Date.now()
  for (const [sym, rec] of Object.entries(state.items)) {
    if (rec.cooldownUntilMs && rec.cooldownUntilMs > now) {
      out.push({ symbol: sym, until: new Date(rec.cooldownUntilMs).toISOString() })
    }
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol))
}

export function getCooldownState(): { items: Record<string, CooldownRecord> } {
  return { items: state.items }
}

export function clearCooldown(symbol: string): void {
  try {
    if (state.items[symbol]) {
      state.items[symbol].cooldownUntilMs = null
      state.items[symbol].consecutiveLosses = 0
      state.items[symbol].lastClosedAtMs = null
      state.updatedAt = new Date().toISOString()
      persist()
    }
  } catch {}
}

function ensureRecord(symbol: string): CooldownRecord {
  if (!state.items[symbol]) {
    state.items[symbol] = { symbol, consecutiveLosses: 0, cooldownUntilMs: null, lastClosedAtMs: null, lastOpenedAtMs: null }
  }
  return state.items[symbol]
}

export function notePositionClosed(symbol: string, realizedPnlUsd: number): void {
  const cfg = getConfig()
  if (!cfg.enabled) return
  const rec = ensureRecord(symbol)
  if (Number(realizedPnlUsd) < 0) {
    rec.consecutiveLosses = (rec.consecutiveLosses || 0) + 1
  } else {
    rec.consecutiveLosses = 0
  }
  rec.lastClosedAtMs = Date.now()
  // Trigger cooldown when threshold reached exactly at this close
  if (rec.consecutiveLosses >= cfg.consecutiveLosses) {
    rec.cooldownUntilMs = Date.now() + cfg.minutes * 60 * 1000
    rec.consecutiveLosses = 0 // reset streak after triggering
  }
  state.updatedAt = new Date().toISOString()
  persist()
}

export function notePositionOpened(symbol: string): void {
  const cfg = getConfig()
  if (!cfg.enabled) return
  const rec = ensureRecord(symbol)
  // Set open timestamp only if not set or if it appears stale (after a previous close)
  if (!rec.lastOpenedAtMs || (rec.lastClosedAtMs && rec.lastClosedAtMs > (rec.lastOpenedAtMs || 0))) {
    rec.lastOpenedAtMs = Date.now()
    state.updatedAt = new Date().toISOString()
    persist()
  }
}

// Query Binance incomes in [lastOpenedAtMs, now] and update cooldown using the net realized PnL
export async function notePositionClosedFromIncomes(symbol: string): Promise<void> {
  const cfg = getConfig()
  if (!cfg.enabled) return
  try {
    const api = getBinanceAPI() as any
    const now = Date.now()
    const rec = ensureRecord(symbol)
    const startTime = Number(rec.lastOpenedAtMs || (now - cfg.incomeWindowMinutes * 60 * 1000))
    const endTime = now
    const incomes = await api.getIncomeHistory({ symbol, incomeType: 'REALIZED_PNL', startTime, endTime, limit: 1000 })
    let sum = 0
    for (const it of (Array.isArray(incomes) ? incomes : [])) {
      try {
        const s = String((it as any)?.symbol || '')
        const t = String((it as any)?.incomeType || (it as any)?.incomeType || '')
        const inc = Number((it as any)?.income)
        const ts = Number((it as any)?.time || (it as any)?.timestamp || 0)
        if (s === symbol && /REALIZED_PNL/i.test(t) && Number.isFinite(inc) && ts >= startTime && ts <= endTime) {
          sum += inc
        }
      } catch {}
    }
    notePositionClosed(symbol, sum)
    // keep lastOpenedAtMs; it will be overwritten on next open
  } catch (e) {
    // If income query fails, we conservatively do not change streak.
    try { console.error('[COOLDOWN_INCOME_ERR]', { symbol, error: (e as any)?.message || e }) } catch {}
  }
}


