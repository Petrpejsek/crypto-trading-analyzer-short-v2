import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })
dotenv.config({ path: path.resolve(process.cwd(), '.env') })

async function main() {
	const { buildPnlReportMarkdown, resolveRange } = await import('../services/decider/lib/pnl_report')
	const preset = 'today'
	const profile: 'aggressive'|'conservative'|'both' = 'both'
	const md = await buildPnlReportMarkdown({ preset, profile })
	const { startTime, endTime } = resolveRange(preset)
	const outDir = path.resolve(process.cwd(), 'runtime', 'reports')
	try { if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true }) } catch {}
	const outFile = path.resolve(outDir, `daily_pnl_${new Date(startTime).toISOString().slice(0,10)}.md`)
	fs.writeFileSync(outFile, md, 'utf8')
	console.log('[DAILY_PNL_REPORT_WRITTEN]', { file: outFile })
}

main().catch(err => {
	console.error('[DAILY_PNL_REPORT_ERROR]', err?.message || err)
	process.exit(1)
})
