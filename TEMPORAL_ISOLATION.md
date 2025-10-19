# Temporal Cluster Isolation - SHORT vs LONG

## Proč oddělené clustery?

Pro **100% zabezpečení** proti kontaminaci mezi SHORT a LONG trading instancemi používáme **zcela oddělené Temporal clustery**.

### Výhody

✅ **Nulová možnost křížení workflows** - SHORT a LONG běží na jiných portech a databázích  
✅ **Oddělené historie** - žádné sdílení workflow historie mezi instancemi  
✅ **Nezávislé restarty/upgrady** - změny v jednom clusteru neovlivní druhý  
✅ **Jasná izolace i při chybě** - špatná konfigurace nezpůsobí cross-contamination  
✅ **Oddělené network namespaces** - Docker izolace na síťové úrovni  

---

## Quick Start

### 1. Konfigurace SHORT instance

Zkopíruj vzorový config:
```bash
cp env.SHORT.example .env.local
```

Uprav `.env.local`:
```bash
TEMPORAL_ADDRESS=127.0.0.1:7500
TEMPORAL_NAMESPACE=trader-short
TASK_QUEUE=entry-short
TASK_QUEUE_OPENAI=io-openai-short
TASK_QUEUE_BINANCE=io-binance-short
FORBIDDEN_TEMPORAL_PORTS=7234,7600  # Zakázané porty (LONG instance)
```

### 2. Start SHORT Temporal cluster

**Varianta A: Pomocí skriptu (doporučeno)**
```bash
./temporal/start-short-cluster.sh
```

**Varianta B: Manuálně**
```bash
temporal server start-dev \
  --headless \
  --port 7500 \
  --db-filename ./runtime/temporal_short.db \
  --namespace trader-short
```

**Varianta C: Docker Compose**
```bash
docker-compose -f deploy/compose.short-temporal.yml up -d

# Temporal Web UI: http://localhost:8501
# Temporal gRPC: localhost:7500
```

### 3. Start aplikace

```bash
./dev.sh
```

---

## Architektura

### SHORT Cluster
- **Port**: `7500` ⚠️ NIKDY ne 7233/7234!
- **Database**: `runtime/temporal_short.db` (SQLite) nebo PostgreSQL
- **Namespace**: `trader-short` (povinné)
- **Queues**: `entry-short`, `io-openai-short`, `io-binance-short`
- **Docker network**: `trader-short-net` (izolovaná)

### LONG Cluster (jiný projekt)
- **Port**: `7600` (úplně jiný)
- **Database**: vlastní `temporal_long.db`
- **Namespace**: `trader-long`
- **Queues**: `entry-long`, `io-openai-long`, `io-binance-long`
- **Docker network**: `trader-long-net` (izolovaná)

---

## Bezpečnostní politiky

### FORBIDDEN_TEMPORAL_PORTS

Chrání proti nechtěnému připojení na LONG cluster:

```bash
FORBIDDEN_TEMPORAL_PORTS=7234,7600
```

Pokud se aplikace pokusí připojit na zakázaný port, **okamžitě selže při startu** s explicitní chybou.

### ALLOWED_TEMPORAL_HOSTS

Volitelný whitelist povolených hostů:

```bash
ALLOWED_TEMPORAL_HOSTS=127.0.0.1,localhost
```

Aplikace se připojí pouze k hostům v tomto seznamu.

### Namespace validace

SHORT instance **MUSÍ** používat namespace `trader-short`. Jakýkoliv jiný namespace (např. `trader-long`) způsobí okamžitou chybu při startu.

### Queue suffixy

Všechny queues **MUSÍ** končit `-short`:
- ✅ `entry-short`
- ✅ `io-openai-short`  
- ✅ `io-binance-short`
- ❌ `entry-long` - způsobí chybu
- ❌ `entry` - způsobí chybu

---

## UI Monitoring

### Temporal Worker Badge

V levém horním rohu UI se zobrazuje badge s:
- **Port**: aktuální připojený port
- **Stav**: 🟢 zelená (OK), 🔴 červená (chyba/forbidden), ⚪ šedá (odpojeno)

**Varování:**
- `⚠️ FORBIDDEN PORT!` - worker je připojen na zakázaný port (možná LONG kontaminace!)
- `DUPLICATE!` - worker je připojen na více portů současně

### Health Check Endpoint

```bash
curl http://localhost:8888/api/temporal/worker/info
```

Response obsahuje:
```json
{
  "ok": true,
  "address": "127.0.0.1:7500",
  "namespace": "trader-short",
  "configuredPort": "7500",
  "connectedPorts": ["7500"],
  "connectedForbiddenPorts": [],  // Pokud není prázdné = PROBLÉM!
  "workerCount": 1
}
```

---

## Troubleshooting

### ❌ Chyba: "TEMPORAL_ADDRESS port 7234 is FORBIDDEN"

**Příčina:** Pokus o připojení na zakázaný port (LONG instance).

**Řešení:**
```bash
# Zkontroluj .env.local
grep TEMPORAL_ADDRESS .env.local
# Mělo by být: TEMPORAL_ADDRESS=127.0.0.1:7500

# Oprav na správný port
sed -i '' 's/TEMPORAL_ADDRESS=.*/TEMPORAL_ADDRESS=127.0.0.1:7500/' .env.local
```

### ❌ Chyba: "TEMPORAL_NAMESPACE must be trader-short"

**Příčina:** Chybný nebo chybějící namespace.

**Řešení:**
```bash
# Přidej do .env.local
echo "TEMPORAL_NAMESPACE=trader-short" >> .env.local
```

### ❌ Chyba: "Temporal server not reachable"

**Příčina:** SHORT cluster neběží.

**Řešení:**
```bash
# Start cluster
./temporal/start-short-cluster.sh

# Nebo Docker Compose
docker-compose -f deploy/compose.short-temporal.yml up -d

# Ověř, že běží
nc -zv 127.0.0.1 7500
```

### ⚠️ UI zobrazuje "FORBIDDEN PORT!"

**Příčina:** Worker je připojen na zakázaný port.

**Akce:**
1. **Okamžitě zastav worker** - možná kontaminace!
2. Zkontroluj `.env.local` - musí být `TEMPORAL_ADDRESS=127.0.0.1:7500`
3. Zkontroluj, že SHORT cluster běží na portu 7500
4. Restartuj aplikaci: `./dev.sh`

---

## Migrace z hardcoded portů

Pokud přecházíš ze staré konfigurace s porty 7233/7234:

1. **Zastav vše:**
   ```bash
   pm2 delete all
   pkill -f temporal
   ```

2. **Aktualizuj .env.local:**
   ```bash
   # Změň
   TEMPORAL_ADDRESS=127.0.0.1:7233
   # Na
   TEMPORAL_ADDRESS=127.0.0.1:7500
   
   # Přidej
   TEMPORAL_NAMESPACE=trader-short
   FORBIDDEN_TEMPORAL_PORTS=7234,7600
   ```

3. **Start nový SHORT cluster:**
   ```bash
   ./temporal/start-short-cluster.sh
   ```

4. **Restart aplikace:**
   ```bash
   ./dev.sh
   ```

---

## Production Deployment

### Docker Compose (doporučeno)

```bash
# Start SHORT cluster
docker-compose -f deploy/compose.short-temporal.yml up -d

# Zkontroluj zdraví
docker-compose -f deploy/compose.short-temporal.yml ps
docker logs temporal-short-cluster

# Temporal Web UI
open http://localhost:8501
```

### PM2

```bash
# .env.local musí obsahovat
TEMPORAL_ADDRESS=127.0.0.1:7500
TEMPORAL_NAMESPACE=trader-short

# Start
pm2 start ecosystem.short.config.cjs
pm2 save
```

---

## Dodatečné poznámky

- ❌ **NIKDY** nepoužívej port `7234` pro SHORT - ten je rezervován pro LONG
- ❌ **NIKDY** nepoužívej namespace `trader-long` - způsobí fail-fast
- ✅ Vždy kontroluj UI badge - musí být zelený s portem `7500`
- ✅ V produkci používej `FORBIDDEN_TEMPORAL_PORTS` a `ALLOWED_TEMPORAL_HOSTS`
- ✅ Pro maximální izolaci používej Docker Compose s oddělenými sítěmi

---

## Reference

- **RUNBOOK**: `docs/RUNBOOK_SHORT.md`
- **Architektura**: `docs/project-overview/temporal-architecture.md`
- **Env config**: `env.SHORT.example`
- **Docker Compose**: `deploy/compose.short-temporal.yml`
- **Start script**: `temporal/start-short-cluster.sh`

