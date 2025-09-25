import fs from 'node:fs'
import path from 'node:path'

export type EntryOrderTrack = {
  symbol: string
  orderId: number
  clientOrderId: string | null
  entryPrice: number
  sl: number | null
  tpLevels: Array<{ tag: 'tp1'|'tp2'|'tp3'; price: number; allocation_pct: number }>
  checks: number
  lastCheck: string | null
  triggerAt: string
  since: string
  touchedRecentlyUntil?: number | null
  status?: 'waiting' | 'processing' | 'completed'
}

const REGISTRY_DIR = path.resolve(process.cwd(), 'runtime')
const REGISTRY_FILE = path.resolve(REGISTRY_DIR, 'entry_updater.json')
const UPDATE_DELAY_MS = 5 * 60 * 1000 // 5 minutes

const byOrderId = new Map<number, EntryOrderTrack>()

function persist(): void {
  try {
    if (!fs.existsSync(REGISTRY_DIR)) fs.mkdirSync(REGISTRY_DIR, { recursive: true })
    const entries = Array.from(byOrderId.values())
      .sort((a,b)=> new Date(a.since).getTime() - new Date(b.since).getTime())
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ ts: new Date().toISOString(), entries }, null, 2), 'utf8')
  } catch (e) {
    try { console.error('[EU_REGISTRY_PERSIST_ERR]', (e as any)?.message || e) } catch {}
  }
}

export function trackEntryOrder(e: Omit<EntryOrderTrack, 'checks' | 'lastCheck' | 'triggerAt' | 'since'> & { triggerAt?: string; since?: string }): void {
  try {
    const now = new Date()
    const triggerAt = e.triggerAt ? new Date(e.triggerAt) : new Date(now.getTime() + UPDATE_DELAY_MS)
    const since = e.since ? new Date(e.since) : now
    const rec: EntryOrderTrack = {
      symbol: e.symbol,
      orderId: e.orderId,
      clientOrderId: e.clientOrderId || null,
      entryPrice: e.entryPrice,
      sl: e.sl ?? null,
      tpLevels: Array.isArray(e.tpLevels) ? e.tpLevels : [],
      checks: 0,
      lastCheck: null,
      triggerAt: triggerAt.toISOString(),
      since: since.toISOString(),
      touchedRecentlyUntil: null,
      status: 'waiting'
    }
    byOrderId.set(rec.orderId, rec)
    persist()
    console.info('[EU_TRACK_START]', { symbol: rec.symbol, orderId: rec.orderId, triggerAt: rec.triggerAt })
  } catch (e) {
    try { console.error('[EU_TRACK_ERR]', (e as any)?.message || e) } catch {}
  }
}

export function untrackEntryOrder(orderId: number): void {
  try { byOrderId.delete(orderId); persist(); console.info('[EU_UNTRACK]', { orderId }) } catch {}
}

export function getDueEntryOrders(): EntryOrderTrack[] {
  try {
    const now = Date.now()
    return Array.from(byOrderId.values()).filter(e => new Date(e.triggerAt).getTime() <= now)
  } catch { return [] }
}

export function listEntryOrders(): EntryOrderTrack[] {
  try { return Array.from(byOrderId.values()) } catch { return [] }
}

export function hasEntryTrack(orderId: number): boolean {
  try { return byOrderId.has(orderId) } catch { return false }
}

export function setEntryStatus(orderId: number, status: 'waiting'|'processing'|'completed'): void {
  try {
    const rec = byOrderId.get(orderId)
    if (!rec) return
    rec.status = status
    persist()
  } catch {}
}

export function reschedule(orderId: number, delayMs: number = UPDATE_DELAY_MS): void {
  try {
    const rec = byOrderId.get(orderId)
    if (!rec) return
    rec.triggerAt = new Date(Date.now() + delayMs).toISOString()
    rec.status = 'waiting'
    persist()
  } catch {}
}

export function markTouchedRecently(orderId: number, ttlMs: number = 2 * 60 * 1000): void {
  try { const rec = byOrderId.get(orderId); if (rec) { rec.touchedRecentlyUntil = Date.now() + ttlMs; persist() } } catch {}
}

export function isTouchedRecently(orderId: number): boolean {
  try { const rec = byOrderId.get(orderId); return !!(rec && Number(rec.touchedRecentlyUntil) > Date.now()) } catch { return false }
}

export async function rehydrateEntryUpdaterFromDisk(): Promise<void> {
  try {
    if (!fs.existsSync(REGISTRY_FILE)) return
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const entries: EntryOrderTrack[] = Array.isArray(parsed?.entries) ? parsed.entries : []
    byOrderId.clear()
    const maxAge = 60 * 60 * 1000
    const now = Date.now()
    for (const e of entries) {
      try {
        const t = new Date(e.triggerAt).getTime()
        if (now - t <= maxAge) byOrderId.set(e.orderId, e)
      } catch {}
    }
    persist()
    console.info('[EU_REHYDRATE]', { count: byOrderId.size })
  } catch (e) {
    try { console.error('[EU_REHYDRATE_ERR]', (e as any)?.message || e) } catch {}
  }
}


