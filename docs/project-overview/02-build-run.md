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
npm run dev:server  # http://localhost:8788

# Frontend
npm run dev         # http://localhost:4000 (Vite proxy /api → :8788)
```

### Prod build a spuštění
```bash
# Build statického frontendu
npm run build    # vytvoří dist/

# Spusť backend (servíruje dist/ + REST API)
npm run dev:server

# Ověření
curl http://localhost:8788/api/health
```

### Porty a proxy
- Frontend dev: `:4000` (Vite) s proxy na `:8788` pro `/api` a `/__proxy`
- Backend: `:8788` (HTTP server)

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



