#!/usr/bin/env tsx
/**
 * Test script pro losers_overheat_relief archetype
 * 
 * Testuje novou logiku výběru kandidátů:
 * - Coiny s ret_24h < 0 (24h losers)
 * - Ale s přehřátým relief rally (RSI M15 ≥ 70, RSI H1 ≥ 60)
 * - Price > VWAP + 0.5×ATR
 * - EMA20.M15 výrazně nad EMA50.M15
 * - Scoring podle vah: RSI 25%, Distance 25%, Liquidity 20%, Momentum 20%, Orderbook 10%
 */

import { selectCandidates } from '../services/signals/candidate_selector'
import type { FeaturesSnapshot, CoinRow } from '../types/features'
import type { MarketRawSnapshot } from '../types/market_raw'

// Mock data pro testování
function createMockCoin(overrides: Partial<CoinRow> = {}): CoinRow {
  return {
    symbol: 'TESTUSDT',
    price: 100,
    volume24h_usd: 5_000_000,
    atr_pct_H1: 3.5,
    market_type: 'perp',
    ret_24h_pct: -5.0,  // 24h loser
    ret_60m_pct: 2.5,   // 1h positive (relief rally)
    ret_15m_pct: 0.8,   // 15m slowing down
    ret_5m_pct: 0.2,    // 5m slowing down more
    RSI_M15: 75,        // Overbought M15
    RSI_H1: 62,         // Overbought H1
    vwap_m15: 95,       // VWAP below price
    atr_m15: 2.0,
    ema20_M15: 98,      // EMA20 above EMA50
    ema50_M15: 96,
    ema20_H1: 97,       // EMA20 ≈ EMA50 (exhaustion)
    ema50_H1: 96.5,
    spread_bps: 50,
    ema_order_H1: '20>50>200',
    h1_range_pos_pct: 70,
    funding_z: 0.5,
    oi_change_pct_h1: 1.2,
    ...overrides
  } as CoinRow
}

console.log('🧪 Testing losers_overheat_relief archetype selection\n')

// Test 1: Perfect candidate
console.log('📊 Test 1: Perfect losers_overheat_relief candidate')
const perfectCandidate = createMockCoin({
  symbol: 'PERFECTUSDT',
  ret_24h_pct: -8.0,
  ret_60m_pct: 3.5,
  ret_15m_pct: 1.2,
  ret_5m_pct: 0.4,
  RSI_M15: 78,
  RSI_H1: 65,
  price: 100,
  vwap_m15: 96,
  atr_m15: 2.0,
  ema20_M15: 99,
  ema50_M15: 97,
  ema20_H1: 98,
  ema50_H1: 97.5,
  volume24h_usd: 10_000_000
})

console.log(`  Symbol: ${perfectCandidate.symbol}`)
console.log(`  ret_24h: ${perfectCandidate.ret_24h_pct}%`)
console.log(`  RSI M15: ${perfectCandidate.RSI_M15}, H1: ${perfectCandidate.RSI_H1}`)
console.log(`  VWAP distance: ${((perfectCandidate.price! - perfectCandidate.vwap_m15!) / perfectCandidate.atr_m15!).toFixed(2)}×ATR`)
console.log(`  EMA20/EMA50 spread M15: ${((perfectCandidate.ema20_M15! - perfectCandidate.ema50_M15!) / perfectCandidate.ema50_M15! * 100).toFixed(2)}%`)
console.log(`  Volume: $${(perfectCandidate.volume24h_usd! / 1_000_000).toFixed(1)}M`)
console.log(`  ✅ Should PASS all filters\n`)

// Test 2: Fail - RSI M15 too low
console.log('📊 Test 2: Fail - RSI M15 < 70')
const failRSI = createMockCoin({
  symbol: 'FAILRSIUSDT',
  RSI_M15: 65,  // Too low
  RSI_H1: 62
})
console.log(`  Symbol: ${failRSI.symbol}`)
console.log(`  RSI M15: ${failRSI.RSI_M15} (< 70)`)
console.log(`  ❌ Should FAIL: RSI M15 too low\n`)

// Test 3: Fail - Not above VWAP + 0.5×ATR
console.log('📊 Test 3: Fail - Not above VWAP + 0.5×ATR')
const failVWAP = createMockCoin({
  symbol: 'FAILVWAPUSDT',
  price: 100,
  vwap_m15: 99.5,  // Too close to price
  atr_m15: 2.0
})
const vwapDist = (failVWAP.price! - failVWAP.vwap_m15!) / failVWAP.atr_m15!
console.log(`  Symbol: ${failVWAP.symbol}`)
console.log(`  VWAP distance: ${vwapDist.toFixed(2)}×ATR (< 0.5)`)
console.log(`  ❌ Should FAIL: Not above VWAP + 0.5×ATR\n`)

// Test 4: Fail - Low liquidity
console.log('📊 Test 4: Fail - Low liquidity')
const failLiquidity = createMockCoin({
  symbol: 'FAILLIQUSDT',
  volume24h_usd: 500_000  // < 1M USD
})
console.log(`  Symbol: ${failLiquidity.symbol}`)
console.log(`  Volume: $${(failLiquidity.volume24h_usd! / 1_000).toFixed(0)}K (< 1M)`)
console.log(`  ❌ Should FAIL: Low liquidity\n`)

// Test 5: Fail - Negative 1h return (no relief rally)
console.log('📊 Test 5: Fail - Negative 1h return')
const failMomentum = createMockCoin({
  symbol: 'FAILMOMOUSDT',
  ret_60m_pct: -1.5  // Negative 1h
})
console.log(`  Symbol: ${failMomentum.symbol}`)
console.log(`  ret_1h: ${failMomentum.ret_60m_pct}% (< 0)`)
console.log(`  ❌ Should FAIL: No positive relief rally\n`)

// Test 6: Fail - Wide spread
console.log('📊 Test 6: Fail - Wide spread')
const failSpread = createMockCoin({
  symbol: 'FAILSPREADUSDT',
  spread_bps: 500  // > 400 bps
})
console.log(`  Symbol: ${failSpread.symbol}`)
console.log(`  Spread: ${failSpread.spread_bps} bps (> 400)`)
console.log(`  ❌ Should FAIL: Spread too wide\n`)

// Test with real selectCandidates function
console.log('🔧 Running selectCandidates with mock data...\n')

const mockFeatures: FeaturesSnapshot = {
  universe: [
    perfectCandidate,
    failRSI,
    failVWAP,
    failLiquidity,
    failMomentum,
    failSpread
  ],
  ts: Date.now()
}

const mockSnapshot: MarketRawSnapshot = {
  ts: Date.now(),
  coins: []
}

const results = selectCandidates(mockFeatures, mockSnapshot, {
  decisionFlag: 'OK',
  allowWhenNoTrade: false,
  limit: 100,
  cfg: {
    atr_pct_min: 1.0,
    atr_pct_max: 12.0,
    min_liquidity_usdt: 1_000_000
  },
  universeStrategy: 'losers'
})

console.log('📈 Results:')
console.log(`  Total candidates: ${results.length}`)
console.log(`  Losers overheat relief: ${results.filter(c => c.archetype === 'losers_overheat_relief').length}\n`)

if (results.length > 0) {
  console.log('🎯 Selected candidates:')
  results.forEach(c => {
    console.log(`  ${c.symbol}: score=${c.score.toFixed(4)}, archetype=${c.archetype}, basket=${c.basket}`)
    console.log(`    ${c.reason}`)
  })
} else {
  console.log('⚠️  No candidates selected (losers_overheat_relief might be disabled in config)')
  console.log('   Enable it by setting "enabled": true in config/candidates.json')
}

console.log('\n✅ Test complete!')

