# Router modeli

Każde wywołanie modelu w Fons przechodzi przez router (`src/engine/llm/router.ts`). Router decyduje, **który model** obsłuży dane zadanie, i co zrobić, gdy model zawiedzie. Tabela w kodzie (`ROUTING_TABLE`) jest jedynym źródłem prawdy; ta strona ją opisuje.

## Tabela: zadanie → model

| Zadanie (`purpose`) | Co robi | Model |
|---|---|---|
| `claims` | rozpoznaje rodzaj wiadomości (twierdzenie / pytanie tak-nie / pytanie otwarte) i wypisuje twierdzenia | szybki (`MODEL_FAST`) |
| `router` | prowadzi rozmowę na podstawie zamaskowanej historii, dopytuje o brakujące szczegóły albo zleca weryfikację, pokazanie źródeł lub uzasadnienia | szybki |
| `verifier` | niezależne sprawdzenie cytatów (jedno zbiorcze wywołanie) | szybki (dostawca weryfikatora) |
| `vision` | przepisanie tekstu ze zrzutu ekranu lub zdjęcia | szybki |
| `smooth` | opcjonalne wygładzenie uzasadnienia z szablonu (domyślnie wyłączone) | szybki |
| `assess` | ocena fragmentów źródeł: relacja, aspekt, dosłowny cytat | główny (`MODEL_MAIN`) |
| `open_answer` | wybór dosłownego cytatu, który odpowiada na pytanie otwarte | główny |

Zadanie spoza tabeli używa poziomu wskazanego przez wywołującego (domyślnie główny).

## Gdy model zawiedzie

1. **Model szybki** zwrócił odpowiedź niezgodną ze schematem, odmówił albo przekroczył czas → **jedna** ponowna próba na modelu głównym tego samego dostawcy.
2. **Model szybki** zawiódł z powodu dostawcy (limit, błąd serwera, budżet) → od razu dostawca zapasowy (jeśli jest), bo model główny tego samego dostawcy najpewniej też nie odpowie.
3. **Model główny** zawiódł (z dowolnego powodu) → **dostawca zapasowy z innej rodziny modeli**, jeśli skonfigurowano drugi klucz (`VERIFIER_PROVIDER`). Bez drugiego klucza: błąd `LlmUnavailableError` i odpowiedź „NIEPEŁNE” — bez werdyktu, bez treści błędu dostawcy.
4. Przerwanie przez użytkownika (anulowanie żądania) nigdy nie jest ponawiane.

Weryfikator nie przechodzi na dostawcę modelu głównego: przestałby być niezależny. Gdy weryfikator nie odpowie, dowody zostają, a siła oceny jest obniżona (raport to mówi).

## Ślad decyzji

- Każde udane wywołanie trafia do `report.models` (`purpose`, `provider`, `model`, tokeny, koszt) — widać, który model naprawdę obsłużył zadanie (np. `claims` obsłużony przez model główny po eskalacji).
- Każda nieudana próba trafia do `report.models` jako wpis `"<purpose>:failed"` z zerowymi tokenami i kosztem.
- Każda decyzja to jedna linia w logu diagnostycznym (włączanym przez `LOG_LEVEL=debug` albo `DEBUG=router`):
  `[router] purpose=claims tier=fast step=primary provider=openai model=gpt-6-luna outcome=failed reason=schema ms=812`.
  Log nie zawiera promptów, kluczy ani treści błędów dostawcy.

## Koszt

Ceny modeli: `src/engine/llm/pricing.ts` (cennik OpenAI odczytany 21.11.2026; bez cen dla wejścia z pamięci podręcznej, więc koszt w raporcie to górne oszacowanie).
