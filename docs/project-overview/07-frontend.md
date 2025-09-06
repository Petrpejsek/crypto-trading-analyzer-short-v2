## Frontend (React + Vite)

### Dev/Build
- Dev: `npm run dev` (Vite `:4000`) – proxy `/api`, `/__proxy` → `:8788`
- Build: `npm run build` → `dist/` – server poté servíruje statiku s REST API na stejné doméně

### Hlavní komponenty
- `src/ui/App.tsx` – orchestrace pipeline (snapshot → features → decision → hot screener → entry → place orders)
- `src/ui/components/OrdersPanel.tsx` – pozice, otevřené objednávky, waiting TP, flatten/cancel, backoff indikace
- `src/ui/components/*` – Decision banner, Setups table, Hot screener, Entry controls

### Workflow UI (hot trading)
1) Copy RAW (metrics) → získat kandidáty
2) Hot Screener (GPT) → Super Hot výběr (auto-select s WS/positions bloky)
3) Analyze selected (Entry Strategy per symbol)
4) Prepare Orders (mapování přesně na GPT entry/sl/tp; žádné locked-values)
5) Place Orders (POST `/api/place_orders` → V3 engine)

### Strict no-fallback zásady v UI
- Žádné lokální „opravy“ čísel – UI posílá přesně to, co vidí.
- MARK guard v UI pouze varuje, server provede finální validaci.
- WS snapshot není seedován RESTem – UI respektuje prázdné seznamy, dokud WS není ready.



