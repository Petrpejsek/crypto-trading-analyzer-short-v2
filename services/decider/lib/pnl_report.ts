import { getBinanceAPI } from '../../trading/binance_futures'

export type Profile = 'aggressive' | 'conservative' | 'unknown'
export type RangePreset = 'today' | 'yesterday' | 'last7d' | 'last30d'

export function resolveRange(preset: RangePreset): { startTime: number; endTime: number } {
	const now = Date.now()
	if (preset === 'today') {
		// Use LOCAL midnight, not UTC, for user-friendly "today"
		const nowDate = new Date(now)
		const startDate = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), 0, 0, 0, 0)
		return { startTime: startDate.getTime(), endTime: now }
	}
	if (preset === 'yesterday') {
		const nowDate = new Date(now)
		nowDate.setDate(nowDate.getDate() - 1)
		const startDate = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), 0, 0, 0, 0)
		const endDate = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), 23, 59, 59, 999)
		return { startTime: startDate.getTime(), endTime: endDate.getTime() }
	}
	if (preset === 'last7d') {
		const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000)
		return { startTime: sevenDaysAgo, endTime: now }
	}
	// last30d
	const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000)
	return { startTime: thirtyDaysAgo, endTime: now }
}

function classifyProfile(clientOrderId: string | null): Profile {
	if (!clientOrderId) return 'unknown'
	if (/^sv2_e_l_/i.test(clientOrderId)) return 'conservative'
	if (/^(sv2_e_stl_|sv2_e_stm_|sv2_e_m_)/i.test(clientOrderId)) return 'aggressive'
	return 'unknown'
}

// Robust pagination for incomes by adaptive window splitting (covers dense same-timestamp records)
async function fetchAllIncomes(
	startTime: number,
	endTime: number,
	incomeType: 'REALIZED_PNL' | 'COMMISSION'
): Promise<any[]> {
	const api = getBinanceAPI()
	const collected: any[] = []
	let totalFetched = 0
	console.info('[PNL_FETCH_INCOMES]', { incomeType, startTime: new Date(startTime).toISOString(), endTime: new Date(endTime).toISOString() })
	async function loadWindow(s: number, e: number, depth = 0): Promise<void> {
		if (s > e || depth > 10) return // Max recursion depth safety
		const page = await api.getIncomeHistory({ incomeType, startTime: s, endTime: e, limit: 1000 })
		const arr = Array.isArray(page) ? page : []
		totalFetched += arr.length
		if (arr.length > 0) {
			collected.push(...arr)
			if (arr.length >= 1000) {
				// Split time window for pagination
				const mid = Math.floor((s + e) / 2)
				await loadWindow(s, mid, depth + 1)
				await loadWindow(mid + 1, e, depth + 1)
			}
		}
	}
	await loadWindow(startTime, endTime)
	// Deduplicate by unique transaction ID if available, else by composite key
	const seen = new Set<string>()
	const out: any[] = []
	for (const it of collected) {
		try {
			const tranId = String((it as any)?.tranId || (it as any)?.id || '')
			const sym = String((it as any)?.symbol || '')
			const ts = Number((it as any)?.time || (it as any)?.timestamp || 0)
			const t = String((it as any)?.incomeType || (it as any)?.type || '')
			const inc = String((it as any)?.income || '')
			const key = tranId || `${sym}|${ts}|${t}|${inc}`
			if (seen.has(key)) continue
			seen.add(key)
			out.push(it)
		} catch { out.push(it) }
	}
	console.info('[PNL_INCOMES_FETCHED]', { incomeType, totalFetched, deduplicated: out.length })
	return out.sort((a: any, b: any) => (Number(a?.time || a?.timestamp || 0) - Number(b?.time || b?.timestamp || 0)))
}

type Trade = { id: number; orderId: number; time: number; qty: number; price: number; buyer: boolean; positionSide: 'LONG'|'SHORT'|'BOTH'|null }

type Order = { orderId: number; clientOrderId: string | null; time: number; side: string; type: string; status: string }

// Paginated fetch for allOrders via time-window splitting
async function fetchAllOrders(symbol: string, startTime: number, endTime: number): Promise<Order[]> {
	const api = getBinanceAPI()
	const out: Order[] = []
	let totalFetched = 0
	console.info('[PNL_FETCH_ORDERS]', { symbol, startTime: new Date(startTime).toISOString(), endTime: new Date(endTime).toISOString() })
	async function loadWindow(s: number, e: number, depth = 0): Promise<void> {
		if (s > e || depth > 10) return
		const raw = await (api as any).getAllOrders(symbol, { startTime: s, endTime: e, limit: 1000 })
		const arr = Array.isArray(raw) ? raw : []
		totalFetched += arr.length
		if (arr.length > 0) {
			const mapped = arr.map((o: any) => ({
				orderId: Number(o?.orderId || 0),
				clientOrderId: String(o?.clientOrderId || '').trim() || null,
				time: Number(o?.time || o?.updateTime || 0),
				side: String(o?.side || ''),
				type: String(o?.type || ''),
				status: String(o?.status || '')
			}))
			out.push(...mapped)
			if (arr.length >= 1000) {
				const mid = Math.floor((s + e) / 2)
				await loadWindow(s, mid, depth + 1)
				await loadWindow(mid + 1, e, depth + 1)
			}
		}
	}
	await loadWindow(startTime, endTime)
	const seen = new Set<number>()
	const dedup: Order[] = []
	for (const o of out) { 
		if (o.orderId > 0 && !seen.has(o.orderId)) { 
			seen.add(o.orderId); 
			dedup.push(o) 
		} 
	}
	console.info('[PNL_ORDERS_FETCHED]', { symbol, totalFetched, deduplicated: dedup.length })
	return dedup.sort((a,b)=> a.time - b.time)
}

// Paginated fetch for userTrades via adaptive window splitting
async function fetchAllTrades(symbol: string, startTime: number, endTime: number): Promise<Trade[]> {
	const api = getBinanceAPI()
	const out: Trade[] = []
	let totalFetched = 0
	console.info('[PNL_FETCH_TRADES]', { symbol, startTime: new Date(startTime).toISOString(), endTime: new Date(endTime).toISOString() })
	async function loadWindow(s: number, e: number, depth = 0): Promise<void> {
		if (s > e || depth > 10) return
		const raw = await (api as any).getUserTrades(symbol, { startTime: s, endTime: e, limit: 1000 })
		const arr = Array.isArray(raw) ? raw : []
		totalFetched += arr.length
		if (arr.length > 0) {
			const mapped: Trade[] = arr.map((t: any) => ({
				id: Number(t?.id || 0),
				orderId: Number(t?.orderId || 0),
				time: Number(t?.time || 0),
				qty: Math.abs(Number(t?.qty || 0)),
				price: Number(t?.price || 0),
				buyer: Boolean(t?.buyer),
				positionSide: ((): 'LONG'|'SHORT'|'BOTH'|null => {
					const ps = String(t?.positionSide || '').toUpperCase()
					if (ps === 'LONG' || ps === 'SHORT' || ps === 'BOTH') return ps
					return null
				})()
			}))
			out.push(...mapped)
			if (arr.length >= 1000) {
				const mid = Math.floor((s + e) / 2)
				await loadWindow(s, mid, depth + 1)
				await loadWindow(mid + 1, e, depth + 1)
			}
		}
	}
	await loadWindow(startTime, endTime)
	const seen = new Set<number>()
	const dedup: Trade[] = []
	for (const t of out) { 
		if (t.id > 0 && !seen.has(t.id)) { 
			seen.add(t.id); 
			dedup.push(t) 
		} 
	}
	console.info('[PNL_TRADES_FETCHED]', { symbol, totalFetched, deduplicated: dedup.length })
	return dedup.sort((a,b)=> a.time - b.time)
}

function buildSessions(symbol: string, trades: Trade[], windowStart: number, windowEnd: number): Array<{ entryTime: number; closeTime: number; entryOrderId: number | null; buyQty: number; sellQty: number }>{
	const sessions: Array<{ entryTime: number; closeTime: number; entryOrderId: number | null; buyQty: number; sellQty: number }> = []
	let netPosition = 0
	let entryTime: number | null = null
	let entryOrderId: number | null = null
	let buyQty = 0
	let sellQty = 0
	
	console.info('[BUILD_SESSIONS]', { symbol, trades: trades.length, windowStart: new Date(windowStart).toISOString(), windowEnd: new Date(windowEnd).toISOString() })
	
	for (const tr of trades) {
		const signedQty = tr.buyer ? tr.qty : -tr.qty
		const before = netPosition
		const after = Math.round((before + signedQty) * 1e8) / 1e8 // Floating point precision fix
		
		// Start new session if currently flat and opening a position
		if (Math.abs(before) < 0.0000001 && entryTime == null && Math.abs(signedQty) > 0) {
			entryTime = tr.time
			entryOrderId = Number.isFinite(tr.orderId) && tr.orderId > 0 ? tr.orderId : null
			buyQty = 0
			sellQty = 0
		}
		
		// Accumulate quantities
		if (tr.buyer) buyQty += tr.qty; else sellQty += tr.qty
		netPosition = after
		
		// Check if position closed (returned to flat or flipped)
		const isFlat = Math.abs(after) < 0.0000001
		const flipped = (before > 0.0000001 && after < -0.0000001) || (before < -0.0000001 && after > 0.0000001)
		
		if ((isFlat || flipped) && entryTime != null) {
			const closeTime = tr.time
			// Include session if it closed within the window
			if (closeTime >= windowStart && closeTime <= windowEnd) {
				sessions.push({ entryTime, closeTime, entryOrderId, buyQty, sellQty })
				console.info('[SESSION_FOUND]', { 
					symbol, 
					entryTime: new Date(entryTime).toISOString(), 
					closeTime: new Date(closeTime).toISOString(),
					buyQty, 
					sellQty 
				})
			}
			
			// Reset for next session
			if (flipped && !isFlat) {
				// Position flipped, start new session immediately
				entryTime = tr.time
				entryOrderId = Number.isFinite(tr.orderId) && tr.orderId > 0 ? tr.orderId : null
				buyQty = 0
				sellQty = 0
				// Reset quantities for flipped position
				if (tr.buyer) buyQty = tr.qty; else sellQty = tr.qty
			} else {
				// Position closed to flat
				entryTime = null
				entryOrderId = null
				buyQty = 0
				sellQty = 0
			}
		}
	}
	
	console.info('[SESSIONS_BUILT]', { symbol, sessionsCount: sessions.length })
	return sessions
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

export async function buildPnlReport(params: { preset: RangePreset; profile: 'aggressive'|'conservative'|'both' }): Promise<{
    startTime: number
    endTime: number
		sessions: Array<{ symbol: string; entryTime: number; closeTime: number; entryClientOrderId: string | null; profile: Profile; realizedPnl: number; buyQty: number; sellQty: number; tradesCount: number; buyNotional: number; sellNotional: number; avgBuyPrice: number; avgSellPrice: number; invested: number | null; pnlPct: number | null }>
    agg: { aggressive: { sessions: number; wins: number; pnl: number }; conservative: { sessions: number; wins: number; pnl: number }; unknown: { sessions: number; wins: number; pnl: number } }
    perSymbol: Record<string, { pnl: number; sessions: number; profileAgg: Record<string, { sessions: number; pnl: number }> }>
}> {
    const { preset, profile } = params
    const { startTime, endTime } = resolveRange(preset)

	// Pull incomes with full pagination
	// Also check 2 hours before startTime to catch sessions that closed right after midnight
	const lookbackStart = startTime - (2 * 60 * 60 * 1000)
	const realizedIncomes = await fetchAllIncomes(lookbackStart, endTime, 'REALIZED_PNL')
	// Use COMMISSION to discover ALL traded symbols
	const commissionIncomes = await fetchAllIncomes(lookbackStart, endTime, 'COMMISSION')
    const bySymbolIncome: Record<string, { realizedPnl: number; records: any[] }> = {}
	for (const it of realizedIncomes) {
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
	// Ensure symbols from commissions are included (for zero-PnL days)
	for (const it of commissionIncomes) {
		try {
			const symbol = String((it as any)?.symbol || '')
			const time = Number((it as any)?.time || (it as any)?.timestamp || 0)
			if (!symbol) continue
			if (time < startTime || time > endTime) continue
			if (!bySymbolIncome[symbol]) bySymbolIncome[symbol] = { realizedPnl: 0, records: [] }
		} catch {}
	}

    const symbols = Object.keys(bySymbolIncome)
    const sessions: Array<{ symbol: string; entryTime: number; closeTime: number; entryClientOrderId: string | null; profile: Profile; realizedPnl: number; buyQty: number; sellQty: number; tradesCount: number; buyNotional: number; sellNotional: number; avgBuyPrice: number; avgSellPrice: number; invested: number | null; pnlPct: number | null }> = []

    // Snapshot current leverage per symbol (used as approximation for margin without leverage multiplier)
    const levBySymbol: Record<string, number> = {}
    try {
        const api = getBinanceAPI()
        const pos = await api.getPositions()
        for (const p of (Array.isArray(pos) ? pos : [])) {
            try {
                const sym = String((p as any)?.symbol || '')
                const lev = Number((p as any)?.leverage)
                if (sym && Number.isFinite(lev) && lev > 0) levBySymbol[sym] = lev
            } catch {}
        }
    } catch {}
	for (const sym of symbols) {
		// Fetch ALL trades for the symbol in extended window to catch cross-day sessions
		// Sessions that started before midnight but closed today need earlier trades
		const extendedStart = startTime - (24 * 60 * 60 * 1000) // Go back 24 hours
		const trades = await fetchAllTrades(sym, extendedStart, endTime)
		if (!trades.length) continue
		const sess = buildSessions(sym, trades, startTime, endTime)
		if (!sess.length) continue
		// For orders, use extended window too to find entry orders from yesterday
		const orders = await fetchAllOrders(sym, extendedStart, endTime)
        const incomes = bySymbolIncome[sym]?.records || []
		for (const s of sess) {
            const ord = (s.entryOrderId ? orders.find(o => o.orderId === s.entryOrderId) : null) || null
            const clientId = ord ? (ord.clientOrderId || null) : null
            const prof = classifyProfile(clientId)
            if (profile !== 'both' && prof !== profile) continue
            const pnl = sumPnl(incomes, s.entryTime, s.closeTime)
			const tradesInSession = trades.filter(t => t.time >= s.entryTime && t.time <= s.closeTime)
			const tradesCount = tradesInSession.length
			let buyNotional = 0
			let sellNotional = 0
			for (const t of tradesInSession) {
				try {
					const notional = Number(t.qty) * Number(t.price)
					if (t.buyer) buyNotional += notional
					else sellNotional += notional
				} catch {}
			}
			const avgBuyPrice = (Number(s.buyQty) > 0) ? (buyNotional / Number(s.buyQty)) : 0
			const avgSellPrice = (Number(s.sellQty) > 0) ? (sellNotional / Number(s.sellQty)) : 0
            const lev = Number(levBySymbol[sym])
            const invested = (Number.isFinite(lev) && lev > 0) ? (buyNotional / lev) : null
            const pnlPct = (Number.isFinite(invested as any) && (invested as number) > 0) ? ((pnl / (invested as number)) * 100) : null
            sessions.push({ symbol: sym, entryTime: s.entryTime, closeTime: s.closeTime, entryClientOrderId: clientId, profile: prof, realizedPnl: pnl, buyQty: s.buyQty, sellQty: s.sellQty, tradesCount, buyNotional, sellNotional, avgBuyPrice, avgSellPrice, invested, pnlPct })
        }
    }

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

    sessions.sort((a,b)=> a.entryTime - b.entryTime)
    return { startTime, endTime, sessions, agg, perSymbol }
}

export async function buildPnlReportMarkdown(params: { preset: RangePreset; profile: 'aggressive'|'conservative'|'both' }): Promise<string> {
    const { preset, profile } = params
    const { startTime, endTime, sessions, agg, perSymbol } = await buildPnlReport({ preset, profile })
    const winRate = (x: { sessions: number; wins: number }) => x.sessions > 0 ? (100 * x.wins / x.sessions) : 0
    const perSymbolRows = Object.entries(perSymbol)
        .map(([symbol, v]) => ({ symbol, pnl: v.pnl, sessions: v.sessions, cons: v.profileAgg.conservative, aggr: v.profileAgg.aggressive, unk: v.profileAgg.unknown }))
        .sort((a,b)=> Math.abs(b.pnl) - Math.abs(a.pnl))

    const when = new Date().toISOString()
    const { startTime: sT, endTime: eT } = { startTime, endTime }
    const md: string[] = []
    md.push(`# P&L report (${preset}, profile=${profile})\n`)
    md.push(`Generated: ${when}`)
    md.push('')
    md.push(`Time window (local): ${new Date(sT).toLocaleString()} — ${new Date(eT).toLocaleString()}`)
    md.push('')
    md.push('## Summary by profile')
    md.push('')
    md.push(`- Aggressive: P&L ${agg.aggressive.pnl.toFixed(2)} USDT | Sessions ${agg.aggressive.sessions} | Win rate ${winRate(agg.aggressive).toFixed(1)}%`)
    md.push(`- Conservative: P&L ${agg.conservative.pnl.toFixed(2)} USDT | Sessions ${agg.conservative.sessions} | Win rate ${winRate(agg.conservative).toFixed(1)}%`)
    md.push(`- Unknown: P&L ${agg.unknown.pnl.toFixed(2)} USDT | Sessions ${agg.unknown.sessions} | Win rate ${winRate(agg.unknown).toFixed(1)}%`)
    md.push('')
    md.push('## Per-symbol breakdown (sum of sessions)')
    md.push('')
    md.push('| Symbol | Sessions | Total P&L | Conservative (n/P&L) | Aggressive (n/P&L) | Unknown (n/P&L) |')
    md.push('|---|---:|---:|---:|---:|---:|')
    for (const r of perSymbolRows) {
        md.push(`| ${r.symbol} | ${r.sessions} | ${r.pnl.toFixed(4)} | ${r.cons.sessions}/${r.cons.pnl.toFixed(2)} | ${r.aggr.sessions}/${r.aggr.pnl.toFixed(2)} | ${r.unk.sessions}/${r.unk.pnl.toFixed(2)} |`)
    }
    md.push('')
    md.push('## Sessions')
    md.push('')
    md.push('| Symbol | Entry time | Close time | Profile | Session P&L | buyQty/sellQty | clientOrderId |')
    md.push('|---|---|---|---|---:|---:|---|')
    for (const s of sessions) {
        md.push(`| ${s.symbol} | ${new Date(s.entryTime).toLocaleString()} | ${new Date(s.closeTime).toLocaleString()} | ${s.profile} | ${s.realizedPnl.toFixed(4)} | ${s.buyQty.toFixed(6)}/${s.sellQty.toFixed(6)} | ${(s.entryClientOrderId||'').slice(0,24)} |`)
    }
    md.push('')
    md.push('Notes: profile determined from first entry clientOrderId prefix; P&L sums Binance REALIZED_PNL in session window.')
    return md.join('\n')
}
