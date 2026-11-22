# Reguły werdyktu Fons

Ten dokument opisuje, **jak kod (nie model językowy) wyznacza werdykt** dla każdego twierdzenia. Odpowiada sekcji 4 planu (`PLAN.md`). Kod: `src/engine/verdict/` (czyste funkcje, bez sieci i bez modelu). Testy: `src/engine/verdict/*.test.ts` — ponad 60 przypadków w tabeli, każda reguła 1–9 ma co najmniej jeden; punktacja siły i kontrola dosłowna mają własne testy.

Model językowy robi tylko dwie rzeczy: czyta fragment źródła i mówi, czy on **wspiera**, **obala**, **częściowo wspiera**, **opisuje inny kontekst** albo **nie ma związku** z twierdzeniem, i którego aspektu dotyczy (sedno, czas, miejsce, liczba, autorstwo, zakres). Drugi model sprawdza sam cytat. Werdykt liczy kod według poniższych reguł.

## 1. Które dowody w ogóle się liczą

Dowód **nie liczy się wcale**, gdy:

- cytat nie został odnaleziony dosłownie w zapisanym fragmencie źródła (`quoteVerified = false`) — szukamy go w treści rekordu; gdy model zaczął cytat od tytułu (widzi go nad fragmentem), zostaje tylko część leżąca w treści rekordu i ona musi spełnić te same warunki; cytat krótszy niż 15 znaków liczy się tylko jako dokładne dopasowanie całych słów, z cyfrą i co najmniej dwoma słowami (np. wiersz listy „Poland 1999”); wyświetlany cytat zawsze jest wycięty z rekordu, nie z odpowiedzi modelu,
- dowód został wykluczony (np. trafienie detektora ataków, `excluded`),
- czytelnik ocenił go jako „bez związku”,
- rekordu nie ma w bazie albo ocena dotyczy innego twierdzenia.

## 2. Dowód rozstrzygający

Werdykt (inny niż „brak dowodów” i „nie podlega weryfikacji”) może wynikać tylko z **dowodu rozstrzygającego**. Jest nim zweryfikowany cytat z:

| Rodzaj | Warunek | Przykład |
|---|---|---|
| (a) źródło pierwotne / urzędowe | rekord treści o poziomie 1 | fragment ustawy w Dzienniku Ustaw, komunikat GUS |
| (b) rekord o stałej roli | fact-check sygnatariusza IFCN/EFCSN (poziom ≤ 2) albo rekord z bazy organizatora; teza pasuje do twierdzenia (patrz §4) i ocena jest znana tabeli mapowania | ocena Demagoga „Fałsz” dla tej samej tezy |
| (c) dwa niezależne źródła wtórne | dwa rekordy treści poziomu 2–3 z **różnych grup niezależności**, o tym samym aspekcie i tym samym kierunku | PAP i TVN24 piszą to samo o sednie |

Doprecyzowania (wszystkie zachowawcze):

- **Weryfikator „sprzeciw”** — dowód przestaje być rozstrzygający (zostaje „poniżej progu”). **Weryfikator „niepewne”** — dowód nadal rozstrzyga, ale siła spada o jeden stopień.
- **Ta sama grupa niezależności = jedno źródło.** Dwa teksty agencji i portalu, który ją przedrukował, nie tworzą pary. Silnik rozpoznaje również identyczne rekordy treści o długości co najmniej 24 słów, nawet gdy wydawcy należą do różnych grup.
- **Dwa źródła wtórne, które się nie zgadzają** (jedno wspiera, drugie obala) albo mówią o różnych aspektach, nie tworzą dowodu rozstrzygającego.
- **Analiza poziomu 2 będąca rekordem treści** (np. analiza instytucji UE) jest źródłem wtórnym: sama nie rozstrzyga, potrzebuje drugiego, niezależnego.
- **Rekord o stałej roli spoza IFCN/EFCSN i spoza bazy organizatora** nie rozstrzyga i nie liczy się jako źródło wtórne. `CorpusRecord` nie ma pola „sygnatariusz IFCN”, dlatego rozpoznajemy go po poziomie przypisanym w katalogu (poziom 2 to właśnie fact-checki sygnatariuszy).
- Pole `decisive` przychodzące z wcześniejszych kroków jest ignorowane — kod liczy je sam.

## 3. Reguły w kolejności stosowania

Pierwsza pasująca reguła wygrywa. Od reguły 3 w górę kod patrzy **wyłącznie na dowody rozstrzygające**; dowody poniżej progu wpływają tylko na siłę i są wymienione w raporcie.

| # | Sytuacja | Werdykt | Przykład |
|---|---|---|---|
| 1 | twierdzenie to opinia albo prognoza | NIE PODLEGA WERYFIKACJI | „Ten rząd jest najgorszy w historii.” |
| 2 | brak dowodu rozstrzygającego | BRAK DOWODÓW (+ co znaleziono poniżej progu) | o sprawie pisze tylko jeden portal |
| 3 | jednorazowe zdarzenie z datą, nowsze niż najnowszy dowód | BRAK DOWODÓW | „20 listopada 2026 w Gdańsku był protest”, a najnowsze źródło jest z 2025 r. Starsze, podobne zdarzenie go nie obala. |
| 4 | stan lub liczba „teraz”: starsze źródło (także stary fact-check) wspiera, nowsze urzędowe obala ten sam aspekt | WPROWADZAJĄCE W BŁĄD (nieaktualne) + ostrzeżenie o materiale archiwalnym | „Bezrobocie wynosi 5%”: GUS za 2022 r. potwierdza, GUS za 2025 r. podaje inną liczbę |
| 5 | wspiera i obala **ten sam aspekt** (także fact-check kontra źródło pierwotne z tego samego okresu) | BRAK DOWODÓW + blok „źródła sprzeczne” (obie strony, bez wskazywania zwycięzcy) | GUS i Eurostat podają sprzeczne dane za 2025 r. |
| 6 | dopasowany rekord o stałej roli i brak nowszego lub sprzecznego źródła pierwotnego dla tego aspektu | werdykt z tabeli mapowania | Demagog: „Fałsz” dla tej samej tezy → FAŁSZYWE |
| 7 | wspiera sedno, żaden aspekt nie jest obalony ani podważony | POTWIERDZONE | Dziennik Ustaw potwierdza, że ustawa weszła w życie |
| 8 | obala sedno; albo twierdzenie sprowadza się do obalonej daty lub liczby | FAŁSZYWE | „W 2024 r. inflacja wyniosła 15%”, a GUS podaje inną liczbę; „Polska wstąpiła do NATO w 2004 roku”, a NATO podaje 1999 |
| 9 | Źródło wykazuje błąd w szczególe, zniekształcony wniosek lub przeniesienie materiału w inny kontekst. | WPROWADZAJĄCE W BŁĄD + brakujący kontekst | Prawdziwe zdjęcie powodzi z 2019 r. przedstawiono jako relację z wczoraj. |

Czytelnik rozróżnia cytat potwierdzający fragment tezy (`CZESCIOWO`, w raporcie `partialMeaning=coverage`) od cytatu wykazującego istotny błąd (`KORYGUJE_CZESC`, w raporcie `partialMeaning=correction`). Korekta wymaga zgody weryfikatora. Profil jednej stacji badawczej może uzupełnić pełny wykaz stacji. Sama informacja o tej jednej stacji pozostawia pytanie o pozostałe otwarte. Kiedy starsza ocena łączyła oba znaczenia, kod uznaje korektę jedynie przy zgodzie weryfikatora i odmiennej dacie lub liczbie w odpowiednim polu.

Jeśli po regułach 3–9 zostały tylko dowody na szczegóły (np. sam czas), a nic o sednie — werdykt to BRAK DOWODÓW z numerem reguły 2 („brak dowodu rozstrzygającego dla sedna”). Pole `ruleApplied` jest zawsze ustawione (1–9).

### Szczegóły reguł 3–5 (czas i okresy)

Stan opisany w datowanym artykule zachowuje swoją datę odniesienia (`temporal.asOf`). Rozstrzygają źródła obejmujące ten okres. Raport odróżnia datę publikacji z metadanych od daty wyświetlonej przy nagłówku. Data materiału może określać perspektywę autora opisującego ówczesny stan. Do ustalenia daty zdarzenia potrzebna jest treść twierdzenia.

- **Okres dowodu** = okres podany przez czytelnika dla fragmentu → okres rekordu w bazie → rok publikacji. Rozumiemy: rok, półrocze (`2024-H1`), kwartał (`2024-Q2`), miesiąc, dzień, zakresy (`2023-2024`, `2024-01-01/2024-06-30`).
- **Nieznany okres nakłada się z każdym innym** i nigdy nie jest „nowszy”. Lepiej pokazać sprzeczność, niż ją ukryć.
- **Reguła 3:** zdarzenie jest „nowsze”, gdy jego najwcześniejszy możliwy dzień przypada po najpóźniejszym możliwym dniu publikacji **każdego** dowodu rozstrzygającego (data publikacji, a gdy jej brak — data pobrania, bo rekord na pewno istniał, zanim go pobraliśmy). Gdy żaden z tych dni nie jest znany, reguła 3 nie działa.
- **Reguła 4 i zastępowanie nieaktualnych danych** (tylko twierdzenia o stanie „teraz”): dowód jest **zastąpiony**, gdy na ten sam aspekt istnieje rozstrzygający dowód urzędowy (poziom 1) o przeciwnym kierunku, którego okres jest **w całości późniejszy**, a data publikacji nie jest wcześniejsza.
  - Zastąpione „wspiera” + nowsze urzędowe „obala”, i nie zostaje żadne aktualne „wspiera” → reguła 4.
  - Zastąpione „obala” + nowsze urzędowe „wspiera” → stara ocena wypada, liczymy dalej (np. reguła 7: twierdzenie jest prawdziwe **dziś**). Raport ma notkę „starsze źródło mówiło inaczej”.
  - Tylko dowód **urzędowy** może zastąpić inny. Nowsze źródło wtórne kontra starsze urzędowe = sprzeczność (reguła 5).
- **Reguła 5 — rozszerzenie zachowawcze:** sprzeczność na ten sam aspekt daje BRAK DOWODÓW także wtedy, gdy okresy się nie nakładają, a reguła 4 tej różnicy nie wyjaśniła. Kod nigdy nie wybiera zwycięzcy między źródłami mówiącymi o tym samym aspekcie. Notka w raporcie zaznacza, że źródła mogą dotyczyć różnych okresów.
- **Różne aspekty to nie sprzeczność.** Sedno potwierdzone + data obalona → reguła 9 (WPROWADZAJĄCE), nie reguła 5.
- **Rekord o stałej roli kontra źródła wtórne** to nie sprzeczność — zgodnie z regułą 6 fact-check ma pierwszeństwo przed oceną czytelnika dla źródeł wtórnych. Fact-check kontra źródło **pierwotne**, i dwa fact-checki o przeciwnych ocenach, to sprzeczność.

### Szczegóły reguły 6

- Rekord o stałej roli przechodzi, gdy żaden rozstrzygający dowód pierwotny na ten sam aspekt nie ma innego kierunku.
- **Dodatkowo (zachowawczo):** ocena „Prawda” nie daje POTWIERDZONE, gdy źródło pierwotne obala lub podważa **dowolny** aspekt (np. datę). Wtedy liczą reguły 7–9 (zwykle wynik to reguła 9, WPROWADZAJĄCE). To ten sam warunek, który ma reguła 7.
- Kilka pasujących rekordów: jedna ocena → ta ocena; oceny „bez werdyktu” (BRAK DOWODÓW, NIE PODLEGA) ustępują pozostałym; różne oceny merytoryczne (np. „Fałsz” i „Manipulacja”) → WPROWADZAJĄCE (najostrożniejsze wspólne stwierdzenie). Przeciwne oceny („Fałsz” i „Prawda”) to sprzeczność → reguła 5.
- Stary fact-check kontra nowsze dane urzędowe: dla twierdzeń o stanie → reguła 4 (albo zastąpienie). Dla pozostałych twierdzeń → reguła 5. Nigdy reguła 6.

### Szczegóły reguły 8 — „twierdzenie sprowadza się do obalonego aspektu”

Kod nie rozumie składni zdania, więc stosuje jawne, deterministyczne przybliżenie (`reductionToAspect` w `rules.ts`, pomocnicze funkcje w `slots.ts`). Granica przebiega tak:

- **twierdzenie = jedna wartość, a źródło ją obala** → FAŁSZYWE (reguła 8b),
- **sedno prawdziwe, a błędny jest szczegół** (albo sedno niesprawdzone, a twierdzenie ma więcej szczegółów) → WPROWADZAJĄCE (reguła 9).

FAŁSZYWE z reguły 8b, gdy jednocześnie:

1. są rozstrzygające dowody **„obala”** i wszystkie dotyczą **jednego** aspektu (nie sedna — obalone sedno to reguła 8a),
2. nie ma żadnego rozstrzygającego dowodu **„częściowo”** ani **„inny kontekst”** — PLAN §4 kieruje je do reguły 9; „częściowo” znaczy, że w podanym czasie lub w podanej liczbie jest coś prawdziwego,
3. nic nie wspiera tego samego aspektu (inaczej to sprzeczność albo brak jednoznacznej korekty),
4. bez pola `assertedAspect` (patrz niżej):
   - aspekt to **czas** albo **liczba**, i nie ma żadnego rozstrzygającego dowodu na sedno,
   - **czas:** twierdzenie „jednej daty” — jedno zdanie bez przecinka i bez spójników łączących kolejne stwierdzenia („i”, „oraz”, „a”, „który”…), najwyżej 14 słów, najwyżej 2 nazwy własne, dokładnie jeden rok i żadnej innej liczby. Data może być względna („wczoraj”), jeśli ekstrakcja ustaliła ją w `temporal.date`,
   - **liczba:** cyfra w tekście (jak wcześniej — twierdzenia liczbowe to zwykle sama liczba albo wyliczenie kilku liczb).

| Twierdzenie | Dowody rozstrzygające | Wynik |
|---|---|---|
| „Polska wstąpiła do NATO w 2004 roku.” | NATO „Poland 1999” — obala, czas | **FAŁSZYWE (8)** |
| to samo, ekstrakcja nie ustaliła daty | jw. | **FAŁSZYWE (8)** — rok jest w tekście |
| „Ustawa o asystencji weszła w życie wczoraj.” (data ustalona) | Dziennik Ustaw: inna data — obala, czas | **FAŁSZYWE (8)** |
| „W 2024 r. inflacja wyniosła 15%.” | GUS: 3,6% — obala, liczba | **FAŁSZYWE (8)** |
| „Polska wstąpiła do NATO w 2004 roku.” | „Polska jest w NATO” — wspiera sedno; „Poland 1999” — obala, czas | WPROWADZAJĄCE (9): sedno prawdziwe, szczegół błędny |
| „Polska wstąpiła do NATO w 2004 roku.” | oba cytaty NATO — **częściowo**, czas | WPROWADZAJĄCE (9) |
| „Rosja rozpoczęła pełnoskalową inwazję na Ukrainę w 2014 roku.” | „full-scale invasion … in February 2022” — częściowo, czas | WPROWADZAJĄCE (9): w 2014 była aneksja Krymu |
| „Na szczycie NATO w Madrycie w 1999 roku Polskę zaproszono do rozmów akcesyjnych.” | NATO: 1997 — obala, czas | WPROWADZAJĄCE (9): kilka szczegółów, błędna tylko data |
| „W 2004 roku do NATO wstąpiło 7 państw.” | „Poland 1999” — obala, czas | WPROWADZAJĄCE (9): poza datą jest jeszcze liczba |
| „Ustawę o obronie Ojczyzny podpisał Jakub Siuda.” | obala, autorstwo | WPROWADZAJĄCE (9) — bez pola `assertedAspect` miejsce, autorstwo i zakres nie dają 8b |

**Dlaczego „częściowo” nigdy nie daje FAŁSZYWE.** W ewaluacji z 21.11.2026 czytelnik ocenił A03 („Polska wstąpiła do NATO w 2004”, wzorzec FAŁSZYWE) i B06 („pełnoskalowa inwazja w 2014”, wzorzec WPROWADZAJĄCE) **tak samo**: „częściowo”, czas, cytat z innym rokiem. Z tych danych kod nie odróżni jednego od drugiego — różnica jest w treści (w 2014 r. była prawdziwa, węższa agresja; w 2004 r. Polska nie wstąpiła do NATO, bo była w nim od 1999). To rozróżnienie należy do czytelnika: inna data tego samego zdarzenia → „obala”, czas; prawdziwe, ale węższe lub inne zdarzenie w podanym czasie → „częściowo”.

**Pole `assertedAspect` (rozszerzenie, opcjonalne).** Ekstrakcja może wskazać, który aspekt niesie jedyną sprawdzalną treść twierdzenia poza niespornym podmiotem (`czas` dla „Polska wstąpiła do NATO w 2004 roku”, `liczba` dla „W 2024 r. inflacja wyniosła 15%”, `autorstwo` dla „Ustawę podpisał Jakub Siuda”, `sedno` dla „Wczoraj w Krakowie była powódź”). Gdy pole jest podane, rozstrzyga zamiast przybliżenia z punktu 4:

- `sedno` → reguła 8b nie działa (twierdzenie mówi, że zdarzenie zaszło; błędna data to szczegół → reguła 9),
- aspekt równy obalonemu → FAŁSZYWE, **także gdy coś wspiera sedno** (sedno jest wtedy tłem: „Polska jest w NATO”) i dla każdego aspektu (także autorstwa, miejsca, zakresu),
- inny aspekt niż obalony → nie 8b.

Warunki 1–3 obowiązują zawsze, więc „częściowo” nadal daje regułę 9. Brak pola = przybliżenie z punktu 4.

W raporcie reguła 8b dopisuje notkę: „Twierdzenie sprowadza się do jednego szczegółu (czas (data)), a źródła podają inną datę…”, a gdy kod (bez modeli) znajdzie w cytacie inny rok lub inną liczbę — także porównanie, np. „źródło podaje „1999”, a twierdzenie „2004””. Porównanie działa na samych liczbach, więc także dla cytatów po angielsku; niczego nie rozstrzyga.

## 4. Rekordy o stałej roli i negacja

Fact-checki, ClaimReview, rekordy bazy organizatora i EUvsDisinfo **dosłownie powtarzają fałszywą tezę**, więc czytelnik nie ocenia ich relacji. Werdykt bierzemy **wyłącznie z pola oceny** przez jawną tabelę mapowania (`data/rating-map.yaml`). Model sprawdza tylko, jak teza z rekordu (`claimReviewed`) ma się do twierdzenia użytkownika:

| Dopasowanie | Co robi kod | Przykład |
|---|---|---|
| `ta_sama` | werdykt = ocena z tabeli | rekord: „Polska wychodzi z UE” — Fałsz; użytkownik: „Polska wychodzi z UE” → FAŁSZYWE |
| `zaprzeczona` | odwraca **tylko oceny binarne**: Fałsz ↔ Prawda | rekord: „Polska wychodzi z UE” — Fałsz; użytkownik: „Polska nie wychodzi z UE” → POTWIERDZONE |
| `zaprzeczona` przy ocenie niebinarnej | nie rozstrzyga | rekord: „…” — Manipulacja; użytkownik zaprzecza → nie da się odwrócić „manipulacji” → BRAK DOWODÓW |
| `inna`, `niepewne` | nie rozstrzyga | teza rekordu dotyczy czegoś innego |
| ocena nieznana tabeli (`mapped = null`) lub brak oceny | nie rozstrzyga | nowa kategoria fact-checkera |

Odwracamy tylko, gdy ocena ma flagę binarną **i** jest równa FAŁSZYWE albo POTWIERDZONE. Każda inna kombinacja nie rozstrzyga — kod nie zgaduje.

Wyjątek: gdy teza rekordu składa się z kilku zdań-stwierdzeń (np. „Zdecydowane weto prezydenta! Żołnierze zostają w Polsce.”), ocena „Fałsz” mówi tylko, że **co najmniej jedna** część jest fałszywa, więc jej odwrócenie niczego nie dowodzi — kod daje wtedy „nie rozstrzyga” (`isCompoundClaim` w `src/engine/assess.ts`). Ocena „Prawda” takiej tezy nadal obala zaprzeczenie każdej jej części.

## 5. Karta siły podstawy

Każdy werdykt ma kartę siły: **słaba / średnia / mocna** oraz **punktację 0–100** z listą jawnych czynników („podnosi” / „obniża”). Kod: `src/engine/verdict/strength.ts`, kontrola dosłowna: `src/engine/verdict/literal.ts`.

### Jak liczymy punkty

Każda **niezależna grupa wydawców** w podstawie to osobny głos (ta sama grupa / przedruk = jeden głos, liczy się jej najlepszy dowód). Głosy łączymy jak niezależne potwierdzenia: `pewność = 1 − Π(1 − waga)`.

| Głos | Waga |
|---|---|
| źródło urzędowe / pierwotne (poziom 1, treść) | 0,90 |
| ocena fact-checkera IFCN/EFCSN lub bazy organizatora | 0,85 |
| analiza instytucji (poziom 2, treść) | 0,60 |
| wiarygodne źródło wtórne (poziom 3) | 0,50 |
| cytat dopasowany niedosłownie (< 0,98) | × 0,95 |
| dowód tylko na szczegół (nie sedno) | × 0,90 |

Potem mnożniki za **odczyt cytatów**:

| Sytuacja | Mnożnik |
|---|---|
| drugi model potwierdził wszystkie cytaty podstawy | 1,00 |
| część cytatów bez drugiej kontroli | 0,90 (0,96 przy potwierdzeniu kontrolą dosłowną) |
| drugi model niepewny choć jednego cytatu (także: niedostępny) | 0,65 (0,85 przy potwierdzeniu kontrolą dosłowną) |
| drugi model innego dostawcy | 0,99 |
| drugi model tego samego dostawcy, ≥ 2 niezależne grupy | 0,96 |
| drugi model tego samego dostawcy, jedna grupa | 0,90 (0,96 przy potwierdzeniu kontrolą dosłowną) |

I **kary**: każde policzone, niezawetowane źródło poza podstawą, które mówi przeciwnie niż werdykt (także poniżej progu), mnoży wynik przez `1 − 0,5 · waga`; twierdzenie o stanie „teraz” z najnowszym dowodem starszym niż 24 miesiące — × 0,85.

**Poziom:** mocna ≥ 85 pkt, średnia ≥ 60 pkt, słaba poniżej. Reguły bez werdyktu merytorycznego (1, 2, 3, 5) → słaba, punktacja = null.

Przykłady (cytaty dosłowne, drugi model się zgodził):

| Podstawa | Inny dostawca | Ten sam dostawca |
|---|---|---|
| dwa niezależne źródła urzędowe (np. prezydent.pl + Dziennik Ustaw) | 98 — mocna | 95 — mocna |
| źródło urzędowe + niezależne wtórne | 94 — mocna | 91 — mocna |
| jedno źródło urzędowe | 89 — mocna | 81 — średnia (86 — mocna z kontrolą dosłowną) |
| jeden fact-check IFCN | 84 — średnia | 77 — średnia |
| dwa niezależne źródła wtórne | 74 — średnia | 72 — średnia |
| trzy niezależne źródła wtórne | 87 — mocna | 84 — średnia |

### Weryfikator tej samej rodziny (tryb jednego klucza)

Do 2026-11-21 tryb jednego klucza obcinał siłę do „średniej” zawsze. Skutek: „Jakub Siuda to prezydent Polski” — obalone przez dwa niezależne źródła urzędowe z potwierdzonymi cytatami — miało siłę „średnią”. Teraz weryfikator tej samej rodziny jest **jawnym czynnikiem obniżającym** (zawsze widocznym w karcie i w ostrzeżeniu `single_key_verifier`). Gdy zgodne są źródła od różnych wydawców, każde z nich czytane osobno, błąd odczytu musiałby powtórzyć się kilka razy w tę samą stronę — wtedy siła może być „mocna”. Przy **jednym** źródle bez innej niezależnej kontroli siła kończy się na „średniej”.

### Kontrola dosłowna (bez modeli)

Kod porównuje **nazwy własne i liczby** twierdzenia z cytatem dowodu podstawy (po sprowadzeniu odmiany):

- WSPIERA — wszystkie nazwy i liczby twierdzenia są w cytacie, a cytat dotyczy tego samego (≥ połowa słów treści twierdzenia),
- OBALA — cytat dotyczy tego samego, a w miejscu nazwy lub liczby twierdzenia stoi inna („Jakub Siuda” ↔ „Karol Nawrocki”, „5 lat” ↔ „4 lata”).

Kontrola **nigdy nie zmienia werdyktu ani relacji**. Jeśli potwierdza odczyt, to jest niezależna od modeli kontrola krzyżowa: podnosi mnożnik odczytu (tabela wyżej) i dopisuje czynnik, np. „Kod (bez modeli) porównał nazwy: źródło podaje „Dr Karol Nawrocki”, a twierdzenie „Jakub Siuda”.” Zaprzeczenie słowne („nie jest”) nie przechodzi tej kontroli — zostaje oceną modelu.

### Pozostałe pola karty

| Pole | Jak liczone |
|---|---|
| `score`, `factors` | punktacja i czynniki z tej sekcji (pola opcjonalne — starsze raporty ich nie mają) |
| `primarySources` | liczba różnych rekordów urzędowych (poziom 1) w podstawie i dowodach z nią zgodnych |
| `independentPublishers` | liczba różnych grup niezależności (ta sama grupa / przedruk = 1) |
| `newestEvidenceAt` | najnowsza data publikacji dowodu z podstawy (z bazy, nie z modelu) |
| `archivalWarning` | reguła 4 albo twierdzenie o stanie „teraz”, którego najnowszy dowód jest starszy niż 24 miesiące |
| `verifierAgreement` | „niepewne”, gdy weryfikator był niepewny choć jednego dowodu podstawy; „zgoda”, gdy zgodził się co do wszystkich; „sprzeciw”, gdy podstawy nie ma, bo weto usunęło dowody; inaczej „brak” |
| `notes` | krótkie notki po polsku, których nie opisują już czynniki (np. o sprzeczności, o materiale poniżej progu) |

**Podstawa** to dowody, na których oparto werdykt (`decisiveRecordIds`). Do liczenia potwierdzeń dokładamy dowody **zgodne z podstawą** (ten sam aspekt i kierunek, bez weta), także te poniżej progu — „liczba potwierdzeń wpływa tylko na siłę”.

Ewaluacja: przypadki z `expected.minStrength` (np. `ST01` „Czy Jakub Siuda to prezydent polski?” → FAŁSZYWE, co najmniej „mocna”) i rozkład siły poprawnych werdyktów FAŁSZYWE/POTWIERDZONE są w raporcie `npm run eval`.

## 6. Znane ograniczenia

- **Reguła 3 a zapowiedzi.** Dowód opublikowany przed datą zdarzenia (np. ustawa ogłoszona w grudniu, wchodzi w życie w styczniu) daje dla twierdzenia jednorazowego z datą BRAK DOWODÓW — tak brzmi reguła. Kod nie odróżnia zapowiedzi od relacji. Ekstrakcja twierdzeń powinna oznaczać takie przypadki jako „stan”.
- **Reguła 8b jest przybliżeniem.** Jeśli czytelnik oznaczy tylko „obala czas” dla krótkiego twierdzenia o prawdziwym zdarzeniu z inną datą (zamiast „częściowo”, „inny kontekst” albo „wspiera sedno”), wynik będzie FAŁSZYWE zamiast WPROWADZAJĄCE. Odwrotnie: gdy czytelnik da „częściowo” dla daty, która jest po prostu błędna (A03 w ewaluacji z 21.11.2026), wynik to WPROWADZAJĄCE zamiast FAŁSZYWE — poprawka należy do instrukcji czytelnika, nie do reguł (patrz „Szczegóły reguły 8”).
- **Twierdzenie „jednej daty” rozpoznajemy po kształcie tekstu** (przecinek, spójniki, liczba słów, nazwy własne), nie po znaczeniu. Lata rozpoznajemy w zakresie 1000–2099, więc liczba w tym zakresie bez jednostki (np. „1500 szpitali”) też liczy się jako rok — skutek jest zachowawczy (brak reguły 8b dla czasu).
- **IFCN/EFCSN po poziomie.** Kwalifikację fact-checkera wnioskujemy z poziomu 2 przypisanego w katalogu, bo rekord korpusu nie ma pola `ifcnEfcsn`. Błąd poziomu w katalogu przenosi się na regułę 6.
- **Okres z roku publikacji.** Gdy ani czytelnik, ani rekord nie podają okresu, przyjmujemy rok publikacji. Fact-check z marca 2025 o danych za 2024 r. może przez to wyglądać na „ten sam okres” co dane za 2025 r. Skutek jest zachowawczy: sprzeczność zamiast werdyktu.
- **Okres podaje czytelnik (model).** Okres fragmentu nie przechodzi kontroli podciągu jak cytat. Błędny okres może przesunąć przypadek między regułami 4 i 5, ale nigdy nie da POTWIERDZONE bez zweryfikowanego cytatu wspierającego.
- **Różne merytoryczne oceny fact-checków** sprowadzamy do WPROWADZAJĄCE — to uproszczenie.
- Potwierdzony błąd w szczególe lub wykazany inny kontekst prowadzi do reguły 9. Cytat o części wymienionych podmiotów może towarzyszyć potwierdzeniu opartemu na pełnym wykazie.
- **Dowody poniżej progu nie zmieniają werdyktu**, nawet jeśli obalają jakiś aspekt — wpływają tylko na siłę i są pokazane w raporcie.

## 7. Twierdzenia złożone (kilka podmiotów)

Zdanie, które przypisuje ten sam fakt kilku podmiotom („Polska i Litwa wstąpiły do NATO w 1999 roku”, „Litwa, Łotwa i Estonia przystąpiły do NATO w 2004 roku”), ekstrakcja rozbija na części — po jednej na podmiot, tymi samymi słowami (kod sprawdza, że część mieści się w słowach całości i nie wnosi nowych liczb). Każda część przechodzi reguły 1–9 osobno. Werdykt całości liczy kod (`src/engine/verdict/compound.ts`):

| Werdykty części | Werdykt całości | Reguła w raporcie |
|---|---|---|
| wszystkie POTWIERDZONE | POTWIERDZONE | reguła tej części |
| choć jedno FAŁSZYWE i choć jedno POTWIERDZONE albo WPROWADZAJĄCE | WPROWADZAJĄCE (uzasadnienie zaczyna się od nazwania nieprawdziwej części) | 9 |
| choć jedno FAŁSZYWE, żadne prawdziwe (reszta: BRAK DOWODÓW) | FAŁSZYWE — zdanie z fałszywą częścią jest fałszywe | reguła tej części |
| choć jedno WPROWADZAJĄCE, żadne FAŁSZYWE | WPROWADZAJĄCE | 9 |
| pozostałe (BRAK DOWODÓW bez FAŁSZYWE) | BRAK DOWODÓW | reguła tej części |
| części NIE PODLEGA są pomijane; same NIE PODLEGA | NIE PODLEGA | 1 |

Siła całości to siła najsłabiej udokumentowanej części, która ustala werdykt (punktacja = minimum) — całość nie może być pewniejsza niż jej najsłabszy element; karta dostaje czynnik „Twierdzenie dotyczy N podmiotów — każdy sprawdziliśmy osobno”. Raport pokazuje jedno twierdzenie (całość) z dowodami wszystkich części; części są wewnętrzne. Na zapytanie przypada najwyżej 8 jednostek (twierdzeń i części) — gdy części się nie mieszczą, twierdzenie jest sprawdzane w całości.

