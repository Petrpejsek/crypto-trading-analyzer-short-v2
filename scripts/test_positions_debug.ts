#!/usr/bin/env tsx
/**
 * DEBUG: Test REST API positions response
 * Zjistí, co přesně vrací Binance API pro BLESSUSDT
 */

import { getBinanceAPI } from '../services/trading/binance_futures'
import { binanceCache } from '../server/lib/apiCache'

async function main() {
  try {
    console.log('=== POSITIONS DEBUG TEST ===\n')
    
    const api = getBinanceAPI()
    
    // 1. Clear cache
    const cleared = binanceCache.invalidatePattern('/fapi/v2/positionRisk')
    console.log('[1] Cache cleared:', cleared, 'entries\n')
    
    // 2. Get positions (fresh from REST API)
    console.log('[2] Calling api.getPositions()...')
    const positions = await api.getPositions()
    console.log('    Total positions received:', Array.isArray(positions) ? positions.length : 'NOT ARRAY')
    
    if (!Array.isArray(positions)) {
      console.error('    ERROR: positions is not an array!')
      console.error('    Type:', typeof positions)
      console.error('    Value:', positions)
      return
    }
    
    // 3. Find BLESSUSDT
    console.log('\n[3] Looking for BLESSUSDT...')
    const bless = positions.find(p => p?.symbol === 'BLESSUSDT')
    
    if (!bless) {
      console.warn('    ⚠️  BLESSUSDT not found in positions!')
      console.log('    Available symbols with positions:')
      positions
        .filter(p => Math.abs(Number(p?.positionAmt || 0)) > 0)
        .forEach(p => {
          console.log(`      - ${p.symbol}: ${p.positionAmt}`)
        })
      return
    }
    
    // 4. Debug BLESSUSDT data
    console.log('\n[4] BLESSUSDT Position Data:')
    console.log(JSON.stringify(bless, null, 2))
    
    console.log('\n[5] BLESSUSDT Key Fields:')
    console.log('    symbol:', bless.symbol)
    console.log('    positionAmt:', bless.positionAmt, `(type: ${typeof bless.positionAmt})`)
    console.log('    positionAmt as Number:', Number(bless.positionAmt))
    console.log('    entryPrice:', bless.entryPrice, `(type: ${typeof bless.entryPrice})`)
    console.log('    markPrice:', bless.markPrice, `(type: ${typeof bless.markPrice})`)
    console.log('    unrealizedProfit:', bless.unrealizedProfit)
    console.log('    positionSide:', bless.positionSide)
    
    // 5. Test filter vs find
    console.log('\n[6] Testing filter() vs find():')
    const filtered = positions.filter(p => String(p?.symbol) === 'BLESSUSDT')
    console.log('    filter() result length:', filtered.length)
    if (filtered.length > 0) {
      console.log('    filter()[0].positionAmt:', filtered[0].positionAmt)
    }
    
    const found = positions.find(p => String(p?.symbol) === 'BLESSUSDT')
    console.log('    find() result:', found ? 'FOUND' : 'NOT FOUND')
    if (found) {
      console.log('    find().positionAmt:', found.positionAmt)
    }
    
    // 6. Compare references
    if (filtered.length > 0 && found) {
      console.log('    Are they same object?', filtered[0] === found)
      console.log('    filter()[0].positionAmt === find().positionAmt?', filtered[0].positionAmt === found.positionAmt)
    }
    
    // 7. Test with active positions only
    console.log('\n[7] All active positions (|positionAmt| > 0):')
    positions
      .filter(p => Math.abs(Number(p?.positionAmt || 0)) > 0)
      .forEach(p => {
        console.log(`    ${p.symbol}:`)
        console.log(`      positionAmt: ${p.positionAmt} (${typeof p.positionAmt})`)
        console.log(`      as Number: ${Number(p.positionAmt)}`)
        console.log(`      entryPrice: ${p.entryPrice}`)
      })
    
    console.log('\n✅ Test complete')
    
  } catch (err: any) {
    console.error('❌ ERROR:', err.message)
    console.error(err.stack)
  }
}

main()

