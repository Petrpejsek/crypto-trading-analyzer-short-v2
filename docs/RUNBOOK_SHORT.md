# RUNBOOK SHORT

## Před spuštěním
- `TRADE_SIDE=SHORT` (povinné)
- `PORT=3081` (prod)
- `TEMPORAL_NAMESPACE=...-short`
- `TASK_QUEUE*` končí `-short`

## Start/Stop (PM2)
```bash
pm2 start ecosystem.short.config.cjs
pm2 reload ecosystem.short.config.cjs
pm2 delete trader-short-backend trader-short-worker
pm2 save
```

## Health
```bash
curl -sS http://127.0.0.1:3081/api/health
```

## Logy
- `[PROMPTS_SIDE=SHORT ... verified=OK]` při startu
- `TRADE_SIDE=SHORT`
- Temporal: namespace a queues končící `-short`

## FS Hard-lock (volitelné – produkce)
```bash
chmod -R a-w /srv/trader-short/prompts
# Linux: chattr +i /srv/trader-short/prompts/*  (snadno rušitelné)
```

## Post-deploy verifikace
- PORT 3081 poslouchá (`lsof -iTCP -sTCP:LISTEN -P | grep :3081`)
- Health OK
- PM2 procesy `trader-short-*` běží
- Logy obsahují `PROMPTS_SIDE=SHORT` a žádné registry mismatche

## Rollback
```bash
git reset --hard safety-pre-prompts-restore-short-<timestamp>
pm2 reload ecosystem.short.config.cjs
```

RUNBOOK – SHORT instance

Env checklist (required)
- PM2_NAME=trader-short (procesy se jménem obsahujícím "short")
- TRADE_SIDE=SHORT
- PORT=3081 (prod). Lokální dev: 8888.
- TEMPORAL_ADDRESS=127.0.0.1:7233
- TEMPORAL_NAMESPACE=trader-short
- TASK_QUEUE=entry-short
- TASK_QUEUE_OPENAI=openai-short
- TASK_QUEUE_BINANCE=binance-short
- BINANCE_API_KEY, BINANCE_SECRET_KEY

Vzorek: env/SHORT.env.example

Start/Stop (PM2, prod)
```bash
pm2 start ecosystem.short.config.cjs --only trader-short-backend
pm2 start ecosystem.short.config.cjs --only trader-short-worker
pm2 status
pm2 logs trader-short-backend --lines 200
pm2 logs trader-short-worker --lines 200
# stop
pm2 stop trader-short-backend trader-short-worker
```

Dev (lokál)
- Backend: PORT=8888 npm run dev:server
- Frontend: VITE_PROXY_TARGET=http://127.0.0.1:8888 npm run dev

Health & diagnostika
- Backend health: GET http://127.0.0.1:3081/api/health (prod) / :8888 (dev)
- Orders console: GET /api/orders_console
- Limits: GET /api/limits

Logy
- ./logs/short/backend.out.log, ./logs/short/backend.err.log
- ./logs/short/worker.out.log, ./logs/short/worker.err.log

Poznámky k oddělení od LONG
- Nepoužívat port 3080, nepoužívat namespace bez sufixu -short.
- Všechny task queue musí končit -short.
- PM2 procesy musí mít v názvu short.


