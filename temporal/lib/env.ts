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

  if (!temporalAddress) {
    throw new Error('TEMPORAL_ADDRESS is required (e.g. 127.0.0.1:7233 or cloud endpoint)');
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

  return { temporalAddress, traderQueue, openaiQueue, binanceQueue };
}


