CI / Pre-commit návrhy

pre-commit hook (návrh)
- Odmítne commit, pokud jsou změny mimo `prompts/short/**` a zároveň obsahují `prompts/` v cestě.
- Odmítne commit, pokud chybí update `prompts/short/registry.json` při změně promptů.

CI joby
- prompt-side-lint:
  - ověř `TRADE_SIDE=SHORT`
  - ověř, že žádné změny nejsou v `prompts/long/**`
- prompt-checksum:
  - spusť `npm run check-prompts`
  - porovnej checksums z `registry.json` vs. reálné soubory


