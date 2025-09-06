## Backend API – přehled endpointů

Základ: `http://localhost:8788`

### Zdraví a limity
- `GET /api/health` – ping
- `GET /api/limits` – snapshot rate-limit telemetrie ze `server/lib/rateLimits.ts`
- `GET /api/ws/health` – ws collector (v tomto projektu deaktivován, vrací statický stav)

### Market data
- `GET /api/snapshot` – surový snapshot (BTC/ETH + universe), query: `?universe=volume|gainers&topN=50&fresh=1`
- `GET /api/snapshot_light`, `GET /api/snapshot_pro` – odlehčené výstupy pro UI
- `GET /api/intraday` – agregované data pro UI tabulky
- `GET /api/intraday_any?symbol=BTCUSDT` – data pro libovolný symbol (1x fetch), robustní retry

### Metrics
- `GET /api/metrics` – list coinů + indikátory, respektuje universe strategii

### GPT/Decider
- `POST /api/decide` – M3 rozhodnutí (rules nebo GPT dle `DECIDER_MODE`)
- `POST /api/final_picker` – M4 výběr finálních picků (GPT + validace)
- `POST /api/hot_screener` – M7 Super Hot picks (GPT)
- `POST /api/entry_strategy` – generuje vstupní plán (conservative/aggressive) pro symbol

### Trading
- `POST /api/place_orders` – spouští V3 batch engine (viz kapitola Order Engine V3)
- `POST /api/place_exits` – zadá pouze SL/TP pro existující (nebo brzkou) pozici
- `GET /api/orders_console` – konsolidovaný stav (pozice, objednávky, marks, waiting TPs)
- `GET /api/positions` – čisté pozice (WS snapshot)
- `GET /api/open_orders` – čisté otevřené objednávky (WS snapshot)
- `DELETE /api/order?symbol=...&orderId=...` – zrušení jedné objednávky
- `PUT /api/trading/settings` – nastavení `pending_cancel_age_min` (sweeper)

### Test/Debug
- `POST /api/test/market_fill` – dev util pro rychlé vytvoření pozice (market)
- `GET /api/debug/last_place_orders` – poslední request/response place_orders
- `GET /api/debug/cancel_audit` – audit zrušených/filled eventů
- `GET /api/gpt/health`, `GET /api/gpt/models` – diagnostika OpenAI
- `GET /api/entry_strategy` – `debug/entry_last?symbol=...` poslední vstupní analýza

### Proxy a speciální routy
- Frontend dev proxy (Vite) mapuje `/api` a `/__proxy` na `:8788`.
- UI používá flatten/cancel-all přes `/__proxy/binance/...` (server poskytuje kompatibilní handler).

### Sémantika odpovědí
- WS not ready: server vrací 200 s prázdnými listy. Žádné REST seedování uvnitř těchto endpointů.
- Rate limit/ban: `429` + `Retry-After` nebo structured `{ error: 'banned_until', until }`.


