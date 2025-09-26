import fs from 'node:fs'
import path from 'node:path'

export type AuditRecord = Record<string, any>

export function isAuditEnabled(): boolean {
  try {
    const v = String(process.env.TOP_UP_EXECUTOR_AUDIT || '').toLowerCase()
    return v === '1' || v === 'true' || v === 'yes'
  } catch { return false }
}

function getAuditDir(): string {
  return path.resolve(process.cwd(), 'runtime', 'audit', 'top_up_executor')
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
    fs.appendFile(file, line, (err) => {
      if (err) {
        try { console.error('[TUP_EXEC_AUDIT_APPEND_ERR]', err.message || err) } catch {}
      }
    })
  } catch (e) {
    try { console.error('[TUP_EXEC_AUDIT_WRITE_ERR]', (e as any)?.message || e) } catch {}
  }
}

async function readJsonLines(file: string): Promise<AuditRecord[]> {
  try {
    if (!fs.existsSync(file)) return []
    const raw = await fs.promises.readFile(file, 'utf8')
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    const out: AuditRecord[] = []
    for (const l of lines) { try { out.push(JSON.parse(l)) } catch {} }
    return out
  } catch { return [] }
}

export async function readAuditEntries(symbol?: string | null, limit: number = 50): Promise<AuditRecord[]> {
  try {
    const today = getAuditFilePath(new Date())
    const yest = getAuditFilePath(new Date(Date.now() - 24 * 60 * 60 * 1000))
    const arr1 = await readJsonLines(today)
    const arr2 = await readJsonLines(yest)
    const all = arr1.concat(arr2)
    const filtered = symbol ? all.filter(r => String(r?.symbol || '') === symbol) : all
    return filtered.slice(Math.max(0, filtered.length - limit))
  } catch { return [] }
}

export async function readAuditLatest(symbol?: string | null): Promise<AuditRecord | null> {
  const list = await readAuditEntries(symbol || null, 1)
  return list.length ? list[0] : null
}


