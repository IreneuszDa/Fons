# Dziennik strojenia jakości (zbiór dev)

Strojenie **wyłącznie** na `eval/cases/dev.jsonl`; wyników held-out nie oglądamy przy strojeniu (PLAN §1.6).
Polecenie każdego pomiaru (baza osobna od produkcyjnej, bo korpus jest równolegle przeładowywany):

```bash
OPENAI_DATA_RESIDENCY= npm run eval -- --split dev --db var/quality.db
```

`OPENAI_DATA_RESIDENCY=` (puste) = przetwarzanie OpenAI w USA — projekt nie ma rezydencji w UE; raport to ujawnia.
Model główny `gpt-6.2-sol`, szybki `gpt-6-luna`, tryb jednego klucza, tryb werdyktu „rules”.

Miary w tabeli:
- **macro-F1** — z `eval/results/latest.md` (klasy obecne w zbiorze),
- **wstrzymanie (fałszywe)** — oczekiwany werdykt rozstrzygający (POTWIERDZONE / FAŁSZYWE / WPROWADZAJĄCE), otrzymano BRAK_DOWODOW,
- **błędne rozstrzygnięcia** — otrzymano werdykt rozstrzygający inny niż oczekiwany (najgorszy rodzaj błędu; nie może rosnąć),
- **koszt** — łączny koszt przebiegu wg `pricing.ts`.

Uwaga o porównywalności: w trakcie strojenia rósł korpus (1052 → 1787+ rekordów; inny agent dokładał rekordy o politykach i rządzie) i zbiór dev (59 → 76 przypadków). Każdy wiersz podaje stan w chwili pomiaru.

| # | Zmiana | Korpus / przypadki | macro-F1 | wstrzymanie (fałszywe) | błędne rozstrzygnięcia | otwarte pytania | koszt |
|---|---|---|---|---|---|---|---|
| 0 | stan wyjściowy (faza 1, 10 przypadków `--limit 10`) | 1052 / 10 | 0.533 | 6/10 | 0 | — | 0.10 USD |
| 1 | persona Fons; tryby pytań (tak/nie → twierdzenie, otwarte → cytat); router modeli; stemmer zależny od języka (koniec „joine*”: pełny token + rdzeń); warianty zapytań z ekstrakcji (EN najpierw, formy podstawowe, nazwy własne); pula 40 → przeszeregowanie leksykalne → 8 fragmentów; zapytanie po tytule/tezie i tabeli bez ogonków w BM25; ważona fuzja (incydenty 0,5); wektory przy nieaktualnej migawce (ten sam model, brakujące rekordy embedowane przy starcie) | 1787 / 76 | 0.467 | 29/53 | 5 | 2/5 | 0.83 USD |
| 2 | kontrola cytatu także w „tytuł + treść” i krótkie dokładne cytaty z cyfrą („Poland 1999”); prompt oceny: WSPIERA nie dla jednego z kilku podmiotów, CZĘŚCIOWO = prawdziwy główny fakt + skorygowana data/liczba/podmiot; ekstrakcja: jedno zdanie o kilku podmiotach = jedno twierdzenie, treść przekazana przez kanał/znajomego = sama treść; nazwy własne PL/EN („Litwa \| Lithuania”) jako alternatywy w przeszeregowaniu | 1787 / 76 | 0.550 | 26/53 | 3 | 1/5 | 0.84 USD |
| 3 | weryfikator dostaje znaczenie relacji (CZĘŚCIOWO = prawdziwy fakt + inna data/liczba — wcześniej model szybki odrzucał takie dowody); link + słowa użytkownika: wiadomość użytkownika idzie przed treścią strony (twierdzenie główne = to, co twierdzi użytkownik); linki i obrazy zawsze w trybie twierdzeń; przeszeregowanie: „e ruchome”, krótkie słowa jako prefiksy (wcześniej 4-literowe rdzenie, np. „sejm”, wymagały dokładnego dopasowania) | 1787 / 76 | 0.615 | 24/53 | 2 | 1/5 ¹ | 0.79 USD |
| 4 | cytat zaczynający się w tytule przycinany do części z treści rekordu (miara i PLAN §1.2: cytat z zapisanej treści); prompt odpowiedzi: cytat z treści, nie z tytułu; ekstrakcja: ogłoszona decyzja / ustalony termin to fakt, nie prognoza | 2037 / 76 | **0.659** | 25/53 | 2 | **5/5** | 0.85 USD |

¹ Wszystkie 5 pytań otwartych dostało odpowiedź z właściwym nazwiskiem, ale 4 cytaty pochodziły z **tytułu** rekordu, a miara (i PLAN §1.2) wymaga cytatu z zapisanej treści. Od iteracji 4 cytat zaczynający się w tytule jest przycinany do części leżącej w treści rekordu (albo odrzucany), a prompt prosi o cytat z treści.

## Diagnostyka offline (bez modelu)

Do strojenia wyszukiwania służy skrypt diagnostyczny (poza repo): ekstrakcja twierdzeń dla przypadków dev raz modelem szybkim (koszt ok. 0,02 USD), potem wielokrotne uruchomienia samego wyszukiwania i sprawdzenie, czy rekord „złoty” (wyznaczony wyrażeniem regularnym na treści korpusu) trafia do 8 fragmentów wysyłanych do modelu.

| Wersja wyszukiwania | złoty rekord w top 8 | złoty rekord w puli |
|---|---|---|
| po iteracji 1 (bez wektorów — niezgodna migawka) | 19/25 (3 bez złotego rekordu w korpusie) | 21/25 |
| + wektory przy nieaktualnej migawce, alternatywy PL/EN | 19/25 | 21/25 |
| + „e ruchome” („marszałkiem” → „marszałek”), krótkie słowa jako prefiksy w przeszeregowaniu | 21/25 | 22/25 |
| pytania otwarte (P03–P15) | 5/5 | 5/5 |

Wagi przeszeregowania (ranga 1,0 / terminy obowiązkowe 0,9 / tytuł 0,6 / treść 0,5) sprawdzone przeglądem siatki — wynik stabilny w zakresie ±50% każdej wagi, więc zostały domyślne.

## Stan końcowy (iteracja 4)

- macro-F1 0.659 (cel 0,75 **nieosiągnięty**), trafność pytań otwartych 5/5, wstrzymanie w scenariuszu D 6/6, odporność 4/4, p50 8,5 s, koszt ok. 0,011 USD na sprawdzenie.
- Błędne rozstrzygnięcia: 5 → 2. Oba pozostałe (B11 „Szwecja i Finlandia nie należą do NATO”, P09 „Czy Morawiecki należy do klubu PiS?”) to stan nieaktualny: oczekiwane WPROWADZAJĄCE wymaga starszego źródła wspierającego (reguła 4), którego w korpusie nie ma — reguły dają wtedy FAŁSZYWE, jak przewidują notatki tych przypadków.
- Znany koszt ostrożności: twierdzenie o kilku podmiotach („Litwa, Łotwa i Estonia przystąpiły…”), gdy każdy rekord potwierdza tylko jeden podmiot, kończy się teraz wstrzymaniem (U02, E04) zamiast potwierdzenia — w zamian „Polska i Litwa wstąpiły do NATO w 1999” nie jest już błędnie potwierdzane (B02). Naprawa wymagałaby łączenia dowodów między rekordami dla jednego twierdzenia (zmiana reguł werdyktu) — nie robiliśmy jej w tej fazie.
- Łączny koszt modelu w strojeniu: ok. 3,7 USD (4 pełne przebiegi dev ≈ 3,3 USD + ekstrakcja do diagnostyki i diagnozy pojedynczych przypadków).

## Czego strojenie nie naprawi

Większość pozostałych fałszywych wstrzymań to **luki w korpusie**, nie błędy wyszukiwania: brak art. 96–98 Konstytucji (liczba posłów/senatorów, kadencja), brak decyzji Rady Europejskiej o statusie kandydata dla Ukrainy, brak rozporządzenia o zakazie importu węgla, brak rekordów o biolaboratoriach i MH17, brak wyników PKW 2025. Dla nich właściwy wynik systemu to „brak wystarczających dowodów”.

## Integracja fazy 2 (2026-11-21, `engine-2026.11.21-4`)

Pełny przebieg dev po integracji (`engine-2026.11.21-3`, plik `eval/results/2026-11-21T19-03-41-679Z-main-dev.json`): macro-F1 0,651, 26/53 fałszywych wstrzymań, 2 błędne rozstrzygnięcia. Diagnoza na dev (bez zaglądania do held-out) wykazała dwa błędy w kodzie:

1. **Fałszywy alarm detektora na KAŻDEJ stronie z linku.** Silnik skanował surowy HTML, a reguła „imitacja ogranicznika” obejmuje zamknięcia `</article>`, `</data>`, `</source>`, `</text>` — to prawdziwe elementy HTML/SVG. Każdy przypadek z URL (U01, U02, I01, I02, L01, L03, L05, L07, L09) miał zdarzenie `delimiter_imitation` i obcięte zdania strony. Poprawka: `neutralizeMarkupTags` w `src/engine/normalize.ts` wycina tylko prawdziwe znaczniki tych elementów przed przebiegiem po surowym HTML. Tekst widoczny na stronie (`&lt;/article&gt;`) i wszystkie inne ograniczniki są wykrywane jak wcześniej. Wszystkie 19 stron ataków z `eval/fixtures/pages` nadal wywołują detektor. Wyjątek: RT-41 i RT-42 (słowa routera, wymuszony link) były „wykrywane” wyłącznie przez ten fałszywy alarm, więc ich wykrywalność spada. Odporność od tego nie zależy.
2. **Odwracanie oceny „Fałsz” tezy złożonej** (A22: „Wojsko Polskie oficjalnie walczy na froncie w Ukrainie” → POTWIERDZONE z Demagoga ocenionego „Fałsz” za historię o wecie). Poprawka: `isCompoundClaim` w `src/engine/assess.ts`, opisana w VERDICT-RULES §4.

Sprawdzenie na przypadkach dotkniętych błędami (`--ids`, plik `2026-11-21T19-19-04-022Z-main-dev.json`): U01 i L05 poprawne. A22 zmienia błędne potwierdzenie na wstrzymanie. L07 i L09 dają wstrzymanie z reguły 3: data wydarzenia na stronie jest nowsza niż dowód, więc wynik jest zgodny z PLAN §4, choć niezgodny z oczekiwaniem przypadku. L03: rekord gov.pl obalający twierdzenie trafił do innego twierdzenia niż główne. To nadal otwarte.

Poza tym nowe zdanie odpowiedzi: „{wydawca} ({data}) podaje: «cytat»”. Poprzednie „Według {wydawca}” było niegramatyczne dla nazw w mianowniku.
