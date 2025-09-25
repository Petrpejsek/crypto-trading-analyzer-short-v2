import { evaluateWatcherTick } from '../../top-up-watcher/logic'

describe('watcher v2 logic (smoke)', () => {
  it('RM filter -> HOLD', () => {
    const entry: any = { symbol: 'XYZUSDT', pilot: { anchor_support: 100, entry_price: 100, size: 1 }, limits: {}, deadlineAt: new Date(Date.now()+60000).toISOString() }
    const snapshot: any = { indicators: { markPrice: 100, atr_m15: 1, ema_m5: {20:1,50:1}, ema_m15: {20:1,50:1}, vwap_m15: 100 }, orderbook: null, market: { spread_bps: 40, estSlippageBps: 10 }, pumpFilterActive: false, recentCandles: { m1: [] } }
    const d = evaluateWatcherTick(entry, snapshot)
    expect(d.action).toBe('HOLD')
    expect(d.reason_code).toBe('RM_FILTER')
  })
})


