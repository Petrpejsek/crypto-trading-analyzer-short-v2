export type TemporalEnv = {
  temporalAddress: string;
  traderQueue: string;
  openaiQueue: string;
  binanceQueue: string;
};

export function loadEnv(): TemporalEnv {
  const temporalAddress = process.env.TEMPORAL_ADDRESS;
  const traderQueue = process.env.TASK_QUEUE; // orchestrator workflows
  const openaiQueue = process.env.TASK_QUEUE_OPENAI;
  const binanceQueue = process.env.TASK_QUEUE_BINANCE;
  const side = String(process.env.TRADE_SIDE || '').toUpperCase();
  if (side !== 'SHORT') {
    throw new Error('TRADE_SIDE must be SHORT in this instance');
  }

  if (!temporalAddress) {
    throw new Error('TEMPORAL_ADDRESS is required (e.g. 127.0.0.1:7233 or cloud endpoint)');
  }
  
  // CRITICAL: Hard-enforce correct Temporal address for SHORT instance
  if (temporalAddress !== '127.0.0.1:7233') {
    throw new Error(`TEMPORAL_ADDRESS MUST be 127.0.0.1:7233 for SHORT instance (got: ${temporalAddress}). NEVER use 7234 - that's for LONG instance!`);
  }
  if (!traderQueue) {
    throw new Error('TASK_QUEUE is required for orchestrators (e.g. trader)');
  }
  if (!openaiQueue) {
    throw new Error('TASK_QUEUE_OPENAI is required (e.g. io-openai)');
  }
  if (!binanceQueue) {
    throw new Error('TASK_QUEUE_BINANCE is required (e.g. io-binance)');
  }

  // Enforce -short suffix on queues and namespace if provided via env
  const endsWithShort = (v?: string) => typeof v === 'string' && /-short$/i.test(v);
  if (!endsWithShort(traderQueue)) throw new Error('TASK_QUEUE must end with -short');
  if (!endsWithShort(openaiQueue)) throw new Error('TASK_QUEUE_OPENAI must end with -short');
  if (!endsWithShort(binanceQueue)) throw new Error('TASK_QUEUE_BINANCE must end with -short');
  const ns = String(process.env.TEMPORAL_NAMESPACE || '');
  if (ns && !endsWithShort(ns)) throw new Error('TEMPORAL_NAMESPACE must end with -short');
  
  // CRITICAL: Never allow -long in queue names (prevents cross-contamination)
  const hasLong = (v?: string) => typeof v === 'string' && /-long/i.test(v);
  if (hasLong(traderQueue)) throw new Error('TASK_QUEUE contains "-long" - this is SHORT instance!');
  if (hasLong(openaiQueue)) throw new Error('TASK_QUEUE_OPENAI contains "-long" - this is SHORT instance!');
  if (hasLong(binanceQueue)) throw new Error('TASK_QUEUE_BINANCE contains "-long" - this is SHORT instance!');

  return { temporalAddress, traderQueue, openaiQueue, binanceQueue };
}


