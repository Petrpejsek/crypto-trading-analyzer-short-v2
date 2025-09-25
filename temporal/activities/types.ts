export interface Activities {
  // Binance
  binancePlaceOrder(params: any): Promise<any>
  binanceCancelOrder(symbol: string, orderId: number | string): Promise<any>
  binanceCancelAllOrders(symbol: string): Promise<any>
  binanceGetPositions(): Promise<any[]>
  binanceGetOpenOrders(symbol?: string): Promise<any[]>
  binanceGetAllOpenOrders(): Promise<any[]>
  binanceSetLeverage(symbol: string, leverage: number): Promise<any>
  binanceGetMarkPrice(symbol: string): Promise<number>
  binanceGetLastPrice(symbol: string): Promise<number>
  binanceGetSymbolInfo(symbol: string): Promise<any>
  binanceCalculateQuantity(symbol: string, usdAmount: number, price: number): Promise<string>

  // OpenAI
  openaiRunEntryStrategy(input: any): Promise<any>
  openaiRunEntryRisk(input: any): Promise<any>
  openaiRunStrategyUpdate(input: any): Promise<any>

  // Data
  fetchMarketRawSnapshot(opts?: any): Promise<any>

  // Strategy Updater
  suProcessDueUpdates(): Promise<void>
}



