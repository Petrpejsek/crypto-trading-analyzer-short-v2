import fs from 'node:fs'
import path from 'node:path'

type AuditRecord = Record<string, any>

export function isAuditEnabled(): boolean {
  try {
    const v = String(process.env.STRATEGY_UPDATER_AUDIT || '').toLowerCase()
    return v === '1' || v === 'true' || v === 'yes'
  } catch { return false }
}

function getAuditDir(): string {
  return path.resolve(process.cwd(), 'runtime', 'audit', 'strategy_updater')
}

function getAuditFilePath(date?: Date): string {
  const d = date ? new Date(date) : new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  const dir = getAuditDir()
  return path.join(dir, `${y}-${m}-${day}.jsonl`)
}

export function appendAudit(record: AuditRecord): void {
  if (!isAuditEnabled()) return
  try {
    const dir = getAuditDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const file = getAuditFilePath()
    const line = JSON.stringify({ ...record, ts: new Date().toISOString() }) + '\n'
    // Non-blocking write; errors are swallowed by design to avoid impacting flow
    fs.appendFile(file, line, (err) => { if (err) { try { console.error('[AUDIT_APPEND_ERR]', err.message || err) } catch {} } })
  } catch (e) {
    try { console.error('[AUDIT_WRITE_ERR]', (e as any)?.message || e) } catch {}
  }
}

async function readJsonLines(file: string): Promise<AuditRecord[]> {
  try {
    if (!fs.existsSync(file)) return []
    const raw = await fs.promises.readFile(file, 'utf8')
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    const out: AuditRecord[] = []
    for (const l of lines) {
      try { out.push(JSON.parse(l)) } catch {}
    }
    return out
  } catch { return [] }
}

export async function readAuditEntries(symbol?: string | null, limit: number = 50): Promise<AuditRecord[]> {
  try {
    const today = getAuditFilePath(new Date())
    const yest = getAuditFilePath(new Date(Date.now() - 24*60*60*1000))
    const arrToday = await readJsonLines(today)
    const arrYest = await readJsonLines(yest)
    // Merge and sort by ts ascending so that slicing from the end yields truly latest records across days
    const merged = ([] as AuditRecord[]).concat(arrYest, arrToday).sort((a: any, b: any) => {
      const ta = Date.parse(String((a as any)?.ts || ''))
      const tb = Date.parse(String((b as any)?.ts || ''))
      const na = Number.isFinite(ta) ? ta : 0
      const nb = Number.isFinite(tb) ? tb : 0
      return na - nb
    })
    const filtered = symbol ? merged.filter(r => String(r?.symbol || '') === symbol) : merged
    return filtered.slice(Math.max(0, filtered.length - Math.max(1, limit)))
  } catch { return [] }
}

export async function readAuditLatest(symbol?: string | null): Promise<AuditRecord | null> {
  const list = await readAuditEntries(symbol || null, 1)
  return list.length ? list[list.length - 1] : null
}


