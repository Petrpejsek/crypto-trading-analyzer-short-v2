import 'dotenv/config'
import { getBinanceAPI } from '../services/trading/binance_futures'

async function testDirectAPI() {
  console.log('\n=== DIRECT BINANCE API TEST ===\n')
  
  const api = getBinanceAPI()
  
  try {
    // Clear cache
    const { binanceCache } = await import('../server/lib/apiCache')
    binanceCache.clear()
    console.log('✅ Cache cleared\n')
    
    // Get all positions
    const positions = await api.getPositions()
    console.log(`Total positions from REST API: ${positions.length}`)
    
    // Filter to only positions with size > 0
    const activePositions = positions.filter((p: any) => {
      const amt = Math.abs(Number(p?.positionAmt || 0))
      return amt > 0
    })
    
    console.log(`Active positions (size > 0): ${activePositions.length}\n`)
    
    // Look for BLESSUSDT specifically
    const bless = positions.find((p: any) => p?.symbol === 'BLESSUSDT')
    
    if (bless) {
      console.log('BLESSUSDT found in REST API:')
      console.log(JSON.stringify(bless, null, 2))
      
      console.log('\nKey fields:')
      console.log(`  positionAmt: ${bless.positionAmt} (${typeof bless.positionAmt})`)
      console.log(`  entryPrice: ${bless.entryPrice}`)
      console.log(`  markPrice: ${bless.markPrice}`)
      console.log(`  unRealizedProfit: ${bless.unRealizedProfit}`)
      console.log(`  positionSide: ${bless.positionSide}`)
    } else {
      console.log('❌ BLESSUSDT NOT found in REST API response')
      
      console.log('\nAll active positions:')
      activePositions.forEach((p: any) => {
        console.log(`  ${p.symbol}: ${p.positionAmt} @ ${p.entryPrice}`)
      })
    }
    
  } catch (error: any) {
    console.error('❌ Error:', error?.message || error)
  }
}

testDirectAPI()
