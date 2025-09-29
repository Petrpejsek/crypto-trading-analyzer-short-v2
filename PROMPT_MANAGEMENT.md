# Prompt Management Systém (DEV-ONLY)

## 📋 Přehled

Dev-only systém pro úpravu promptů asistentů s **100% garancí použití správného textu** pomocí SHA-256 attestace.

### Klíčové vlastnosti

✅ **Žádné fallbacky** - pokud prompt chybí nebo nesedí hash, běh selže tvrdě  
✅ **Dev-only** - funguje pouze v `NODE_ENV !== 'production'`  
✅ **Atomic zápis** - write→fsync→rename→fsync(dir) + read-after-write verifikace  
✅ **SHA-256 attestace** - každý běh vrací hash použitého promptu  
✅ **Přepis = smazání** - žádné verzování, staré texty se mažou  

---

## 🚀 Jak používat

### 1. Spuštění dev módu

```bash
# Ujisti se, že NODE_ENV není 'production'
export NODE_ENV=development

# Nastav dev auth token (volitelné, default: 'dev-secret-token')
export DEV_AUTH_TOKEN=your-secret-token

# Spusť server
npm run dev
```

### 2. Otevření UI

1. V hlavní liště klikni na tlačítko **📝 Prompts** (červené tlačítko)
2. Otevře se modal s:
   - **Levý panel**: seznam všech asistentů
   - **Pravý panel**: editor promptu

### 3. Úprava promptu

1. **Vyber asistenta** ze seznamu vlevo
   - Pokud má overlay: zobrazí se text + hash
   - Pokud nemá overlay: načte se text z registry
   
2. **Edituj text** v textaree
   - Uvidíš "Current hash" vs "Stored hash"
   - Při změnách se zobrazí ⚠️ "Neuložené změny"

3. **Ulož prompt**
   - Klikni na **💾 Uložit**
   - Objeví se confirm dialog s upozorněním
   - **Zaškrtni checkbox** "Souhlasím a rozumím důsledkům"
   - Klikni **Uložit**

4. **Verifikace**
   - Systém automaticky:
     - Spočítá SHA-256 hash
     - Zkontroluje linty
     - Uloží atomic write
     - Provede read-after-write verifikaci
   - Zobrazí se: `✓ Uloženo (hash...)`

5. **Export do Registry (DŮLEŽITÉ!)**
   - Klikni na **📤 Export do Registry** (zelené tlačítko nahoře)
   - Potvrd export
   - Overlay se zkopírují do `prompts/*.md`
   - **Teď musíš commitnout `prompts/*.md`!**

---

## 🔐 Jak to funguje

### Backend flow

1. **Overlay mechanismus**
   ```
   runtime/prompts/dev/
   ├── _meta.json          # Registry overlay promptů
   ├── _audit.ndjson       # Audit log použití
   └── (žádné .md soubory) # Text je v _meta.json
   ```

2. **Resolve flow**
   ```typescript
   // Dev mód
   resolveAssistantPrompt('strategy_updater', 'prompts/short/strategy_updater.md')
   // → Hledá overlay v runtime/prompts/dev/_meta.json
   // → Pokud neexistuje → FAIL HARD (žádný fallback)
   // → Vrací { text, sha256, source: 'dev-overlay' }
   
   // Prod mód
   resolveAssistantPrompt('strategy_updater', 'prompts/short/strategy_updater.md')
   // → Vždy použije fallbackPath z registry
   // → Ignoruje overlay (i kdyby existoval)
   // → Vrací { text, sha256, source: 'registry' }
   ```

3. **Save flow**
   ```typescript
   PUT /dev/prompts/:key
   Body: { text, clientSha256, ifMatchRevision }
   
   → Lint kontroly (NO_FALLBACKS + per-asistent kotvy)
   → Verifikace SHA-256 shody
   → Revision guard (conflict detection)
   → Atomic write (_meta.json)
   → Read-after-write verifikace
   → Audit log
   
   Response: { storedSha256, revision, updatedAt }
   ```

### Attestace (garance správnosti)

Každý běh asistenta vrací v `meta`:
```json
{
  "prompt_sha256": "d1de8c2c08c28c8eb9040295e32a2692...",
  "request_id": "chatcmpl-...",
  "model": "gpt-5"
}
```

UI zobrazuje:
- **Stored hash** = hash uložený v overlay
- **Current hash** = hash aktuálního textu v editoru
- **Used hash** = hash z posledního běhu (z audit logu)

---

## 🎯 Linty (blokují save)

### Globální pravidla

**NO_FALLBACKS** - zakázaná slova:
- `fallback`
- `default prompt`
- `pokud selže`
- `náhradní`

### Per-asistent kotvy

#### `strategy_updater`
✅ **Invariant**: Musí obsahovat:
- `newSL ≤ currentSL`
- `newSL = markPrice` (okamžitý exit)

#### `entry_risk_manager`
✅ **Invariant**: Musí obsahovat:
- `spread > 0.25` (skip při spread > 0.25 %)

---

## 📚 API Endpointy

### `GET /dev/prompts`
Seznam všech asistentů

**Request:**
```bash
curl -H "X-Dev-Auth: dev-secret-token" \
  http://localhost:3000/dev/prompts
```

**Response:**
```json
{
  "assistants": [
    {
      "assistantKey": "strategy_updater",
      "hasOverlay": true,
      "sha256": "d1de8c2c08c28c8eb9040295e32a2692...",
      "updatedAt": "2025-09-29T10:30:00.000Z",
      "revision": "01HZ..."
    }
  ]
}
```

### `GET /dev/prompts/:key`
Detail promptu

**Request:**
```bash
curl -H "X-Dev-Auth: dev-secret-token" \
  http://localhost:3000/dev/prompts/strategy_updater
```

**Response:**
```json
{
  "text": "Jsi profesionální trader...",
  "sha256": "d1de8c2c08c28c8eb9040295e32a2692...",
  "revision": "01HZ...",
  "updatedAt": "2025-09-29T10:30:00.000Z"
}
```

### `PUT /dev/prompts/:key`
Uložení/update promptu

**Request:**
```bash
curl -X PUT \
  -H "X-Dev-Auth: dev-secret-token" \
  -H "Content-Type: application/json" \
  -d '{"text":"...","clientSha256":"...","ifMatchRevision":"01HZ..."}' \
  http://localhost:3000/dev/prompts/strategy_updater
```

**Response:**
```json
{
  "ok": true,
  "storedSha256": "d1de8c2c08c28c8eb9040295e32a2692...",
  "revision": "01HZ...",
  "updatedAt": "2025-09-29T10:35:00.000Z"
}
```

**Error codes:**
- `400` - SHA-256 mismatch
- `409` - Revision conflict
- `422` - Lint failed

### `GET /dev/prompt-attestation/:key`
Attestation info (stored vs used)

**Response:**
```json
{
  "storedSha256": "d1de8c2c08c28c8eb9040295e32a2692...",
  "lastUsedSha256": "d1de8c2c08c28c8eb9040295e32a2692...",
  "lastUsedAt": "2025-09-29T10:40:00.000Z"
}
```

### `POST /dev/prompts/export-all`
Export všech overlay do registry

**Request:**
```bash
curl -X POST \
  -H "X-Dev-Auth: dev-secret-token" \
  http://localhost:3000/dev/prompts/export-all
```

**Response:**
```json
{
  "ok": true,
  "total": 4,
  "success": 4,
  "failed": 0,
  "results": [
    {
      "assistantKey": "strategy_updater",
      "exported": true,
      "sha256": "d1de8c2c...",
      "path": "/path/to/prompts/short/strategy_updater.md"
    }
  ]
}
```

---

## 🔧 Integrace do asistentů

### Ukázka integrace

**Před:**
```typescript
const SYSTEM_PROMPT = fs.readFileSync(
  resolvePromptPathShort('strategy_updater.md'), 
  'utf8'
)

const body = {
  model: 'gpt-5',
  messages: [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(input) }
  ]
}

// ...

return { ok: true, data, meta: { request_id: resp.id } }
```

**Po:**
```typescript
function readPrompt(): { text: string; sha256: string } {
  const { resolveAssistantPrompt, notePromptUsage } = require('../lib/dev_prompts')
  const fallback = resolvePromptPathShort('strategy_updater.md')
  const result = resolveAssistantPrompt('strategy_updater', fallback)
  notePromptUsage('strategy_updater', result.sha256)
  return result
}

// ...

const promptResult = readPrompt()
const body = {
  model: 'gpt-5',
  messages: [
    { role: 'system', content: promptResult.text },
    { role: 'user', content: JSON.stringify(input) }
  ]
}

// ...

return { 
  ok: true, 
  data, 
  meta: { 
    request_id: resp.id,
    prompt_sha256: promptResult.sha256 
  } 
}
```

### Integrované asistenty

✅ **strategy_updater** - plně integrováno  
✅ **entry_updater** - plně integrováno  
✅ **entry_strategy** (conservative + aggressive) - plně integrováno  

🔄 **Zbývající** (viz `PROMPT_INTEGRATION_GUIDE.md`):
- entry_risk_gpt
- final_picker_gpt
- hot_screener_gpt
- market_decider_gpt
- profit_taker
- top_up_executor

---

## ⚠️ KRITICKÉ pravidla

### DO ✅

- ✅ Používej UI pro všechny změny promptů v dev módu
- ✅ Po dokončení změn klikni na **📤 Export do Registry**
- ✅ Commituj **POUZE** `prompts/*.md` (ne overlay!)
- ✅ Kontroluj, že hash v meta sedí s tím, co jsi uložil

### DON'T ❌

- ❌ **NIKDY** necommituj `runtime/prompts/dev/` (overlay)
- ❌ **NIKDY** neupravuj `prompts/*.md` ručně (edituj v UI + exportuj)
- ❌ **NIKDY** nedoplňuj fallbacky do kódu
- ❌ **NIKDY** nepoužívej tento systém v produkci bez exportu

---

## 🐛 Troubleshooting

### Chyba: "Overlay prompt not found"

```
[dev_prompts] DEV MODE: Overlay prompt not found for 'strategy_updater'. 
Use Prompt Management UI to create one. NO FALLBACK.
```

**Řešení:**
1. Otevři UI (📝 Prompts)
2. Vyber asistenta
3. Editor načte text z registry
4. Ulož ho (vytvoří overlay)

### Chyba: "SHA-256 mismatch"

```
[dev_prompts] SHA-256 mismatch: client=d1de8c2c..., server=a8b37822...
```

**Řešení:**
- Reload stránky (někdo jiný upravil prompt)
- Zkus save znovu

### Chyba: "Revision conflict"

```
Revision conflict - někdo jiný upravil prompt, reload stránky
```

**Řešení:**
- Reload stránky
- Zkopíruj si své změny
- Merge ručně
- Ulož znovu

### Chyba: "Lint failed"

```
Lint failed:
  - NO_FALLBACKS: Zakázané slovo: "fallback"
  - STRATEGY_UPDATER_INVARIANT: Chybí invariant: "newSL ≤ currentSL"
```

**Řešení:**
- Odstraň zakázaná slova
- Přidej chybějící kotvy/invarianty
- Zkus save znovu

---

## 📊 Audit trail

Každé použití promptu se loguje do `runtime/prompts/dev/_audit.ndjson`:

```json
{"timestamp":"2025-09-29T10:40:00.000Z","assistantKey":"strategy_updater","sha256":"d1de8c2c...","action":"used"}
{"timestamp":"2025-09-29T10:35:00.000Z","assistantKey":"strategy_updater","sha256":"d1de8c2c...","action":"set_overlay"}
```

### Účel
- Verifikace, že běh použil správný prompt
- Audit změn v čase
- Debug nesrovnalostí mezi UI a skutečným během

---

## 🔍 Technické detaily

### Struktura `_meta.json`

```json
{
  "strategy_updater": {
    "assistantKey": "strategy_updater",
    "sha256": "d1de8c2c08c28c8eb9040295e32a2692fa2a3c047820d7eebce54af53da6c957",
    "revision": "01HZABCDEF123456789",
    "updatedAt": "2025-09-29T10:35:00.000Z",
    "text": "Jsi profesionální intradenní trader kryptoměn..."
  }
}
```

### SHA-256 výpočet

```typescript
// Backend (Node.js)
crypto.createHash('sha256').update(text, 'utf8').digest('hex')

// Frontend (Browser)
crypto.createHash('sha256').update(text, 'utf8').digest('hex')
// (používá crypto-browserify)
```

### Atomic write sekvence

1. Write to temp file: `_meta.json.tmp.{ulid}`
2. fsync file descriptor
3. Rename temp → `_meta.json`
4. fsync parent directory
5. Read-after-write verification

---

## 📖 Další dokumenty

- **`PROMPT_MANAGEMENT_FLOW.md`** - detailní flow dev → prod (START ZDE!)
- `PROMPT_INTEGRATION_GUIDE.md` - průvodce pro integraci do zbývajících asistentů
- `prompts/short/registry.json` - production registry s hashy
- `docs/PROMPTS_MAP.md` - mapa všech promptů v systému
- `scripts/export_prompts_to_registry.ts` - CLI script pro export

---

## 📝 Shrnutí

**Kompletní flow:**

```
1. Dev: Edituj v UI → Save → overlay
2. Dev: Testuj s overlay
3. Export: 📤 Export do Registry → prompts/*.md
4. Commit: git add prompts/ && git commit
5. Deploy: Prod používá prompts/*.md
```

✅ **Klíčové:**
- Overlay = dev staging (necommituje se)
- Export = migrace změn do registry
- Prod = ignoruje overlay, čte registry

📖 **Více info**: Viz `PROMPT_MANAGEMENT_FLOW.md`

---

**Autor**: AI/Cursor  
**Vytvořeno**: 2025-09-29  
**Verze**: 2.0.0 (s export mechanismem)
