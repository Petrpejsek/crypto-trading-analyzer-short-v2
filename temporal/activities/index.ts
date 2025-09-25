import type { Activities } from './types';

export const activities: Activities = {
  // Binance
  async binancePlaceOrder(params: any) {
    const { getBinanceAPI } = await import('../../services/trading/binance_futures')
    const api = getBinanceAPI() as any
    return api.placeOrder(params)
  },
  async binanceCancelOrder(symbol: string, orderId: number | string) {
    const { cancelOrder } = await import('../../services/trading/binance_futures')
    return cancelOrder(symbol, orderId)
  },
  async binanceCancelAllOrders(symbol: string) {
    const { getBinanceAPI } = await import('../../services/trading/binance_futures')
    const api = getBinanceAPI() as any
    return api.cancelAllOrders(symbol)
  },
  async binanceGetPositions() {
    const { getBinanceAPI } = await import('../../services/trading/binance_futures')
    const api = getBinanceAPI() as any
    return api.getPositions()
  },
  async binanceGetOpenOrders(symbol?: string) {
    const { getBinanceAPI } = await import('../../services/trading/binance_futures')
    const api = getBinanceAPI() as any
    return symbol ? api.getOpenOrders(symbol) : api.getAllOpenOrders()
  },
  async binanceGetAllOpenOrders() {
    const { fetchAllOpenOrders } = await import('../../services/trading/binance_futures')
    return fetchAllOpenOrders()
  },
  async binanceSetLeverage(symbol: string, leverage: number) {
    const { getBinanceAPI } = await import('../../services/trading/binance_futures')
    const api = getBinanceAPI() as any
    return api.setLeverage(symbol, leverage)
  },
  async binanceGetMarkPrice(symbol: string) {
    const { fetchMarkPrice } = await import('../../services/trading/binance_futures')
    return fetchMarkPrice(symbol)
  },
  async binanceGetLastPrice(symbol: string) {
    const { fetchLastTradePrice } = await import('../../services/trading/binance_futures')
    return fetchLastTradePrice(symbol)
  },
  async binanceGetSymbolInfo(symbol: string) {
    const { getBinanceAPI } = await import('../../services/trading/binance_futures')
    const api = getBinanceAPI() as any
    return api.getSymbolInfo(symbol)
  },
  async binanceCalculateQuantity(symbol: string, usdAmount: number, price: number) {
    const { getBinanceAPI } = await import('../../services/trading/binance_futures')
    const api = getBinanceAPI() as any
    return api.calculateQuantity(symbol, usdAmount, price)
  },

  // OpenAI
  async openaiRunEntryStrategy(input: any) {
    const { runEntryStrategy } = await import('../../services/decider/entry_strategy_gpt')
    return runEntryStrategy(input)
  },
  async openaiRunEntryRisk(input: any) {
    const { runEntryRisk } = await import('../../services/decider/entry_risk_gpt')
    return runEntryRisk(input)
  },
  async openaiRunStrategyUpdate(input: any) {
    const { runStrategyUpdate } = await import('../../services/strategy-updater/strategy_updater_gpt')
    return runStrategyUpdate(input)
  },

  // Data
  async fetchMarketRawSnapshot(opts?: any) {
    // Preferovat server/fetcher/binance pro velké snapshoty
    const { buildMarketRawSnapshot } = await import('../../server/fetcher/binance')
    return buildMarketRawSnapshot(opts)
  },

  // Strategy Updater
  async suProcessDueUpdates() {
    const { processDueStrategyUpdates } = await import('../../services/strategy-updater/trigger')
    await processDueStrategyUpdates()
  }
}

export default activities;


