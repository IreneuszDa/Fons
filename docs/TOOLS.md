# Fons — narzędzia: wyszukiwanie na żywo i serwer MCP

Dwa dodatki do rdzenia sprawdzania informacji. Oba są opcjonalne: bez nich usługa działa tak samo, na zamkniętym korpusie.

| Dodatek | Co robi | Kod |
|---|---|---|
| Wyszukiwanie na żywo | Gdy korpus nie ma odpowiedzi, szuka świeżych stron **wyłącznie w serwisach z katalogu źródeł** i dołącza ich fragmenty jako dodatkowe kandydatury do dowodów | `src/tools/search.ts`, `src/engine/retrieval/live*.ts` |
| Oficjalne kanały instytucji | Pobiera komunikaty i ostrzeżenia **bezpośrednio**, bez wyszukiwarki i bez modelu (§1a) | `src/engine/retrieval/official*.ts`, `data/authorities.yaml` |
| Serwer MCP | Udostępnia Fons innym programom (Claude Desktop, IDE, agenci analityków) jako cztery narzędzia | `src/mcp/` |

## 1. Wyszukiwanie na żywo

### Zasada: narzędzie proponuje, kod decyduje

Wyszukiwarka (hostowane narzędzie `web_search` w API Responses OpenAI) może zaproponować **tylko adresy URL**. Cała reszta to zwykły kod:

1. **Lista dozwolonych hostów** = dokładne hosty z katalogu `data/sources.yaml` o typie `pierwotne` i `factcheck` **z `liveSearch: true`** (typ `analiza` nie bierze udziału; odpadają też fact-checkerzy poziomu 3 oraz Demagog, którego dane idą wyłącznie przez Google Fact Check Tools API). Wyszukiwarka dostaje ją jako `filters.allowed_domains`, ale filtr po stronie OpenAI obejmuje także subdomeny, więc nie jest zabezpieczeniem — prawdziwy filtr to kod:
2. Każdy zaproponowany adres: **dokładny host** w katalogu (bez dziedziczenia z domeny nadrzędnej; `sub.www.nato.int` odpada), adresy plików (PDF itp.) odpadają bez zużycia limitu pobrań.
3. Pobranie przez `fetchPage` z `src/security` (ochrona SSRF, tylko http/https na portach 80/443, ≤ 3 przekierowania, limit rozmiaru).
4. **Host po ostatnim przekierowaniu** jest sprawdzany jeszcze raz tą samą regułą; metadane rekordu (wydawca, poziom, typ, rola, licencja) pochodzą z wpisu katalogu hosta końcowego, nigdy z odpowiedzi wyszukiwarki.
5. **Detektor ataków** na surowej treści strony (tekst razem z elementami ukrytymi, komentarzami, metadanymi) i na tekście czytelnym. Trafienie `high` → strona odrzucona w całości, zdarzenie bezpieczeństwa zapisane (callback `onSecurityEvent`). Trafienie `low` → wypada tylko zdanie z trafieniem. Surowy HTML nie jest skanowany: markup daje lawinę fałszywych alarmów, a `rawText` z `fetchPage` już zawiera ukryty tekst.
6. Tekst dzielony na fragmenty ~1200 znaków, punktowany leksykalnie względem twierdzenia (BM25 po fragmentach bieżącego przebiegu, rdzeniowanie polskiej fleksji). Zwracane są najlepsze fragmenty (≤ 8) jako kandydaci `via: "live"`.
7. Zwrócone fragmenty trafiają do tabeli **`live_snapshots`** (`id`, `run_id`, `record_json`, `created_at`, `expires_at`; TTL 48 h) — **nie** do migawki korpusu. Id rekordu: `live:<sha256 adresu i treści>`; `origin: "live_snapshot"`.

Dalej to zwykły rekord: silnik ocenia go, sprawdza cytat jako dosłowny podciąg, uruchamia detektor na cytacie i weryfikatora — tak samo jak rekord z korpusu. Strona podana przez użytkownika nie może być dowodem (silnik odrzuca migawkę tego samego adresu).

### Limity na jedno twierdzenie

2 wyszukiwania (równolegle: twierdzenie + zapytanie dodatkowe, a gdy go nie ma — same słowa kluczowe), 5 pobrań stron, 6 s łącznie (po limicie zostają strony, które zdążyły się przetworzyć). Awaria wyszukiwarki, brak klucza albo brak jakiejkolwiek czytelnej strony przy błędach sieci → gałąź „niedostępna”: silnik dopisuje do raportu „nie udało się sprawdzić w: wyszukiwanie na żywo”, a werdykt zostaje (PLAN §1.3). Brak trafień to nie awaria — gałąź zwraca pustą listę.

### Włączanie

```
LIVE_SEARCH=on
OPENAI_API_KEY=...
OPENAI_DATA_RESIDENCY=      # puste = przetwarzanie w USA (raport mówi o tym jawnie)
```

Wyszukiwanie używa modelu szybkiego (`MODEL_FAST`). Bez `LIVE_SEARCH=on` gałąź nie powstaje. `OPENAI_DATA_RESIDENCY=eu` działa tylko dla projektu OpenAI z rezydencją danych w UE; przy projekcie bez niej OpenAI odrzuca klucz, a gałąź zgłasza niedostępność (nie przełączamy się po cichu na USA).

Rejestracja w kodzie: `createLiveBranchFromConfig(db, cfg)` z `src/engine/retrieval/live.ts` (albo `createLiveBranch(db, { searchProvider, ... })`). Ręczny test z prawdziwym modelem i prawdziwymi stronami: `OPENAI_DATA_RESIDENCY= npm run live:smoke -- "Szwecja dołączyła do NATO w 2024 roku."`.

### Koszt i czas (pomiar z prawdziwym modelem)

- ok. **0,02–0,04 USD za twierdzenie**: 0,01 USD za każde wyszukiwanie (cena narzędzia: 10 USD / 1000 wywołań) plus ok. 8–13 tys. tokenów wejściowych na wyszukiwanie po stawkach modelu szybkiego.
- czas: wyszukiwanie 3–7 s, pobranie stron 0,3–1,5 s (rzadko kilka sekund dla dużych stron). Typowo cała gałąź 4–7 s. Przy limicie 6 s w 8 próbach: 7 zwróciło fragmenty, 1 przekroczyło czas. Ciężka ekstrakcja HTML działa synchronicznie, więc limit bywa przekroczony o ok. 1 s.

### Znane ograniczenia

- Wyszukiwarka bywa niedeterministyczna: to samo zapytanie raz zwraca 19 adresów, raz pustą listę.
- Rekordy z hostów o roli `stala_rola` (fact-checki) nie mają oceny w tabeli mapowania, więc z migawki strony nigdy nie rozstrzygają.
- Strony `eur-lex.europa.eu` zwracają po ekstrakcji pusty tekst (odrzucane jako `no_text`).
- Detektor odrzuca niektóre zwykłe strony (np. Eurostat: ukryty `<span class="ecl-button__label">Menu</span>` i napis „Help us improve your experience…”), więc część stron o poziomie 1 jest tracona.

## 1a. Oficjalne kanały instytucji (gałąź „official”) — weryfikacja u źródła i triangulacja

Pytania typu „MSZ zakazało wszystkim Polakom wyjazdów do Niemiec” albo „Czy jest teraz jakiś alert RCB?” dotyczą **stanu na dziś** i **konkretnej instytucji**. Zamknięty korpus tego nie wie, a wyszukiwarka trafia w takie strony przypadkowo. Dlatego Fons stosuje kolejność, której używają redakcje fact-checkingowe (zasada IFCN „najpierw źródło pierwotne”, metoda SIFT: *trace claims to the original source*):

| Krok | Co się dzieje | Kto decyduje |
|---|---|---|
| 1. Wybór kanału | Rozpoznajemy instytucję, kraj podróży lub województwo i temat ostrzeżenia z tekstu twierdzenia. Plan korzysta z rejestru `data/authorities.yaml` i listy krajów MSZ `data/odyseusz-countries.json` | kod |
| 2. Pobranie materiału | Odczytujemy **oficjalny kanał bezpośrednio**, bez wyszukiwarki i bez modelu. Lista kanałów jest poniżej | kod |
| 3. Niezależne potwierdzenia | Równolegle działają pozostałe gałęzie: korpus (akty prawne, dane), fact-checki IFCN/EFCSN, baza incydentów i wyszukiwanie na żywo w hostach z katalogu (§1) | kod |
| 4. Ocena fragmentów | Model czyta fragmenty i mówi tylko, czy cytat wspiera / obala twierdzenie. Rekordy z oficjalnego kanału mają zarezerwowane 4 z 8 miejsc, żeby urzędowa strona pisana innymi słowami nie przegrała z tekstami, które tylko powtarzają słowa twierdzenia | model + kod |
| 5. Kontrola | Cytat musi istnieć dosłownie w pobranym rekordzie; drugi model sprawdza cytaty rozstrzygające | kod + model |
| 6. Werdykt | Reguły z `docs/VERDICT-RULES.md`: rozstrzyga źródło urzędowe (poziom 1) **albo** fact-check IFCN/EFCSN **albo** dwa niezależne źródła wtórne; sprzeczne źródła = „brak dowodów” z obiema stronami; liczba niezależnych wydawców wpływa na siłę oceny | kod |

Triangulacja jest więc w regułach werdyktu, a gałąź „official” dba o to, żeby w puli dowodów zawsze był głos samej instytucji.

**Czego ta gałąź nie robi.** Brak komunikatu na oficjalnej stronie **nie jest dowodem** — bez dosłownego cytatu, który wspiera albo obala twierdzenie, wynik to nadal „Brak wystarczających dowodów” (raport wymienia sprawdzone kanały). Nie zgadujemy z ciszy.

### Kanały w rejestrze

| Instytucja | Kanał | Co trafia do rekordów |
|---|---|---|
| MSZ — ostrzeżenia dla podróżujących | publiczne dane serwisu `odyseusz.gov.pl` (tam przekierowują strony gov.pl „Informacje dla podróżujących”) | profil kraju: ogólny poziom ostrzeżenia (1–4), ostrzeżenia regionalne, data obowiązywania i aktualizacji, bieżący komunikat, streszczenia sekcji „Bezpieczeństwo” i „Podróżowanie”; strona „Czym są ostrzeżenia dla podróżujących” (znaczenie poziomów i skutki prawne) |
| MSZ — aktualności | `www.gov.pl/web/dyplomacja/aktualnosci` | 10 najnowszych pozycji: data, tytuł, zajawka |
| RCB — komunikaty i Alert RCB | `www.gov.pl/web/rcb/komunikaty` | 10 najnowszych pozycji: data, tytuł, treść alertu z zajawki |
| RCB — raport dobowy | [Raport dobowy](https://www.gov.pl/web/rcb/raport-dobowy3) | Sekcje raportu z datą wydania. Zapis dotyczy dnia wskazanego przez RCB |
| MSWiA — Regionalny System Ostrzegania | Publiczne dane [wyszukiwarki ostrzeżeń Gov.pl](https://www.gov.pl/web/gov/ostrzezenia) | Ostrzeżenia ogólne, meteorologiczne, hydrologiczne i drogowe. Każdy komunikat ma własny link, obszar i okres obowiązywania |
| GIS i PAA | [Ostrzeżenia GIS](https://www.gov.pl/web/gis/ostrzezenia), [komunikaty PAA](https://www.gov.pl/web/paa/komunikaty) | Daty i tytuły komunikatów oraz zajawki, gdy dostępne |
| KG PSP, MON, MSWiA, MI i KPRM | [KG PSP](https://www.gov.pl/web/kgpsp/aktualnosci), [MON](https://www.gov.pl/web/obrona-narodowa/aktualnosci5), [MSWiA](https://www.gov.pl/web/mswia/aktualnosci), [Ministerstwo Infrastruktury](https://www.gov.pl/web/infrastruktura/aktualnosci), [KPRM](https://www.gov.pl/web/premier/wydarzenia) | Daty, tytuły i zajawki najnowszych pozycji |

RSO dobiera kategorie do pytania i korzysta z danych dla wskazanego województwa, gdy je rozpozna. Sprawdza obszar i okres obowiązywania każdego komunikatu, pomija wpisy, które wygasły, i zachowuje terminy przyszłych ostrzeżeń. Komunikaty środowiskowe i drogowe pochodzą z danych przekazywanych do RSO m.in. przez IMGW-PIB i GDDKiA. [Opis RSO](https://www.gov.pl/web/mswia/regionalny-system-ostrzegania)

Kolejne listy aktualności można dodać do `data/authorities.yaml`, podając słowa kluczowe i adres. Host musi występować w `data/sources.yaml` jako źródło pierwotne z włączonym `liveSearch`.

### Zabezpieczenia (te same co w §1)

- Adres jest pobierany tylko wtedy, gdy jego **dokładny host** jest w katalogu źródeł z typem `pierwotne`; host jest sprawdzany ponownie po przekierowaniach.
- Pobranie przez `fetchPage` (ochrona SSRF, limit rozmiaru i czasu). Dla danych JSON włączona jest opcja `acceptJson` — poza typem treści nic się nie zmienia.
- Treść rekordu składa kod z pól odpowiedzi serwisu; poziom, wydawca i licencja pochodzą z katalogu. Każdy rekord przechodzi detektor ataków (trafienie `high` = rekord odrzucony + zdarzenie bezpieczeństwa).
- Rekordy trafiają do `live_snapshots` (TTL 48 h), nie do migawki korpusu. W raporcie mają datę publikacji z serwisu i dokładny czas pobrania.
- Żaden model nie bierze udziału w wyborze ani pobieraniu stron — zasada PLAN §1.4 jest tu spełniona w całości (inaczej niż w wyszukiwarce z §1).
- `odyseusz.gov.pl` i `www.gov.pl` nie publikują ograniczeń w `robots.txt` (sprawdzone 21.11.2026). Pobieramy wyłącznie publiczne dane bez logowania; ta sama strona najwyżej raz na minutę.

### Limity, czas, koszt

Najwyżej 4 adresy i 5 rekordów na twierdzenie, 3,5 s na pobranie, 4,5 s na całą gałąź. Zmierzone: 0,1–0,6 s. Koszt: 0 USD (brak wywołań modelu i wyszukiwarki). Awaria wszystkich pobrań → „nie udało się sprawdzić w: oficjalne kanały instytucji”, werdykt zostaje (PLAN §1.3).

### Świeżość odpowiedzi

Przy `LIVE_SEARCH=on` wynik w pamięci podręcznej obliczeń żyje 15 minut zamiast 48 godzin — odpowiedź na „czy jest teraz alert?” nie może być wczorajsza.

### Włączanie

Gałąź działa razem z wyszukiwaniem na żywo: `LIVE_SEARCH=on`. Ewaluacja (`npm run eval`, `npm run consistency`) wyłącza obie gałęzie, żeby pomiar był odtwarzalny offline.

### Zmierzone przykłady (21.11.2026, prawdziwe źródła i model)

| Wejście | Wynik | Podstawa |
|---|---|---|
| „MSZ zakazało wszystkim Polakom wyjazdów do Niemiec.” | **Fałszywe** (reguła 8) | MSZ, Odyseusz: „Pamiętaj, że MSZ nie ma prawnych możliwości zakazania wyjazdu do jakiegokolwiek państwa.”; kontekst: profil Niemiec — „Poziom 1 - Zwykła ostrożność” |
| „Czy jest teraz jakiś alert RCB?” | odpowiedź cytatem (albo **Potwierdzone**, gdy model potraktuje pytanie jako tak/nie) | lista komunikatów RCB: „21.11.2026 — Alert RCB - trening systemów alarmowania (21.11)…” |

Bez tej gałęzi oba wejścia kończyły się wynikiem „Brak wystarczających dowodów”.

### Znane ograniczenia

- Rejestr obejmuje na razie MSZ i RCB. Inne instytucje (IMGW, GIS, Straż Graniczna…) wymagają wpisu w rejestrze, a hosty spoza gov.pl — także wpisu w katalogu źródeł.
- Rozpoznawanie krajów jest przedrostkowe, z listą form nieregularnych; rzadkie odmiany („z Nigru”) mogą nie zostać rozpoznane — wtedy profil kraju nie jest pobierany.
- Pytanie „czy jest **teraz** alert” dostaje najnowsze pozycje listy z datami; system nie ocenia sam, czy alert z godz. 8:00–12:00 nadal obowiązuje o 20:00 — pokazuje cytat z datą.
- Wydawca rekordów z gov.pl to ogólny wpis katalogu („Rząd RP — serwis gov.pl”), nie nazwa konkretnej instytucji.
- Testy: `npx vitest run src/engine/retrieval/official.test.ts` (bez sieci).

## 2. Serwer MCP

[Model Context Protocol](https://modelcontextprotocol.io) pozwala podłączyć Fons do Claude Desktop, IDE i innych klientów. Serwer używa dokładnie tego samego silnika co strona WWW — ten sam werdykt, te same cytaty.

### Narzędzia

| Narzędzie | Wejście | Wynik |
|---|---|---|
| `verify_claim` | `text` **albo** `url` | status techniczny, werdykt twierdzenia głównego, uzasadnienie, dowody (tytuł, wydawca, daty, link, dosłowny cytat), ostrzeżenia, blok przejrzystości, `resultUrl` (strona `/w/{token}` pod `PUBLIC_BASE_URL`) i `reportId`. Kosztuje ok. 0,01 USD i trwa kilkanaście sekund. Treść `url` jest przedmiotem sprawdzenia, nie dowodem |
| `search_sources` | `query`, `limit` (1–20) | fragmenty z lokalnego korpusu (BM25 + wektory + incydenty) z metadanymi i krótkim wyimkiem. Nie używa wyszukiwania na żywo |
| `get_report` | `token` | zapisany raport (tylko do odczytu) |
| `list_sources` | — | katalog źródeł z liczbą rekordów w korpusie |

Raport z `verify_claim` jest zapisywany jak raport z WWW (własny token, dziennik audytu, zdarzenia bezpieczeństwa, dobowy bezpiecznik budżetu tokenów), więc `resultUrl` otwiera zwykłą stronę wyniku. Jeśli zapis się nie uda, wynik nie ma `resultUrl`, tylko `reportId`. Pominięte są cache obliczeń i pętla informacji (sprawy moderatora) — MCP jest kanałem dla analityków, nie dla obywateli. Kanał w logach to `mcp`.

### Podłączenie

**Claude Desktop / IDE (stdio, lokalnie)** — w `claude_desktop_config.json` (podaj bezwzględne ścieżki do repozytorium):

```json
{
  "mcpServers": {
    "fons": {
      "command": "/ŚCIEŻKA/DO/Fons/node_modules/.bin/tsx",
      "args": ["/ŚCIEŻKA/DO/Fons/src/mcp/stdio.ts"]
    }
  }
}
```

Claude Code: `claude mcp add fons -- /ŚCIEŻKA/DO/Fons/node_modules/.bin/tsx /ŚCIEŻKA/DO/Fons/src/mcp/stdio.ts`. Albo po prostu `npm run mcp` w terminalu. Proces sam ustawia katalog roboczy na korzeń repozytorium (czyta `.env`, bazę z `DB_PATH` i `data/`), a stdout zostawia protokołowi (logi idą na stderr). Dostęp lokalny jest zaufany: rola `analyst`, bez tokenów.

**Zdalnie (HTTP, `POST /mcp`)** — serwer WWW montuje `createMcpHttpHandler` z `src/mcp/http.ts`; klient wysyła `Authorization: Bearer <token>`:

```
claude mcp add --transport http fons https://TWOJA-DOMENA/mcp --header "Authorization: Bearer TOKEN"
```

Transport jest bezstanowy (Streamable HTTP, odpowiedzi JSON): `GET` i `DELETE` zwracają 405. Tokeny wydaje i sprawdza serwer przez funkcję `authorize(bearer) → { ok, role }`.

### Role i limity

- `analyst` (każda rola poza `reader`): wszystkie cztery narzędzia.
- `reader`: bez `verify_claim` (nie wydaje pieniędzy) — `search_sources`, `get_report`, `list_sources`.
- Limity na token: 120 żądań HTTP/min, `verify_claim` 6/min, pozostałe narzędzia 60/min (odpowiedź 429 lub wynik z `rateLimited: true`). Treść żądania ≤ 64 KB, tekst do sprawdzenia ≤ 4000 znaków.

### Model bezpieczeństwa

- **Dane niezaufane.** Każdy wynik niesie `untrusted: true` i ostrzeżenie, że pola `title`, `publisher`, `quote`, `excerpt`, `answerPl` to cudzy tekst, nie polecenia. Dodatkowo `search_sources` przepuszcza wyimki przez detektor ataków i usuwa zdania z trafieniem (`flaggedSentencesRemoved`).
- **Werdykt liczy kod.** Klient dostaje werdykt wyznaczony regułami z PLAN §4; model w silniku tylko czyta fragmenty. Cytaty są dosłownymi podciągami zapisanych fragmentów źródeł z katalogu.
- **Brak narzędzi z niezaufaną treścią po stronie Fons.** Serwer nie wykonuje niczego na podstawie treści stron; jedyne skutki uboczne to zapis raportu i wpis w dzienniku.
- **Błędy.** Treść błędów dostawcy i sieci nigdy nie trafia do klienta — tylko komunikaty techniczne po polsku.
- **Uwierzytelnienie.** Token w nagłówku; brak lub zły token → 401 bez podania powodu; brak nagłówków CORS; odpowiedzi `no-store`. Token w logach występuje wyłącznie jako skrót.
- **Wyszukiwanie na żywo (zastrzeżenie).** Model wyszukiwarki widzi tekst twierdzenia (od użytkownika) i ma jedno narzędzie tylko do odczytu, ograniczone do hostów katalogu. Jego odpowiedź jest sprowadzana do listy adresów, które sprawdza kod, więc najgorsze, co może zrobić zmanipulowany model wyszukiwarki, to zmienić, *które* dozwolone strony zostaną pobrane (i tak przechodzą detektor). To odstępstwo od zasady „żaden model nie ma jednocześnie treści niezaufanej i narzędzi” (PLAN §1.4) jest świadome i opisane też w komentarzu w `src/tools/search.ts`.

### Koszty

`search_sources`, `get_report`, `list_sources` nie wywołują modeli (0 USD). `verify_claim` ok. 0,01 USD (5–7 wywołań modelu); z włączonym wyszukiwaniem na żywo dochodzi 0,02–0,04 USD za twierdzenie. Dobowy bezpiecznik budżetu tokenów (`DAILY_TOKEN_BUDGET`) obejmuje także MCP.

### Testy

`npx vitest run src/mcp src/tools src/engine/retrieval/live` — bez sieci i bez klucza (klient SDK przez transport w pamięci i przez `StreamableHTTPClientTransport` z podstawionym `fetch`, atrapa silnika, atrapy wyszukiwarki i pobierania stron).
