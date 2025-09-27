Prompts workflow (SHORT only)

- Prompty se mění pouze přes PR s povinným review.
- Všechny prompty musí být umístěny v `prompts/short/`.
- Je zakázáno měnit soubory pod `prompts/long/**` (v tomto repu se nepoužívá).
- Před commitem spusť:
  - `npm run check-prompts` – vygeneruje/aktualizuje `prompts/short/registry.json` a `SNAPSHOT_*.md`.
- Do commit message u prompt změn přidej `prompts:` prefix.

Pre-commit hook (návrh):
- Zablokuje commit, pokud se mění soubory mimo `prompts/short/**` se slovem `prompts/` v cestě.
- CI job `prompt-side-lint` ověří:
  - že žádné změny nejsou mimo `prompts/short/**`;
  - že `registry.json` odpovídá souborům (počet, checksumy);
  - že `PROMPTS_SIDE=SHORT` proběhne log při startu.


