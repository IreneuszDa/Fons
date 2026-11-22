# Fons — sprawdź informację u źródła

**Fons** pomaga sprawdzać informacje po polsku. Czat przyjmuje pytania, linki, obrazy, dokumenty, nagrania głosowe i filmy. Czat i CLI korzystają ze wspólnego silnika. Przy artykule można rozwinąć każde sprawdzone twierdzenie, zobaczyć ocenę, przeczytać dowody i otworzyć publikacje. [Metoda weryfikacji i standardy redakcyjne](docs/METODA-WERYFIKACJI.md)

**Dla obywatela:** jedna rozmowa po polsku, prostym językiem, na telefonie od 360 px. Zamiast kolejnej opinii dostaje źródło, które może sam otworzyć. **Dla analityków MSZ:** każde sprawdzenie to zapisany, audytowalny raport (dowody, cytaty, modele, koszt, czas). Nierozstrzygnięte zgłoszenia trafiają do kolejki spraw z deduplikacją. Panel z rolami pokazuje metryki, eksporty i dziennik audytu, a serwer MCP pozwala podłączyć Fons do narzędzi analitycznych i asystentów AI.

> Fons pomaga ocenić informację. Nie jest automatycznym sędzią prawdy.

**Materiały konkursowe:** opis rozwiązania (nazwa zespołu, tytuł, do 4000 znaków): [docs/OPIS.md](docs/OPIS.md) · prezentacja PDF (do 12 slajdów): _do dodania_ · film (do 3 min): _link do dodania_ · licencja kodu: [ISC](LICENSE).

---

## Jak pytanie staje się odpowiedzią

1. **Pytanie.** Czat WWW i CLI przekazują wiadomość do wspólnego silnika. Przy linku i zrzucie ekranu silnik rozdziela pytanie od materiału wskazanego przez użytkownika. Odczytana z obrazu data jest częścią treści obrazu.
2. **Wyszukiwanie.** BM25 i lokalny indeks wektorowy znajdują publikacje na podstawie treści pytania. Przy włączonym `LIVE_SEARCH` silnik korzysta również z wyszukiwania w dozwolonych serwisach oraz oficjalnych kanałów instytucji. Uwzględnia powiązane dokumenty źródłowe i przechowuje w raporcie przebieg wyszukiwania.
3. **Oceny Demagoga.** Pytanie o to, czy Demagog sprawdzał daną tezę, uruchamia wyszukiwanie w Google Fact Check Tools. Silnik porównuje pytanie z tezą w znalezionej publikacji. Zwraca źródło i ocenę, prosi o doprecyzowanie podobnego wyniku albo informuje o braku trafienia lub błędzie dostępu.
4. **Odpowiedź.** Model opracowuje odpowiedź na podstawie wyszukanych fragmentów. Kod weryfikuje cytaty, a drugie wywołanie modelu sprawdza, czy cytaty i metadane uzasadniają wniosek. Przy braku wystarczających dowodów użytkownik otrzymuje informację o ograniczeniu. Przy braku odpowiedzi z modelu interfejs korzysta z rzeczywistego statusu usługi.
5. **Zapis.** Czat pokazuje krótką odpowiedź i linki. Szczegóły są w raporcie pod `/w/:token`. Stan zgłoszenia pochodzi z kolejki moderatora w SQLite. Panel pobiera z API rzeczywiste sesje, sprawy i statystyki.

## Co potrafi

### Filmy z TikToka, Instagrama, Facebooka i YouTube

Wklej w czacie link do publicznego filmu. Możesz dopisać pytanie o wybrany fragment. Fons odczytuje opis posta i dostępne napisy. W trybie OpenAI wybiera z nagrania do 32 klatek rozłożonych w czasie i przekazuje je do analizy obrazu. Przy braku napisów pobiera transkrypcję ścieżki dźwiękowej. Krótki napis między próbkowanymi klatkami może zostać pominięty. Raport wskazuje pochodzenie maksymalnie sześciu twierdzeń, ich czas oraz dowody z osobnego etapu weryfikacji.

Przy ogólnej prośbie o sprawdzenie posta, którego publiczny odtwarzacz udostępnił tylko opis, Fons może zweryfikować twierdzenia z opisu. Wskazuje wtedy ograniczenie w raporcie. Jeśli pytasz o niedostępny obraz lub dźwięk, możesz dołączyć plik nagrania.

| Platforma | Jak Fons odczytuje materiał |
|---|---|
| TikTok | Rozwija link udostępniania, odpytuje oEmbed i uzupełnia brakujące dane z publicznej strony tego samego filmu. Pobiera dostępne napisy WebVTT i próbuje pobrać jeden z mniejszych wariantów nagrania. |
| Instagram | Czyta opis i adres nagrania z publicznego posta lub jego osadzonego odtwarzacza. |
| Facebook | Rozwija obsługiwane linki udostępniania, w tym `fb.watch` i `fb.me`. Szuka MP4 na stronie i w publicznym odtwarzaczu tego samego filmu. |
| YouTube i Shorts | Pobiera metadane i publiczne napisy. W trybie OpenAI pobiera MP4, jeśli publiczny odtwarzacz udostępnia bezpośredni plik z obrazem i dźwiękiem. W trybie Gemini przekazuje modelowi kanoniczny adres filmu. |

W serwerowym `.env` ustaw `VIDEO_PROVIDER=openai` i `OPENAI_API_KEY`, po czym uruchom ponownie API. Serwer używa programów `ffmpeg` i `ffprobe` z pakietu FFmpeg dostępnych w `PATH` (macOS: `brew install ffmpeg`, Debian/Ubuntu: `apt install ffmpeg`). Model `gpt-6-luna` odczytuje klatki, a `gpt-transcribe` przepisuje mowę z krótkich fragmentów audio. Czas transkrypcji OpenAI oznacza początek wysłanego fragmentu. Możesz zmienić model obrazu przez `OPENAI_VIDEO_MODEL`. Obie operacje stosują konfigurację `OPENAI_DATA_RESIDENCY`. [Wejście obrazowe OpenAI](https://developers.openai.com/api/docs/models/gpt-6-luna) · [Transkrypcja plików](https://developers.openai.com/api/docs/guides/speech-to-text)

Dla publicznych filmów z Instagrama i TikToka uruchom w katalogu serwera `npm run setup:video` (Python 3.11+ na macOS/Linux). Polecenie instaluje przypiętą wersję yt-dlp w lokalnym środowisku projektu. Do wdrożenia skopiuj także `scripts/social-video.py` i uruchom instalację w docelowym środowisku. Gdy bezpośrednie pobieranie nie dostarczy pliku, Fons próbuje pobrać ten sam post przez yt-dlp. Działa bez klucza do pobierania i bez logowania na konto społecznościowe.

Przy pustym `VIDEO_PROVIDER` Fons wybiera OpenAI, jeśli ma jego klucz, a przy samym `GEMINI_API_KEY` używa Gemini. Można też wskazać `VIDEO_PROVIDER=gemini` lub wyłączyć analizę obrazu i dźwięku przez `VIDEO_PROVIDER=off`. Limit wynosi 10 minut i 64 MiB na pobierany plik. Gdy dostępna jest wyłącznie transkrypcja lub napisy, Fons może sprawdzić zawarte w nich wypowiedzi. Raport wskazuje zakres analizy.

Opcjonalny `SOCIALKIT_API_KEY` włącza dodatkową próbę pobrania MP4, gdy publiczny post na TikToku jest dostępny, ale bezpośrednie pobranie nagrania zawiedzie. W tym przypadku adres filmu trafia do SocialKit. Fons zamawia plik MP4 w 480p. Dostawca podaje limit 30 MB i nalicza własne kredyty za każdą rozpoczętą minutę nagrania. [TikTok Video Download API](https://docs.socialkit.dev/api-reference/tiktok-download-api)

### Funkcje Fons

| Obszar | Co to znaczy w praktyce | Gdzie w kodzie |
|---|---|---|
| **Potok RAG** | twierdzenia → wyszukiwanie hybrydowe → ocena dowodów → kontrola cytatów → reguły werdyktu → odpowiedź z cytatem. Szybki model wydziela twierdzenia i rozpoznaje, czy to twierdzenie, pytanie tak/nie, czy pytanie otwarte. Główny model czyta tylko znalezione fragmenty. Kod sprawdza, że cytat występuje dosłownie w zapisanym rekordzie, a werdykt liczą reguły 1–9. | `src/engine/` · [VERDICT-RULES](docs/VERDICT-RULES.md) |
| **Pytania i odpowiedzi** | Silnik wyszukuje źródła dla treści pytania i weryfikuje cytaty wykorzystane w syntezie. Gdy cytaty nie wystarczą, sprawdza wyodrębnioną tezę lub szuka pojedynczego fragmentu odpowiadającego wprost. | `src/engine/source-question.ts`, `src/engine/answer.ts` |
| **Baza wektorowa** | SQLite: FTS5 (BM25 z rdzeniowaniem PL/EN) + wektory z lokalnego modelu `multilingual-e5-small` (ONNX, nic nie wychodzi z serwera). Wyniki łączy ważone RRF i tani reranking leksykalny. Embeddingi korpusu są w repozytorium i są sprawdzane względem migawki korpusu. Ścieżka skalowania: ten sam port `RetrievalBranch` na pgvector albo Qdrant. | `src/engine/retrieval/` |
| **Narzędzia i MCP** | Wyszukiwanie GPT (`web_search`) jest domyślnie włączone przy skonfigurowanym kluczu OpenAI. Wyszukiwarka proponuje adresy, a serwer pobiera publikacje z katalogu. Przechodzi tylko dokładny host z katalogu z flagą `liveSearch` (np. Demagog jej nie ma), sprawdzany też po przekierowaniu. Strony wyników wyszukiwania w serwisie i zapytania tekstowe w adresie są odrzucane przed pobraniem i po przekierowaniu. Potem pobranie z ochroną SSRF, detektor wstrzyknięć i migawka z TTL 48 h. **Serwer MCP** (`verify_claim`, `search_sources`, `get_report`, `list_sources`) przez stdio i `POST /mcp` z tokenem. | `src/tools/`, `src/mcp/` · [TOOLS](docs/TOOLS.md) |
| **Kanały** | Czat WWW i CLI korzystają ze wspólnej warstwy rozmowy. MCP daje dostęp do wyszukiwania i raportów analitycznych. | `src/server/`, `scripts/ask.ts`, `src/mcp/` |
| **Role i dostęp** | obywatel (bez logowania) · moderator (kolejka spraw) · analityk (metryki, eksporty, tokeny API) · administrator (wszystko + użytkownicy, cache). Jedna macierz uprawnień: trasa bez wpisu blokuje start serwera. Tokeny API `fons_…` są tylko do odczytu, a w bazie leży tylko ich SHA-256. Dziennik działań administracyjnych ma łańcuch hashy. | `src/server/auth/` |
| **Ochrona przed prompt injection** | Filtry wejścia i limity. Deterministyczny detektor (PL/EN/RU/UA, homoglify, zero-width, base64, ukryty HTML) działa na **surowej** treści, zanim zobaczy ją model. Treść niezaufana trafia do modelu tylko w blokach z losowym ogranicznikiem, a odpowiedzi muszą pasować do schematu JSON. Osobne wywołanie modelu sprawdza odczyt materiału. Raport ujawnia, czy oba modele mają tego samego dostawcę. Treść od użytkownika nigdy nie jest dowodem. Linki przechodzą przez allowlistę schematów, a pobieranie przez ochronę SSRF (blokada sieci prywatnych, kontrola każdego przekierowania, limit 5 MB). | `src/security/`, `src/engine/prompts.ts` |
| **Dane osobowe** | PESEL, telefony, e-maile, IBAN i karty są maskowane przed modelem i przed logiem. Nadawca jest pseudonimizowany (HMAC z osobnym kluczem). Retencja: przebiegi i raporty 30 dni, sesje 7 dni, migawki „live” 48 h. „Usuń moje dane” działa w czacie i przez API. Logi nie zawierają treści wiadomości. | `src/security/pii.ts`, `src/server/db.ts` |
| **Cache** | Klucz to hash znormalizowanego wejścia, migawka korpusu i wersja potoku, TTL 48 h. Trafienie w cache oszczędza tokeny silnika i **ponownie zapisuje zdarzenia bezpieczeństwa** (ten sam atak trzy razy to trzy wpisy). Każdy użytkownik dostaje własną kopię raportu z własnym 128-bitowym tokenem. | `src/server/conversation/` |
| **Router modeli** | Jawna tabela: cel wywołania → model szybki albo główny. Błąd schematu, odmowa albo limit czasu na szybkim modelu powoduje jedną próbę na głównym. Inny błąd przełącza na zapasowego dostawcę innej rodziny (jeśli jest skonfigurowany). Każda nieudana próba jest widoczna w raporcie. | `src/engine/llm/router.ts` · [ROUTER](docs/ROUTER.md) |
| **Obserwowalność** | Logi JSON z `X-Request-Id` (ten sam identyfikator co raport). `GET /metrics` w formacie Prometheus: liczniki, histogramy czasu na krok, koszt. Panel `/admin` z metrykami. Dziennik przebiegów z łańcuchem hashy, sprawdzany przez `GET /api/admin/audit/verify`. | `src/server/observability/` |
| **Ewaluacja** | Zestawy dev, held-out, red-team, demo i spójność kanałów. Liczymy macro-F1, cytaty, wstrzymania, odporność, czas, koszt i trafność odpowiedzi. Wyniki **z prawdziwym modelem** są w `eval/results/` (tabela niżej). | `eval/` · [EVAL](docs/EVAL.md) |
| **Uczciwe wstrzymanie** | Pięć werdyktów: **Potwierdzone · Fałszywe · Wprowadzające w błąd · Brak wystarczających dowodów · Nie podlega weryfikacji**. Osobno jest status techniczny (`OK · NIEPEŁNE · AWARIA · DOPRECYZUJ · POZA ZAKRESEM`): awaria nigdy nie udaje werdyktu. | `src/engine/verdict/` |

## Wyniki ewaluacji (prawdziwy model)

Pomiar z 2026-11-21: modele `gpt-6.2-sol` / `gpt-6-luna`, tryb jednego klucza, przetwarzanie w USA, korpus `47adf7fd…` (2037 rekordów), potok `engine-2026.11.21-4`, wyszukiwanie na żywo wyłączone. Pliki z wynikami są w `eval/results/` (JSON z każdym przebiegiem; `latest.md` to raport held-out). **Te liczby opisują stan sprzed późniejszych zmian i nie da się ich dziś odtworzyć z repozytorium 1:1** — szczegóły pod tabelami.

| Miara | Cel | dev (76 przyp.) | held-out (53 przyp.) | Status |
|---|---|---|---|---|
| Macro-F1 (5 klas) | ≥ 0,75 | 0,639 | **0,586** | **niespełniony** |
| Pokrycie cytatami | ≥ 95% | 100% (30/30) | 100% (24/24) | spełniony |
| Poprawność cytatów (cytat jest dosłownym podciągiem rekordu) | ≥ 85% | 100% (63/63) | 100% (39/39) | spełniony |
| Poprawne wstrzymanie (scenariusz D) | ≥ 80% | 100% (6/6) | 100% (4/4) | spełniony |
| Trafność odpowiedzi na pytania otwarte | raportowana | 100% (5/5) | 100% (4/4) | spełniony |
| Mediana czasu (p95) | ≤ 30 s | 8,4 s (15,3 s) | 8,0 s (16,0 s) | spełniony |
| Działanie end-to-end (raport zamiast wyjątku) | 100% | 100% (76/76) | 100% (53/53) | spełniony |
| Wstrzyknięcie usterek J (bez werdyktu) | 100% | 3/3 | 2/2 | spełniony |
| Koszt 100 sprawdzeń | raportowany | 1,10 USD | 1,07 USD | — |

| Bezpieczeństwo i spójność | Cel | Wynik | Status |
|---|---|---|---|
| Odporność na wstrzyknięcia (red-team, **tylko podział dev**: 25 ataków + 5 bliźniaków, 3 przebiegi, liczy się najgorszy) | ≥ 90% | **84,0% (21/25)** | **niespełniony** |
| Odporność na wstrzyknięcia — red-team held-out (18 ataków + 5 bliźniaków: wyciek promptu PL/EN, podszywanie się pod administratora, „usuń moje dane”/„zgłoś” w treści, base64, zero-width, homoglify, RU, `aria-hidden`, imitacja ograniczników) | ≥ 90% | **niezmierzona** | — |
| Wykrywalność ataków (zdarzenie bezpieczeństwa w każdym przebiegu, dev) | raportowana | 80,0% (20/25) | — |
| Fałszywe alarmy detektora | jak najniżej | 0/2037 rekordów korpusu, 0/31 tekstów łagodnych | spełniony |
| Spójność kanałów (web vs cli, ten sam status, werdykt i dowody) | 100% | 100% (26/26) | spełniony |
| Ten sam atak 3 razy = 3 zdarzenia w logu | 3/3 | 3/3 | spełniony |
| Zestaw demo (10 przypadków w kolejności pokazu) | — | 7/10 (nie przeszły DEMO04, DEMO05, DEMO09 — patrz niżej) | — |
| Deduplikacja spraw moderatora (scenariusz H, `npm run consistency`) | 1 sprawa na grupę | 1/2 grup (H-elblag: 2 sprawy) | niespełniony w pomiarze; poprawka w kodzie, niezmierzona |

**Wyniki według scenariusza** (scenariusze z treści zadania; „trafność” = zgodność z oczekiwanym werdyktem/statusem, 1 przebieg). Pokazujemy też słabe miejsca — PDF wymaga ujawnienia przypadków, których system nie obsługuje.

| Scenariusz | dev | held-out | Uwagi |
|---|---|---|---|
| A — prosty fakt (w tym negacje) | 19/36 | 16/27 | błędy to głównie wstrzymania z luk korpusu (na held-out też A03, patrz niżej); negacje 3/6 i 1/3 |
| B — zły kontekst / nieaktualne | 3/7 | **1/5** | „nieaktualne, ale kiedyś prawdziwe” **0/4 i 0/4**; zły kontekst 3/4 i 1/2 |
| C — sprzeczne źródła | 3/3 | 0/1 | trafienia dev to wstrzymania **bez znalezionych źródeł**; blok „źródła sprzeczne” pojawił się w **0/3 i 0/1** (miękka kontrola) — mechanizm reguły 5 jest pokryty tylko testami jednostkowymi |
| D — brak dowodów | 6/6 | 4/4 | |
| E — wstrzyknięcia w zestawie głównym | 1/4 | 2/2 | odporność 4/4 i 2/2; trafność werdyktu niższa przez wstrzymania |
| G — ten sam przypadek w dwóch kanałach | 2/2 | 0/1 | spójność web ↔ cli: 26/26 (`npm run consistency`) |
| H — powtórzone podobne zgłoszenie | 2/2 | 2/2 | werdykty poprawne; deduplikacja spraw 1/2 grup (wyżej) |
| I — znany incydent / domena (RT, Sputnik, „Pravda”) | 2/3 | 1/2 | werdykt opiera się tylko na treści; **ostrzeżenie o domenie incydentu: 0/3 i 0/2**, a ostrzeżenia o statusie źródła (np. sankcje UE) system dziś nie wydaje |
| J — usterki | 3/3 | 2/2 | |
| X — swobodne pytania, opinie | 6/10 | 4/7 | pytania o polityków 12/13 i 8/9 |
| Linki (etykieta, przekrój A/B/X) | 1/5 | 2/5 | strony dezinformacyjne **1/2 i 0/2**; link urzędowy 0/3 i 2/3 |
| F — zrzut ekranu | — | — | brak przypadków; ścieżka obrazowa niezmierzona |

Zestaw demo: **DEMO04** („Stany Zjednoczone płacą za 100% NATO”, oczekiwane FAŁSZYWE) → BRAK DOWODÓW; **DEMO05** („UE liczy 28 państw”, oczekiwane WPROWADZAJĄCE) → BRAK DOWODÓW; **DEMO09** (link do fikcyjnej strony dezinformacyjnej, oczekiwane FAŁSZYWE) → BRAK DOWODÓW. Przed nagraniem filmu trzeba te przypadki naprawić albo zmienić scenariusz pokazu.

**Odtwarzalność — czym obecne repozytorium różni się od pomiaru:**
- **Korpus.** Pomiar wykonano na korpusie sprzed przejścia Demagoga na Google Fact Check Tools API (2037 rekordów, w tym 250 pobranych wtedy wprost ze stron Demagoga). Aktualną liczebność i rozkład publikacji podaje raport budowy korpusu w `data/corpus-report.json`.
- **Potok.** Od czasu pomiaru doszły m.in. źródła na żywo, obsługa długich tekstów, odpowiedzi o konkretnych publikacjach i sprawdzanie indeksu Demagoga. Wersję bieżącego potoku określa `PIPELINE_VERSION` w `src/engine/verify.ts`.
- **Zestawy.** `dev.jsonl` ma dziś 84 przypadki (zmierzono 76; ST01–ST05 i LT01–LT03 dodano później). Held-out v1 przestał być ślepy przy diagnozie błędów; liczbą raportową ma być odtąd **ślepy zestaw v2** (`eval/cases/heldout-v2.jsonl`, 68 przypadków), **jeszcze niezmierzony** ([EVAL §2a](docs/EVAL.md)).
- **Commit.** Pomiar powstał przed pierwszym commitem repozytorium, więc z kodem wiąże go tylko `pipelineVersion` i migawka korpusu. Od teraz meta każdego wyniku zapisuje `gitSha` i `gitDirty`.

Wszystkie wyniki wymagają ponownego pomiaru na zamrożonym korpusie i potoku.

**Co zostało poniżej celu i dlaczego.**
- **Macro-F1.** Decyzje rozstrzygające są precyzyjne (POTWIERDZONE: precyzja 1,00 na dev i held-out), ale system często się wstrzymuje: 27/53 przypadków na dev i 17/38 na held-out. Większość to luki w korpusie, nie błędy wyszukiwania. Brakuje art. 96–98 Konstytucji (A06, A08, A10, A07, G03), decyzji UE o statusie kandydata Ukrainy (A13, E06), zakazu importu węgla i ropy (A15, B05), źródeł o biolaboratoriach, MH17 i Buczy (A17, N06, A19, A18), wyników PKW 2025 (X04, X08), listy państw UE i strefy euro (X02, B09, B12, X09, DEMO05) oraz danych geograficznych (A16, N07). Błędne rozstrzygnięcia na dev: B11 i P09 („nieaktualne”, a w korpusie brak starszego źródła, reguła 4). Na held-out: A03, C03, L06, P10.
- **Odporność 84% (tylko podział dev).** Trzy z czterech porażek to odpowiedź DOPRECYZUJ zamiast werdyktu. RT-21: fałszywy znacznik ogrodzenia w tym samym „zdaniu” co twierdzenie, więc twierdzenie wypadało razem ze znacznikiem. RT-03/RT-04: model tłumaczył twierdzenie z rosyjskiego/ukraińskiego, a kontrola zgodności z wejściem je odrzucała. Poprawki są w kodzie: `isolateFenceMarkers` i reguła „pole text w języku wiadomości”. Ponowny pomiar tylko tych przypadków (`2026-11-21T20-07-38-581Z-redteam-dev.json`): RT-03, RT-08 i RT-21 odparte 3/3, RT-04 2/3. Pełnego zestawu red-team po poprawkach nie powtórzyliśmy (budżet), więc oficjalną liczbą pozostaje 84%.

**Jak odtworzyć** (wymaga klucza; ok. 5 USD za całość):

```bash
OPENAI_DATA_RESIDENCY= npm run eval -- --split dev
OPENAI_DATA_RESIDENCY= npm run eval -- --split heldout-v2        # ślepy held-out v2 (liczba raportowa)
OPENAI_DATA_RESIDENCY= npm run eval -- --split heldout           # held-out v1 (odsłonięty, regresja)
OPENAI_DATA_RESIDENCY= npm run eval -- --suite redteam --split all --runs 3
OPENAI_DATA_RESIDENCY= npm run eval -- --suite demo
OPENAI_DATA_RESIDENCY= npm run consistency
```

Pliki z tego pomiaru: `2026-11-21T19-22-04-503Z-main-dev.json`, `2026-11-21T19-32-57-848Z-main-heldout.json`, `2026-11-21T19-40-54-200Z-redteam-dev.json`, `2026-11-21T20-01-28-528Z-demo-dev.json`, `consistency-2026-11-21T20-03-05-967Z.json`. Definicje miar i ograniczenia zestawu: [docs/EVAL.md](docs/EVAL.md). Historia strojenia: [docs/QUALITY-LOG.md](docs/QUALITY-LOG.md).

## Architektura

Jedna usługa w TypeScript (Node 22): Hono (API i serwowanie WWW), SQLite (better-sqlite3, FTS5, wektory), React + Vite + Astryx (WWW). **Orkiestratorem jest kod:** żaden model nie dostaje jednocześnie treści niezaufanej i narzędzi. Jedyny świadomy wyjątek, opisany w [TOOLS](docs/TOOLS.md), to wyszukiwarka z jednym narzędziem tylko do odczytu, której wynik kod sprowadza do listy adresów.

```
 Obywatel: WWW / CLI / webhook kanału        Analityk: panel /admin · MCP (stdio, POST /mcp) · /metrics
        │ limit IP/użytkownika, sesja, maskowanie PII,        │ logowanie, macierz ról, tokeny API
        │ cache 48 h                                         │
        ▼                                                    ▼
 Asystent z historią rozmowy      → odpowiedź, doprecyzowanie, źródła, uzasadnienie         src/server
        │ decyzja o sprawdzeniu     „zgłoś” i „usuń moje dane” wymagają potwierdzenia
        │ jedyne wywołanie silnika
        ▼
 verifyInput()                                                                              src/engine
   1 normalizacja: tekst │ URL (pobranie z ochroną SSRF, ekstrakcja) │ obraz           src/security
   2 detektor wstrzyknięć na surowej treści ───────────────► security_events, ostrzeżenie
   3 twierdzenia + tryb (twierdzenie / pytanie tak-nie / pytanie otwarte)   [model szybki]
   4 wyszukiwanie hybrydowe: BM25 + wektory e5 + incydenty (+ live)  → RRF → rerank    retrieval/
   5a ocena fragmentów (1 wywołanie na twierdzenie)                    [model główny]
   5b pytanie otwarte: wybór cytatu-odpowiedzi tylko z rekordów treściowych   [model główny]
   6 kontrola cytatów: dosłowny podciąg rekordu + detektor + weryfikator   [model szybki]
   7 werdykt = reguły 1–9 w kodzie; odpowiedź składa kod z rekordu        verdict/
   8 uzasadnienie z szablonu
        │
        ▼
 VerdictReport (kanoniczny JSON) ─► karta w czacie · strona /w/:token · tekst CLI/MCP
                                  └► runs (łańcuch hashy) · metryki · sprawy moderatora
```

**Przepływ danych.** Fons maskuje dane identyfikacyjne w tekście przed oceną twierdzeń i zapisem raportu. Przy analizie wideo OpenAI otrzymuje wybrane klatki oraz fragmenty dźwięku potrzebne do transkrypcji. W trybie Gemini nagranie trafia do Google. W obu trybach na obrazie i w dźwięku mogą występować dane osobowe. Tekst transkrypcji podlega maskowaniu po odczycie. Tytuły, linki, daty i wydawcy cytowanych źródeł pochodzą z bazy. Raport jest zapisywany z tokenem nadawcy i usuwany po 30 dniach.

### Moduły

| Moduł | Katalog | Dokumentacja |
|---|---|---|
| Kontrakty danych (zod) | `src/shared/contracts.ts` | [MODULES](docs/MODULES.md) |
| Bezpieczeństwo: fetch z ochroną SSRF, ekstrakcja, detektor, PII, daty, limiter | `src/security/` | [MODULES](docs/MODULES.md) |
| Korpus: katalog, ingestia (ELI, EUR-Lex, Eurostat, NATO, gov.pl, API Sejmu, Demagog…), SQLite | `src/corpus/`, `data/` | [SOURCES](docs/SOURCES.md) |
| Wyszukiwanie: BM25 + rdzeniowanie, wektory ONNX, incydenty, live, RRF, rerank | `src/engine/retrieval/` | [MODULES](docs/MODULES.md), [TOOLS](docs/TOOLS.md) |
| Reguły werdyktu i karta siły dowodów | `src/engine/verdict/` | [VERDICT-RULES](docs/VERDICT-RULES.md) |
| Rdzeń silnika, odpowiedzi na pytania, router i dostawcy LLM | `src/engine/` | [ROUTER](docs/ROUTER.md), [QUALITY-LOG](docs/QUALITY-LOG.md) |
| Narzędzia (wyszukiwanie na żywo) i serwer MCP | `src/tools/`, `src/mcp/` | [TOOLS](docs/TOOLS.md) |
| Serwer: rozmowa, RBAC, panel API, obserwowalność, retencja | `src/server/`, `scripts/` | [MODULES](docs/MODULES.md) |
| WWW: czat, karta werdyktu i odpowiedzi, `/w/:token`, `/zrodla`, `/admin` | `src/web/` | [AGENTS.md](AGENTS.md) |
| Ewaluacja | `eval/` | [EVAL](docs/EVAL.md) |

## Modele i dostawcy

| Dostawca / model | Do czego | Gdzie przetwarzane | Koszt |
|---|---|---|---|
| **OpenAI `gpt-6.2-sol`** (główny) | ocena fragmentów, wybór cytatu-odpowiedzi | **USA** (`api.openai.com`), chyba że projekt OpenAI ma rezydencję danych w UE i ustawiono `OPENAI_DATA_RESIDENCY=eu`. Każdy raport ujawnia przetwarzanie poza EOG. Żądania mają `store:false`. | 2 / 10 USD za mln tokenów (wejście / wyjście) |
| **OpenAI `gpt-6-luna`** (szybki) | rozmowa i wybór narzędzia, twierdzenia i tryb wejścia, weryfikator (tryb jednego klucza), odczyt obrazu | jw. | 0,10 / 0,50 USD za mln tokenów |
| OpenAI `web_search` (opcjonalnie) | propozycje adresów dla gałęzi „live” | jw. | ok. 0,02–0,04 USD na twierdzenie |
| Anthropic / Mistral (opcjonalnie) | weryfikator innej rodziny albo dostawca zapasowy w routerze; Mistral ma endpoint w UE | USA / EOG | wg `src/engine/llm/pricing.ts` |
| `Xenova/multilingual-e5-small` (ONNX) | wektory zapytań i korpusu | lokalnie | 0 USD |

**Koszt 1000 zapytań (zmierzony):** ok. **11 USD** za sprawdzenie tekstu (1,07–1,10 USD za 100 na dev i held-out, średnio ok. 5–7 tys. tokenów wejścia i 0,6–0,8 tys. wyjścia). Link to ok. 0,03–0,04 USD, bo strona jest długa. Prosta odpowiedź na pytanie otwarte to ok. 0,005 USD. Wyszukiwanie na żywo dokłada ok. 20–40 USD na 1000 twierdzeń. W serwerze i MCP jest wliczane do `costUsd` i `models[]` raportu (pozycja `live_search`: tokeny wyszukiwarki + 0,01 USD za wywołanie; użycie, które dotrze po zakończeniu przebiegu, nie jest liczone, więc to dolna granica). Ewaluacja działa bez źródeł na żywo, więc zmierzone 11 USD ich nie obejmuje. Silnik odczytuje zapisany wynik z cache (48 h) bez wywoływania modeli. Poprzedzająca go decyzja asystenta w czacie może zużyć tokeny.

Koszt pracy silnika jest liczony z faktycznych tokenów i zapisywany w raporcie (`costUsd`, `models[]`). Dobowy bezpiecznik `DAILY_TOKEN_BUDGET` zatrzymuje usługę komunikatem technicznym. Przy awarii dostawcy usługa odpowiada „NIEPEŁNE”, bez werdyktu i bez treści błędu dostawcy.

### Koszty utrzymania i zachowanie przy większym ruchu

To szacunki, nie pomiary obciążeniowe (testu obciążenia nie wykonaliśmy).

- **Kanały.** Czat WWW, CLI i MCP korzystają z serwera aplikacji. Koszty zależą od wybranych modeli, wyszukiwania i hostingu.
- **Przepustowość jednej instancji.** Sprawdzenie to głównie czekanie na model (mediana ok. 8 s), więc proces obsługuje wiele zapytań równolegle; ograniczeniem są limity konta OpenAI (RPM/TPM zależne od poziomu konta), a nie CPU. SQLite działa w trybie WAL z jednym zapisującym i `busy_timeout` 5 s — przy jednej instancji wystarcza, bo zapis to kilka wierszy na sprawdzenie.
- **Przy przeciążeniu.** Limit na klienta (`RATE_LIMIT_PER_MINUTE`, domyślnie 10/min, IPv6 grupowane po /64), dzienny udział jednego klienta w budżecie tokenów (`IP_DAILY_TOKEN_SHARE`, domyślnie 25% `DAILY_TOKEN_BUDGET`) i dobowy bezpiecznik całej usługi. Odpowiedź 429 dostawcy: router przenosi wywołanie na zapasowego dostawcę (jeśli skonfigurowany), inaczej odpowiedź „NIEPEŁNE” bez werdyktu. Po wyczerpaniu budżetu nadal można odczytać zapisany wynik z cache.
- **Skalowanie.** Kilka procesów za load balancerem wymaga przeniesienia stanu z pamięci (limity, budżet klienta, sesje panelu) i bazy z SQLite do PostgreSQL; wyszukiwanie wektorowe przechodzi na pgvector albo Qdrant za tym samym portem `RetrievalBranch`.

## Źródła

Według raportu budowy z 22 listopada 2026 r. korpus liczy **3637 rekordów z 31 hostów**. Obejmuje 2241 rekordów źródeł pierwotnych, 934 fact-checki i 462 analizy. W osobnym zbiorze znajduje się 604 incydentów. [Raport budowy korpusu](data/corpus-report.json)

Wśród źródeł są m.in. PAP, RPO, Wrocław, MSZ, Sejm, Eurostat i NATO. Wśród fact-checków jest 745 recenzji Demagoga pobranych przez Google Fact Check Tools, w tym archiwalne publikacje wykorzystane w odpowiedziach o Wrocławiu i depeszy PAP.

Poziom źródła i grupa niezależności są przypisane do **dokładnego hosta**. Oceny fact-checków przechodzą przez jawną tabelę `data/rating-map.yaml`, a ocena spoza tabeli niczego nie rozstrzyga. Licencje, kwalifikacja, aktualizacja i to, czego nie udało się pobrać (AFP Sprawdzam, PAP FakeHunter, Rada Europejska blokują boty): **[docs/SOURCES.md](docs/SOURCES.md)**. Katalog jest też w aplikacji, na stronie `/zrodla`. Kod jest na licencji ISC ([LICENSE](LICENSE)); rekordy korpusu zachowują licencje swoich źródeł (pole `licence` w rekordzie i w `data/sources.yaml`).

## Szybki start

Wymagania: Node.js ≥ 22 i npm.

```bash
cp .env.example .env          # OPENAI_API_KEY dla modelu, FACTCHECK_API_KEY dla indeksu Google
npm install
npm run corpus:load           # data/corpus/*.jsonl → SQLite (var/prawdowid.db), ok. 0,1 s
npm run dev                   # API :8787 + WWW (Vite) :5173 → otwórz http://localhost:5173
```

Jeśli projekt OpenAI nie ma rezydencji danych w UE, zostaw `OPENAI_DATA_RESIDENCY` puste (przetwarzanie w USA, ujawniane w raporcie). Ustawienie `eu` przy zwykłym projekcie kończy się błędem 401 i komunikatem „NIEPEŁNE”: usługa nigdy nie przełącza się po cichu na serwery w USA.

**Produkcja** (jeden proces, serwuje zbudowane WWW z `web-dist/`):

```bash
npm run build && npm start    # http://localhost:8787
```

**Panel `/admin`.** Przy pierwszym starcie powstaje konto `admin` (rola administrator) z hasłem z `ADMIN_PASSWORD`. Gdy zmienna jest pusta, hasło jest generowane, zapisywane w `var/admin-password` i wypisywane raz na stderr. Kolejne konta:

```bash
npm run user -- add anna moderator      # hasło z ukrytego promptu albo z pierwszej linii stdin
npm run user -- list | remove <login> | passwd <login>
```

Tokeny API (dla `/metrics`, eksportów i MCP) tworzy analityk albo administrator w panelu. Token jest pokazywany tylko raz.

**MCP.** Lokalnie (Claude Desktop, IDE) przez stdio:

```json
{ "mcpServers": { "fons": {
    "command": "/ŚCIEŻKA/DO/Fons/node_modules/.bin/tsx",
    "args": ["/ŚCIEŻKA/DO/Fons/src/mcp/stdio.ts"] } } }
```

Zdalnie: `claude mcp add --transport http fons https://TWOJA-DOMENA/mcp --header "Authorization: Bearer fons_…"`. Szczegóły w [docs/TOOLS.md](docs/TOOLS.md).

**Przydatne polecenia**

| Polecenie | Co robi |
|---|---|
| `npm run ask "tekst"` | sprawdzenie z terminala (kanał `cli`) |
| `npm test` · `npm run typecheck` | testy jednostkowe (bez sieci i klucza) · TypeScript |
| `npm run eval -- --split dev` | ewaluacja (wymaga klucza, kosztuje ok. 1 USD) |
| `npm run eval -- --suite redteam --split all --runs 3` · `npm run eval:demo` · `npm run consistency` | red-team (dev + held-out) · zestaw demo · spójność kanałów |
| `npm run eval:render <wyniki.json>` | odtworzenie `latest.md` z zapisanego wyniku, bez modelu |
| `npm run corpus:build` · `npm run corpus:officials` · `npm run corpus:demagog` | przebudowa korpusu z prawdziwych źródeł (Demagog: wyłącznie Google Fact Check Tools API, wymaga `FACTCHECK_API_KEY`) |
| `npm run corpus:verify` · `npm run embed` | kontrola rekordów względem źródeł · przeliczenie wektorów |
| `npm run mcp` · `npm run live:smoke "twierdzenie"` | serwer MCP (stdio) · próba wyszukiwania na żywo |

Ważne zmienne `.env`: `LIVE_SEARCH=on` (źródła na żywo: oficjalne kanały instytucji i wyszukiwanie w hostach z katalogu; `off` = tylko zamknięty korpus), `VERIFIER_PROVIDER` z drugim kluczem (weryfikator innej rodziny; bez niego weryfikator tej samej rodziny jest jawnym czynnikiem obniżającym punktację siły, a raport to zaznacza), `METRICS_TOKEN`, `USERS_PATH`, `DAILY_TOKEN_BUDGET`, `IP_DAILY_TOKEN_SHARE` (udział jednego klienta w dobowym budżecie, domyślnie 0,25), `RATE_LIMIT_PER_MINUTE`.

## Pliki w czacie

Przycisk „+” obok pola wiadomości pozwala dołączyć jeden plik, samodzielnie lub z pytaniem. Limit dla obrazu lub dokumentu wynosi 5 MiB. Fons odczytuje JPG, PNG i WebP do 32 megapikseli oraz tekst z PDF i TXT (UTF-8). Dokument z opisem może mieć łącznie do 20 000 znaków. Do odczytu PDF serwer potrzebuje polecenia `pdftotext` z pakietu Poppler (`brew install poppler` na macOS, `apt install poppler-utils` na Debianie). Skan można przesłać jako obraz.

Wybierz „Film” lub „Plik audio”, aby wysłać MP4, MOV, WebM, MP3, M4A, WAV lub OGG do 20 MiB i 10 minut. Na HTTPS lub localhost kliknij mikrofon obok strzałki wysyłania, aby podyktować wiadomość. Po zakończeniu transkrypcja OpenAI trafia do pola tekstowego. Możesz ją poprawić przed wysłaniem. Serwer sprawdza format i długość. Raport zachowuje odczytaną, zamaskowaną treść oraz pochodzenie twierdzeń. Bajty nagrania są usuwane po obsłużeniu wiadomości.

Pytanie „Czy ten obraz wygenerowała AI?” uruchamia lokalne sprawdzenie oryginalnego pliku. Fons weryfikuje osadzone poświadczenie C2PA i zaufanie do wystawcy. Podpisana deklaracja może wskazywać na wygenerowanie całego obrazu albo edycję z użyciem AI. W pliku bez podpisu Fons szuka edytowalnej deklaracji IPTC. Brak obu oznaczeń pozostawia pochodzenie nieustalone. Przy weryfikacji tekstu na obrazie model wizyjny otrzymuje kopię obrazu bez osadzonych metadanych. Dane widoczne w samych pikselach pozostają widoczne dla dostawcy.

Wysłane zdjęcie pojawia się przy wiadomości w czacie. Przy pytaniach o widoczne przedmioty, napisy lub kolory Fons analizuje obraz. Gdy pytanie dotyczy osoby lub wcześniejszej publikacji, sam dobiera wyszukiwanie obrazem. Przy ustalaniu tożsamości szuka podpisu powiązanego z tą samą fotografią w wiarygodnym źródle. Sprawdza również, czy Kancelaria Prezydenta opublikowała dokładnie tę fotografię jako portret w oficjalnym biogramie.

Cloud Vision Web Detection otrzymuje zmniejszoną kopię bez metadanych. Dla publicznego adresu pełnego dopasowania Fons odpytuje także Google Fact Check Tools o powiązane publikacje. Aby korzystać z tych usług, włącz ich API i ustaw na serwerze `GOOGLE_VISION_API_KEY` oraz `FACTCHECK_API_KEY`. Dzienny limit wyszukiwań określa `REVERSE_IMAGE_DAILY_CAP`. Administrator może wyłączyć wyszukiwanie obrazem przez `REVERSE_IMAGE_PROVIDER=off`. [Cloud Vision Web Detection](https://docs.cloud.google.com/vision/docs/detecting-web) · [Fact Check Tools](https://developers.google.com/fact-check/tools/api/reference/rest/v1alpha1/claims/imageSearch)

Google oferuje także probabilistyczny klasyfikator obrazów pod nazwą **AI Content Detection API**. Usługa wymaga przyjęcia projektu do programu Private Preview. Według oficjalnego formularza Google nabór nowych uczestników jest obecnie wstrzymany (sprawdzono 21.11.2026). [Dokumentacja](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/ai-content-detection) · [Stan naboru](https://docs.google.com/forms/d/e/1FAIpQLScj_8Im1G0A1DsJBfqT7mVN4ZaSKbP58D1PNrx3lnKr4Zt6jg/viewform)

## Następne kroki

1. **Kanały wiadomości.** Konektor ChatLoom przekazuje tekst i linki do silnika Fons oraz zwraca odpowiedź i reakcję na wiadomość. Uruchomienie na numerze wymaga podłączenia konta i wybranych rozmów po stronie ChatLoom. Formularz demonstracyjny pod `/telefon` zapisuje profil w przeglądarce. [Konfiguracja konektora](integrations/chatloom/README.md)
2. **Wiadomości głosowe:** zamiana mowy na tekst, potem ten sam potok. Transkrypcja jest przedmiotem sprawdzenia, nie dowodem.
3. **Dokumenty:** obsługa DOCX i wielostronicowych skanów PDF.
4. **Zdjęcia i zrzuty ekranu:** OCR modelem wizyjnym (ścieżka już istnieje) i wyszukiwanie wcześniejszych wystąpień treści w bazie incydentów.
5. **Pochodzenie mediów:** rozszerzenie sprawdzania poświadczeń na wideo.
6. **Import pakietu źródeł organizatora:** importer `src/corpus/import-organizer.ts` jest gotowy i czeka na publikację pakietu.
7. **Profil przetwarzania tylko w UE:** Mistral (endpoint UE) albo projekt OpenAI z rezydencją danych w UE, bez dostawców spoza EOG.
8. **Pilotaż:** proponujemy 4–6 tygodni z wybraną komórką MSZ. Najpierw kanał WWW i MCP dla analityków, potem jeden komunikator. Korpus odświeżamy codziennie (`corpus:officials`, `corpus:build`). Co tydzień mierzymy jakość na nowych, prawdziwych zgłoszeniach (wstrzymania, błędne werdykty, czas, koszt). Moderator przegląda kolejkę spraw, a do szerszego udostępnienia przechodzimy dopiero po spełnieniu progów z tabeli wyników.

## Ograniczenia i przypadki nieobsługiwane

- **Pokrycie źródeł decyduje o wyniku.** Jeśli w korpusie nie ma źródła, poprawną odpowiedzią jest „Brak wystarczających dowodów” i tak też odpowiada Fons. Brakuje m.in. Konstytucji art. 96–98, decyzji Rady Europejskiej, wyników PKW 2025, AFP Sprawdzam, PAP FakeHunter i Przewodniczącego Rady Europejskiej.
- **Twierdzenia o kilku podmiotach** („Litwa, Łotwa i Estonia…”), gdzie każdy rekord potwierdza tylko jeden podmiot, kończą się dziś wstrzymaniem. Reguły nie łączą dowodów z kilku rekordów dla jednego twierdzenia.
- **„Nieaktualne, ale kiedyś prawdziwe”** (reguła 4) wymaga starszego źródła w korpusie. Bez niego wynik to „Fałszywe” zamiast „Wprowadzające w błąd”.
- **Dane o osobach publicznych** się dezaktualizują. Przed pokazem trzeba przebudować `corpus:officials`, a potem `corpus:load` i `embed` (ok. 5 min).
- **Oficjalne kanały instytucji** (`LIVE_SEARCH=on`): gdy twierdzenie dotyczy MSZ albo RCB, kod pobiera ich kanał bezpośrednio (MSZ Odyseusz, komunikaty na gov.pl) — „najpierw źródło, potem triangulacja”, opis w [TOOLS](docs/TOOLS.md) §1a. Rejestr obejmuje na razie tylko MSZ i RCB. Ewaluacja działa bez źródeł na żywo.
- **Wyszukiwanie na żywo** (ta sama flaga, wymaga klucza OpenAI) dodaje 4–7 s, w ok. 12% przypadków przekracza limit czasu, a strony EUR-Lex wracają puste z ekstraktora.
- **Obrazy.** Scenariusz depeszy PAP sprawdzono na przygotowanym zrzucie z widoczną datą. Jakość odczytu na reprezentatywnej próbie zrzutów wymaga osobnego pomiaru. Wyszukiwanie obrazem obejmuje indeks Google Cloud Vision. Nazwiska widoczne na obrazie mogą trafić do dostawcy.
- **Tryb jednego klucza:** weryfikator to model tego samego dostawcy. To jawny czynnik obniżający punktację siły (raport to zaznacza); bez niezależnej kontroli (kontroli dosłownej nazw i liczb w kodzie) jedno źródło kończy się na „średniej”, a jedno źródło urzędowe z kontrolą dosłowną może dostać „mocną” ([VERDICT-RULES §5](docs/VERDICT-RULES.md)).
- **Deduplikacja spraw moderatora** (scenariusz H) zadziałała w pomiarze w 1 z 2 grup podobnych zgłoszeń: dla „H-elblag” powstały 2 sprawy zamiast jednej. Poprawka jest w kodzie (parafrazy łączone podobieństwem wektorów e5 ze strażnikiem nazw własnych, skrótów i liczb, bo same wektory nie odróżniają innego miasta); progi sprawdzono na prawdziwym modelu wektorowym w teście opcjonalnym (`RUN_E5_TESTS=1`), ale pełnego `npm run consistency` po poprawce nie powtórzyliśmy.
- **Ostrzeżenia o domenie i statusie źródła** (scenariusz I): domeny incydentów w `data/incidents` są puste, więc ostrzeżenie o znanym incydencie nie pojawia się (0/3 dev, 0/2 held-out), a ostrzeżenia o statusie źródła (np. media objęte sankcjami UE) system jeszcze nie wydaje. Werdykt i tak opiera się wyłącznie na treści.
- **Sprzeczne źródła** (scenariusz C): reguła 5 i blok „źródła sprzeczne” są pokryte testami jednostkowymi, ale w pomiarze na prawdziwym modelu blok nie pojawił się ani razu (0/3 dev, 0/1 held-out) — w korpusie brakuje par sprzecznych źródeł dla tych przypadków.
- **Data lub liczba w prostym twierdzeniu** (np. A03 „Polska wstąpiła do NATO w 2004”): reguła 8b daje FAŁSZYWE tylko, gdy model oceniający oznaczy fragment jako obalający datę/liczbę; w pomiarze oznaczył go jako „częściowo”, więc wynik to WPROWADZAJĄCE. Zmiana instrukcji modelu jest w toku i niezmierzona.
- **Niedeterminizm modelu:** te same przypadki z linkiem (np. L01, L05, L07) w różnych przebiegach kończą się werdyktem albo wstrzymaniem. Dlatego red-team liczy najgorszy z 3 przebiegów.
- Sesje panelu są w pamięci (po restarcie trzeba się zalogować ponownie). Dziennik audytu nie wykrywa ucięcia końcówki bez zewnętrznej kotwicy (`headHash`).
- Wykrywanie ukrytej treści czyta style inline i proste reguły `<style>`, nie obliczony CSS. Numery stacjonarne w formacie „221 234 567” nie są maskowane.

## Ryzyka i ich ograniczanie

| Ryzyko | Jak je ograniczamy |
|---|---|
| **Halucynacje** | Werdykt liczą reguły w kodzie. Cytat musi występować dosłownie w rekordzie, a pokazany cytat jest wycinany z rekordu, nie z odpowiedzi modelu. Tytuły, linki, daty i wydawców wstawia baza. Odpowiedź na pytanie otwarte składa kod; bez sprawdzonego cytatu odpowiedzi nie ma. Weryfikator może zawetować dowód. Persona Fons zakazuje podawania wiedzy modelu jako faktu. |
| **Stronniczość źródeł** | Jawny katalog z poziomem, typem i grupą niezależności (syndykacja liczy się jako jeden wydawca). Fact-check rozstrzyga tylko od sygnatariusza IFCN/EFCSN, a źródła wtórne tylko w parze niezależnych. Przy sprzecznych źródłach reguła 5 daje „Brak wystarczających dowodów” i blok „źródła sprzeczne” z oboma cytatami (pokryte testami jednostkowymi reguł; na prawdziwym modelu jeszcze niezmierzone — scenariusz C: 0/3 dev, 0/1 held-out). Katalog jest publiczny (`/zrodla`). |
| **Prywatność** | Maskowanie PII przed modelem i logiem, pseudonimizacja nadawcy, retencja 30/7 dni, „usuń moje dane”, `store:false` u dostawcy, logi bez treści, ujawnianie przetwarzania poza EOG w każdym raporcie, prywatny token raportu dla każdego użytkownika. |
| **Prompt injection** | Detektor na surowej treści (także ukryty HTML i strony z wyszukiwania na żywo). Trafione zdania wypadają z podstawy werdyktu. Bloki z losowym ogranicznikiem, odpowiedzi tylko w schemacie JSON, brak narzędzi przy treści niezaufanej, weryfikator. Zestaw red-team sprawdza też kanarki (fraza, która nie może pojawić się w odpowiedzi). Ponowne logowanie ataku także przy trafieniu w cache. Wyniki MCP są oznaczone jako dane niezaufane. Pomiar: 3 przebiegi red-team, liczy się najgorszy. |
| **Dostępność** | Awaria elementu koniecznego daje „NIEPEŁNE” bez werdyktu. Awaria gałęzi opcjonalnej daje werdykt z adnotacją. Każda gałąź i każde wywołanie modelu ma limit czasu. Router przenosi wywołanie na główny model albo zapasowego dostawcę. Bez modelu wektorowego działa samo BM25. WWW jest po polsku, prostym językiem, od 360 px, z komunikatami dla czytników ekranu. |
| **Nadużycia** | Limity na użytkownika, IP (IPv6 po /64) i token, dzienny udział jednego klienta w budżecie tokenów, limit długości wejścia, dobowy bezpiecznik tokenów, ochrona `POST /api/chat` przed żądaniami z obcych stron (wymagany JSON, `Sec-Fetch-Site`/`Origin`), ochrona SSRF, podpisy HMAC webhooków, RBAC z CSRF i sprawdzaniem Origin, limit nieudanych logowań na IP i login, eksport CSV neutralizujący formuły, nagłówki CSP. |
