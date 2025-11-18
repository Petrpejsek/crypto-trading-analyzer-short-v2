import 'dotenv/config';
import dotenv from 'dotenv';
// CRITICAL: Load .env.local BEFORE anything else to prevent cross-contamination
dotenv.config({ path: '.env.local' });

import { Worker, NativeConnection } from '@temporalio/worker';
import { loadEnv } from './lib/env';
import activities from './activities';
import { acquireLock } from '../server/lib/processLock';

async function run(): Promise<void> {
  // CRITICAL: Acquire lock before anything else
  try {
    acquireLock('worker');
  } catch (e: any) {
    console.error('[FATAL]', e?.message || e);
    process.exit(1);
  }

  // ========================================
  // GLOBAL ERROR HANDLERS: Prevent worker crashes
  // ========================================
  // Handler pro nezachycené Promise rejections (KRITICKÝ!)
  process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('[WORKER_UNHANDLED_REJECTION] Uncaught Promise rejection detected!');
    console.error('[WORKER_UNHANDLED_REJECTION] Reason:', {
      message: reason?.message || String(reason),
      name: reason?.name || 'Unknown',
      stack: reason?.stack || 'No stack trace',
      code: reason?.code || null
    });
    console.error('[WORKER_UNHANDLED_REJECTION] Promise:', promise);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    // NEPADÁME - logujeme a pokračujeme (preventivní monitoring)
  });

  // Handler pro uncaught exceptions
  process.on('uncaughtException', (err: Error) => {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('[WORKER_UNCAUGHT_EXCEPTION] Fatal error detected!');
    console.error('[WORKER_UNCAUGHT_EXCEPTION] Error:', {
      message: err.message,
      name: err.name,
      stack: err.stack,
      code: (err as any).code || null
    });
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    // Exit s krátkou prodlevou pro flush logů
    setTimeout(() => process.exit(1), 100);
  });

  const env = loadEnv();
  const namespace = String(process.env.TEMPORAL_NAMESPACE || 'default');
  
  // CRITICAL: STRICT BAN on port 7800 (LONG instance) - THIS IS SHORT ONLY!
  if (env.temporalAddress.includes(':7800')) {
    console.error('')
    console.error('🚨🚨🚨 FATAL ERROR 🚨🚨🚨')
    console.error('')
    console.error('❌ PORT 7800 IS STRICTLY FORBIDDEN!')
    console.error('   Port 7800 is reserved for LONG trading instance')
    console.error('   This is SHORT instance - MUST use port 7500')
    console.error('')
    console.error(`   Current: TEMPORAL_ADDRESS=${env.temporalAddress}`)
    console.error('   Required: TEMPORAL_ADDRESS=127.0.0.1:7500')
    console.error('')
    console.error('🚨 Fix .env.local and restart!')
    console.error('')
    process.exit(1)
  }
  
  try {
    console.log(`[temporal] ENV_CHECK`, {
      TEMPORAL_ADDRESS: env.temporalAddress,
      TEMPORAL_NAMESPACE: namespace,
      TRADE_SIDE: String(process.env.TRADE_SIDE || ''),
      queues: { trader: env.traderQueue, openai: env.openaiQueue, binance: env.binanceQueue }
    })
  } catch {}

  // CRITICAL: Create explicit connection to prevent default port usage
  const connection = await NativeConnection.connect({
    address: env.temporalAddress,
  });

  // Orchestrator worker (high-level workflows)
  const traderWorker = await Worker.create({
    connection,
    namespace,
    taskQueue: env.traderQueue,
    workflowsPath: require.resolve('./workflows'),
    activities,
    identity: `trader-worker:${env.traderQueue}`,
    maxConcurrentWorkflowTaskExecutions: Number(process.env.TRADER_WF_CONCURRENCY || 20),
    maxConcurrentActivityTaskExecutions: Number(process.env.TRADER_ACTIVITY_CONCURRENCY || 10),
    bundlerOptions: {
      ignoreModules: ['fs', 'path'],
      webpackConfigHook: (config) => {
        config.externals = config.externals || [];
        if (Array.isArray(config.externals)) {
          config.externals.push('fs', 'path');
        }
        return config;
      }
    }
  });

  // OpenAI-specific queue (activities only)
  const openaiWorker = await Worker.create({
    connection,
    namespace,
    taskQueue: env.openaiQueue,
    activities,
    identity: `openai-worker:${env.openaiQueue}`,
    maxConcurrentActivityTaskExecutions: Number(process.env.OPENAI_CONCURRENCY || 6),
  });

  // Binance-specific queue (activities only)
  const binanceWorker = await Worker.create({
    connection,
    namespace,
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


