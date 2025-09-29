# Průvodce integrace Prompt Management systému

## ✅ Hotové asistenty

- [x] `strategy_updater` - plně integrováno
- [x] `entry_updater` - plně integrováno
- [x] `entry_strategy` (conservative + aggressive) - plně integrováno

## 🔄 Zbývající asistenty k integraci

Pro každý asistent proveď tyto kroky:

### 1. Nahraď readFileSync za resolveAssistantPrompt

**Před:**
```typescript
const SYSTEM_PROMPT = fs.readFileSync(resolvePromptPathShort('assistant_name.md'), 'utf8')
```

**Po:**
```typescript
function getPrompt(): { text: string; sha256: string } {
  const { resolveAssistantPrompt, notePromptUsage } = require('../lib/dev_prompts')
  const fallback = resolvePromptPathShort('assistant_name.md')
  const result = resolveAssistantPrompt('assistant_name', fallback)
  notePromptUsage('assistant_name', result.sha256)
  return result
}
```

### 2. Použij `.text` při volání API

**Před:**
```typescript
messages: [
  { role: 'system', content: SYSTEM_PROMPT },
  ...
]
```

**Po:**
```typescript
const promptResult = getPrompt()
messages: [
  { role: 'system', content: promptResult.text },
  ...
]
```

### 3. Přidej hash do meta při úspěšném výsledku

```typescript
return { ok: true, data, meta: { 
  ...existingMeta, 
  prompt_sha256: promptResult.sha256 
} }
```

## 🎯 Seznam asistentů k dokončení

1. **entry_risk_gpt** (`services/decider/entry_risk_gpt.ts`)
   - Key: `entry_risk_manager`
   - Fallback: `prompts/short/entry_risk_manager.md`

2. **hot_screener_gpt** (`services/decider/hot_screener_gpt.ts`)
   - Key: `hot_screener`
   - Fallback: `prompts/short/hot_screener.md`

3. **profit_taker** (`services/profit-taker/decision.ts`)
   - Key: `profit_taker`
   - Fallback: `prompts/short/profit_taker.md`

4. **top_up_executor** (`services/top-up-executor/decision.ts`)
   - Key: `top_up_executor`
   - Fallback: `prompts/short/top_up_executor.md`

## 🔥 Testování

1. Nastav `NODE_ENV=development` (nebo neproduction)
2. V UI klikni na tlačítko "📝 Prompts"
3. Vyber asistenta ze seznamu
4. První save vytvoří overlay (staré texty se nepřepisují automaticky)
5. Po save musí být zobrazeno: `✓ Uloženo (hash...)`
6. Další běh asistenta musí používat overlay a vrátit správný hash v `meta.prompt_sha256`

## ⚠️ KRITICKÉ

- **Žádné fallbacky** - pokud v dev módu chybí overlay, systém failne
- V **produkci** se vždy používá `prompts/*.md` z registry (overlay se ignoruje)
- Každý běh vrací použitý hash v meta pro verifikaci
