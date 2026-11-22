# Prawdowid — archiwalny plan budowy (v3)

Bieżącą architekturę i instrukcję uruchomienia opisuje [README](README.md).

Hackathon HackNation 2026, zadanie MSZ. 24 h, 1 osoba + agenci kodujący. Jury uruchamia system samo, ma ukryty zestaw ≥30 przypadków (scenariusze A–J) i zadaje własne pytania.

## 0. Decyzja

Trzech niezależnych sędziów (kryteria jury / bezpieczeństwo / wykonalność) oceniło hipotezy:

| Hipoteza | Oceny | Dlaczego |
|---|---|---|
| H1 sztywny potok na zamkniętym korpusie | 55 / 72 / 55 | bezpieczny, ale pytania jury kończą się wstrzymaniem; brak „agenta” |
| H2 swobodny agent z narzędziami (styl Instinct) | 30 / 30 / 35 | treści niezaufane przy modelu z narzędziami, werdykt = etykieta modelu (zakaz §5), niespójność kanałów, >30 s |
| H3 powłoka agenta + rdzeń potokowy | v1: 66 / 74 / 50 → v2: 81 / 84 / 80 → v3: 85 / 88 / 86 → v4: 87 / 89 / 88 | ta wersja nanosi też uwagi z rundy 4 (nieoceniane ponownie) |

Próg 90/100 nie został osiągnięty u żadnego sędziego. Według nich pozostała luka nie wynika z wad planu, tylko z dwóch ryzyk wykonania: jedna osoba na 24 h (szansa ukończenia P0 ok. 88%, P0+P1 ok. 55–68%) oraz nieznane pokrycie źródeł względem ukrytego zestawu jury.

Wybór: **H3**. Odczucie „piszę z agentem” daje cienka warstwa rozmowy; o werdykcie decyduje jawny, audytowalny potok.

## 1. Zasady nienaruszalne

1. **Treść od użytkownika nigdy nie jest dowodem.** URL, OCR, transkrypcja, EXIF to przedmiot weryfikacji. Dowodem są wyłącznie rekordy ze źródeł z katalogu `sources.yaml`. Poziom źródła jest przypisany do **dokładnego hosta** w katalogu (bez dziedziczenia z domeny nadrzędnej), nigdy z odpowiedzi konektora ani modelu.
2. **Każda teza w odpowiedzi ma cytat**, który istnieje dosłownie w zapisanym fragmencie źródła. Linki, tytuły, daty i wydawcy są wstawiane z bazy, nigdy z tekstu modelu.
3. **Status techniczny to nie werdykt.** Osobne pole: `OK | NIEPEŁNE | AWARIA | DOPRECYZUJ | POZA ZAKRESEM`.
   - Padł element konieczny (model, korpus lokalny, odczyt wejścia/OCR) albo wszystkie gałęzie wyszukiwania → **bez werdyktu**, komunikat techniczny.
   - Padła gałąź opcjonalna (konektor, wyszukiwanie na żywo) → werdykt zostaje, raport zawiera „nie udało się sprawdzić w: X”.
   - Komunikat nigdy nie przepisuje treści błędu dostawcy.
4. **Żaden model nie ma jednocześnie treści niezaufanej i narzędzi.** Orkiestratorem jest kod.
5. **Ten sam rdzeń i ten sam raport dla każdego kanału** (WWW też przechodzi przez router). Renderery kanałów to szablony bez LLM.
6. **Żadnych przykładów testowych w promptach**; strojenie tylko na zbiorze dev, raport z held-out.
7. Funkcje premiowane dopiero po przejściu progów MVP w `make eval`.

## 2. Architektura

Jedna usługa: **Python FastAPI + SQLite (FTS5) + wektory w numpy + Jinja/HTMX + Tailwind**. Jeden Dockerfile, `docker compose up` albo `uv run`. Bez modeli językowych i bez torch w obrazie (jedyny dołączony model to mały embedder ONNX). Publiczne demo na hostingu w UE od 3. godziny.

**Tryb jednego klucza jest domyślny w README:** jeden klucz LLM wystarcza do pełnego działania; drugi dostawca i wyszukiwarka są opcjonalne i włączane flagami. Test czystego klonu odbywa się w tym trybie. Embeddingi zapytań liczy mały model ONNX dołączony do obrazu (bez torch; wybór i rozmiar potwierdzane w 1. godzinie). Identyfikator i hash modelu są zapisane w migawce korpusu i sprawdzane przy starcie usługi oraz w `make eval`; przy niezgodności lub braku modelu usługa przechodzi na samo BM25 z jawnym komunikatem — nigdy na embeddingi z innego modelu. Dzięki temu wyszukiwanie u jury działa tak samo jak w publicznym demo, bez dodatkowego klucza i bez wysyłania zapytań poza usługę.

```
Adaptery kanałów ──► Gateway (podpis, deduplikacja, limit, maskowanie PII)
WWW · CLI
        │
        ▼
Warstwa rozmowy (przyciski i słowa kluczowe; mały model tylko jako zapas)
        │ jedyne narzędzie
        ▼
verify(): normalizacja → detektor ataków → twierdzenia → wyszukiwanie
          → ocena dowodów → kontrola cytatów → werdykt (kod) → uzasadnienie
        │
        ▼
VerdictReport (kanoniczny JSON, zapis przebiegu) ──► renderer kanału / strona /w/{token}
```

Porty wymienne: `LLMProvider`, `EmbeddingProvider`, `SourceConnector`, `SearchProvider`, `VisionOCR`, `ChannelAdapter`, `Notifier`, `Exporter`. OpenAPI generuje FastAPI.

## 3. Potok `verify()`

**Budżet: 5–7 wywołań LLM, p50 ok. 15 s, p95 ≤ 30 s.**

1. **Normalizacja wejścia.** Tekst; URL (pobranie z ochroną SSRF, ekstrakcja treści); obraz (P2). Limit długości. „Wczoraj/dziś” kotwiczone do czasu zgłoszenia.
2. **Detektor ataków — deterministyczny, na surowej treści** (przed usunięciem ukrytego HTML i znaków zero-width): wzorce PL/EN/RU/UA, imitacja ograniczników, base64, ukryty tekst w trybie rozkazującym. Trafienie = zdarzenie bezpieczeństwa w logu z identyfikatorem źródła; **trafione zdanie** wypada z podstawy werdyktu (reszta fragmentu zostaje); raport mówi „w materiale wykryto próbę wpłynięcia na system — zignorowano”. Dodatkowo kanarek w prompcie systemowym i naruszenie schematu jako sygnały. Cel: fałszywe alarmy ≤ 2% na 200 łagodnych fragmentach, w tym debunkach cytujących dezinformację.
3. **Ekstrakcja twierdzeń** (mały model, schemat): do 3 twierdzeń atomowych z krótkiej wiadomości, do 6 z długiego tekstu (od 1500 znaków: artykuł, transkrypcja; wklejony tekst do 20 000 znaków, strona do 16 000), ułożonych od najważniejszego i najłatwiejszego do sprawdzenia; typ (fakt / opinia / prognoza), twierdzenie główne, czas zdarzenia. Twierdzenie musi mieć wysoką zgodność n-gramów z wejściem; gdy model przeredagował albo przetłumaczył twierdzenie, kod bierze dosłowny fragment wejścia (`sourceText`, próg 0,85) — twierdzenie zostaje w języku wiadomości. 0 twierdzeń przy niepustym wejściu = zdarzenie w logu.
   - **Transkrypcje** (2026-11-21): przed ekstrakcją kod usuwa znaczniki czasu, numerację i linie napisów SRT/WebVTT oraz wtrącenia typu „[muzyka]”, a krótkie linie napisów łączy w zdania; mówcy zostają.
   - **Twierdzenia złożone** (ten sam fakt o 2–4 podmiotach, np. „Polska i Litwa wstąpiły do NATO w 1999”): model podaje części (po jednej na podmiot, tymi samymi słowami), kod sprawdza każdą osobno i łączy werdykty (`verdict/compound.ts`, zasady w docs/VERDICT-RULES.md §7). Najwyżej 8 jednostek (twierdzeń i części) na zapytanie.
   - **Budżet długiego tekstu:** wyszukiwanie na żywo tylko dla 3 pierwszych jednostek (pozostałe — baza), surowy tekst dłuższy niż 600 znaków bez wyszukiwania na żywo, najwyżej 4 równoległe wywołania oceny; weryfikator dostaje pozycje na zmianę z każdego twierdzenia (limit 18). Podsumowanie zestawia oceny wszystkich twierdzeń i mówi, że z długiego tekstu wybrano najważniejsze.
   - **Twierdzenie o osobie** („Prezydentem Polski jest Donald Tusk”): drugie zapytanie bez nazwiska („Prezydentem Polski jest”) — do 2 najlepszych rekordów pierwotnych z niego zawsze trafia do ocenianych fragmentów, bo pula z nazwiskiem wypełnia się rekordami o tej osobie, a nie stroną urzędu.
4. **Wyszukiwanie** — równolegle z krokiem 3, limit 4 s na gałąź:
   - korpus lokalny: BM25 + wektory, zapytania PL i EN;
   - baza zweryfikowanych informacji/incydentów organizatora i fact-checki (rekordy o stałej roli, patrz sekcja 4);
   - trafienie samej **domeny/kanału** w katalog incydentów = wyłącznie neutralne ostrzeżenie;
   - konektory API źródeł pierwotnych (ELI/ISAP);
   - wyszukiwanie na żywo ograniczone do hostów z katalogu; dopasowanie hosta dokładne, **po ostatnim przekierowaniu**; strona przechodzi detektor (oflagowana nie jest zapisywana), trafia do osobnej tabeli `live_snapshots` z identyfikatorem przebiegu i TTL — **nie** do migawki korpusu.
5. **Ocena dowodów** — jedno wywołanie na twierdzenie z 6–8 fragmentami w blokach z losowym ogranicznikiem. Wyjście (schemat) dla każdego fragmentu: relacja `WSPIERA | OBALA | CZĘŚCIOWO | INNY_KONTEKST | BEZ_ZWIĄZKU`, aspekt `sedno | czas | miejsce | liczba | autorstwo | zakres`, okres, którego dotyczy fragment, dosłowny cytat ≤ 300 znaków.
6. **Kontrola cytatów:** (i) dopasowanie podciągu po normalizacji (rapidfuzz ≥ 90), inaczej dowód odpada; (ii) detektor na samym cytacie; (iii) **weryfikator** — jedno zbiorcze wywołanie innego modelu tylko dla dowodów rozstrzygających („czy sam cytat wspiera/obala twierdzenie?”). Jawnie przeciwna odpowiedź → dowód nie rozstrzyga + sprawa dla moderatora; „niepewne” → tylko obniża siłę. Weryfikator z innej rodziny modeli, gdy jest drugi klucz (tak działa publiczne demo); w trybie jednego klucza — inny model tej samej rodziny i jawna adnotacja w raporcie. *(Zmiana 2026-11-21, na prośbę właściciela projektu: twardy limit „najwyżej średnia” dawał „średnią” siłę nawet dla oczywistych przypadków potwierdzonych przez dwa niezależne źródła urzędowe. Zamiast limitu weryfikator tej samej rodziny jest osobnym, jawnym czynnikiem obniżającym punktację; przy jednym źródle bez niezależnej kontroli siła nadal kończy się na „średniej”. Niezależną od modeli kontrolą odczytu jest kontrola dosłowna w kodzie — nazwy i liczby twierdzenia vs cytat. Szczegóły: docs/VERDICT-RULES.md §5.)* Adnotacja o weryfikatorze tej samej rodziny jest widoczna w każdym rendererze (także SMS i Discord), a `make eval` publikuje wyniki dla obu trybów. `eval` raportuje odsetek werdyktów zmienionych przez weryfikator; weto można ograniczyć do wpływu na siłę tylko wtedy, gdy łącznie: F1 na dev spada przez nie o > 0,03 **i** odporność na zestawie red-team bez weta pozostaje ≥ 90%. Decyzja i obie liczby trafiają do README.
7. **Werdykt — reguły w kodzie** (sekcja 4).
8. **Uzasadnienie:** szablon z pól raportu (domyślnie). Wygładzanie małym modelem opcjonalne, z walidatorem (żadnych URL, liczb spoza cytatów, innego słowa werdyktu) — przy odrzuceniu wraca szablon.
9. **Zapis przebiegu:** pytanie po maskowaniu, czasy kroków, źródła, wynik, modele, tokeny, koszt, błędy gałęzi, zdarzenia bezpieczeństwa; log JSON z łańcuchem hashy.

**Spójność kanałów i odtwarzalność:**
- identyfikator migawki korpusu ustalany na starcie zapytania; migawka publicznego demo jest w repo;
- cache **obliczenia** po kluczu `hash(znormalizowane wejście) + migawka + wersja potoku`, TTL 48 h (obejmuje użyte rekordy z `live_snapshots`); zapisywane są przebiegi ze statusem OK, także z adnotacją o niedostępnej gałęzi opcjonalnej i z trafieniem detektora (jego decyzja jest deterministyczna); nie zapisujemy AWARII, NIEPEŁNE ani DOPRECYZUJ; administrator może unieważnić wpis;
- przebieg z niedostępną gałęzią opcjonalną ma TTL 15 min, żeby chwilowa awaria nie utrwaliła okrojonego wyniku;
- każde trafienie w cache zapisuje od nowa zdarzenia bezpieczeństwa z zapisanego przebiegu (z nowym identyfikatorem żądania) i pokazuje komunikat o próbie manipulacji;
- daty względne („wczoraj”, „dziś”) są zamieniane na konkretne przed liczeniem hasha; plik modelu ONNX przypięty po hashu;
- `make consistency` obejmuje też przypadki ataku (E) i awarii (J), w tym test: ten sam atak 3 razy = 3 zdarzenia w logu;
- każdy użytkownik dostaje **własną kopię raportu z własnym tokenem** — „usuń moje dane” nie dotyka cudzych raportów;
- `make eval` i `make consistency` działają offline (wyszukiwanie na żywo wyłączone), na migawce z repo.

## 4. Reguły werdyktu

Pięć klas: POTWIERDZONE · FAŁSZYWE · WPROWADZAJĄCE W BŁĄD · BRAK WYSTARCZAJĄCYCH DOWODÓW · NIE PODLEGA WERYFIKACJI.

**Dwa rodzaje rekordów:**
- **Źródła treści** (akty prawne, komunikaty, dane, analizy): relację ustala czytelnik (krok 5).
- **Rekordy o stałej roli** (fact-checki, ClaimReview, baza organizatora, EUvsDisinfo — one dosłownie powtarzają fałszywą tezę): werdykt bierzemy **wyłącznie z pola oceny w rekordzie** przez jawną tabelę mapowania (w repo, m.in. kategorie Demagoga); ocena nieznana tabeli nie rozstrzyga. Model sprawdza tylko stosunek sprawdzanej tezy (`claimReviewed`, pokazywanej dosłownie) do twierdzenia użytkownika co do sedna i czasu: `ta_sama | zaprzeczona | inna | niepewne`. `ta_sama` → ocena z tabeli; `zaprzeczona` → odwracamy wyłącznie oceny binarne (fałsz ↔ prawda), pozostałe nie rozstrzygają; `inna` i `niepewne` nie rozstrzygają. W zestawie ewaluacyjnym ≥ 5 przypadków z negacją.

**Dowód rozstrzygający** = zweryfikowany cytat z: ≥ 1 źródła pierwotnego/urzędowego **albo** ≥ 1 rekordu o stałej roli od organizacji IFCN/EFCSN lub z bazy organizatora, dopasowanego do twierdzenia **albo** ≥ 2 niezależnych źródeł wtórnych. Liczba potwierdzeń wpływa tylko na siłę.

Reguły w kolejności stosowania:

| # | Sytuacja | Werdykt |
|---|---|---|
| 1 | typ = opinia / prognoza | NIE PODLEGA WERYFIKACJI |
| 2 | brak dowodu rozstrzygającego | BRAK DOWODÓW + co próbowano ustalić + co znaleziono poniżej progu |
| 3 | **jednorazowe zdarzenie z datą** nowsze niż najnowszy dowód (nie dotyczy stanów i statystyk — te idą do reguły 4) | BRAK DOWODÓW (starsze, podobne zdarzenie nie obala) |
| 4 | twierdzenie o stanie lub liczbie w czasie teraźniejszym: starsze źródło (także stary fact-check) WSPIERA, nowsze urzędowe OBALA ten sam aspekt | WPROWADZAJĄCE W BŁĄD (nieaktualne) + ostrzeżenie o materiale archiwalnym |
| 5 | WSPIERA i OBALA dla **tego samego aspektu i nakładającego się okresu** (także: fact-check kontra źródło pierwotne z tego samego okresu) | BRAK DOWODÓW z blokiem „źródła sprzeczne”: obie strony, daty, bez wskazywania zwycięzcy |
| 6 | dopasowany rekord o stałej roli i **brak nowszego lub sprzecznego źródła pierwotnego** dla tego aspektu | werdykt z tabeli mapowania; ma pierwszeństwo przed oceną czytelnika dla źródeł wtórnych |
| 7 | WSPIERA sedno, żaden aspekt nie jest obalony | POTWIERDZONE |
| 8 | OBALA sedno; albo twierdzenie sprowadza się do obalonego aspektu (np. sama data lub liczba) | FAŁSZYWE |
| 9 | sedno prawdziwe + obalony aspekt (czas, miejsce, liczba, autorstwo, zakres); relacja CZĘŚCIOWO lub INNY_KONTEKST; obalony aspekt bez dowodu na sedno | WPROWADZAJĄCE W BŁĄD + nazwany brakujący kontekst |

Wiele twierdzeń: werdykt per twierdzenie; etykieta wiadomości = werdykt twierdzenia głównego.

**Siła podstawy** (słaba / średnia / mocna + punktacja 0–100) — jawna karta z listą czynników „podnosi / obniża”: poziom i typ źródeł, aktualność względem pytania, liczba niezależnych wydawców (ta sama grupa/syndykacja = 1), wynik i niezależność weryfikatora, kontrola dosłowna nazw i liczb, źródła mówiące inaczej poniżej progu. Status źródła (np. sankcje UE) = osobne neutralne ostrzeżenie.

**Lista dowodów** w każdym raporcie (P1): dowody pogrupowane na wspierające / obalające / uzupełniające kontekst, każdy z tytułem, wydawcą, datą publikacji i pobrania, linkiem i cytatem. Wizualny „łańcuch dowodowy” od twierdzenia do źródeł — P2.

**Blok przejrzystości** w każdym raporcie, zgodny z faktycznym trybem: „Kod sprawdził: obecność cytatu w źródle z katalogu, poziom źródła, daty, niezależność wydawców. Model X ocenił, czy cytat wspiera twierdzenie; model Y to sprawdził. Przeczytaj źródło sam.” W trybie zapasowym: „Model zaproponował werdykt, kod sprawdził warunki.”

**Dwa tryby werdyktu za flagą od 3. godziny:** (A) reguły powyżej; (B) model proponuje werdykt ze schematem, kod zostawia bramki (brak cytatu → brak dowodów; opinia → nie podlega; nie wolno potwierdzić bez WSPIERA). Pomiar na dev w 9. i 17. godzinie; domyślny zostaje A, B tylko gdy A < 0,75 macro-F1.

## 5. Źródła

- **Katalog** `sources.yaml` (otwarty): host, wydawca, typ (pierwotne/urzędowe · fact-check · analiza instytucjonalna), poziom, grupa niezależności, licencja, sposób pobierania, częstotliwość aktualizacji, zasady kwalifikacji i wykluczania. Strona audytu w WWW.
- **Korpus startowy** ≥ 300 rekordów, ≥ 12 domen: ELI (Dz.U./M.P.), Sejm API, EUR-Lex, lista sankcji UE, Eurostat, gov.pl/MSZ; DataCommons ClaimReview PL (CC BY), Demagog; EUvsDisinfo, EEAS/NATO, NASK/EDMO. Akty prawne i materiały urzędowe — pełne fragmenty; treści redakcyjne — metadane + krótki cytat + link.
- **Pakiet organizatora** (lista źródeł, baza incydentów): importer gotowy przed publikacją, import w ≤ 2 h.
- Rekord: tytuł, wydawca, data publikacji, data pobrania, URL, fragment, licencja, typ, poziom, grupa, rola (treść / stała rola + ocena).
- Embeddingi korpusu policzone wcześniej i zapisane w repo; zapytania liczy ten sam dołączony model ONNX; gdy model jest niedostępny — samo BM25 z jawnym komunikatem.
- Nie obchodzimy paywalli ani zabezpieczeń; robots.txt, limit zapytań.

## 6. Bezpieczeństwo i prywatność

- Zasady 1–4 z sekcji 1 + detektor, kontrola cytatów i rekordy o stałej roli.
- **URL:** jednorazowe rozwiązanie DNS i połączenie z tym IP, blokada sieci prywatnych, ≤ 3 przekierowania sprawdzane osobno, tylko http/https 80/443, limit 5 MB po dekompresji, limit czasu.
- **Webhooki:** podpis na surowym ciele (HMAC), deduplikacja po identyfikatorze wiadomości, okno 5 min; test: żądanie bez podpisu → 403.
- **Discord:** `allowed_mentions=none`, escapowanie markdown (tytuły źródeł nie tworzą zamaskowanych linków), odpowiedzi tylko w wiadomościach prywatnych i na wzmianki.
- **Strona wyniku:** token 128-bit per użytkownik, `noindex`, tylko zamaskowane twierdzenie, allowlista schematów URL, ścisły CSP, pełne escapowanie.
- **Panel administratora:** hasło wymagane w env lub generowane przy pierwszym starcie, ciasteczko httpOnly + SameSite=Strict, CSRF.
- **Nadużycia i koszt:** limit per użytkownik i IP, limit znaków, dobowy bezpiecznik budżetu tokenów (po przekroczeniu komunikat techniczny).
- **Eksport CSV:** neutralizacja formuł. **Logi** nigdy nie trafiają do modelu.
- **Prywatność.** Tekst przed zapisem i oceną przechodzi maskowanie m.in. PESEL-u, numeru dowodu, telefonu, e-maila i IBAN-u. Imiona, nazwiska i wartości opisane jako kwoty, miary lub publiczne numery referencyjne służą do weryfikacji. Wyszukiwarki pomijają znaczniki używane do maskowania. Identyfikator użytkownika jest pseudonimizowany przez HMAC z osobnym kluczem. EXIF bez GPS i poza promptem. Media usuwamy po przetworzeniu. Retencja wynosi 30 dni dla przebiegów i 7 dni dla sesji. Dane można usunąć poleceniem „usuń moje dane” lub przez `DELETE /session`.
- **Metryka odporności:** każdy przypadek ma cel atakującego (zmiana werdyktu, kanarek, link, wyciek promptu, efekt uboczny, stłumienie logu). Odparcie = werdykt równy bliźniakowi bez ładunku ∧ brak kanarka ∧ brak efektu ubocznego. Raportujemy osobno: odporność, wykrywalność, fałszywe alarmy. Zestaw ≥ 40 przypadków: wiadomość, strona, ukryty HTML, dokument korpusu, odpowiedź konektora, strona z wyszukiwania na żywo, OCR/EXIF, markdown Discorda; ładunek pisany pod cytat, podzielony między fragmenty, imitacja ogranicznika, intencje „usuń dane”/„zgłoś”; PL/EN/RU/UA; base64, homoglify. W trakcie budowy 1 uruchomienie, w pomiarze końcowym 3 (liczy się najgorsze).

## 7. Kanały

| Wejście aplikacji | Uruchomienie |
|---|---|
| WWW | Czat na stronie głównej |
| CLI | `npm run ask -- "pytanie"` |
| MCP | Transport stdio lub HTTP pod `/mcp` |

Kontrakt `ChannelAdapter`: `verify_signature`, `parse_inbound → InboundMessage`, `send(OutboundMessage)`, `capabilities` (długość, media, przyciski). Dodanie kanału = jeden plik.

**Warstwa rozmowy:** natychmiastowe „Sprawdzam…”, potem wynik. Intencje rozpoznawane przyciskami i słowami kluczowymi (sprawdź · źródła · dlaczego · zgłoś · usuń moje dane); „źródła” i „dlaczego” to szablony z zapisanego raportu; mały model tylko gdy reguły nie rozpoznają wiadomości. „Usuń moje dane” i „zgłoś” wymagają potwierdzenia przyciskiem lub drugą wiadomością — słowo kluczowe w przekazanej treści niczego nie uruchamia.

## 8. Pętla informacji

- **P1 (minimum):** nierozstrzygnięte zgłoszenie → sprawa; deduplikacja przez podobieństwo twierdzeń → jedna sprawa z licznikiem unikalnych nadawców; jeden alert (webhook) do odbiorcy wskazanego przez administratora, gdy temat jest z jawnej listy wysokiego ryzyka (wybory, zdrowie, bezpieczeństwo, sprawy konsularne/ewakuacje) lub ≥ N nadawców; alert wysyłany raz na sprawę, z twardym dziennym limitem i licznikiem pominiętych w logu. Użytkownik dostaje „sprawa #X utworzona/zaktualizowana” dopiero po zapisie; inaczej tylko rekomendację.
- **P2:** panel (kolejka, klastry, metryki), tekst reprezentatywny sprawy ustala moderator, pominięte alerty trafiają do zestawienia zbiorczego, eksport CSV/JSON.

## 9. Modele i dostawcy

Port `LLMProvider`, dwie implementacje: Mistral (endpoint UE) i Claude. Domyślny pojedynczy klucz wybiera pomiar na dev w 9. godzinie; przy porównywalnej jakości domyślny jest Mistral UE (przetwarzanie w EOG), a Claude pełni rolę drugiego klucza — weryfikatora z innej rodziny. Małe modele wszędzie; mocniejszy tylko w ocenie dowodów, jeśli wymaga tego F1. Profil „UE” = wyłącznie Mistral UE. Claude przez endpoint w UE, jeśli jest dostępny na koncie; inaczej miejsce przetwarzania jest jawnie podane. W README tabela: klucze, limity, koszt zapytania i 1000 zapytań (szacunek: 45–100 USD), miejsce przetwarzania, zachowanie przy awarii, ścieżka migracji. Dostawcy spoza EOG oznaczeni i wyłączalni flagą.

## 10. Ewaluacja

`make eval` offline na migawce: macro-F1 + macierz pomyłek, pokrycie i poprawność cytowań, wstrzymanie, odporność / wykrywalność / fałszywe alarmy, p50/p95, koszt 100 testów, spójność kanałów, pętla, wstrzykiwanie usterek (scenariusz J), wpływ weryfikatora. Zestaw ≥ 60 przypadków A–J, ≥ 10 na klasę „wprowadzające w błąd” (w tym nieaktualne-ale-prawdziwe), podział dev / held-out; held-out pisze agent, który nie widzi promptów. Lista przypadków nieobsługiwanych w README.

## 11. Zakres

- **P0 (warunek brzegowy):** WWW tekst/URL → werdykt z cytatami; CLI; korpus; wstrzymanie; zapis przebiegu; publiczne demo; README przechodzące czysty klon w trybie jednego klucza.
- **P1 (trzon oceny, ≤ 10 h):** ingestia + pakiet organizatora + dopasowanie treści do incydentów; wyszukiwanie po katalogu; reguły werdyktu strojone na dev; lista dowodów w raporcie; warstwa bezpieczeństwa i prywatności; `make eval`; minimum pętli informacji; obserwowalność i koszt.
- **P2 (premia, w tej kolejności):** zrzut ekranu/zdjęcie przez model wizyjny — chroniony slot 2 h (odczytany tekst i data pokazane, użytkownik może poprawić; tekst i adresy ze zrzutu przechodzą przez gotowe dopasowanie do bazy incydentów, co daje „wcześniejsze wystąpienia” treści; jawnie: to nie jest odwrotne wyszukiwanie obrazu) · wizualny łańcuch dowodowy (ok. 1 h, inne wyrenderowanie gotowej listy dowodów) · WhatsApp · panel i eksport CSV/JSON · strona audytu źródeł · sygnały stronniczości przekazu jako kontekst.
- **Rezerwa:** lokalny indeks pHash, audio/wideo z przesłanego pliku, eksport STIX 2.1 + DISARM, prawdziwy SMS.
- **Poza zakresem:** pobieranie rolek z linków (tylko publiczne metadane + prośba o plik), nieoficjalne mosty iMessage, lokalne modele językowe i transkrypcji w obrazie.

## 12. Harmonogram

| Godziny | Praca |
|---|---|
| 0–1 | konta: hosting UE, Discord, klucze; agent A: szkielet + zaślepka raportu; agent B: zestaw ewaluacyjny i harness; agent C: dokumenty formalne (prowadzone ciągle) |
| 1–3 | cienki przekrój wejście → odpowiedź, **wdrożony publicznie**, WWW + Discord; oba tryby werdyktu za flagą |
| 3–10 | ingestia, wyszukiwanie po katalogu, reguły werdyktu; ewaluacja co godzinę; pomiar w 9. godzinie; import pakietu organizatora natychmiast po publikacji |
| 10–14 | bezpieczeństwo, prywatność, zestaw red-team, minimum pętli, obserwowalność |
| 12 | **punkt kontrolny.** Jeśli P1 się nie mieści, wypadają kolejno: wyszukiwanie na żywo (zostają korpus, ClaimReview, ELI) → warianty red-team ponad 40 bazowych → alert pętli (zostaje sprawa z deduplikacją). Jeśli nie ma jeszcze pakietu organizatora: korpus startowy + wyszukiwanie po katalogu i jawna adnotacja w README |
| 14–17 | P2 w kolejności z sekcji 11; 14–16 chronione na zrzut ekranu/zdjęcie, 16–17 na łańcuch dowodowy. Cięcia z 12. godziny nie dotykają tych dwóch pozycji; działający zrzut ekranu (scenariusz F) jest warunkiem akceptacji filmu |
| 17 | **zamrożenie funkcji**, drugi pomiar trybów werdyktu |
| 17–20 | test czystego klonu przez agenta, strojenie, pomiar końcowy |
| 20–24 | film 3 min (na żywo A–J, w tym atak i awaria), 12 slajdów, opis 4000 znaków, zapas |

## 13. Dokumenty formalne (§4)

Opis ≤ 4000 znaków · PDF 12 slajdów · film ≤ 3 min · README z uruchomieniem · architektura, przepływ danych, modele, dostawcy, ograniczenia · źródła, licencje, kwalifikacja, aktualizacja · wyniki testów + dane do odtworzenia · ryzyka (halucynacje, stronniczość źródeł, prywatność, prompt injection, dostępność, nadużycia) · koszt 1000 zapytań, koszt utrzymania kanału, zachowanie przy zwiększonym ruchu · kontrast WCAG AA.
