# 🚀 Deploy Instructions - Trader SHORT V2

## ✅ Pre-deploy Checklist

- [ ] Všechny změny commitnuty a pushnuty
- [ ] Lokální testy prošly (`npm run qa:m2`, `npm run locks:check`)
- [ ] Temporal cluster běží (`./temporal/start-short-cluster.sh`)
- [ ] `.env.local` nakonfigurován správně

---

## 📦 Co deploy obsahuje

### Core aplikace
1. **Backend** (`server/index.ts`)
   - WebSocket server
   - API endpointy
   - Fetcher, Features, Signals
   - Process Lock systém

2. **Temporal Worker** (`temporal/worker.ts`)
   - Activities (OpenAI, Binance, validátory)
   - Workflows (entry pipeline)
   - Process Lock systém

3. **Frontend** (Vite SPA)
   - Dashboard UI
   - Pozice, signály, monitoring
   - Proxy na backend API

### Infrastruktura
- **PM2 Process Manager** - production orchestration
- **Temporal Cluster** - workflow orchestration
- **Process Lock System** - duplicate prevention
- **SQLite Databases** - runtime state (temporal_short.db)

---

## 🎯 Deploy workflow

### 1. Na produkčním serveru - Pull změny

```bash
ssh user@production-server
cd /srv/trader-short-v2

# Backup současného stavu
git stash push -m "pre-deploy-backup-$(date +%Y%m%d-%H%M%S)"

# Pull změny
git fetch origin
git checkout main
git pull origin main

# Ověř commit
git log -1 --oneline
```

### 2. Instalace dependencies

```bash
npm ci
```

### 3. Kontrola locks před restartem

```bash
# Zkontroluj aktivní locks
npm run locks:check

# Pokud jsou aktivní, stop PM2 a vyčisti locks
pm2 stop all
npm run locks:clear
```

### 4. Restart služeb (PM2)

**Doporučený způsob - graceful restart:**
```bash
pm2 restart ecosystem.short.config.cjs --update-env
```

**Nebo jednotlivě:**
```bash
pm2 restart trader-short-backend --update-env
pm2 restart trader-short-worker --update-env
```

**Hard restart (když máš problémy):**
```bash
pm2 delete all
pm2 start ecosystem.short.config.cjs
pm2 save
```

### 5. Verifikace

```bash
# PM2 status
pm2 status
pm2 logs --lines 50

# Process locks
npm run locks:check
# Očekáváno: backend i worker LOCKED, STATUS: ✅ RUNNING

# Backend health
curl http://localhost:3081/api/health
# Očekáváno: {"ok":true}

# Temporal worker
pm2 logs trader-short-worker --lines 20
# Očekáváno: "Worker state changed { state: 'RUNNING' }"
```

---

## 🔧 Troubleshooting

### Problem: "LOCK_CONFLICT" při startu

**Příčina:** Jiná instance už běží nebo zůstal stale lock

**Řešení:**
```bash
# 1. Zjisti co běží
pm2 list
npm run locks:check

# 2. Stop vše
pm2 stop all

# 3. Vyčisti locks
npm run locks:clear

# 4. Start znovu
pm2 start ecosystem.short.config.cjs
```

### Problem: Worker se nespustí

**Příčina:** Temporal cluster neběží nebo špatná adresa

**Řešení:**
```bash
# Zkontroluj .env.local
cat .env.local | grep TEMPORAL

# Očekáváno:
# TEMPORAL_ADDRESS=127.0.0.1:7500
# TEMPORAL_NAMESPACE=trader-short

# Zkontroluj že Temporal cluster běží
nc -z 127.0.0.1 7500 && echo "OK" || echo "FAIL"

# Pokud FAIL, spusť cluster:
./temporal/start-short-cluster.sh
```

### Problem: Duplicitní instance běží

**Příčina:** PM2 instance + dev.sh instance současně

**Řešení:**
```bash
# Stop vše
pm2 stop all
pkill -f "tsx.*server/index.ts"
pkill -f "tsx.*temporal/worker.ts"

# Vyčisti locks
npm run locks:clear

# Start jen PM2
pm2 start ecosystem.short.config.cjs
```

### Problem: Port 3081 je obsazený

**Příčina:** Jiná aplikace nebo zombie proces

**Řešení:**
```bash
# Najdi co běží na portu
lsof -i :3081

# Kill proces
kill -9 <PID>

# Vyčisti locks
npm run locks:clear

# Start PM2
pm2 start ecosystem.short.config.cjs
```

---

## 🆘 Rollback (pokud něco selže)

### Rychlý rollback z stash

```bash
# Vrať předchozí stav
git stash pop

# Restart
pm2 restart all
```

### Rollback na konkrétní commit

```bash
# Najdi commit
git log --oneline -10

# Reset na commit
git reset --hard <COMMIT_SHA>

# Reinstall
npm ci

# Restart
pm2 restart all
```

---

## 📊 Post-deploy monitoring

### 1. PM2 Logy (první 5 minut)

```bash
# Real-time všechny logy
pm2 logs

# Pouze backend
pm2 logs trader-short-backend

# Pouze worker
pm2 logs trader-short-worker
```

**Co hledat:**
- ✅ `[PROCESS_LOCK_ACQUIRED]` - locks OK
- ✅ `PROMPTS_SIDE=SHORT (N=...)` - prompty načtené
- ✅ `Worker state changed { state: 'RUNNING' }` - worker OK
- ✅ `[WS] WebSocket server listening` - WS OK
- ❌ `[FATAL]`, `[ERROR]` - problém!

### 2. Lock status

```bash
npm run locks:check
```

**Očekávaný výstup:**
```
[BACKEND] LOCKED
  PID:         12345
  Trade Side:  SHORT
  Process:     trader-short-backend
  Status:      ✅ RUNNING

[WORKER] LOCKED
  PID:         12346
  Trade Side:  SHORT
  Process:     trader-short-worker
  Status:      ✅ RUNNING
```

### 3. Health checks

```bash
# Backend API
curl http://localhost:3081/api/health

# Temporal
temporal workflow list --namespace trader-short

# Frontend (pokud je na serveru)
curl http://localhost:4302/
```

---

## 🎯 Rozdíly Development vs Production

| Feature | Development (`./dev.sh`) | Production (`pm2`) |
|---------|-------------------------|-------------------|
| Code reload | ✅ Hot reload (tsx watch) | ❌ Manual restart required |
| Port backend | 8888 | 3081 |
| Port frontend | 4302 | 4302 (nebo production URL) |
| NODE_ENV | development | production |
| Logs | `runtime/*.log` | PM2 logs + `logs/short/*.log` |
| Process manager | Bash script PIDs | PM2 daemon |
| Lock files | Auto cleanup on stop | Manual cleanup needed |
| Restart na změnu | Automatický | `pm2 restart` |

**Důležité:**
- Pro vývoj **VŽDY** používej `./dev.sh start`
- Pro produkci **VŽDY** používej `pm2 start ecosystem.short.config.cjs`
- **NIKDY** nemixtuj oba přístupy současně (lock system to zabrání)

---

## 🔐 Production Best Practices

### ✅ DO:
- Vždy používej PM2 pro produkci
- Kontroluj locks před každým restartem
- Monitoruj logy prvních 5 minut po deployu
- Backupuj před každým pullnutím změn
- Používej graceful restart (`pm2 restart`)

### ❌ DON'T:
- Nespouštěj dev.sh na produkci (kromě emergency debug)
- Nekombinuj PM2 + dev.sh současně
- Neignoruj lock konflikty
- Nepoužívej `pm2 delete` bez důvodu (zabíjí metriky)
- Nezapomeň na `pm2 save` po změnách

---

## 📚 Související dokumentace

- [docs/PROCESS_LOCK_SYSTEM.md](docs/PROCESS_LOCK_SYSTEM.md) - Detaily lock systému
- [docs/ops/PRODUCTION.md](docs/ops/PRODUCTION.md) - Production operations
- [TEMPORAL_ISOLATION.md](TEMPORAL_ISOLATION.md) - Temporal cluster izolace
- [README.md](README.md) - Quick start guide

---

**Poslední update:** Říjen 2025  
**Status:** ✅ Production ready s PM2 + Process Lock systémem
