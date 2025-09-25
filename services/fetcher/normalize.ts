export function toNumber(value: any): number | undefined {
  if (value === null || value === undefined) return undefined
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

export function toUtcIso(msOrSec: number | string): string | undefined {
  const n = toNumber(msOrSec)
  if (n === undefined) return undefined
  const ms = n > 1e12 ? n : n * 1000
  return new Date(ms).toISOString()
}

export function calcSpreadBps(bestBid?: number, bestAsk?: number): number | undefined {
  if (!bestBid || !bestAsk) return undefined
  if (bestBid <= 0 || bestAsk <= 0) return undefined
  const mid = (bestBid + bestAsk) / 2
  if (mid <= 0) return undefined
  return ((bestAsk - bestBid) / mid) * 10000
}

export function calcDepthWithin1PctUSD(
  bids: Array<[number, number]>,
  asks: Array<[number, number]>,
  markPrice: number,
  notionalPerStepUSD: number
): { bids: number; asks: number } | undefined {
  if (!Array.isArray(bids) || !Array.isArray(asks) || !markPrice || markPrice <= 0) return undefined
  const lower = markPrice * 0.99
  const upper = markPrice * 1.01

  let bidUsd = 0
  for (const [price, qty] of bids) {
    if (price < lower) break
    bidUsd += price * qty
  }

  let askUsd = 0
  for (const [price, qty] of asks) {
    if (price > upper) break
    askUsd += price * qty
  }

  if (!Number.isFinite(bidUsd) || !Number.isFinite(askUsd)) return undefined
  return { bids: bidUsd, asks: askUsd }
}

export function clampSnapshotSize(json: string, maxBytes: number): boolean {
  const bytes = new TextEncoder().encode(json).length
  return bytes <= maxBytes
}

