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
- Batch flow:
  1) paralelně odešle VŠECHNY ENTRY LIMIT objednávky (BUY)
  2) čeká pevně 3s (konfig)
  3) paralelně odešle VŠECHNY SL (STOP_MARKET, closePosition=true)
  4) TP LIMIT reduceOnly se NEOdesílá hned – naplánuje se „waiting TP“ a odešle se AUTOMATICKY, jakmile existuje pozice (viz Waiting TP)

- Rounding: v režimu `RAW_PASSTHROUGH=true` engine neposouvá ceny – používá přesně UI hodnoty.
- Leverage: před ENTRY se pokusí nastavit `POST /fapi/v1/leverage` na požadovanou hodnotu (bez tvrdého failu při chybě).
- Working type: `MARK_PRICE` pro SL/TP MARKET.
- Dedup symbolů: server filtruje duplicitní symboly v requestu.

### Waiting TP
- Registry: in-memory `waitingTpBySymbol` + persist `runtime/waiting_tp.json`.
- Odeslání TP LIMIT (reduceOnly) se provede v `waitingTpProcessPassFromPositions()` během průchodu `/api/orders_console` nebo `/api/positions`, jakmile pozice existuje.
- Parametry TP LIMIT: SELL LIMIT s `price=tp * 1.03`, `stopPrice=tp`, `timeInForce=GTC`, `quantity = abs(positionAmt)`, `reduceOnly=true`.

### Sanitizace a whitelist
- Bezpečnostní pravidla v několika vrstvách:
  - `services/exchange/binance/safeSender.ts` (wrap klienta):
    - nikdy neposílej `reduceOnly` spolu s `closePosition=true`
    - SELL LIMIT (TP) – odstranit reduceOnly, pokud by bránil pre-entry odeslání
    - blokace `closePosition=true` pro typy jiné než `STOP_MARKET` a `TAKE_PROFIT_MARKET`
  - `BinanceFuturesAPI.request()` a `placeOrder()` – identická pravidla + robustní logování `[OUTGOING_ORDER]` / `[BINANCE_ERROR]`

### Guardy proti okamžitému triggeru
- SL/TP MARKET se kontrolují proti MARK pouze v SAFE sekvencích v jiných režimech; V3 používá waiting TP s delay – tím minimalizuje -2021 chyby.

### Výstup (server → UI)
Server vrací `engine: "v3_batch_2s"` plus list výsledků (per symbol `executed|error`) a echo struktur. UI následně čte `/api/orders_console` pro živý stav a waiting TP list.

### Kdy použít V2 (sekvenční)
- `services/trading/binance_futures_batch.ts` (`executeHotTradingOrdersV2`) – když je potřeba přísnější sekvenční průchod s kontrolami MARK a on-fill variantami. V aktuální konfiguraci je výchozí V3.


