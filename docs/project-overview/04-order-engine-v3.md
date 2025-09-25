## V3 Order Engine (Batch 2s)

Implementace: `services/trading/binance_futures.ts` → `executeHotTradingOrders()` → `executeHotTradingOrdersV3_Batch2s()`

### Vstup (UI → server)
`POST /api/place_orders`
```json
{
  "orders": [
    {
      "symbol": "XYZUSDT",
      "side": "LONG",
      "strategy": "conservative|aggressive",
      "tpLevel": "tp1|tp2|tp3",
      "orderType": "limit|stop|stop_limit",
      "amount": 20,
      "leverage": 15,
      "entry": 1.2345,
      "sl": 1.1111,
      "tp": 1.3456
    }
  ]
}
```

### Politika V3
- Batch flow (aktuální):
  1) paralelně odešle VŠECHNY ENTRY LIMIT objednávky (BUY)
  2) čeká pevně 3s (konfig)
  3) paralelně odešle VŠECHNY SL (STOP_MARKET, closePosition=true)
  4) TP se řídí přepínačem `V3_TP_IMMEDIATE_MARKET` v `config/trading.json`:
     - `true` (immediate): odešle se okamžitě TP MARKET (closePosition=true) – funguje i bez fillu, hedge-aware (`positionSide`)
     - `false` (waiting) – AKTUÁLNÍ STAV: TP MARKET (closePosition=true) se odešle automaticky, jakmile existuje pozice (viz Waiting TP)

- Rounding: v režimu `RAW_PASSTHROUGH=true` engine neposouvá ceny – používá přesně UI hodnoty.
- Leverage: před ENTRY se pokusí nastavit `POST /fapi/v1/leverage` na požadovanou hodnotu (bez tvrdého failu při chybě).
- Working type: `MARK_PRICE` pro SL/TP MARKET.
- Dedup symbolů: server filtruje duplicitní symboly v requestu.

### Waiting TP
- Registry: in-memory `waitingTpBySymbol` + persist `runtime/waiting_tp.json`.
- Odeslání se provede v `waitingTpProcessPassFromPositions()` během průchodu `/api/orders_console` nebo `/api/positions`, jakmile pozice existuje.
- Parametry TP (AKTUÁLNĚ): TP MARKET (closePosition=true), `workingType=MARK_PRICE`, hedge-aware (`positionSide`). Žádné zaokrouhlování – RAW UI `tp`.

### Sanitizace a whitelist
- Bezpečnostní pravidla v několika vrstvách:
  - `services/exchange/binance/safeSender.ts` (wrap klienta):
    - nikdy neposílej `reduceOnly` spolu s `closePosition=true`
    - SELL LIMIT (TP) – odstranit reduceOnly, pokud by bránil pre-entry odeslání
    - blokace `closePosition=true` pro typy jiné než `STOP_MARKET` a `TAKE_PROFIT_MARKET`
  - `BinanceFuturesAPI.request()` a `placeOrder()` – identická pravidla + robustní logování `[OUTGOING_ORDER]` / `[BINANCE_ERROR]`

### Guardy proti okamžitému triggeru
- SL/TP MARKET se proti MARK neblokují (fungují i bez fillu); waiting varianta minimalizuje -2021 (would immediately trigger) u TP.

### Sweeper (auto-cancel stáří)
- Přepínač: `pending_cancel_age_min` (0 = vypnuto)
- Bezpečné chování (opraveno): Sweeper ruší POUZE BUY LIMIT ENTRY (bez `reduceOnly/closePosition`). EXIT objednávky (STOP/TP) NIKDY nemaže.

### Výstup (server → UI)
Server vrací `engine: "v3_batch_2s"` plus list výsledků (per symbol `executed|error`) a echo struktur. UI následně čte `/api/orders_console` pro živý stav a waiting TP list.

### Stav engine
- V3 je jediný podporovaný engine. V1/V2 byly odstraněny/deaktivovány, všechny cesty používají `executeHotTradingOrders()` → V3.

