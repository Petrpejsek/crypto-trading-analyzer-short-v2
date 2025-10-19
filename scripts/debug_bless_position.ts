import 'dotenv/config'
import { getBinanceAPI } from '../services/trading/binance_futures'

async function debug() {
  const api = getBinanceAPI()
  const positions = await api.getPositions()
  const activePositions = positions.filter((p: any) => Math.abs(Number(p?.positionAmt || 0)) > 0)
  
  console.log('Active positions from REST API:')
  activePositions.forEach((p: any) => {
    console.log(`  ${p.symbol}: positionAmt=${p.positionAmt} (type: ${typeof p.positionAmt})`)
  })
  
  const bless = positions.find((p: any) => p?.symbol === 'BLESSUSDT')
  if (bless) {
    console.log('\nBLESSUSDT raw data:')
    console.log('  positionAmt:', bless.positionAmt, '(type:', typeof bless.positionAmt, ')')
    console.log('  parsed as Number:', Number(bless.positionAmt))
    console.log('  is < 0?', Number(bless.positionAmt) < 0)
    console.log('  is SHORT?', Number(bless.positionAmt) < 0 ? 'YES' : 'NO')
  } else {
    console.log('\nBLESSUSDT NOT FOUND in positions array!')
  }
}

debug().catch(console.error)
