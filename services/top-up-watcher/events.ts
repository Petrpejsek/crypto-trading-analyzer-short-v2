import fs from 'node:fs'
import path from 'node:path'
import type { WatcherEvent } from './types'

const EVENTS_FILE = path.resolve(process.cwd(), 'runtime', 'top_up_events.ndjson')

export async function emitWatcherEvent(event: WatcherEvent): Promise<void> {
  try {
    const dir = path.dirname(EVENTS_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({ ...event, ts: new Date().toISOString() }) + '\n'
    await fs.promises.appendFile(EVENTS_FILE, line, 'utf8')
  } catch (err) {
    try { console.error('[TOPUP_EVENT_WRITE_ERR]', (err as any)?.message || err) } catch {}
  }
}

export async function readLatestEvent(symbol: string): Promise<any> {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return null
    const data = await fs.promises.readFile(EVENTS_FILE, 'utf8')
    const lines = data.trim().split('\n').reverse()
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line)
        if (parsed && String(parsed.symbol || '').toUpperCase() === symbol.toUpperCase()) return parsed
      } catch {}
    }
  } catch {}
  return null
}


