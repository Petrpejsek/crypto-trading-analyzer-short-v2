## Rate limiting, backoff a logging

### Sběr telemetrie
- `server/lib/rateLimits.ts` – funkce `noteApiCall()` se volá u všech REST volání na Binance a sbírá hlavičky:
  - `x-mbx-used-weight-1m`
  - `x-mbx-order-count-10s`, `x-mbx-order-count-1m`
  - `retry-after`
  - oznamuje události 429 a kód -1003 (ban window)

### Backoff
- Při 429 nebo -1003 se nastaví `banUntilMs` (z hlavičky/parsované zprávy) a server i UI omezují dotazy.
- `GET /api/limits` vrací snapshot pro UI – riziko: `normal|elevated|critical`, poslední zásahy, recent calls.

### Logging a audit
- Všechny odchozí objednávky: `[OUTGOING_ORDER]` s typem, cenami, flagy.
- Chyby Binance: `[BINANCE_ERROR]` s kódem, zprávou a payloadem.
- Batch sekvence: `[BATCH_*]` fáze a výsledky.
- User-data WS: `[USERDATA_WS_*]` connect/rehydrate/update eventy.
- Orders audit: `/api/debug/cancel_audit` poskytuje poslední cancel/filled události pro UI footer.

### Sweeper
- Server periodicky ruší staré ENTRY objednávky dle `pending_cancel_age_min` (nastavitelné přes `PUT /api/trading/settings`).
  - handshake logika: pokud dojde k auto-cancel, UI parametr se resetuje na 0.





