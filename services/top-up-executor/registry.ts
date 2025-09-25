import fs from 'node:fs'
import path from 'node:path'

export type TopUpExecutorEntry = {
  symbol: string
  pilotEntryPrice: number
  pilotSize: number
  multiplier: number
  plannedTotalSize: number
  topUpsEmitted: number
  watcherReasonCode: string | null
  watcherConfidence: number | null
  since: string
  lastCheck: string | null
  checks: number
  status: 'waiting' | 'processing'
  triggerAt: string
  cycleIndex: number
  lastError?: string | null
  lastErrorAt?: string | null
}

const entriesBySymbol: Record<string, TopUpExecutorEntry> = {}
const REGISTRY_DIR = path.resolve(process.cwd(), 'runtime')
const REGISTRY_FILE = path.resolve(REGISTRY_DIR, 'top_up_executor.json')

function persist(): void {
  try {
    if (!fs.existsSync(REGISTRY_DIR)) fs.mkdirSync(REGISTRY_DIR, { recursive: true })
    const payload = Object.values(entriesBySymbol).sort((a, b) => new Date(a.triggerAt).getTime() - new Date(b.triggerAt).getTime())
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ ts: new Date().toISOString(), entries: payload }, null, 2), 'utf8')
  } catch {}
}

export function scheduleTopUpExecutor(symbol: string, opts: {
  pilotEntryPrice: number
  pilotSize: number
  multiplier: number
  plannedTotalSize: number
  initialDelaySec: number
  watcherReasonCode?: string | null
  watcherConfidence?: number | null
}): void {
  try {
    const now = new Date()
    const triggerAt = new Date(now.getTime() + Math.max(0, Math.floor(opts.initialDelaySec)) * 1000)
    entriesBySymbol[symbol] = {
      symbol,
      pilotEntryPrice: Number(opts.pilotEntryPrice),
      pilotSize: Number(opts.pilotSize),
      multiplier: Number(opts.multiplier),
      plannedTotalSize: Number(opts.plannedTotalSize),
      topUpsEmitted: 0,
      watcherReasonCode: opts.watcherReasonCode ?? null,
      watcherConfidence: opts.watcherConfidence ?? null,
      since: now.toISOString(),
      lastCheck: null,
      checks: 0,
      status: 'waiting',
      triggerAt: triggerAt.toISOString(),
      cycleIndex: 1,
      lastError: null,
      lastErrorAt: null
    }
    persist()
  } catch {}
}

export function rescheduleTopUpExecutor(symbol: string, intervalSec: number): void {
  try {
    const e = entriesBySymbol[symbol]
    if (!e) return
    const next = new Date(Date.now() + Math.max(1, Math.floor(intervalSec)) * 1000)
    e.triggerAt = next.toISOString()
    e.status = 'waiting'
    e.checks += 1
    e.lastCheck = new Date().toISOString()
    e.cycleIndex = Math.max(1, Number(e.cycleIndex || 1) + 1)
    persist()
  } catch {}
}

export function markProcessing(symbol: string): void {
  try {
    const e = entriesBySymbol[symbol]
    if (e) {
      e.status = 'processing'
      e.lastCheck = new Date().toISOString()
      persist()
    }
  } catch {}
}

export function markError(symbol: string, err: string): void {
  try {
    const e = entriesBySymbol[symbol]
    if (e) {
      e.lastError = String(err || 'unknown')
      e.lastErrorAt = new Date().toISOString()
      e.status = 'waiting'
      persist()
    }
  } catch {}
}

export function markCompleted(symbol: string): void {
  try { delete entriesBySymbol[symbol]; persist() } catch {}
}

export function incrementTopUps(symbol: string): void {
  try {
    const e = entriesBySymbol[symbol]
    if (!e) return
    e.topUpsEmitted = Math.max(0, Number(e.topUpsEmitted || 0) + 1)
    persist()
  } catch {}
}

export function getDueTopUpExecutors(): TopUpExecutorEntry[] {
  try {
    const now = Date.now()
    return Object.values(entriesBySymbol).filter(e => new Date(e.triggerAt).getTime() <= now && e.status === 'waiting')
  } catch { return [] }
}

export function getTopUpExecutorList(): TopUpExecutorEntry[] {
  try { return Object.values(entriesBySymbol) } catch { return [] }
}

let __rehydrateStarted = false
export async function rehydrateTopUpExecutorFromDisk(): Promise<void> {
  if (__rehydrateStarted) return
  __rehydrateStarted = true
  try {
    if (!fs.existsSync(REGISTRY_FILE)) return
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const arr: TopUpExecutorEntry[] = Array.isArray(parsed?.entries) ? parsed.entries : []
    for (const e of arr) {
      try {
        const ageOk = (Date.now() - new Date(e.since).getTime()) < 6 * 60 * 60 * 1000
        if (ageOk) entriesBySymbol[e.symbol] = { ...e, status: 'waiting' }
      } catch {}
    }
    persist()
  } catch {}
}
