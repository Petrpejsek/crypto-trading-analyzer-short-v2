import fs from 'node:fs'
import path from 'node:path'
import { RegistryEntry, WatcherContext } from './types'

const REGISTRY_DIR = path.resolve(process.cwd(), 'runtime')
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'top_up_watcher.json')

const __entries = new Map<string, RegistryEntry>()

function isEnabled(): boolean {
  const env = String(process.env.TOPUP_WATCHER_ENABLED || '').toLowerCase()
  if (env) return env === '1' || env === 'true'
  try {
    const file = path.resolve('config/top_up_watcher.json')
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      return j?.enabled !== false
    }
  } catch {}
  return true
}

export function isWatcherEnabled(): boolean {
  return isEnabled()
}

function persist(): void {
  try {
    if (!fs.existsSync(REGISTRY_DIR)) fs.mkdirSync(REGISTRY_DIR, { recursive: true })
    const payload = Array.from(__entries.values()).sort((a, b) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime())
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ ts: new Date().toISOString(), entries: payload }, null, 2), 'utf8')
  } catch (err) {
    try { console.error('[TOPUP_REGISTRY_PERSIST_ERR]', (err as any)?.message || err) } catch {}
  }
}

function computeNextRun(limits: WatcherContext['limits']): string {
  const base = limits.poll_interval_sec
  const jitter = limits.poll_interval_jitter_sec
  const lo = Math.max(1, base - jitter)
  const hi = base + jitter
  const delaySec = lo + Math.random() * Math.max(1, hi - lo)
  return new Date(Date.now() + delaySec * 1000).toISOString()
}

export function scheduleWatcher(ctx: WatcherContext): void {
  if (!isEnabled()) { try { console.info('[TOPUP_REG_DISABLED]') } catch {} ; return }
  const now = new Date()
  const deadline = new Date(new Date(ctx.pilot.opened_at).getTime() + ctx.limits.ttl_minutes * 60 * 1000)
  const anchor = ctx.pilot.anchor_support ?? extractSupportFromRaw(ctx.symbol)
  const entry: RegistryEntry = {
    symbol: ctx.symbol,
    pilot: { ...ctx.pilot, anchor_support: anchor },
    plan: ctx.plan,
    limits: ctx.limits,
    maxSlippagePct: ctx.maxSlippagePct,
    startedAt: now.toISOString(),
    deadlineAt: deadline.toISOString(),
    status: 'running',
    lastTickAt: null,
    checks: 0,
    debounceCounter: 0,
    lastResult: null,
    nextRunAt: computeNextRun(ctx.limits),
    lastBidWallPrice: null,
    lastBidWallSeenAt: null,
    lastAskWallPrice: null,
    lastAskWallSeenAt: null,
    topUpsEmitted: 0
  }
  __entries.set(ctx.symbol, entry)
  persist()
  try { console.info('[TOPUP_WATCH_START]', { symbol: ctx.symbol, deadline: entry.deadlineAt, size: ctx.pilot.size, entry_px: ctx.pilot.entry_price }) } catch {}
}

function extractSupportFromRaw(symbol: string): number | null {
  try {
    const entry = __entries.get(symbol)
    if (entry?.pilot?.anchor_support) return entry.pilot.anchor_support
  } catch {}
  return null
}

export function completeWatcher(symbol: string): void {
  const entry = __entries.get(symbol)
  if (!entry) return
  entry.status = 'completed'
  entry.nextRunAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  persist()
}

export function removeWatcher(symbol: string): void {
  if (__entries.delete(symbol)) persist()
}

export function updateWatcher(symbol: string, draft: Partial<RegistryEntry>): void {
  const entry = __entries.get(symbol)
  if (!entry) return
  __entries.set(symbol, { ...entry, ...draft })
  persist()
}

export function getWatcher(symbol: string): RegistryEntry | undefined {
  return __entries.get(symbol)
}

export function listWatchers(): RegistryEntry[] {
  return Array.from(__entries.values())
}

export function getDueWatchers(): RegistryEntry[] {
  const now = Date.now()
  return Array.from(__entries.values()).filter(entry => {
    if (entry.status !== 'running') return false
    const t = Date.parse(entry.nextRunAt)
    if (!Number.isFinite(t)) return false
    // Clamp: never due earlier than now-1s; if in future, not due
    return t <= now
  })
}

export async function rehydrateWatchersFromDisk(): Promise<void> {
  try {
    if (!fs.existsSync(REGISTRY_FILE)) return
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const arr: RegistryEntry[] = Array.isArray(parsed?.entries) ? parsed.entries : []
    const now = Date.now()
    for (const entry of arr) {
      try {
        const deadline = Date.parse(entry.deadlineAt)
        if (!Number.isFinite(deadline)) continue
        if (deadline + 5 * 60 * 1000 < now) {
          continue
        }
        const nextRun = Date.parse(entry.nextRunAt)
        entry.nextRunAt = Number.isFinite(nextRun) ? new Date(Math.max(nextRun, now + 2000)).toISOString() : computeNextRun(entry.limits)
        entry.status = entry.status === 'completed' ? 'completed' : 'running'
        __entries.set(entry.symbol, entry)
      } catch {}
    }
    persist()
    try { console.info('[TOPUP_REGISTRY_REHYDRATE]', { count: __entries.size }) } catch {}
  } catch (err) {
    try { console.error('[TOPUP_REGISTRY_REHYDRATE_ERR]', (err as any)?.message || err) } catch {}
  }
}


