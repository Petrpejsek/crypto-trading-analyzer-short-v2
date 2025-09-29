# 🚀 Deploy Instructions - Prompt Management System

## ✅ Pre-deploy Checklist

- [x] Commit pushed: `8d13982`
- [x] Lokál testován: http://localhost:4302 ✅
- [x] Žádné extra Binance API calls ✅
- [x] Prompt Management API funguje ✅

---

## 📦 Co se deployuje:

### Backend změny:
1. **Prompt Management API** (`/dev/prompts/*`)
   - GET /dev/prompts - seznam asistentů
   - GET /dev/prompts/:key - detail promptu
   - PUT /dev/prompts/:key - save promptu
   - POST /dev/prompts/export-all - export do registry
   - GET /dev/prompt-attestation/:key - attestation info

2. **Helper modul**: `services/lib/dev_prompts.ts`
   - `resolveAssistantPrompt()` - overlay/registry resolver
   - `setOverlayPrompt()` - atomic write + verifikace
   - `notePromptUsage()` - audit trail
   - `exportOverlayToRegistry()` - migrace do prod

3. **Integrace** do 4 asistentů:
   - `strategy_updater` - vrací prompt_sha256 v meta
   - `entry_updater` - vrací prompt_sha256 v meta
   - `entry_strategy_conservative` - vrací prompt_hash v meta
   - `entry_strategy_aggressive` - vrací prompt_hash v meta

### Frontend změny:
1. **PromptsModal** komponenta
   - UI editor s SHA-256 verifikací
   - Save flow s lint kontrolami
   - Export tlačítko
   - Tlačítko v HeaderBar (dev-only)

2. **Vite config**:
   - Proxy pro `/dev` endpointy
   - Web Crypto API pro SHA-256

### Prompty (aktualizované z dev overlay):
1. `hot_screener.md` - nová verze
2. `entry_strategy_conservative.md` - nová verze
3. `entry_risk_manager.md` - nová verze
4. `strategy_updater.md` - nová verze

### Cleanup:
- ❌ Odstraněno 5 nepoužívaných promptů
- ❌ Background pipeline disabled
- ✅ 8 asistentů (bylo 12)

### Dependencies:
- `ulid` - pro revision IDs
- `stream-browserify`, `buffer` - polyfilly (nakonec nepoužito, ale installed)

---

## 🎯 Deploy na produkci

### 1. SSH do prod serveru

```bash
ssh user@prod-server
cd /path/to/trader-short-v2
```

### 2. Backup současného stavu

```bash
# Vytvoř backup
git stash push -m "pre-deploy-backup-$(date +%Y%m%d-%H%M%S)"

# Nebo bundle backup
git bundle create backup-$(date +%Y%m%d-%H%M%S).bundle HEAD
```

### 3. Pull změny

```bash
# Pull z origin
git pull origin main

# Ověř commit
git log -1 --oneline
# Mělo by být: 8d13982 feat: Prompt Management systém...
```

### 4. Install dependencies

```bash
npm install
```

### 5. Restart služeb

**PM2 způsob** (doporučeno):
```bash
# Restart všech služeb
pm2 restart all

# Nebo postupně:
pm2 restart backend
pm2 restart frontend  
pm2 restart worker
```

**Nebo dev.sh** (pokud nepoužíváš PM2):
```bash
# Stop
./dev.sh stop

# Start (produkční mód)
NODE_ENV=production ./dev.sh start
```

### 6. Verifikace

```bash
# Health check
curl http://localhost:8888/api/health
# Očekáváno: {"ok":true}

# Ověř že frontend běží
curl -I http://localhost:4302/
# Očekáváno: HTTP 200

# Zkontroluj prompty jsou načtené
curl http://localhost:8888/api/health
# V logs: PROMPTS_SIDE=SHORT (N=8, snapshot=..., verified=OK)
```

---

## 🔐 Produkční chování

### ✅ Co se POUŽIJE:
- `prompts/*.md` z registry (VŽDY)
- Overlay se ignoruje (i kdyby existoval)
- Žádné /dev/prompts API (404 v production)

### ❌ Co se IGNORUJE:
- `runtime/prompts/dev/` (overlay)
- /dev/prompts endpointy (disabled v prod)

---

## 📊 Monitoring po deployu

### 1. Zkontroluj logy

```bash
# PM2 logs
pm2 logs backend --lines 50 | grep PROMPTS

# Nebo tail
tail -50 runtime/backend*.log | grep PROMPTS
```

**Očekávaný výstup:**
```
PROMPTS_SIDE=SHORT (N=8, snapshot=SNAPSHOT_..., verified=OK)
TRADE_SIDE=SHORT
[PROMPT] { name: 'hot_screener', version: '...', checksum: '...' }
[PROMPT] { name: 'strategy_updater', version: '...', checksum: '...' }
...
```

### 2. Test asistenta

```bash
# Spusť Strategy Updater
# Zkontroluj v logu:
# - Používá prompt z registry (NE overlay)
# - meta obsahuje prompt_sha256
```

### 3. Zkontroluj Binance calls

```bash
# Počet requestů
tail -200 runtime/backend*.log | grep -c "BINANCE_REQ"
# Mělo by být: nízké číslo (< 20)

# Žádné bany
tail -200 runtime/backend*.log | grep "418\|banned"
# Mělo by být: prázdné
```

---

## 🆘 Rollback (pokud něco selže)

### Rychlý rollback:

```bash
# Vrať na předchozí commit
git reset --hard cbfb4e7

# Restart
pm2 restart all
```

### Nebo použij backup:

```bash
# Restore ze stashe
git stash pop

# Nebo z bundle
git pull backup-YYYYMMDD-HHMMSS.bundle
```

---

## ✅ Post-deploy checklist

- [ ] Backend běží (health check OK)
- [ ] Frontend běží (UI přístupné)
- [ ] Prompts načteny (N=8, verified=OK v logu)
- [ ] Strategy Updater funguje
- [ ] Žádné extra Binance calls
- [ ] Žádné 418 bany
- [ ] UI zobrazuje pozice správně

---

## 🎯 Rozdíly dev vs prod

| Feature | Dev (NODE_ENV=development) | Prod (NODE_ENV=production) |
|---------|---------------------------|----------------------------|
| Prompt source | Overlay (runtime/prompts/dev/) | Registry (prompts/*.md) |
| Pokud chybí | FAIL HARD (no fallback) | Načte z registry |
| /dev/prompts API | ✅ Aktivní | ❌ 404 Not Found |
| UI Prompts tlačítko | ✅ Zobrazeno | ❌ Skryto |
| Overlay commitován | ❌ Ne (.gitignore) | ❌ Ne |
| Registry commitován | ✅ Ano (po exportu) | ✅ Používá se |

---

## 📝 Poznámky

- **Overlay se nedeployuje** - jen registry soubory
- **Prod ignoruje overlay** - vždy čte z registry
- **Export je povinný** pro migraci změn
- **Zero overhead** v produkci
- **Žádné extra Binance calls** - jen čtení lokálních souborů

---

**Autor**: Automated deploy prep  
**Commit**: 8d13982  
**Datum**: 2025-09-29  
**Produkce ready**: ✅ ANO
