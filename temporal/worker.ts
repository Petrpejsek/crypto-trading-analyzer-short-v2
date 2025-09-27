import 'dotenv/config';
import { Worker } from '@temporalio/worker';
import { loadEnv } from './lib/env';
import activities from './activities';

async function run(): Promise<void> {
  const env = loadEnv();
  try {
    console.log(`[temporal] ENV_CHECK`, {
      TEMPORAL_NAMESPACE: String(process.env.TEMPORAL_NAMESPACE || ''),
      TRADE_SIDE: String(process.env.TRADE_SIDE || ''),
      queues: { trader: env.traderQueue, openai: env.openaiQueue, binance: env.binanceQueue }
    })
  } catch {}

  // Orchestrator worker (high-level workflows)
  const traderWorker = await Worker.create({
    address: env.temporalAddress,
    taskQueue: env.traderQueue,
    workflowsPath: require.resolve('./workflows'),
    activities,
    identity: `trader-worker:${env.traderQueue}`,
    maxConcurrentWorkflowTaskExecutions: Number(process.env.TRADER_WF_CONCURRENCY || 20),
    maxConcurrentActivityTaskExecutions: Number(process.env.TRADER_ACTIVITY_CONCURRENCY || 10),
  });

  // OpenAI-specific queue (activities only)
  const openaiWorker = await Worker.create({
    address: env.temporalAddress,
    taskQueue: env.openaiQueue,
    activities,
    identity: `openai-worker:${env.openaiQueue}`,
    maxConcurrentActivityTaskExecutions: Number(process.env.OPENAI_CONCURRENCY || 6),
  });

  // Binance-specific queue (activities only)
  const binanceWorker = await Worker.create({
    address: env.temporalAddress,
    taskQueue: env.binanceQueue,
    activities,
    identity: `binance-worker:${env.binanceQueue}`,
    maxConcurrentActivityTaskExecutions: Number(process.env.BINANCE_CONCURRENCY || 3),
  });

  console.log(`[temporal] Workers started on ${env.temporalAddress}: trader=${env.traderQueue}, openai=${env.openaiQueue}, binance=${env.binanceQueue}`);
  await Promise.all([traderWorker.run(), openaiWorker.run(), binanceWorker.run()]);
}

run().catch((err) => {
  console.error('[temporal] Worker failed to start', err);
  process.exit(1);
});


