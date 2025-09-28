import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'

// Load .env.local explicitly
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })
dotenv.config({ path: path.resolve(process.cwd(), '.env') })

import { getBinanceAPI } from '../services/trading/binance_futures'

// Local helpers replicated from services/decider/lib/pnl_report.ts to ensure identical logic

type Profile = 'aggressive' | 'conservative' | 'unknown'

type RangePreset = 'today' | 'yesterday' | 'last7d' | 'last30d'

function resolveRange(preset: RangePreset): { startTime: number; endTime: number } {
	const now = new Date()
	if (preset === 'today') {
		const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
		return { startTime: start.getTime(), endTime: now.getTime() }
	}
	if (preset === 'yesterday') {
		const y = new Date(now)
		y.setDate(y.getDate() - 1)
		const start = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 0, 0, 0, 0)
		const end = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59, 999)
		return { startTime: start.getTime(), endTime: end.getTime() }
	}
	if (preset === 'last7d') {
		const start = new Date(now)
		start.setDate(start.getDate() - 7)
		return { startTime: start.getTime(), endTime: now.getTime() }
	}
	const start = new Date(now)
	start.setDate(start.getDate() - 30)
	return { startTime: start.getTime(), endTime: now.getTime() }
}

function classifyProfile(clientOrderId: string | null): Profile {
	if (!clientOrderId) return 'unknown'
	if (/^sv2_e_l_/i.test(clientOrderId)) return 'conservative'
	if (/^(sv2_e_stl_|sv2_e_stm_|sv2_e_m_)/i.test(clientOrderId)) return 'aggressive'
	return 'unknown'
}

type Trade = { id: number; orderId: number; time: number; qty: number; price: number; buyer: boolean }

type Order = { orderId: number; clientOrderId: string | null; time: number; side: string; type: string; status: string }

async function fetchOrders(symbol: string, startTime: number, endTime: number): Promise<Order[]> {
	const api = getBinanceAPI()
	const raw = await (api as any).getAllOrders(symbol, { startTime, endTime, limit: 1000 })
	return (Array.isArray(raw) ? raw : []).map((o: any) => ({
		orderId: Number(o?.orderId || o?.orderID || 0),
		clientOrderId: ((): string | null => { const id = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || ''); return id || null })(),
		time: Number(o?.time || o?.updateTime || 0),
		side: String(o?.side || ''),
		type: String(o?.type || ''),
		status: String(o?.status || '')
	}))
}

async function fetchTrades(symbol: string, startTime: number, endTime: number): Promise<Trade[]> {
	const api = getBinanceAPI()
	const raw = await (api as any).getUserTrades(symbol, { startTime, endTime, limit: 1000 })
	return (Array.isArray(raw) ? raw : []).map((t: any) => ({
		id: Number(t?.id || t?.tradeId || 0),
		orderId: Number(t?.orderId || t?.orderID || 0),
		time: Number(t?.time || t?.T || 0),
		qty: Number(t?.qty || t?.qtyFilled || t?.executedQty || 0),
		price: Number(t?.price || t?.p || 0),
		buyer: String(t?.side || (t?.isBuyer ? 'BUY' : 'SELL')).toUpperCase() === 'BUY'
	})).sort((a,b)=> a.time - b.time)
}

function buildSessions(symbol: string, trades: Trade[], startTime: number, endTime: number): Array<{ entryTime: number; closeTime: number; entryOrderId: number | null; buyQty: number; sellQty: number }>{
	const sessions: Array<{ entryTime: number; closeTime: number; entryOrderId: number | null; buyQty: number; sellQty: number }> = []
	let pos = 0
	let entryTime: number | null = null
	let entryOrderId: number | null = null
	let buyQty = 0
	let sellQty = 0
	for (const tr of trades) {
		if (tr.buyer) {
			if (pos === 0) {
				entryTime = tr.time
				entryOrderId = Number.isFinite(tr.orderId) && tr.orderId > 0 ? tr.orderId : null
				buyQty = 0
				sellQty = 0
			}
			pos += tr.qty
			buyQty += tr.qty
		} else {
			pos -= tr.qty
			sellQty += tr.qty
			if (pos <= 0 && entryTime != null) {
				const closeTime = tr.time
				if (entryTime >= startTime && closeTime <= endTime) {
					sessions.push({ entryTime, closeTime, entryOrderId, buyQty, sellQty })
				}
				entryTime = null
				entryOrderId = null
				pos = 0
			}
		}
	}
	return sessions
}

async function fetchIncomes(startTime: number, endTime: number) {
	const api = getBinanceAPI()
	const incomes = await api.getIncomeHistory({ incomeType: 'REALIZED_PNL', startTime, endTime, limit: 1000 })
	return Array.isArray(incomes) ? incomes : []
}

function sumPnl(incomes: any[], start: number, end: number): number {
	let s = 0
	for (const it of incomes) {
		try {
			const t = Number((it as any)?.time || (it as any)?.timestamp || 0)
			const income = Number((it as any)?.income)
			if (t >= start && t <= end && Number.isFinite(income)) s += income
		} catch {}
	}
	return s
}

async function computeGroundTruth(preset: RangePreset, profile: 'aggressive'|'conservative'|'both') {
	const { startTime, endTime } = resolveRange(preset)
	const incomesAll = await fetchIncomes(startTime, endTime)
	const bySymbolIncome: Record<string, { realizedPnl: number; records: any[] }> = {}
	for (const it of incomesAll) {
		try {
			const symbol = String((it as any)?.symbol || '')
			const incomeType = String((it as any)?.incomeType || (it as any)?.type || '')
			const income = Number((it as any)?.income)
			const time = Number((it as any)?.time || (it as any)?.timestamp || 0)
			if (!symbol || !/REALIZED_PNL/i.test(incomeType)) continue
			if (time < startTime || time > endTime) continue
			if (!bySymbolIncome[symbol]) bySymbolIncome[symbol] = { realizedPnl: 0, records: [] }
			if (Number.isFinite(income)) bySymbolIncome[symbol].realizedPnl += income
			bySymbolIncome[symbol].records.push(it)
		} catch {}
	}
	const symbols = Object.keys(bySymbolIncome)
	const sessions: Array<{ symbol: string; entryTime: number; closeTime: number; entryClientOrderId: string | null; profile: Profile; realizedPnl: number; buyQty: number; sellQty: number }> = []
	for (const sym of symbols) {
		const trades = await fetchTrades(sym, startTime, endTime)
		if (!trades.length) continue
		const sess = buildSessions(sym, trades, startTime, endTime)
		if (!sess.length) continue
		const orders = await fetchOrders(sym, startTime, endTime)
		const incomes = bySymbolIncome[sym]?.records || []
		for (const s of sess) {
			const ord = (s.entryOrderId ? orders.find(o => o.orderId === s.entryOrderId) : null) || null
			const clientId = ord ? (ord.clientOrderId || null) : null
			const prof = classifyProfile(clientId)
			if (profile !== 'both' && prof !== profile) continue
			const pnl = sumPnl(incomes, s.entryTime, s.closeTime)
			sessions.push({ symbol: sym, entryTime: s.entryTime, closeTime: s.closeTime, entryClientOrderId: clientId, profile: prof, realizedPnl: pnl, buyQty: s.buyQty, sellQty: s.sellQty })
		}
	}
	// Aggregations identical to UI
	const agg = { aggressive: { sessions: 0, wins: 0, pnl: 0 }, conservative: { sessions: 0, wins: 0, pnl: 0 }, unknown: { sessions: 0, wins: 0, pnl: 0 } }
	for (const s of sessions) {
		const a = (agg as any)[s.profile]
		a.sessions += 1
		a.pnl += s.realizedPnl
		if (s.realizedPnl > 0) a.wins += 1
	}
	const perSymbol: Record<string, { pnl: number; sessions: number; profileAgg: Record<string, { sessions: number; pnl: number }> }> = {}
	for (const s of sessions) {
		if (!perSymbol[s.symbol]) perSymbol[s.symbol] = { pnl: 0, sessions: 0, profileAgg: { aggressive: { sessions: 0, pnl: 0 }, conservative: { sessions: 0, pnl: 0 }, unknown: { sessions: 0, pnl: 0 } } }
		perSymbol[s.symbol].pnl += s.realizedPnl
		perSymbol[s.symbol].sessions += 1
		perSymbol[s.symbol].profileAgg[s.profile].sessions += 1
		perSymbol[s.symbol].profileAgg[s.profile].pnl += s.realizedPnl
	}
	return { startTime, endTime, sessions, agg, perSymbol }
}

function parseNumberCell(s: string | null | undefined): number | null {
	if (!s) return null
	const n = Number(String(s).replace(/[^0-9+\-\.]/g, ''))
	return Number.isFinite(n) ? n : null
}

function parseUiMarkdown(md: string) {
	// Extract per-symbol table rows and sessions rows
	const lines = md.split(/\r?\n/)
	const perSymbolRows: Array<{ symbol: string; sessions: number; pnl: number; cons: { sessions: number; pnl: number }; aggr: { sessions: number; pnl: number }; unk: { sessions: number; pnl: number } }> = []
	const sessionsRows: Array<{ symbol: string; entryTime: string; closeTime: string; profile: string; pnl: number; buyQty: number; sellQty: number; clientId: string }>=[]
	let section: 'none'|'perSymbol'|'sessions' = 'none'
	for (const raw of lines) {
		const line = raw.trim()
		if (/^\|\s*Symbol\s*\|\s*Sessions\s*\|\s*Total P&L/i.test(line)) { section = 'perSymbol'; continue }
		if (/^##\s*Sessions/i.test(line)) { section = 'sessions'; continue }
		if (section === 'perSymbol' && /^\|/.test(line) && !/\|---/.test(line)) {
			const cols = line.split('|').map(c => c.trim())
			// | Symbol | Sessions | Total P&L | Conservative (n/P&L) | Aggressive (n/P&L) | Unknown (n/P&L) |
			const symbol = cols[1]
			const sessions = Number(cols[2])
			const pnl = parseNumberCell(cols[3]) || 0
			const [consN, consP] = String(cols[4]||'').split('/').map(s => s.trim())
			const [aggrN, aggrP] = String(cols[5]||'').split('/').map(s => s.trim())
			const [unkN, unkP] = String(cols[6]||'').split('/').map(s => s.trim())
			perSymbolRows.push({ symbol, sessions, pnl, cons: { sessions: Number(consN||0), pnl: parseNumberCell(consP)||0 }, aggr: { sessions: Number(aggrN||0), pnl: parseNumberCell(aggrP)||0 }, unk: { sessions: Number(unkN||0), pnl: parseNumberCell(unkP)||0 } })
		}
		if (section === 'sessions' && /^\|/.test(line) && !/\|---/.test(line)) {
			// | Symbol | Entry time | Close time | Profile | Session P&L | buyQty/sellQty | clientOrderId |
			const cols = line.split('|').map(c => c.trim())
			const symbol = cols[1]
			const entryTime = cols[2]
			const closeTime = cols[3]
			const profile = cols[4]
			const pnl = parseNumberCell(cols[5]) || 0
			const [buyQty, sellQty] = String(cols[6]||'').split('/').map(s => Number(s))
			const clientId = cols[7] || ''
			sessionsRows.push({ symbol, entryTime, closeTime, profile, pnl, buyQty: Number(buyQty||0), sellQty: Number(sellQty||0), clientId })
		}
	}
	return { perSymbolRows, sessionsRows }
}

function compareWithTolerance(a: number, b: number, tol = 1e-9): boolean {
	return Math.abs(a - b) <= tol
}

async function fetchUiReport(preset: RangePreset, profile: 'aggressive'|'conservative'|'both'): Promise<string> {
    const params = new URLSearchParams({ preset, profile })
    const port = Number(process.env.PORT || process.env.SERVER_PORT || 8888)
    const url = `http://127.0.0.1:${port}/api/reports/pnl?${params.toString()}`
	const res = await fetch(url)
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
	return await res.text()
}

async function main() {
	const preset: RangePreset = (process.env.PRESET as any) || 'today'
	const profile = ((process.env.PROFILE as any) || 'both') as 'aggressive'|'conservative'|'both'
	console.log('[VERIFY_PNL]', { preset, profile })
	const [uiMd, gt] = await Promise.all([
		fetchUiReport(preset, profile),
		computeGroundTruth(preset, profile)
	])
	const parsed = parseUiMarkdown(uiMd)
	// Build comparable maps
	const uiPerSymbol = new Map<string, { sessions: number; pnl: number; cons: number; aggr: number; unk: number }>()
	for (const r of parsed.perSymbolRows) {
		uiPerSymbol.set(r.symbol, { sessions: r.sessions, pnl: r.pnl, cons: r.cons.pnl, aggr: r.aggr.pnl, unk: r.unk.pnl })
	}
	const gtPerSymbol = new Map<string, { sessions: number; pnl: number; cons: number; aggr: number; unk: number }>()
	for (const [symbol, v] of Object.entries(gt.perSymbol)) {
		gtPerSymbol.set(symbol, { sessions: v.sessions, pnl: v.pnl, cons: v.profileAgg.conservative.pnl, aggr: v.profileAgg.aggressive.pnl, unk: v.profileAgg.unknown.pnl })
	}
	// Compare sets
	const symbols = new Set([...uiPerSymbol.keys(), ...gtPerSymbol.keys()])
	const diffs: string[] = []
	for (const sym of symbols) {
		const ui = uiPerSymbol.get(sym)
		const gtRow = gtPerSymbol.get(sym)
		if (!ui || !gtRow) {
			diffs.push(`Symbol mismatch: ${sym} present in ${ui ? 'UI' : 'GT'} only`)
			continue
		}
		if (ui.sessions !== gtRow.sessions) diffs.push(`${sym} sessions: UI ${ui.sessions} vs GT ${gtRow.sessions}`)
		if (!compareWithTolerance(ui.pnl, gtRow.pnl)) diffs.push(`${sym} pnl: UI ${ui.pnl.toFixed(8)} vs GT ${gtRow.pnl.toFixed(8)}`)
		if (!compareWithTolerance(ui.cons, gtRow.cons)) diffs.push(`${sym} cons pnl: UI ${ui.cons.toFixed(8)} vs GT ${gtRow.cons.toFixed(8)}`)
		if (!compareWithTolerance(ui.aggr, gtRow.aggr)) diffs.push(`${sym} aggr pnl: UI ${ui.aggr.toFixed(8)} vs GT ${gtRow.aggr.toFixed(8)}`)
		if (!compareWithTolerance(ui.unk, gtRow.unk)) diffs.push(`${sym} unk pnl: UI ${ui.unk.toFixed(8)} vs GT ${gtRow.unk.toFixed(8)}`)
	}
	// Print result
	if (diffs.length === 0) {
		console.log('[VERIFY_PNL_OK] UI report matches Binance 1:1 for per-symbol aggregates.')
	} else {
		console.error('[VERIFY_PNL_DIFF]', diffs.join('\n'))
	}
	// Optional: write artifacts
	const outDir = path.resolve(process.cwd(), 'runtime', 'reports')
	try { if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true }) } catch {}
	fs.writeFileSync(path.resolve(outDir, 'pnl_ui.md'), uiMd, 'utf8')
	fs.writeFileSync(path.resolve(outDir, 'pnl_gt.json'), JSON.stringify(gt, null, 2), 'utf8')
}

main().catch(err => {
	console.error('[VERIFY_PNL_ERROR]', err?.message || err)
	process.exit(1)
})
