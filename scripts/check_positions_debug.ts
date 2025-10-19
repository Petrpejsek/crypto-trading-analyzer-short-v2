/**
 * Debug script - zkontrolovat proč systém nevidí pozice
 */

import 'dotenv/config'
import { getBinanceAPI } from '../services/trading/binance_futures'
import { getPositionsInMemory, isUserDataReady } from '../services/exchange/binance/userDataWs'

async function debugPositions() {
  console.log('\n=== POSITIONS DEBUG ===\n')
  
  try {
    // 1. Check WebSocket readiness
    const wsReadyPositions = isUserDataReady('positions')
    const wsReadyOrders = isUserDataReady('orders')
    const wsReadyAny = isUserDataReady('any')
    
    console.log('1. WebSocket Status:')
    console.log(`   - Positions ready: ${wsReadyPositions}`)
    console.log(`   - Orders ready: ${wsReadyOrders}`)
    console.log(`   - Any ready: ${wsReadyAny}`)
    
    // 2. Check in-memory positions from WS
    const memoryPositions = getPositionsInMemory()
    console.log(`\n2. In-Memory Positions (from WebSocket):`)
    console.log(`   - Count: ${memoryPositions.length}`)
    if (memoryPositions.length > 0) {
      memoryPositions.forEach(p => {
        console.log(`   - ${p.symbol}: ${p.positionAmt > 0 ? 'LONG' : 'SHORT'} ${Math.abs(p.positionAmt)} @ ${p.entryPrice}`)
      })
    } else {
      console.log('   - EMPTY (žádné pozice v paměti)')
    }
    
    // 3. Check REST API directly (bypass WS)
    console.log(`\n3. Direct REST API Call (bypass WebSocket):`)
    const api = getBinanceAPI()
    const restPositions = await api.getPositions()
    
    const filtered = (Array.isArray(restPositions) ? restPositions : [])
      .filter((p: any) => {
        const amt = Number(p?.positionAmt || 0)
        return Math.abs(amt) > 0
      })
    
    console.log(`   - Count: ${filtered.length}`)
    if (filtered.length > 0) {
      filtered.forEach((p: any) => {
        const amt = Number(p?.positionAmt || 0)
        const entry = Number(p?.entryPrice || 0)
        const mark = Number(p?.markPrice || 0)
        const pnl = Number(p?.unRealizedProfit || p?.unrealizedPnl || 0)
        console.log(`   - ${p.symbol}: ${amt > 0 ? 'LONG' : 'SHORT'} ${Math.abs(amt)} @ ${entry} (mark: ${mark}, PnL: ${pnl.toFixed(2)} USDT)`)
      })
    } else {
      console.log('   - EMPTY (žádné pozice na Binance)')
    }
    
    // 4. Diagnóza
    console.log(`\n4. Diagnóza:`)
    if (!wsReadyPositions) {
      console.log('   ❌ PROBLÉM: WebSocket není ready pro pozice')
      console.log('   → API endpoint /api/positions vrací prázdný array')
      console.log('   → Řešení: Počkat na WebSocket připojení nebo použít fallback na REST')
    } else if (memoryPositions.length === 0 && filtered.length > 0) {
      console.log('   ❌ PROBLÉM: WebSocket je ready, ale in-memory pozice jsou prázdné')
      console.log('   → REST API vidí pozice, ale WS je neuchovává')
      console.log('   → Možná chyba v rehydrate nebo ACCOUNT_UPDATE parsování')
    } else if (memoryPositions.length > 0 && filtered.length > 0) {
      console.log('   ✅ Pozice jsou OK - WebSocket i REST vidí pozice')
    } else {
      console.log('   ℹ️  Žádné otevřené pozice na účtu')
    }
    
  } catch (error: any) {
    console.error('\n❌ Debug Error:', error?.message || error)
    console.error('Stack:', error?.stack)
  }
}

debugPositions()
  .then(() => {
    console.log('\n=== DEBUG COMPLETE ===\n')
    process.exit(0)
  })
  .catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
  })

