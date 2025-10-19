// Direct restore of missing waiting TP orders
import { getBinanceAPI, waitingTpSchedule } from '../services/trading/binance_futures'

// Exact historical data from logs + current estimations
const RESTORE_DATA = [
  // Exact from logs (these were scheduled but cleaned up)
  { symbol: 'MYXUSDT', tp: 13.83, qty: '31.000' },
  { symbol: 'WLDUSDT', tp: 1.475, qty: '282.000' },  
  { symbol: 'AI16ZUSDT', tp: 0.1195, qty: '3427.5' },
  { symbol: 'VIRTUALUSDT', tp: 1.29, qty: '242.2' }, 
  
  // Estimates for others (based on ~5% above entry prices from logs)  
  { symbol: 'FARTCOINUSDT', tp: 0.85, qty: '492.6' },
  { symbol: 'GOATUSDT', tp: 0.097, qty: '4324' },
  { symbol: 'OGUSDT', tp: 18.1, qty: '23.1' },  
  { symbol: 'KAITOUSDT', tp: 1.1, qty: '381.3' },
  { symbol: 'QUSDT', tp: 0.0173, qty: '24242' },
  { symbol: 'ARKMUSDT', tp: 0.59, qty: '711' }
]

async function main() {
  try {
    console.log('[RESTORE_WAITING_TP_SIMPLE_START]')
    
    const api = getBinanceAPI()
    const orders = await api.getAllOpenOrders()
    
    let restoredCount = 0
    
    for (const data of RESTORE_DATA) {
      try {
        const { symbol, tp, qty } = data
        
        // Check if symbol has internal entry order 
        const entryOrder = orders.find((o: any) => {
          const clientId = String(o?.clientOrderId || '')
          const isInternal = /^sv2_e_l_/.test(clientId)
          const isEntry = String(o?.side) === 'SELL' && String(o?.type) === 'LIMIT'
          return isInternal && isEntry && String(o?.symbol) === symbol
        })
        
        if (entryOrder) {
          // Restore waiting TP using the exported function
          waitingTpSchedule(symbol, tp, qty, 'SHORT', 'MARK_PRICE')
          restoredCount++
          
          console.log('[RESTORED_WAITING_TP]', { 
            symbol, 
            tp, 
            qty,
            entryOrderId: entryOrder?.orderId
          })
        } else {
          console.log('[SKIP_NO_ENTRY]', { symbol })
        }
        
      } catch (error) {
        console.error('[RESTORE_SYMBOL_ERROR]', { 
          symbol: data.symbol, 
          error: (error as any)?.message || error 
        })
      }
    }
    
    console.log('[RESTORE_COMPLETE]', { restoredCount })
    
  } catch (error) {
    console.error('[RESTORE_ERROR]', (error as any)?.message || error)
    process.exit(1)
  }
}

main()

