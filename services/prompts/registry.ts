import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export type PromptRegistryItem = {
  name: string
  path: string
  version: string
  checksum_sha256: string
}

export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

export function loadShortRegistry(): { items: PromptRegistryItem[]; version: string; snapshot?: string } {
  const dir = path.resolve('prompts/short')
  const regPath = path.join(dir, 'registry.json')
  const raw = fs.readFileSync(regPath, 'utf8')
  const items = JSON.parse(raw) as PromptRegistryItem[]
  const version = String(items?.[0]?.version || '')
  let snapshot: string | undefined
  try {
    const files = fs.readdirSync(dir).filter(f => f.startsWith('SNAPSHOT_') && f.endsWith('.md'))
    snapshot = files.find(f => version && f.includes(version)) || files.sort().pop()
  } catch {}
  return { items, version, snapshot }
}

export function verifyShortRegistry(items: PromptRegistryItem[]): { ok: boolean; invalid: Array<{ name: string; expected: string; actual: string }> } {
  const invalid: Array<{ name: string; expected: string; actual: string }> = []
  for (const it of items) {
    try {
      const p = path.resolve(it.path)
      const content = fs.readFileSync(p, 'utf8')
      const actual = sha256(content)
      if (actual !== it.checksum_sha256) {
        invalid.push({ name: it.name, expected: it.checksum_sha256, actual })
      }
    } catch {
      invalid.push({ name: it.name, expected: it.checksum_sha256, actual: 'missing' })
    }
  }
  return { ok: invalid.length === 0, invalid }
}


