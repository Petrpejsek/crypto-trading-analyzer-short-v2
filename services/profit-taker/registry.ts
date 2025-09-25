import fs from 'node:fs'
import path from 'node:path'

export type ProfitTakerEntry = {
  symbol: string
  entryPrice: number
  positionSize: number
  since: string
  lastCheck: string | null
  checks: number
  status: 'waiting' | 'processing'
  triggerAt: string
  cycleIndex: number
  lastError?: string | null
  lastErrorAt?: string | null
}

const entriesBySymbol: Record<string, ProfitTakerEntry> = {}
const REGISTRY_DIR = path.resolve(process.cwd(), 'runtime')
const REGISTRY_FILE = path.resolve(REGISTRY_DIR, 'profit_taker.json')

function persist(): void {
  try {
    if (!fs.existsSync(REGISTRY_DIR)) fs.mkdirSync(REGISTRY_DIR, { recursive: true })
    const payload = Object.values(entriesBySymbol).sort((a,b)=> new Date(a.triggerAt).getTime() - new Date(b.triggerAt).getTime())
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ ts: new Date().toISOString(), entries: payload }, null, 2), 'utf8')
  } catch {}
}

export function scheduleProfitTaker(symbol: string, entryPrice: number, positionSize: number, initialDelayMin: number): void {
  try {
    const now = new Date()
    const triggerAt = new Date(now.getTime() + Math.max(0, Math.floor(initialDelayMin)) * 60 * 1000)
    entriesBySymbol[symbol] = {
      symbol,
      entryPrice: Number(entryPrice),
      positionSize: Number(positionSize),
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

export function rescheduleProfitTaker(symbol: string, intervalMin: number): void {
  try {
    const e = entriesBySymbol[symbol]
    if (!e) return
    const next = new Date(Date.now() + Math.max(1, Math.floor(intervalMin)) * 60 * 1000)
    e.triggerAt = next.toISOString()
    e.status = 'waiting'
    e.checks += 1
    e.lastCheck = new Date().toISOString()
    e.cycleIndex = Math.max(1, Number(e.cycleIndex||1) + 1)
    persist()
  } catch {}
}

export function markProcessing(symbol: string): void {
  try { const e = entriesBySymbol[symbol]; if (e) { e.status = 'processing'; e.lastCheck = new Date().toISOString(); persist() } } catch {}
}

export function markError(symbol: string, err: string): void {
  try { const e = entriesBySymbol[symbol]; if (e) { e.lastError = String(err||'unknown'); e.lastErrorAt = new Date().toISOString(); e.status = 'waiting'; persist() } } catch {}
}

export function markCompleted(symbol: string): void {
  try { delete entriesBySymbol[symbol]; persist() } catch {}
}

export function getDueProfitTakers(): ProfitTakerEntry[] {
  try {
    const now = Date.now()
    return Object.values(entriesBySymbol).filter(e => new Date(e.triggerAt).getTime() <= now && e.status === 'waiting')
  } catch { return [] }
}

export function getProfitTakerList(): ProfitTakerEntry[] {
  try { return Object.values(entriesBySymbol) } catch { return [] }
}

let __rehydrateStarted = false
export async function rehydrateProfitTakerFromDisk(): Promise<void> {
  if (__rehydrateStarted) return
  __rehydrateStarted = true
  try {
    if (!fs.existsSync(REGISTRY_FILE)) return
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const arr: ProfitTakerEntry[] = Array.isArray(parsed?.entries) ? parsed.entries : []
    for (const e of arr) {
      try {
        const ageOk = (Date.now() - new Date(e.since).getTime()) < 12*60*60*1000
        if (ageOk) entriesBySymbol[e.symbol] = { ...e, status: 'waiting' }
      } catch {}
    }
    persist()
  } catch {}
}


