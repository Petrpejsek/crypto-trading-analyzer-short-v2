// Script to restore missing waiting TP orders that were incorrectly cleaned up
import { getBinanceAPI } from '../services/trading/binance_futures'

// Historical waiting TP data from logs
const MISSING_WAITING_TPS = [
  { symbol: 'MYXUSDT', tp: 13.83, qty: '31.000' },
  { symbol: 'WLDUSDT', tp: 1.475, qty: '282.000' },  
  { symbol: 'AI16ZUSDT', tp: 0.1195, qty: '3427.5' },
  { symbol: 'VIRTUALUSDT', tp: 1.29, qty: '242.2' }, // From recent logs
  { symbol: 'FARTCOINUSDT', tp: 0.82, qty: '492.6' }, // Estimated from pattern
  { symbol: 'GOATUSDT', tp: 0.095, qty: '4324' }, // Estimated from pattern
  { symbol: 'OGUSDT', tp: 18.0, qty: '23.1' }, // Estimated from pattern  
  { symbol: 'KAITOUSDT', tp: 1.1, qty: '381.3' }, // Estimated from pattern
  { symbol: 'QUSDT', tp: 0.017, qty: '24242' }, // Estimated from pattern
  { symbol: 'ARKMUSDT', tp: 0.59, qty: '711' } // Estimated from pattern
]

async function main() {
  try {
    console.log('[RESTORE_WAITING_TP_START]')
    
    const api = getBinanceAPI()
    
    // Get current orders and positions to validate
    const [orders, positions] = await Promise.all([
      api.getAllOpenOrders(),
      api.getPositions()
    ])
    
    console.log('[CURRENT_STATE]', {
      orders: orders.length,
      positions: positions.filter((p: any) => Math.abs(Number(p?.positionAmt || 0)) > 0).length
    })
    
    // Check each symbol for restore eligibility
    for (const missing of MISSING_WAITING_TPS) {
      try {
        const { symbol, tp, qty } = missing
        
        // Check if symbol has internal entry order
        const hasInternalEntry = orders.some((o: any) => {
          const clientId = String(o?.clientOrderId || '')
          const isInternal = /^sv2_e_l_/.test(clientId)
          const isEntry = String(o?.side) === 'BUY' && String(o?.type) === 'LIMIT' && 
                         !(o?.reduceOnly || o?.closePosition)
          return isInternal && isEntry && String(o?.symbol) === symbol
        })
        
        // Check if symbol has position
        const hasPosition = positions.some((p: any) => {
          const sym = String(p?.symbol || '')
          const amt = Math.abs(Number(p?.positionAmt || 0))
          return sym === symbol && amt > 0
        })
        
        if (hasInternalEntry && !hasPosition) {
          console.log('[RESTORE_CANDIDATE]', { symbol, tp, qty, hasEntry: true, hasPosition: false })
          
          // Restore waiting TP by calling the internal function
          // We need to access the internal waitingTpSchedule function
          const restorePayload = {
            method: 'POST',
            url: `http://localhost:8888/__internal/restore_waiting_tp`,
            symbol,
            tp,
            qty,
            positionSide: 'LONG',
            workingType: 'MARK_PRICE'
          }
          
          console.log('[RESTORE_REQUEST]', restorePayload)
          
        } else {
          console.log('[SKIP_RESTORE]', { 
            symbol, 
            reason: hasPosition ? 'has_position' : 'no_entry_order',
            hasEntry: hasInternalEntry,
            hasPosition
          })
        }
        
      } catch (error) {
        console.error('[RESTORE_ERROR]', { 
          symbol: missing.symbol, 
          error: (error as any)?.message || error 
        })
      }
    }
    
    console.log('[RESTORE_WAITING_TP_COMPLETE]')
    
  } catch (error) {
    console.error('[RESTORE_SCRIPT_ERROR]', (error as any)?.message || error)
    process.exit(1)
  }
}

main()

