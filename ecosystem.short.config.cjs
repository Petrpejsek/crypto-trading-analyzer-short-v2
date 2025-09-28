module.exports = {
  apps: [
    {
      name: 'trader-short-backend',
      script: 'server/index.ts',
      interpreter: './node_modules/.bin/tsx',
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      time: true,
      env_file: '.env.local',
      env: {
        PM2_NAME: 'trader-short-backend',
        NODE_ENV: 'production',
        TRADE_SIDE: 'SHORT',
        PORT: '3081',
        TEMPORAL_NAMESPACE: 'trader-short',
        STRATEGY_UPDATER_MODEL: 'gpt-4o',
        MAX_SLIPPAGE_PCT: '0.05',
        STRATEGY_UPDATER_AUDIT: '1',
        STRATEGY_UPDATER_ENABLED: '1'
      },
      error_file: './logs/short/backend.err.log',
      out_file: './logs/short/backend.out.log',
      merge_logs: true
    },
    {
      name: 'trader-short-worker',
      script: 'temporal/worker.ts',
      interpreter: './node_modules/.bin/tsx',
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      time: true,
      env_file: '.env.local',
      env: {
        PM2_NAME: 'trader-short-worker',
        NODE_ENV: 'production',
        TRADE_SIDE: 'SHORT',
        TEMPORAL_NAMESPACE: 'trader-short',
        TASK_QUEUE: 'entry-short',
        TASK_QUEUE_OPENAI: 'openai-short',
        TASK_QUEUE_BINANCE: 'binance-short'
      },
      error_file: './logs/short/worker.err.log',
      out_file: './logs/short/worker.out.log',
      merge_logs: true
    }
  ]
}

