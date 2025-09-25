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

### Dev režim
```bash
# Backend
PORT=8789 npm run dev:server  # http://localhost:8789

# Frontend
npm run dev                   # http://localhost:4201 (Vite proxy /api → :8789)
```

### Prod build a spuštění
```bash
# Build statického frontendu
npm run build    # vytvoří dist/

# Spusť backend (servíruje dist/ + REST API)
npm run dev:server

# Ověření
curl http://localhost:8789/api/health
```

### Porty a proxy
- Frontend dev: `:4201` (Vite) s proxy na `:8789` pro `/api` a `/__proxy`
- Backend: `:8789` (HTTP server)

### Restart dev prostředí (kill → clean → start → verify)
Vždy spouštěj příkazy z kořene projektu.

```bash
# 1) Přejdi do kořene projektu
cd /path/to/trader-new-new-new

# Doporučený způsob: jeden příkaz
./dev.sh restart

# Alternativně manuálně (macOS-kompatibilní):
# 2) Zastav běžící procesy na portech 4201 (Vite) a 8789 (backend)
for p in 4201 8789; do
  pids=$(lsof -n -iTCP:$p -sTCP:LISTEN -t 2>/dev/null || true); [ -n "$pids" ] && kill -9 $pids || true
done

# (volitelně) doraz dev procesy podle patternu – nevadí, když nic nenajde
pkill -f 'trader-new-new-new.*(vite|tsx|server/index.ts|npm run dev)' || true

# 3) Vyčisti runtime PID/log soubory
mkdir -p runtime
rm -f runtime/*.pid runtime/*log runtime/*.out runtime/*.err

# 4) Spusť backend (HTTP :8789), loguj a ulož PID
PORT=8789 nohup npm run -s dev:server > runtime/backend_dev.log 2>&1 & echo $! > runtime/backend.pid

# 5) Počkej na health backendu
for i in {1..40}; do sleep 0.25; if curl -sf http://127.0.0.1:8789/api/health >/dev/null; then break; fi; done

# 6) Spusť frontend (Vite :4201), loguj a ulož PID
nohup npm run -s dev > runtime/frontend_dev.log 2>&1 & echo $! > runtime/frontend.pid

# 7) Ověř dostupnost frontendu a proxy na backend
curl -sf http://127.0.0.1:4201/ >/dev/null
curl -sf http://127.0.0.1:4201/api/health >/dev/null

# 8) Ověř, že běží právě jedna instance na každém portu
test "$(lsof -n -iTCP:4201 -sTCP:LISTEN -t | wc -l | tr -d " ")" = "1"
test "$(lsof -n -iTCP:8789 -sTCP:LISTEN -t | wc -l | tr -d " ")" = "1"
```

### Logy a PID soubory
- Backend log: `runtime/backend_dev.log`, PID: `runtime/backend.pid`
- Frontend log: `runtime/frontend_dev.log`, PID: `runtime/frontend.pid`

Poznámky:
- Vite má `strictPort: true` a poběží na `:4201`. Pokud je port obsazený, příkaz skončí chybou – uvolni port dle kroku 2.
- Backend běží defaultně na `:8789` (lze měnit proměnnou `PORT`).

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



