import React, { useEffect, useMemo, useRef, useState } from 'react'

// Minimal fetch helper with timeout and safe JSON parse
async function fetchJson(input: string, init?: RequestInit & { timeoutMs?: number }): Promise<{ ok: boolean; status: number; json: any | null }> {
	const ac = new AbortController()
	const t = window.setTimeout(() => ac.abort(new DOMException('timeout', 'TimeoutError')), init?.timeoutMs ?? 8000)
	try {
		const res = await fetch(input, { ...init, signal: ac.signal })
		let json: any = null
		try { json = await res.json() } catch {}
		return { ok: res.ok, status: res.status, json }
	} catch (e:any) {
		return { ok: false, status: 0, json: { error: e?.message || 'network' } }
	} finally {
		window.clearTimeout(t)
	}
}

const containerStyle: React.CSSProperties = {
	position: 'fixed',
	left: 0,
	right: 0,
	bottom: 0,
	zIndex: 9999,
	background: '#0b0b0b',
	borderTop: '1px solid #333',
	fontSize: 12,
	color: '#ddd',
	boxShadow: '0 -8px 18px rgba(0,0,0,0.55)'
}

const headerStyle: React.CSSProperties = {
	display: 'flex',
	justifyContent: 'space-between',
	alignItems: 'center',
	gap: 8,
	padding: '6px 10px'
}

const bodyStyle: React.CSSProperties = {
	padding: '6px 10px',
	maxHeight: 220,
	overflowY: 'auto',
	borderTop: '1px solid #222',
	background: '#0e0e0e'
}

export const OrderDebugFooter: React.FC = () => {
	const [open, setOpen] = useState<boolean>(() => {
		try { return localStorage.getItem('order_debug_open') === '1' } catch { return false }
	})
	useEffect(() => { try { localStorage.setItem('order_debug_open', open ? '1' : '0') } catch {} }, [open])

	const [tab, setTab] = useState<'audit'|'last'|'limits'>('audit')
	const [audit, setAudit] = useState<any[]>([])
	const [lastPlace, setLastPlace] = useState<any | null>(null)
	const [limits, setLimits] = useState<any | null>(null)
	const [err, setErr] = useState<string | null>(null)
	const timerRef = useRef<number | null>(null)

	const load = async () => {
		try {
			setErr(null)
			const [a, l, lim] = await Promise.all([
				fetchJson('/api/debug/cancel_audit?last=300', { timeoutMs: 7000 }),
				fetchJson('/api/debug/last_place_orders', { timeoutMs: 7000 }),
				fetchJson('/api/limits', { timeoutMs: 5000 })
			])
			if (a.ok) setAudit(Array.isArray(a.json?.events) ? a.json.events : [])
			if (l.ok) setLastPlace(l.json || null)
			if (lim.ok) setLimits(lim.json?.limits || null)
		} catch (e:any) {
			setErr(String(e?.message || 'debug_fetch_failed'))
		}
	}

	useEffect(() => {
		load()
		timerRef.current = window.setInterval(load, 5000)
		return () => { if (timerRef.current) window.clearInterval(timerRef.current) }
	}, [])

	const auditRows = useMemo(() => {
		const list = (Array.isArray(audit) ? audit : []).slice(-120)
		return list.reverse()
	}, [audit])

	const lastPlaceText = useMemo(() => {
		try {
			const obj: any = lastPlace || {}
			const orders = Array.isArray(obj?.result?.orders)
				? obj.result.orders.map((o:any) => ({
					symbol: o?.symbol,
					entryId: o?.entry_order?.orderId ?? null,
					slId: o?.sl_order?.orderId ?? null,
					tpId: o?.tp_order?.orderId ?? null,
					entryPx: Number(o?.entry_order?.price ?? null) || null,
					slPx: Number(o?.sl_order?.stopPrice ?? o?.sl_order?.price ?? null) || null,
					tpPx: Number(o?.tp_order?.stopPrice ?? o?.tp_order?.price ?? null) || null
				}) )
				: []
			return JSON.stringify({ success: obj?.result?.success ?? obj?.success ?? null, orders }, null, 2)
		} catch {
			return 'n/a'
		}
	}, [lastPlace])

	// Reserve space under content so footer never overlaps: small when closed, larger when open
	const reservedHeight = open ? 260 : 36

	return (
		<>
			<div style={{ height: reservedHeight }} />
			<div style={containerStyle}>
				<div style={headerStyle}>
					<div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
						<button className="btn" onClick={() => setOpen(v => !v)} style={{ fontSize: 12, padding: '2px 8px' }}>{open ? 'Hide' : 'Show'} Order Debug</button>
						<div style={{ display: open ? 'flex' : 'none', alignItems: 'center', gap: 8 }}>
							<button className={tab==='audit'?'btn':'btn ghost'} onClick={()=>setTab('audit')} style={{ fontSize: 12, padding: '2px 8px' }}>Audit</button>
							<button className={tab==='last'?'btn':'btn ghost'} onClick={()=>setTab('last')} style={{ fontSize: 12, padding: '2px 8px' }}>Last place</button>
							<button className={tab==='limits'?'btn':'btn ghost'} onClick={()=>setTab('limits')} style={{ fontSize: 12, padding: '2px 8px' }}>Limits</button>
						</div>
					</div>
					<div style={{ opacity: .8 }}>{err ? <span style={{ color: 'crimson' }}>Error: {err}</span> : <span>Auto-refresh 5s</span>}</div>
				</div>
				{open && (
					<div style={bodyStyle}>
						{tab === 'audit' ? (
							<table style={{ width: '100%', borderCollapse: 'collapse' }}>
								<thead>
									<tr>
										<th style={{ textAlign: 'left' }}>Time</th>
										<th style={{ textAlign: 'left' }}>Type</th>
										<th style={{ textAlign: 'left' }}>Source</th>
										<th style={{ textAlign: 'left' }}>Symbol</th>
										<th style={{ textAlign: 'left' }}>OrderId</th>
										<th style={{ textAlign: 'left' }}>Reason</th>
									</tr>
								</thead>
								<tbody>
									{auditRows.length === 0 ? (
										<tr><td colSpan={6} style={{ opacity: .7 }}>No audit events yet</td></tr>
									) : auditRows.map((e:any, i:number) => (
										<tr key={i}>
											<td style={{ whiteSpace: 'nowrap' }}>{e?.ts || '-'}</td>
											<td>{e?.type || '-'}</td>
											<td>{e?.source || '-'}</td>
											<td>{e?.symbol || '-'}</td>
											<td>{e?.orderId ?? '-'}</td>
											<td>{e?.reason || '-'}</td>
										</tr>
									))}
								</tbody>
							</table>
						) : tab === 'last' ? (
							<div>
								<div style={{ marginBottom: 6, opacity: .85 }}>Last place_orders snapshot</div>
								<pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11, lineHeight: 1.25, background: 'transparent', color: '#ccc' }}>
									{lastPlaceText}
								</pre>
							</div>
						) : (
							<div>
								<div style={{ marginBottom: 6, opacity: .85 }}>Binance API Limits snapshot</div>
								<pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11, lineHeight: 1.25, background: 'transparent', color: '#ccc' }}>
									{(() => { try { return JSON.stringify(limits || {}, null, 2) } catch { return 'n/a' } })()}
								</pre>
							</div>
						)}
					</div>
				)}
			</div>
		</>
	)
}

export default OrderDebugFooter
