# Process Lock System

## Problém

Pokud spustíš omylem dvě instance traderu (např. přes PM2 a zároveň přes `dev.sh`), může dojít k:

- ❌ Duplicitním API callům k Binance
- ❌ Race conditions v SQLite databázích
- ❌ Duplicitnímu zpracování WebSocket událostí
- ❌ Temporal worker conflicts
- ❌ Nepřehlednému chování a logům

## Řešení: Process Lock

Implementovali jsme **PID lock file systém**, který zabraňuje duplicitnímu běhu stejné instance.

### Jak funguje

1. **Při startu** aplikace (backend nebo worker):
   - Vytvoří se lock file: `runtime/locks/backend.short.lock` nebo `runtime/locks/worker.short.lock`
   - Lock file obsahuje PID procesu, timestamp a trade side

2. **Pokud se pokusíš spustit druhou instanci**:
   - Systém zkontroluje, zda lock file existuje
   - Ověří, zda proces s daným PID stále běží
   - Pokud ANO → **zastaví se s chybou** a vypíše PID první instance
   - Pokud NE (stale lock) → automaticky odstraní starý lock a spustí se

3. **Při ukončení aplikace**:
   - Lock file se automaticky odstraní
   - Funguje i při SIGINT, SIGTERM nebo uncaughtException

### Lock Files

Lock files jsou v `runtime/locks/`:
```
runtime/locks/
├── backend.short.lock
└── worker.short.lock
```

Formát lock file:
```json
{
  "pid": 51172,
  "started": "2025-10-18T22:38:49.123Z",
  "tradeSide": "SHORT",
  "processName": "trader-short-backend"
}
```

## Použití

### Kontrola stavu locků

```bash
npm run locks:check
```

Ukáže:
- Které procesy mají aktivní lock
- PID, trade side, čas startu
- Zda jsou procesy stále běžící

### Vymazání všech locků (emergency)

```bash
npm run locks:clear
```

⚠️ **POZOR:** Toto pouze smaže lock files, ale **nezastaví běžící procesy!**

Pokud potřebuješ zastavit procesy:
```bash
pm2 stop all
npm run locks:clear  # Vyčistit lock files
```

### Programové použití

```typescript
import { acquireLock, releaseLock, getLockInfo } from './server/lib/processLock'

// Získat lock na začátku aplikace
try {
  acquireLock('backend')
} catch (e) {
  console.error('Cannot start - another instance is running')
  process.exit(1)
}

// Zjistit info o locku
const lockInfo = getLockInfo('backend')
if (lockInfo) {
  console.log(`Backend běží s PID ${lockInfo.pid}`)
}

// Uvolnit lock (automaticky při exit, ale můžeš i manuálně)
releaseLock('backend')
```

## Scénáře

### ✅ Normální start (bez konfliktu)

```bash
$ pm2 start ecosystem.short.config.cjs
[PROCESS_LOCK_ACQUIRED] { processType: 'backend', tradeSide: 'SHORT', pid: 51172 }
[PROCESS_LOCK_ACQUIRED] { processType: 'worker', tradeSide: 'SHORT', pid: 48425 }
✅ Aplikace běží
```

### ❌ Duplicitní start (konflikt)

```bash
$ npm run dev:server
[PROCESS_LOCK_CONFLICT] Another backend (SHORT) is already running!
[PROCESS_LOCK_CONFLICT] Existing process: { pid: 51172, started: '2025-10-18T22:38:49Z' }
[PROCESS_LOCK_CONFLICT] To force restart, run: kill 51172
[FATAL] LOCK_CONFLICT: backend (SHORT) is already running (PID: 51172)
```

### 🔄 Stale lock (proces je mrtvý)

```bash
$ npm run dev:server
[PROCESS_LOCK_STALE] Found stale lock file for PID 12345, removing...
[PROCESS_LOCK_ACQUIRED] { processType: 'backend', tradeSide: 'SHORT', pid: 51500 }
✅ Aplikace běží (starý lock automaticky odstraněn)
```

## Integrace v kódu

### Backend (`server/index.ts`)

```typescript
import { acquireLock } from './lib/processLock'

// Hned na začátku, před jakoukoliv inicializací
try {
  acquireLock('backend')
} catch (e: any) {
  console.error('[FATAL]', e?.message || e)
  process.exit(1)
}
```

### Worker (`temporal/worker.ts`)

```typescript
import { acquireLock } from '../server/lib/processLock'

async function run(): Promise<void> {
  try {
    acquireLock('worker')
  } catch (e: any) {
    console.error('[FATAL]', e?.message || e)
    process.exit(1)
  }
  
  // ... rest of worker initialization
}
```

## Trade Side Izolace

Lock system respektuje `TRADE_SIDE` env variable:
- SHORT instance má lock: `backend.short.lock`
- LONG instance by měla: `backend.long.lock`

To znamená, že SHORT a LONG instance **mohou běžet současně** (mají různé lock files), ale **duplicitní SHORT × SHORT nebo LONG × LONG není možné**.

## Troubleshooting

### Problem: "LOCK_CONFLICT" při startu

**Řešení:**
1. Zkontroluj běžící procesy: `pm2 list`
2. Pokud žádné neběží, vymaž lock: `npm run locks:clear`
3. Pokud běží, zastav je: `pm2 stop all` nebo `kill <PID>`

### Problem: Lock file zůstal po crash

**Řešení:**
```bash
npm run locks:clear
```

### Problem: Chci restartovat bez čekání

**Řešení:**
```bash
# Zastav vše a vyčisti locky naráz
pm2 stop all && npm run locks:clear && pm2 start ecosystem.short.config.cjs
```

## Výhody

✅ **Prevence duplicitních instancí** - nelze omylem spustit dvě instance
✅ **Automatické cleanup** - při normálním i abnormálním ukončení
✅ **Stale lock detection** - automaticky odstraní staré locky z mrtvých procesů
✅ **Trade Side izolace** - SHORT a LONG mohou běžet vedle sebe
✅ **Explicitní error messages** - jasné informace při konfliktu

## Kdy dojde k automatickému cleanup

Lock se automaticky uvolní při:
- ✅ `process.exit()`
- ✅ `SIGINT` (Ctrl+C)
- ✅ `SIGTERM` (PM2 stop)
- ✅ `uncaughtException`
- ✅ Normální ukončení aplikace

## API Reference

### `acquireLock(processType)`
Získá exkluzivní lock. Hází error pokud lock již existuje.

**Parameters:**
- `processType`: `'backend'` | `'worker'`

**Throws:**
- Error pokud lock již drží jiný běžící proces

### `releaseLock(processType)`
Uvolní lock (pokud patří aktuálnímu procesu).

### `getLockInfo(processType)`
Vrátí info o aktuálním lock holderu nebo `null`.

**Returns:**
```typescript
{
  pid: number
  started: string
  tradeSide: string
  processName: string
} | null
```

### `forceRemoveLock(processType)`
Násilně odstraní lock (use with caution!).

