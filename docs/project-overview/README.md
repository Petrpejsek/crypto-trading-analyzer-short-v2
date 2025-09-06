## Project Overview

Tento balík dokumentace shrnuje architekturu, produkční/dev build postupy, klíčové API a obchodní logiku (V3 order engine). Slouží jako přesný referenční postup pro budoucí buildy a nasazení bez domněnek a bez fallbacků.

### Co najdete
- **Architektura**: adresářová struktura, hlavní běhové toky, závislosti
- **Build & Run**: přesné příkazy a pořadí spuštění (dev/prod), env proměnné
- **Backend API**: seznam endpointů s účelem a klíčovými parametry
- **V3 Order Engine**: přesný flow vstupů/výstupů, pravidla a ochrany
- **Konfigurace**: popis `config/*.json`, doporučené hodnoty, schémata
- **Rate limiting & logging**: sběr telemetrie, diagnostika, backoff
- **Frontend**: UI workflow, výchozí strategie market-universe, build

### Rychlý start (dev)
1) Vytvořte `.env` s klíči (viz Build & Run):
```bash
OPENAI_API_KEY=sk-...
OPENAI_ORG_ID=
OPENAI_PROJECT=
BINANCE_API_KEY=...
BINANCE_SECRET_KEY=...
DECIDER_MODE=mock # nebo gpt pro OpenAI režim
```
2) Instalace a spuštění:
```bash
npm ci
npm run dev:server   # backend na http://localhost:8788
npm run dev          # frontend (Vite) na http://localhost:4000
```

### Obsah
- 01-architecture.md
- 02-build-run.md
- 03-backend-api.md
- 04-order-engine-v3.md
- 05-config.md
- 06-rate-limits-logging.md
- 07-frontend.md
- 08-ops-cheatsheet.md



