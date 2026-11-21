# Embeddingi korpusu

Pliki generuje `src/engine/retrieval/embed-corpus.ts` (model `Xenova/multilingual-e5-small`, kwantyzowany ONNX, prefiks `passage: `):

- `<slug>.bin` — Float32 little-endian, `count × dims`, wiersze znormalizowane L2,
- `<slug>.manifest.json` — `ids` (kolejność wierszy), `dims`, `modelId`, `modelHash` (SHA-256 pliku wag), `snapshotId` (migawka korpusu), `binSha256`.

Generowanie (po `npm run corpus:load`, wymaga modelu — pierwsze uruchomienie pobiera ~120 MB):

    npx tsx src/engine/retrieval/embed-corpus.ts

Po każdej zmianie korpusu (zmiana `snapshot_id`) trzeba przeliczyć i zacommitować oba pliki. Gdy manifest nie zgadza się z modelem,
hashem modelu lub migawką korpusu, gałąź wektorowa zgłasza się jako niedostępna i silnik używa samego BM25 (z adnotacją w raporcie).
