# 🚀 Binance API Cache Optimalizace - Testing Guide

## ✅ Implementováno

### 1. Cache Layer (`server/lib/apiCache.ts`)
- TTL-based cache s automatickou expirací
- Konfigurace TTL per endpoint (5s-1h)
- Automatický cleanup každých 5 minut
- Stats tracking (hits, misses, evictions, hit rate)

### 2. Request Coalescer (`server/lib/requestCoalescer.ts`)
- Sloučení duplicitních in-flight requestů
- Stats tracking (unique, coalesced, save rate)

### 3. Integrace (`server/fetcher/binance.ts`)
- 3-vrstvý flow: Cache → Coalescer → API
- Podpora `skipCache` parametru pro force refresh
- Zachována retry logic

### 4. Monitoring Endpoint
- **GET `/api/cache_stats`** - Cache a coalescer statistiky
- **GET `/api/limits`** - Rate limit monitoring (už existoval)

---

## 🧪 Jak testovat

### 1️⃣ Spusť server
```bash
cd /Users/petrliesner/trader-short-v2
npm run dev
# nebo
node --loader tsx server/index.ts
```

### 2️⃣ Monitoruj cache statistiky

**Cache Stats:**
```bash
curl http://localhost:8789/api/cache_stats
```

**Očekávaný výstup:**
```json
{
  "ok": true,
  "cache": {
    "hits": 1247,
    "misses": 156,
    "evictions": 23,
    "size": 89,
    "hitRate": 88.9
  },
  "coalescer": {
    "unique": 234,
    "coalesced": 567,
    "total": 801,
    "saveRate": 70.8,
    "pending": 0
  },
  "timestamp": "2025-10-18T14:30:00.000Z"
}
```

**Rate Limits:**
```bash
curl http://localhost:8789/api/limits
```

**Sleduj:**
- `lastUsedWeight1m` - cíl: <800 (bylo ~1530)
- `risk` - cíl: "normal" (nebylo "critical")
- `callRate.per60s` - cíl: <50 (bylo ~120)

### 3️⃣ Console logy

Sleduj tyto logy v terminálu:
```
[CACHE_HIT] /fapi/v2/positionRisk
[COALESCE_HIT] Key: /fapi/v1/openOrders:symbol=BTCUSDT
[CACHE_CLEANUP] Removed 15 expired entries
```

**High hit rate = cache funguje!**

---

## 📊 Očekávané výsledky

### PŘED optimalizací:
- API calls: ~120/min
- Weight: ~1530/min ❌ **ČASTO BAN**
- Cache hit rate: 0%

### PO optimalizaci:
- API calls: ~30/min (↓ 75%)
- Weight: ~400/min ✅ **BEZPEČNĚ POD LIMITEM**
- Cache hit rate: **75-85%**
- Coalescer save rate: **50-70%**

---

## 🎯 Monitoring checklist

Po 5 minutách běhu zkontroluj:

- [ ] `/api/cache_stats` - hit rate >70%
- [ ] `/api/limits` - weight <800/min
- [ ] Console: pravidelné `[CACHE_HIT]` logy
- [ ] Console: pravidelné `[COALESCE_HIT]` logy
- [ ] Žádné Binance 429 errors
- [ ] Frontend funguje (pozice, orders refreshují se)
- [ ] Strategy Updater funguje (3min cycle)

---

## 🔧 Konfigurace

### Cache TTL (lze upravit v `server/lib/apiCache.ts`):

```typescript
'/fapi/v2/positionRisk': 5000      // 5s
'/fapi/v1/openOrders': 5000        // 5s
'/fapi/v1/premiumIndex': 10000     // 10s
'/fapi/v1/klines': 30000           // 30s
'/fapi/v1/ticker/24hr': 120000     // 2min
'/fapi/v1/exchangeInfo': 3600000   // 1h
```

### Force bypass cache:
```typescript
// V kódu
await httpGet('/fapi/v1/klines', params, skipCache: true)

// Nebo
await httpGetCached('/fapi/v1/ticker/24hr', params, ttl, fresh: true)
```

---

## 🐛 Troubleshooting

### Cache hit rate je nízký (<50%)
- Zkontroluj, že všechny `httpGet()` volání NEPŘESKAKUJÍ cache
- Zkontroluj TTL hodnoty - možná jsou moc krátké

### Stále vysoký weight
- Zkontroluj `/api/limits` - který endpoint má nejvíc calls
- Zvyš TTL pro daný endpoint
- Zkontroluj, že coalescer funguje (`saveRate` >50%)

### Data nejsou fresh
- Zkrať TTL pro daný endpoint
- Nebo použij `fresh: true` parametr

---

## 📝 Poznámky

- **Zachovány všechny intervaly** (frontend 5s, sweeper 10s, strategy updater 30s)
- **SHORT-only** systém - žádné LONG změny
- **Žádné fallbacky** - strict error handling
- Cache se automaticky čistí každých 5 minut
- Možnost úplného vypnutí: `skipCache=true` všude

---

## ✅ Next Steps (pokud potřeba)

Pokud i s cache je weight stále vysoký:
1. Frontend: 5s → 10s polling
2. Sweeper: 10s → 20s
3. SL Monitor: 30s → 60s

**ALE nejdřív změř efekt cache!**

