## Build & Run – přesný postup

### Požadavky
- Node.js LTS (doporučeno v16+)
- NPM (projekt používá `npm ci`)
- Binance Futures API klíče (režim paper/real dle účtu)
- OpenAI klíč (pro GPT režimy)

### Env proměnné (.env / .env.local)
- `BINANCE_API_KEY`, `BINANCE_SECRET_KEY`
- `OPENAI_API_KEY` (povinné pro `DECIDER_MODE=gpt` a GPT-based endpoints)
- `OPENAI_ORG_ID`, `OPENAI_PROJECT` (volitelně)
- `DECIDER_MODE` = `mock` nebo `gpt` (ovlivňuje `/api/decide`)

Poznámka: Server automaticky načítá `.env.local` i `.env` i v produkci.

### Instalace
```bash
npm ci
```

### Dev režim (bezpečné porty pro tento projekt)
```bash
# Doporučené oddělené porty (aby se NIKDY nemíchalo s "trader new new new")
FRONTEND_PORT=4302 BACKEND_PORT=8888 ./dev.sh restart

# Kontroly
curl -sf http://127.0.0.1:4302/ >/dev/null
curl -sf http://127.0.0.1:4302/api/health >/dev/null  # proxy → :8888
curl -sf http://127.0.0.1:8888/api/health >/dev/null  # backend přímo
```

### Prod build a spuštění
```bash
# Build statického frontendu
npm run build    # vytvoří dist/

# Spusť backend (servíruje dist/ + REST API)
npm run dev:server

# Ověření
curl http://localhost:8888/api/health
```

### Porty a proxy (v tomto repu)
- Frontend dev: `:4302` (Vite) s proxy na `:8888` pro `/api` a `/__proxy`
- Backend: `:8888` (HTTP server)

### Restart dev prostředí (kill → clean → start → verify)
Vždy spouštěj příkazy z kořene projektu.

```bash
# 1) Přejdi do kořene projektu
cd /path/to/trader-short-v2

# Doporučený způsob: jeden příkaz
./dev.sh restart

# Alternativně manuálně (macOS-kompatibilní):
# 2) Zastav běžící procesy na portech 4302 (Vite) a 8888 (backend)
for p in 4302 8888; do
  pids=$(lsof -n -iTCP:$p -sTCP:LISTEN -t 2>/dev/null || true); [ -n "$pids" ] && kill -9 $pids || true
done

# (volitelně) doraz dev procesy podle patternu – nevadí, když nic nenajde
pkill -f 'trader-short-v2.*(vite|tsx|server/index.ts|npm run dev)' || true

# 3) Vyčisti runtime PID/log soubory
mkdir -p runtime
rm -f runtime/*.pid runtime/*log runtime/*.out runtime/*.err

# 4) Spusť backend (HTTP :8888), loguj a ulož PID
PORT=8888 nohup npm run -s dev:server > runtime/backend_dev.log 2>&1 & echo $! > runtime/backend.pid

# 5) Počkej na health backendu
for i in {1..40}; do sleep 0.25; if curl -sf http://127.0.0.1:8888/api/health >/dev/null; then break; fi; done

# 6) Spusť frontend (Vite :4302), loguj a ulož PID
nohup npm exec -s vite -- --port 4302 > runtime/frontend_dev.log 2>&1 & echo $! > runtime/frontend.pid

# 7) Ověř dostupnost frontendu a proxy na backend
curl -sf http://127.0.0.1:4302/ >/dev/null
curl -sf http://127.0.0.1:4302/api/health >/dev/null

# 8) Ověř, že běží právě jedna instance na každém portu
test "$(lsof -n -iTCP:4302 -sTCP:LISTEN -t | wc -l | tr -d " ")" = "1"
test "$(lsof -n -iTCP:8888 -sTCP:LISTEN -t | wc -l | tr -d " ")" = "1"
```

### Logy a PID soubory
- Backend log: `runtime/backend_dev.log`, PID: `runtime/backend.pid`
- Frontend log: `runtime/frontend_dev.log`, PID: `runtime/frontend.pid`

Poznámky:
- Vite má `strictPort: true` – pro tento projekt použij `:4302`.
- Backend používej na `:8888` (lze dočasně měnit proměnnou `PORT`).

### Oddělení od „trader new new new“ (kriticky důležité)
- Tento projekt NESMÍ používat porty 4201/8789.
- Vždy spouštěj přes `FRONTEND_PORT=4302 BACKEND_PORT=8888 ./dev.sh restart`.
- Rychlá kontrola oddělení:
```bash
PID=$(lsof -n -iTCP:4302 -sTCP:LISTEN -t | head -n1); lsof -a -p "$PID" -d cwd
PID=$(lsof -n -iTCP:8888 -sTCP:LISTEN -t | head -n1); lsof -a -p "$PID" -d cwd
```

### Ports & Environment Guard (aby se to už nikdy nespletlo)

1) Hard pravidla v kódu
- Backend má guard: `TRADE_SIDE` musí být `SHORT`. Při nesouladu proces skončí.
- V produkci musí běžet na `PORT=3081`; v dev používáme `:8888`. Produkční guard chybný port ukončí.

2) Dev režim – jediný správný způsob spuštění
```bash
FRONTEND_PORT=4302 BACKEND_PORT=8888 ./dev.sh restart
```

3) Verifikace, že UI mluví na správný backend
```bash
# Frontend → proxy health
curl -sf http://127.0.0.1:4302/api/health

# Backend health přímo (dev)
curl -sf http://127.0.0.1:8888/api/health

# V produkci (PM2 short backend)
curl -sf http://127.0.0.1:3081/api/health
```

4) Rychlý sanity check „jsem na short backendu?“
```bash
curl -s http://127.0.0.1:3081/api/orders_console \
 | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s);const sample=(j.open_orders||[]).slice(0,3);console.log({port:3081, shortOnly: true, sample: sample.map(o=>({symbol:o.symbol, side:o.side, positionSide:o.positionSide, isExternal:o.isExternal}))})})"
```

5) PM2 jména pro SHORT instanci (produkce)
- `trader-short-backend` (PORT 3081)
- `trader-short-worker`

6) Nejčastější pasti a fixy
- UI ukazuje data z jiného projektu: přepni proxy/URL na `:3081` (prod) nebo `:8888` (dev)
- PM2 běží starý proces: `pm2 restart trader-short-backend --update-env`

### Minimální konfigurace pro trading
- `config/trading.json`:
  - `RAW_PASSTHROUGH: true` – engine posílá přesně UI hodnoty (žádné rounding uvnitř engine)
  - `TP_MODE`: `MARKET_PREENTRY` nebo `LIMIT_ON_FILL` (viz Order Engine)
  - `EXIT_WORKING_TYPE`: doporučeno `MARK_PRICE`

### Smoke test
1) Ověř snapshot: `GET /api/snapshot?universe=gainers&topN=50`
2) Ověř metrics: `GET /api/metrics?universe=gainers&topN=50`
3) UI „Run now" → „Copy RAW" → Hot Screener → Entry → Prepare Orders → Place

### Produkční build a deploy
Pro nasazení na externí server:
```bash
# Build pro produkci
npm run build

# Deploy pomocí automatizovaného scriptu
./scripts/deploy.sh
```

Kompletní návod produkčního nasazení viz **[docs/ops/PRODUCTION.md](../ops/PRODUCTION.md)**.



