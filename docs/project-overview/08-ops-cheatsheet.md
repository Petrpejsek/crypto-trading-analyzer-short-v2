## Ops Cheatsheet

### Rychlé ověření běhu
```bash
# DEV (short v tomto repu): backend :8888
curl -sf http://127.0.0.1:8888/api/health

# PROD (PM2 short backend): :3081
curl -sf http://127.0.0.1:3081/api/health

# Snapshot/limits – použij správný port dle režimu
curl -sf "http://127.0.0.1:3081/api/snapshot?universe=gainers&topN=50"
curl -sf http://127.0.0.1:3081/api/limits
```

### Diagnostika rate limitu/ban
- Sledujte `/api/limits` a UI banner v Orders panelu (backoff sekund).
- V logu hledejte `[BINANCE_ERROR]`, kód `-1003` a `[BATCH_*]`.

### Čištění waiting TP
- Server sám rehydratuje `runtime/waiting_tp.json` při startu.
- Ruční cleanup symbolu: přes UI „Close“ ENTRY, případně `/api/order` DELETE.

### Dev util – vynucení pozice (opatrně)
```bash
curl -X POST localhost:8888/api/test/market_fill \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"BTCUSDT","side":"BUY","quantity":"0.001"}'
```

### Minimální postup nasazení (single host)
1) Naplňte `.env` (BINANCE/OPENAI klíče)
2) `npm ci`
3) `npm run build`
4) Spusťte přes PM2 short ekosystém (zajistí TRADE_SIDE=SHORT, PORT=3081)
```bash
pm2 start ecosystem.short.config.cjs --update-env
pm2 status
```
5) Ověřte health na `:3081` nebo proxujte přes reverzní proxy na `/` a `/api`

### Quick-check: správný backend/port
```bash
curl -sf http://127.0.0.1:3081/api/orders_console \
 | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s);const shorts=(j.open_orders||[]).filter(o=>String(o.positionSide).toUpperCase()==='SHORT');console.log({port:3081,shorts:shorts.length});})"
```





