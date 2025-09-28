export const SHORT_SIMPLE = {
  gates: {
    minAgeDays: 14,
    minVolume24hUsd: 10_000_000,
    maxSpreadBps: 12,
    minLiq1pctUsd: 150_000,
    // data hygiene
    requirePriceTs: true,
    requireAtr15: true,
    requireVwap: true
  },
  // score without volume weighting
  weights: { zOverVWAP: 0.6, rsi15Norm: 0.4 },
  topN: 50
}


