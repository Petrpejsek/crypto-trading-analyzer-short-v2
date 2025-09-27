module.exports = {
  apps: [
    {
      name: 'trader-short-backend',
      script: 'tsx',
      args: 'server/index.ts',
      env: {
        NODE_ENV: 'production',
        TRADE_SIDE: 'SHORT',
        PORT: '3081'
      }
    },
    {
      name: 'trader-short-worker',
      script: 'tsx',
      args: 'temporal/worker.ts',
      env: {
        NODE_ENV: 'production',
        TRADE_SIDE: 'SHORT',
        PORT: '3081'
      }
    }
  ]
}

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
      env: {
        PM2_NAME: 'trader-short-backend',
        NODE_ENV: 'production',
        TRADE_SIDE: 'SHORT',
        PORT: '3081',
        TEMPORAL_NAMESPACE: 'trader-short'
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
      env: {
        PM2_NAME: 'trader-short-worker',
        NODE_ENV: 'production',
        TRADE_SIDE: 'SHORT',
        TEMPORAL_NAMESPACE: 'trader-short',
        TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS,
        TASK_QUEUE: 'entry-short',
        TASK_QUEUE_OPENAI: 'openai-short',
        TASK_QUEUE_BINANCE: 'binance-short',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        OPENAI_ORG_ID: process.env.OPENAI_ORG_ID,
        OPENAI_PROJECT: process.env.OPENAI_PROJECT
      },
      error_file: './logs/short/worker.err.log',
      out_file: './logs/short/worker.out.log',
      merge_logs: true
    }
  ]
}


