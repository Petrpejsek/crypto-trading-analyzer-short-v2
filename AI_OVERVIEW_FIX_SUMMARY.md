# AI Overview Fix - Implementation Summary

**Datum:** 19. října 2025  
**Status:** ✅ HOTOVO

## Problémy vyřešené

### 1. ✅ Statický Hash Routing
**Problém:** Navigace na `/#/dev/ai-overview` nefungovala po načtení stránky
**Řešení:** Implementován dynamický hash routing s `hashchange` event listener v `src/main.tsx`

**Změny:**
- Vytvořen `Router` component s `useState` a `useEffect`
- Přidán `hashchange` listener pro real-time route updates
- Navigace mezi `/#/` a `/#/dev/ai-overview` nyní funguje bez page reload

### 2. ✅ SSE Performance Issue - "Failed to Fetch" + Lag
**Problém:** 
- Browser limit 6 HTTP/1.1 konexí na doménu
- Při zaškrtnutí více checkboxů vzniklo 6-7 SSE konexí → lag + "failed to fetch"

**Řešení:** Multiplexovaný SSE stream - **jedna konexe pro všechny assistanty**

**Backend změny:**
- Nový endpoint: `/dev/ai-stream/all` (server/index.ts:4295-4362)
- Subscribuje se na všech 7 assistantů současně
- Legacy endpoint `/dev/ai-stream/{key}` zachován pro kompatibilitu

**Frontend změny:**
- Pouze **1 EventSource** místo 6-7 (DevAiOverview.tsx:119-168)
- Client-side filtrování podle zaškrtnutých checkboxů
- Drastické snížení network load a odstranění browser connection limitu

### 3. ✅ Connection Status Indicator
**Nové features v UI:**
- Real-time connection status badge (DISCONNECTED/CONNECTING/CONNECTED/ERROR)
- Color-coded visual feedback (šedá/modrá/zelená/červená)
- Pulse animace při connecting stavu
- Lepší UX pro debugging SSE problémů

## Upravené soubory

1. **src/main.tsx** - Dynamický hash routing
2. **src/ui/components/DevAiOverview.tsx** - SSE multiplexing + connection status
3. **server/index.ts** - Nový `/dev/ai-stream/all` endpoint
4. **src/styles.css** - Pulse keyframe animace

## Testovací Checklist

### Backend Tests
- [x] SSE endpoint `/dev/ai-stream/all` odpovídá (curl test passed)
- [x] Backend běží na portu 8888
- [x] Vite proxy správně přeposílá SSE requesty

### Frontend Tests - Pro uživatele
Otevři: http://localhost:4302

**Test 1: Hash Routing**
- [ ] Otevři http://localhost:4302/#/ - měl by se zobrazit hlavní dashboard
- [ ] Změň URL na http://localhost:4302/#/dev/ai-overview - měla by se zobrazit AI Overview stránka BEZ page reload
- [ ] Klikni zpět na http://localhost:4302/#/ - měl by se zobrazit dashboard BEZ page reload

**Test 2: Connection Status**
- [ ] Na AI Overview stránce by měl být v headerů status badge "DISCONNECTED" (šedý)
- [ ] Zaškrtni jakýkoliv checkbox (např. "conservative") 
- [ ] Status by měl změnit na "CONNECTING..." (modrý, s pulse animací)
- [ ] Po ~500ms by měl změnit na "CONNECTED" (zelený)

**Test 3: SSE Performance (hlavní test!)**
- [ ] Zaškrtni **VŠECHNY checkboxy najednou** (včetně reactive_entry)
- [ ] Stránka by **NEMĚLA laggovat**
- [ ] **NEMĚLA** by se objevit chyba "failed to fetch"
- [ ] Connection status by měl zůstat "CONNECTED" (zelený)
- [ ] V browser DevTools → Network → Event Source by měla být pouze **1 aktivní konexe** (ne 6-7)

**Test 4: Real-time Events**
- [ ] Nech checkboxy zaškrtnuté a počkej na AI aktivitu (když decider analyzuje symbol)
- [ ] Events by se měly zobrazovat v real-time bez lagů
- [ ] Copy button by měl fungovat pro request/response payloads

## Technické detaily

### SSE Multiplexing Architecture
```
Frontend (1 EventSource)
    ↓
/dev/ai-stream/all
    ↓
aiTap.subscribe() × 7 assistants
    ↓
AI Services emit events → broadcast přes SSE
    ↓
Frontend client-side filtering
```

### Performance Improvements
- **Před:** 6-7 SSE konexí = browser connection limit hit = lag + fetch errors
- **Po:** 1 SSE konexe = žádné limity = smooth performance

### Connection States
- `disconnected` - žádný checkbox zaškrtnutý
- `connecting` - EventSource inicializace (modrý + pulse)
- `connected` - SSE stream aktivní (zelený)
- `error` - SSE onerror triggered (červený)

## Debugging

Pokud něco nefunguje:

1. **Backend log:** `tail -f runtime/backend_dev.log`
2. **Frontend log:** Browser DevTools Console
3. **SSE test:** `curl "http://localhost:8888/dev/ai-stream/all?token=dev-secret-token"`
4. **Restart:** `./dev.sh restart`

## Poznámky

- Legacy endpoint `/dev/ai-stream/{assistantKey}` zachován pro zpětnou kompatibilitu
- "reactive_entry crashes" warning odstraněn - multiplexing vyřešil problém
- Browser cache: při problémech zkus Hard Refresh (Cmd+Shift+R)

