## Ops Cheatsheet

### Rychlé ověření běhu
```bash
curl http://localhost:8788/api/health
curl "http://localhost:8788/api/snapshot?universe=gainers&topN=50"
curl http://localhost:8788/api/limits
```

### Diagnostika rate limitu/ban
- Sledujte `/api/limits` a UI banner v Orders panelu (backoff sekund).
- V logu hledejte `[BINANCE_ERROR]`, kód `-1003` a `[BATCH_*]`.

### Čištění waiting TP
- Server sám rehydratuje `runtime/waiting_tp.json` při startu.
- Ruční cleanup symbolu: přes UI „Close“ ENTRY, případně `/api/order` DELETE.

### Dev util – vynucení pozice (opatrně)
```bash
curl -X POST localhost:8788/api/test/market_fill \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"BTCUSDT","side":"BUY","quantity":"0.001"}'
```

### Minimální postup nasazení (single host)
1) Naplňte `.env` (BINANCE/OPENAI klíče)
2) `npm ci`
3) `npm run build`
4) `npm run dev:server`
5) Otevřete `http://localhost:8788` nebo proxujte přes reverzní proxy na `/` a `/api`





