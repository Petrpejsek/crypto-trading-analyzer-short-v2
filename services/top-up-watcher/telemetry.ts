import type { RegistryEntry, WatcherDecision, WatcherSnapshot } from './types'

export function logWatcherTick(entry: RegistryEntry, decision: WatcherDecision, snapshot: WatcherSnapshot): void {
  try {
    const ttlLeftMin = (() => {
      const deadline = Date.parse(entry.deadlineAt)
      if (!Number.isFinite(deadline)) return null
      return Math.max(0, (deadline - Date.now()) / 60000)
    })()

    const payload = {
      symbol: entry.symbol,
      action: decision.action,
      reason_code: decision.reason_code,
      snapshot_ts: snapshot.timestamp,
      spread_bps: snapshot.market.spread_bps,
      estSlip: snapshot.market.estSlippageBps,
      ema_m5: snapshot.indicators.ema_m5,
      ema_m15: snapshot.indicators.ema_m15,
      vwap_m15: snapshot.indicators.vwap_m15,
      obi5: snapshot.orderbook?.obi5 ?? null,
      obi20: snapshot.orderbook?.obi20 ?? null,
      walls: {
        bid: snapshot.orderbook?.nearestBidWallDistBps ?? null,
        ask: snapshot.orderbook?.nearestAskWallDistBps ?? null,
        consumeBid: snapshot.orderbook?.consumeBidWallPct3s ?? null,
        consumeAsk: snapshot.orderbook?.consumeAskWallPct3s ?? null
      },
      deltaATR: (() => {
        const mark = snapshot.indicators.markPrice
        const atr = snapshot.indicators.atr_m15
        if (mark == null || atr == null) return null
        return (mark - entry.pilot.entry_price) / atr
      })(),
      ttlMinLeft: ttlLeftMin != null ? Number(ttlLeftMin.toFixed(2)) : null
    }
    console.info('[TOPUP_WATCHER]', payload)
  } catch (err) {
    try { console.error('[TOPUP_WATCHER_LOG_ERR]', (err as any)?.message || err) } catch {}
  }
}




