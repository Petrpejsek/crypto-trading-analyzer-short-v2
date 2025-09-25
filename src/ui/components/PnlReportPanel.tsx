import React, { useMemo, useState } from 'react'

export default function PnlReportPanel() {
	const [preset, setPreset] = useState<'today'|'yesterday'|'last7d'|'last30d'>('today')
	const [profile, setProfile] = useState<'both'|'conservative'|'aggressive'>('both')
	const [downloading, setDownloading] = useState(false)
	const [show, setShow] = useState(false)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	type ReportProfile = 'aggressive'|'conservative'|'unknown'
	type ReportData = {
		startTime: number
		endTime: number
		sessions: Array<{ symbol: string; entryTime: number; closeTime: number; entryClientOrderId: string | null; profile: ReportProfile; realizedPnl: number; buyQty: number; sellQty: number; tradesCount: number; buyNotional: number; sellNotional: number; avgBuyPrice: number; avgSellPrice: number; invested: number | null; pnlPct: number | null }>
		agg: { aggressive: { sessions: number; wins: number; pnl: number }; conservative: { sessions: number; wins: number; pnl: number }; unknown: { sessions: number; wins: number; pnl: number } }
		perSymbol: Record<string, { pnl: number; sessions: number; profileAgg: Record<string, { sessions: number; pnl: number }> }>
	}
	const [data, setData] = useState<ReportData | null>(null)
	const [page, setPage] = useState(1)
	const PAGE_SIZE = 100
	const [levForInvested, setLevForInvested] = useState<number>(() => {
		try { const v = Number(localStorage.getItem('pnl_invested_lev')); return Number.isFinite(v) && v > 0 ? v : 15 } catch { return 15 }
	})

	const query = useMemo(() => {
		const p = new URLSearchParams({ preset, profile })
		return `/api/reports/pnl?${p.toString()}`
	}, [preset, profile])

	const jsonUrl = useMemo(() => {
		const p = new URLSearchParams({ preset, profile })
		return `/api/reports/pnl.json?${p.toString()}`
	}, [preset, profile])

	async function handleDownload() {
		setDownloading(true)
		try {
			const r = await fetch(query, { method: 'GET' })
			if (!r.ok) throw new Error(`HTTP ${r.status}`)
			const blob = await r.blob()
			const url = URL.createObjectURL(blob)
			const a = document.createElement('a')
			const ts = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')
			a.href = url
			a.download = `pnl_${preset}_${profile}_${ts}.md`
			document.body.appendChild(a)
			a.click()
			document.body.removeChild(a)
			URL.revokeObjectURL(url)
		} catch (e) {
			console.error('Download failed', e)
		} finally {
			setDownloading(false)
		}
	}

	async function handleShow() {
		setError(null)
		setLoading(true)
		setShow(true)
		setPage(1)
		try {
			const r = await fetch(jsonUrl, { method: 'GET' })
			if (!r.ok) throw new Error(`HTTP ${r.status}`)
			const j = await r.json()
			if (!j || typeof j !== 'object' || !Array.isArray(j.sessions)) throw new Error('invalid_response')
			j.sessions.sort((a: any, b: any) => Number(a.entryTime) - Number(b.entryTime))
			setData(j)
		} catch (e: any) {
			setError(e?.message || 'unknown')
			setData(null)
			setShow(false)
		} finally {
			setLoading(false)
		}
	}

	function handleHide() {
		setShow(false)
	}

	const totalSessions = Array.isArray(data?.sessions) ? data!.sessions.length : 0
	const pageCount = Math.max(1, Math.ceil(totalSessions / PAGE_SIZE))
	const pageStart = (page - 1) * PAGE_SIZE
	const pageRows = (Array.isArray(data?.sessions) ? data!.sessions : []).slice(pageStart, pageStart + PAGE_SIZE)
	function prevPage() { setPage(p => Math.max(1, p - 1)) }
	function nextPage() { setPage(p => Math.min(pageCount, p + 1)) }

	function displayInvested(s: ReportData['sessions'][number]): number {
		const server = Number((s as any)?.invested ?? NaN)
		if (Number.isFinite(server)) return server
		const notional = Number((s as any)?.buyNotional || 0)
		return levForInvested > 0 ? (notional / levForInvested) : notional
	}

	function displayPct(s: ReportData['sessions'][number]): number {
		const server = Number((s as any)?.pnlPct ?? NaN)
		if (Number.isFinite(server)) return server
		const inv = displayInvested(s)
		const pnl = Number((s as any)?.realizedPnl || 0)
		return inv > 0 ? (pnl / inv) * 100 : 0
	}

	const totals = useMemo(() => {
		try {
			const rows = Array.isArray(data?.sessions) ? data!.sessions : []
			let invested = 0
			let pnl = 0
			for (const s of rows) {
				invested += displayInvested(s)
				pnl += Number(s.realizedPnl || 0)
			}
			const pct = invested > 0 ? (pnl / invested) * 100 : 0
			return { invested, pnl, pct }
		} catch { return { invested: 0, pnl: 0, pct: 0 } }
	}, [data, levForInvested])

	function formatDuration(entryTime: number, closeTime: number): string {
		try {
			const ms = Math.max(0, Number(closeTime||0) - Number(entryTime||0))
			const sec = Math.floor(ms / 1000)
			const days = Math.floor(sec / 86400)
			const hours = Math.floor((sec % 86400) / 3600)
			const minutes = Math.floor((sec % 3600) / 60)
			const seconds = sec % 60
			if (days > 0) return `${days}d ${hours}h ${minutes}m`
			if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
			return `${minutes}m ${seconds}s`
		} catch { return '' }
	}

	return (
		<div style={{ marginTop: 24, padding: 12, borderTop: '1px solid #eee', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
			<div style={{ fontWeight: 600 }}>P&L report export</div>
			<div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
				<label>
					<span style={{ marginRight: 6 }}>Range:</span>
					<select value={preset} onChange={e=> setPreset(e.target.value as any)}>
						<option value="today">Dnes</option>
						<option value="yesterday">Včera</option>
						<option value="last7d">Posledních 7 dní</option>
						<option value="last30d">Posledních 30 dní</option>
					</select>
				</label>
				<label>
					<span style={{ marginRight: 6 }}>Profil:</span>
					<select value={profile} onChange={e=> setProfile(e.target.value as any)}>
						<option value="both">Obojí</option>
						<option value="conservative">Conservative</option>
						<option value="aggressive">Aggressive</option>
					</select>
				</label>
				<button onClick={handleDownload} disabled={downloading}>
					{downloading ? 'Stahuji…' : 'Stáhnout .md'}
				</button>
				{!show ? (
					<button onClick={handleShow} disabled={loading}>
						{loading ? 'Načítám…' : 'Show'}
					</button>
				) : (
					<>
						<button onClick={handleHide} disabled={loading}>Hide</button>
						<button onClick={handleShow} disabled={loading}>{loading ? 'Načítám…' : 'Refresh'}</button>
					</>
				)}
			</div>
			{error ? (
				<div style={{ color: 'crimson', fontSize: 12, whiteSpace: 'pre-wrap' }}>Error: {error}</div>
			) : null}
			{show && data && (
				<div className="card" style={{ marginTop: 8 }}>
					<div className="space-between" style={{ marginBottom: 8 }}>
						<strong>Sessions ({totalSessions})</strong>
						<div className="row gap-8">
							<span style={{ fontSize: 12, opacity: .8 }}>{new Date(data.startTime).toLocaleString()} — {new Date(data.endTime).toLocaleString()}</span>
						</div>
					</div>
					<div style={{ overflowX: 'auto' }}>
						<table style={{ width: '100%', borderCollapse: 'collapse' }}>
							<thead>
								<tr>
									<th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>Entry time</th>
									<th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>Close time</th>
									<th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>Duration</th>
									<th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>Symbol</th>
									<th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>Profile</th>
									<th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>Session P&L</th>
									<th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>% P&L</th>
									<th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>Invested</th>
									<th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>Avg buy</th>
									<th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>Avg sell</th>
									<th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>buyQty/sellQty</th>
									<th style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>Trades</th>
									<th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>ClientOrderId</th>
								</tr>
							</thead>
							<tbody>
								{pageRows.map((s, i) => (
									<tr key={`${s.symbol}-${s.entryTime}-${i}`}>
										<td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{new Date(s.entryTime).toLocaleString()}</td>
										<td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{new Date(s.closeTime).toLocaleString()}</td>
										<td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{formatDuration(s.entryTime, s.closeTime)}</td>
										<td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>{s.symbol}</td>
										<td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', textTransform: 'capitalize' }}>{s.profile}</td>
										<td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'right', color: ((Number(s.realizedPnl)||0) < 0 ? 'var(--danger)' : (Number(s.realizedPnl)||0) > 0 ? 'var(--ok)' : undefined) }}>{(Number(s.realizedPnl)||0).toFixed(4)}</td>
										<td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'right', color: ((displayPct(s)) < 0 ? 'var(--danger)' : (displayPct(s)) > 0 ? 'var(--ok)' : undefined) }}>{displayPct(s).toFixed(2)}%</td>
										<td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'right' }}>{displayInvested(s).toFixed(2)}</td>
										<td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'right' }}>{Number(s.avgBuyPrice||0).toFixed(6)}</td>
										<td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'right' }}>{Number(s.avgSellPrice||0).toFixed(6)}</td>
										<td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'right' }}>{Number(s.buyQty).toFixed(6)}/{Number(s.sellQty).toFixed(6)}</td>
										<td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'right' }}>{s.tradesCount}</td>
										<td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', fontFamily: 'monospace', fontSize: 12 }}>{String(s.entryClientOrderId||'').slice(0, 28)}</td>
									</tr>
								))}
								{pageRows.length === 0 && (
									<tr>
										<td colSpan={8} style={{ padding: '10px 8px', textAlign: 'center', opacity: .8 }}>No sessions</td>
									</tr>
								)}
							</tbody>
							<tfoot>
								<tr>
									<td colSpan={5} style={{ padding: '6px 8px', borderTop: '1px solid var(--border)', fontWeight: 600 }}>Total</td>
									<td style={{ padding: '6px 8px', borderTop: '1px solid var(--border)', textAlign: 'right', fontWeight: 600, color: (totals.pnl < 0 ? 'var(--danger)' : totals.pnl > 0 ? 'var(--ok)' : undefined) }}>{totals.pnl.toFixed(4)}</td>
									<td style={{ padding: '6px 8px', borderTop: '1px solid var(--border)', textAlign: 'right', fontWeight: 600, color: (totals.pct < 0 ? 'var(--danger)' : totals.pct > 0 ? 'var(--ok)' : undefined) }}>{totals.pct.toFixed(2)}%</td>
									<td style={{ padding: '6px 8px', borderTop: '1px solid var(--border)', textAlign: 'right', fontWeight: 600 }}>{totals.invested.toFixed(2)}</td>
									<td colSpan={5} style={{ padding: '6px 8px', borderTop: '1px solid var(--border)' }} />
								</tr>
							</tfoot>
						</table>
					</div>
					<div className="row space-between" style={{ marginTop: 8 }}>
						<div style={{ fontSize: 12, opacity: .85 }}>Page {page} / {pageCount} — {PAGE_SIZE} rows per page</div>
						<div className="row gap-8">
							<button className="btn" onClick={() => setPage(1)} disabled={page <= 1}>« First</button>
							<button className="btn" onClick={prevPage} disabled={page <= 1}>‹ Prev</button>
							<button className="btn" onClick={nextPage} disabled={page >= pageCount}>Next ›</button>
							<button className="btn" onClick={() => setPage(pageCount)} disabled={page >= pageCount}>Last »</button>
						</div>
						<div className="row gap-8" style={{ marginTop: 6 }}>
							<label style={{ fontSize: 12, opacity: .85 }}>
								<span style={{ marginRight: 6 }}>Invested leverage:</span>
								<input type="number" min={1} max={125} step={1} value={levForInvested} onChange={e=>{ const v = Math.max(1, Math.min(125, Math.floor(Number(e.target.value)||15))); setLevForInvested(v); try{ localStorage.setItem('pnl_invested_lev', String(v)) } catch {} }} style={{ width: 70 }} />
							</label>
							<span style={{ fontSize: 12, opacity: .65 }}>(použito jen když server nepošle přesné invested)</span>
						</div>
					</div>
				</div>
			)}
			<div style={{ fontSize: 12, color: '#666' }}>Bez grafů, generuje čistý Markdown s přehledem P&L.</div>
		</div>
	)
}
