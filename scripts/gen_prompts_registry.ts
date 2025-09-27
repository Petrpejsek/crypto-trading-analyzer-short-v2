import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}

function main() {
  const side = 'short'
  const dir = path.resolve(`prompts/${side}`)
  if (!fs.existsSync(dir)) {
    console.error(`[REGISTRY] directory not found: ${dir}`)
    process.exit(1)
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort()
  const version = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13) // YYYYMMDDTHH
  const items = files.map(name => {
    const p = path.join(dir, name)
    const content = fs.readFileSync(p, 'utf8')
    return {
      name: name.replace(/\.md$/, ''),
      path: `prompts/${side}/${name}`,
      version,
      checksum_sha256: sha256(content)
    }
  })
  const outDir = path.resolve(`prompts/${side}`)
  const regFile = path.join(outDir, 'registry.json')
  fs.writeFileSync(regFile, JSON.stringify(items, null, 2) + '\n', 'utf8')
  const snapshotName = `SNAPSHOT_${version}.md`
  const snapshotPath = path.join(outDir, snapshotName)
  const blocks = items.map(x => `# ${x.name}\n\n` + '```\n' + fs.readFileSync(path.resolve(x.path), 'utf8') + '\n```\n')
  fs.writeFileSync(snapshotPath, blocks.join('\n'), 'utf8')
  console.log('[REGISTRY_GENERATED]', { side: side.toUpperCase(), count: items.length, snapshot: snapshotName })
}

main()


