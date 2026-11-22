# Fons — źródła, licencje, kwalifikacja i aktualizacja korpusu

Dokument opisuje korpus startowy Fons (dane w `data/`), zasady jego budowy i to, jak go odświeżać. Reguły
produktu są w `PLAN.md` (§1, §3, §4, §5); kontrakty danych w `src/shared/contracts.ts`; kod w `src/corpus/`.
Sekcja „Liczby” jest generowana przez `npm run corpus:build` (nie edytuj jej ręcznie).

## 1. Wymagania zadania a stan korpusu

| Wymaganie | Wymóg zadania | Nasz cel | Stan |
|---|---|---|---|
| liczba rekordów | ≥ 100 | ≥ 300 | aktualna liczba poniżej |
| domeny (hosty) | ≥ 10 | ≥ 12 | aktualna liczba poniżej |
| typy źródeł | ≥ 2 (pierwotne + wiarygodne wtórne) | 3: `pierwotne`, `factcheck`, `analiza` | 3 |
| pola rekordu | tytuł, wydawca, data publikacji, data pobrania, link, użyty fragment | + licencja, poziom, grupa niezależności, rola | wszystkie w każdym rekordzie (test `corpus-data.test.ts`) |
| reguły | licencje, kwalifikacja, aktualizacja, wykluczenia | — | sekcje 4–8 |
| zakaz obchodzenia zabezpieczeń | paywalle, ochrona stron | — | sekcja 9 (co pominięto i dlaczego) |

<!-- COUNTS:START -->

Stan na dzień 2026-11-22: **3957 rekordów**, **604 incydentów**, **45 hostów** (domen źródłowych), **3 typy źródeł**.

Rekordy według źródła z katalogu:

| Źródło (id) | Hosty | Typ | Poziom | Rekordy |
|---|---|---|---|---|
| ecb | `www.ecb.europa.eu` | pierwotne | 1 | 1 |
| gus-cpi | `publikacje.new.stat.gov.pl` | pierwotne | 1 | 46 |
| nbp-rates | `static.nbp.pl` | pierwotne | 1 | 94 |
| gus-publications | `stat.gov.pl` | pierwotne | 1 | 3 |
| sejm-eli | `api.sejm.gov.pl` | pierwotne | 1 | 1025 |
| eur-lex | `eur-lex.europa.eu` | pierwotne | 1 | 99 |
| eurostat | `ec.europa.eu` | pierwotne | 1 | 383 |
| nato | `www.nato.int` | pierwotne | 1 | 329 |
| eu-portal | `european-union.europa.eu` | pierwotne | 1 | 70 |
| gov-pl | `www.gov.pl` | pierwotne | 1 | 194 |
| rpo | `bip.brpo.gov.pl` | pierwotne | 1 | 1 |
| pap-depesze | `www.pap.pl` | pierwotne | 1 | 1 |
| wroclaw-transport | `www.wroclaw.pl` | pierwotne | 1 | 1 |
| sky-tg24 | `tg24.sky.it` | analiza | 3 | 2 |
| msz-odyseusz | `odyseusz.gov.pl` | pierwotne | 1 | 1 |
| eeas | `www.eeas.europa.eu` | analiza | 2 | 6 |
| euvsdisinfo | `euvsdisinfo.eu` | analiza | 2 | 455 |
| pravda-pl | `pravda.org.pl` | factcheck | 2 | 70 |
| dpa-factchecking | `dpa-factchecking.com`, `www.dpa-factchecking.com` | factcheck | 2 | 35 |
| dw-factcheck | `www.dw.com` | factcheck | 2 | 34 |
| factcheck-org | `www.factcheck.org` | factcheck | 2 | 25 |
| politifact | `www.politifact.com` | factcheck | 2 | 25 |
| demagog | `demagog.org.pl` | factcheck | 2 | 745 |
| afp-sprawdzam | `sprawdzam.afp.com` | factcheck | 2 | 0 |
| konkret24 | `konkret24.tvn24.pl` | factcheck | 3 | 0 |
| fakehunter | `fakehunter.pap.pl` | factcheck | 3 | 0 |
| prezydent-pl | `www.prezydent.pl` | pierwotne | 1 | 2 |
| zus-swiadczenia | `www.zus.pl` | pierwotne | 1 | 2 |
| zus-wskazniki | `psz.zus.pl` | pierwotne | 1 | 26 |
| senat-pl | `www.senat.gov.pl` | pierwotne | 1 | 7 |
| ec-commission | `commission.europa.eu` | pierwotne | 1 | 28 |
| hungarian-government | `kormany.hu` | pierwotne | 1 | 1 |
| ep-open-data | `data.europarl.europa.eu` | pierwotne | 1 | 53 |
| ec-finance | `finance.ec.europa.eu` | pierwotne | 1 | 44 |
| ec-home-affairs | `home-affairs.ec.europa.eu` | pierwotne | 1 | 4 |
| un-news | `news.un.org`, `ukraine.un.org` | pierwotne | 1 | 24 |
| onderzoeksraad | `onderzoeksraad.nl`, `www.onderzoeksraad.nl` | pierwotne | 1 | 9 |
| prosecutionservice | `www.prosecutionservice.nl` | pierwotne | 1 | 8 |
| government-nl | `www.government.nl` | pierwotne | 1 | 2 |
| gus-bdl | `bdl.stat.gov.pl` | pierwotne | 1 | 70 |
| consilium-eu | `www.consilium.europa.eu` | pierwotne | 1 | 0 |
| ohchr | `www.ohchr.org` | pierwotne | 1 | 0 |
| un-press | `press.un.org` | pierwotne | 1 | 0 |
| eu-enlargement | `neighbourhood-enlargement.ec.europa.eu` | pierwotne | 1 | 0 |
| sg-pl | `www.strazgraniczna.pl` | pierwotne | 1 | 1 |
| cbos | `www.cbos.pl` | pierwotne | 1 | 1 |
| unhcr-data | `data.unhcr.org` | pierwotne | 1 | 1 |
| sipri | `www.sipri.org` | pierwotne | 1 | 25 |
| iiss | `www.iiss.org` | pierwotne | 1 | 1 |
| kse-institute | `institute.kse.ua` | pierwotne | 1 | 1 |
| marsz-organizator | `marszniepodleglosci.pl` | analiza | 3 | 2 |

Rekordy według typu:

| Typ | Rekordy |
|---|---|
| factcheck | 934 |
| pierwotne | 2558 |
| analiza | 465 |

Rekordy według hosta (adres rekordu):

| Host | Rekordy |
|---|---|
| `api.sejm.gov.pl` | 1025 |
| `demagog.org.pl` | 745 |
| `euvsdisinfo.eu` | 455 |
| `ec.europa.eu` | 383 |
| `www.nato.int` | 329 |
| `www.gov.pl` | 194 |
| `eur-lex.europa.eu` | 99 |
| `static.nbp.pl` | 94 |
| `european-union.europa.eu` | 70 |
| `bdl.stat.gov.pl` | 70 |
| `pravda.org.pl` | 70 |
| `data.europarl.europa.eu` | 53 |
| `publikacje.new.stat.gov.pl` | 46 |
| `finance.ec.europa.eu` | 44 |
| `dpa-factchecking.com` | 35 |
| `www.dw.com` | 34 |
| `commission.europa.eu` | 28 |
| `psz.zus.pl` | 26 |
| `www.factcheck.org` | 25 |
| `www.politifact.com` | 25 |
| `www.sipri.org` | 25 |
| `news.un.org` | 20 |
| `onderzoeksraad.nl` | 9 |
| `www.prosecutionservice.nl` | 8 |
| `www.senat.gov.pl` | 7 |
| `www.eeas.europa.eu` | 6 |
| `home-affairs.ec.europa.eu` | 4 |
| `ukraine.un.org` | 4 |
| `stat.gov.pl` | 3 |
| `www.government.nl` | 2 |
| `www.zus.pl` | 2 |
| `www.prezydent.pl` | 2 |
| `tg24.sky.it` | 2 |
| `marszniepodleglosci.pl` | 2 |
| `kormany.hu` | 1 |
| `www.ecb.europa.eu` | 1 |
| `www.pap.pl` | 1 |
| `www.wroclaw.pl` | 1 |
| `odyseusz.gov.pl` | 1 |
| `bip.brpo.gov.pl` | 1 |
| `www.cbos.pl` | 1 |
| `www.iiss.org` | 1 |
| `institute.kse.ua` | 1 |
| `www.strazgraniczna.pl` | 1 |
| `data.unhcr.org` | 1 |

<!-- COUNTS:END -->

Pliki: `data/sources.yaml` (katalog), `data/rating-map.yaml` (mapowanie ocen), `data/corpus/<źródło>.jsonl`
(jeden `CorpusRecord` na linię), `data/incidents/*.jsonl` (incydenty), `data/corpus-report.json` (przebieg ostatniego
budowania: liczby, pominięte elementy, uwagi). Migawka korpusu (`snapshot_id`) to sha256 z posortowanych linii plików jsonl.

## 2. Katalog źródeł (`data/sources.yaml`)

Poziom źródła jest przypisany do **dokładnego hosta** (bez dziedziczenia z domeny nadrzędnej; `catalogSourceForHost`).
Wpisy z zerową liczbą rekordów obejmują kanały używane na żywo, źródła z blokadą automatycznego pobierania i wydawców
oczekiwanych w pakiecie organizatora. Poziom dowodu w każdym przypadku wynika z hosta.

| id | Hosty | Typ | Poziom | Rola | IFCN/EFCSN | Metoda | Licencja / sposób użycia |
|---|---|---|---|---|---|---|---|
| `sejm-eli` | `api.sejm.gov.pl` | pierwotne | 1 | treść | — | API ELI (HTML, PDF) + API Sejmu (posłowie, kluby) | akty prawne i urzędowe dokumenty poza ochroną prawa autorskiego (art. 4 pkt 1–2 ustawy z 4.02.1994 r.); pełne artykuły; posłowie/kluby: zdania generowane z pól API |
| `eur-lex` | `eur-lex.europa.eu` | pierwotne | 1 | treść | — | API Cellar (publications.europa.eu) | decyzja Komisji 2011/833/UE (ponowne wykorzystywanie z podaniem źródła); artykuły aktów |
| `eurostat` | `ec.europa.eu` | pierwotne | 1 | treść | — | API Eurostatu (JSON-stat) | CC BY 4.0 (Eurostat); zdania wygenerowane z wartości |
| `nato` | `www.nato.int` | pierwotne | 1 | treść | — | HTML | polityka NATO — cytowanie z atrybucją; fragmenty ≤ 1200 zn. z linkiem |
| `eu-portal` | `european-union.europa.eu` | pierwotne | 1 | treść | — | HTML | informacja prawna europa.eu (2011/833/UE); blok „informacje o kraju” |
| `gov-pl` | `www.gov.pl` | pierwotne | 1 | treść | — | HTML i kanał JSON RSO | krótkie fragmenty z datą i odnośnikiem do komunikatu |
| `gus-bdl` | `bdl.stat.gov.pl` | pierwotne | 1 | treść | — | API Banku Danych Lokalnych | CC BY 4.0 z podaniem GUS jako źródła |
| `eeas` | `www.eeas.europa.eu` | analiza | 2 | treść | — | HTML | informacja prawna EEAS/KE; streszczenia raportów FIMI |
| `euvsdisinfo` | `euvsdisinfo.eu` | analiza | 2 | stała rola | nie | HTML lub MCP `cases` z tokenem | tytuł przypadku, data, odnośnik |
| `pravda-pl` | `pravda.org.pl` | factcheck | 2 | stała rola | tak | feed ClaimReview | metadane ClaimReview DataCommons (CC BY 4.0); teza, ocena, uzasadnienie ≤ 300 zn. |
| `dpa-factchecking` | `dpa-factchecking.com`, `www.dpa-factchecking.com` | factcheck | 2 | stała rola | tak | feed ClaimReview | j.w. |
| `dw-factcheck` | `www.dw.com` | factcheck | 2 | stała rola | tak (tylko IFCN) | feed ClaimReview | j.w.; tylko rekordy ClaimReview, nie zwykłe artykuły |
| `factcheck-org` | `www.factcheck.org` | factcheck | 2 | stała rola | tak (IFCN) | feed ClaimReview | j.w.; organizacja spoza EOG |
| `politifact` | `www.politifact.com` | factcheck | 2 | stała rola | tak (IFCN) | feed ClaimReview | j.w.; organizacja spoza EOG |
| `demagog` | `demagog.org.pl` | factcheck | 2 | stała rola | tak | **Google Fact Check Tools API** (bez łączenia się z demagog.org.pl) | teza, ocena, daty, tytuł i link z API; zastrzeżenie `ai-train=no` (nie trenujemy) |
| `afp-sprawdzam` | `sprawdzam.afp.com` | factcheck | 2 | stała rola | tak | pakiet organizatora | **0 rekordów** — robots.txt i strona dają HTTP 403 (sekcja 9) |
| `konkret24` | `konkret24.tvn24.pl` | factcheck | 3 | stała rola | **nie** | pakiet organizatora | **0 rekordów** — poza listami IFCN/EFCSN, więc poziom 3 |
| `fakehunter` | `fakehunter.pap.pl` | factcheck | 3 | stała rola | **nie** | pakiet organizatora | **0 rekordów** — blokada Incapsula; poza listami IFCN/EFCSN, więc poziom 3 |
| `prezydent-pl` | `www.prezydent.pl` | pierwotne | 1 | treść | — | HTML | krótki cytat ≤ 300 zn. + link (sekcja 13) |
| `senat-pl` | `www.senat.gov.pl` | pierwotne | 1 | treść | — | HTML | informacje o składzie Prezydium (sekcja 13) i krótki cytat o uchwaleniu Konstytucji |
| `zus-wskazniki` | `psz.zus.pl` | pierwotne | 1 | treść | — | HTML | stawki minimalnego wynagrodzenia za pracę, ich daty obowiązywania i podstawa prawna |
| `ec-commission` | `commission.europa.eu` | pierwotne | 1 | treść | — | HTML | CC BY 4.0 (informacja prawna Komisji); krótkie fragmenty (sekcja 13) |
| `ep-open-data` | `data.europarl.europa.eu` | pierwotne | 1 | treść | — | API PE | zdania generowane z pól danych (sekcja 13) |

Pole **`liveSearch`** (`true`/`false`, domyślnie `false`) określa, czy host jest dopuszczony do wyszukiwania na żywo.
Włączamy je dla dostępnych witryn urzędowych oraz fact-checkerów IFCN/EFCSN. Demagog i GUS BDL są obsługiwani przez API przy
odświeżaniu korpusu. Wyłączamy automatyczne pobieranie stron z potwierdzonymi blokadami oraz źródeł poziomu 3.
Gałąź „live” (`src/engine/retrieval/live.ts`) i `npm run live:smoke` biorą tylko hosty z `liveSearch: true`.
To flaga polityki, nie gwarancja dostępu — gdy serwis blokuje boty (np. AFP, EUvsDisinfo), dostawca wyszukiwania musi uznać gałąź
za niedostępną. Pole jest w kontrakcie `CatalogSource` (`src/shared/contracts.ts`).

Pełne uzasadnienia (kwalifikacja, wykluczenia, częstotliwość aktualizacji, strona główna, flaga `nonEea`) są przy każdym
wpisie w `data/sources.yaml`; `GET /api/sources` serwera i strona `/zrodla` pokazują ten sam katalog.

### Wymiana katalogu i wycofanie źródła

Publiczny `GET /api/sources` zwraca JSON obejmujący wydawców, zasady kwalifikacji, wykluczenia, harmonogram aktualizacji, licencje i liczby rekordów. Katalog z tego eksportu można zapisać jako `sources.yaml` w osobnym pakiecie. Serwer przyjmuje również listę YAML lub JSON. W pakiecie złożonym z eksportu obejmującego już wydawców organizatora każdy wpis powinien wystąpić jeden raz.

Ustaw `PRAWDOWID_DATA_DIR` na katalog wybranego pakietu. Jego publikacje umieść w `corpus/*.jsonl`, a incydenty w `incidents/*.jsonl`. Uruchom `npm run corpus:load`. Dla wyszukiwania semantycznego zbuduj indeks tego samego pakietu przez `npm run embed` z tym samym `DB_PATH` i katalogiem danych. Uruchom ponownie serwer i używane procesy MCP, żeby wszystkie kanały korzystały z nowego katalogu.

Przy ładowaniu Fons sprawdza identyfikator źródła, dokładny host, dozwolone ścieżki i rolę materiału. Poziom, typ, licencję i grupę niezależności bierze z aktualnego wpisu. Aby wycofać źródło, usuń wpis z katalogu. Aby zawęzić zakres, zmień `pathPrefixes`. Przy kolejnym ładowaniu dawne fragmenty i powiązane incydenty wypadają z indeksu. Zmiana polityki zmienia identyfikator migawki, którego aplikacja używa również do buforowania wyników sprawdzeń.

Wyszukiwanie łączy zapytanie oryginalne z wariantami polskimi i angielskimi oraz lokalnym modelem wielojęzycznym. Odpowiedź dla czytelnika jest po polsku. Raport zachowuje cytat w języku źródła. Przy odpowiedzi opartej na jednym obcojęzycznym cytacie weryfikator sprawdza także jego polski przekład.

### 2.1. Weryfikacja statusu IFCN / EFCSN (stan na 2026-11-21)

Flaga `ifcnEfcsn` jest `true` **wyłącznie** dla organizacji, które widzieliśmy na oficjalnych listach:

* **EFCSN** — <https://members.efcsn.com/signatories> (strona „Verified members”; pobrana automatycznie): m.in. AFP (od 13.07.2023),
  DEMAGOG, Poland (od 25.05.2023), Pravda, Poland (od 23.02.2024), dpa (od 27.07.2023), Full Fact, CORRECTIV, Lead Stories, Maldita.es.
* **IFCN** — <https://ifcncodeofprinciples.poynter.org/signatories> (lista ładowana skryptem po stronie przeglądarki, więc odczytana
  po wyrenderowaniu oficjalnej strony): zakładka „Active” (132) — m.in. AFP Fact Check (15.09.2026), Demagog Association, Poland
  (04.10.2024), Pravda, Poland (25.06.2026), Fundacja „Przeciwdziałamy Dezinformacji”, Poland (23.10.2025), dpa (25.06.2026),
  Deutsche Welle (15.09.2026), FactCheck.org (20.05.2026), PolitiFact, Full Fact, Reuters, CORRECTIV, StopFake.org, Vox Ukraine;
  zakładka „In Renewal” (51) — z Polski tylko „Wojownicy Klawiatury”.
* **Nie znaleziono na żadnej liście** (stąd `ifcnEfcsn: false`, poziom 3): Konkret24 (TVN24), PAP FakeHunter, OKO.press;
  EUvsDisinfo to służba EEAS, nie fact-checker-sygnatariusz.

Statusy zmieniają się (odnowienia, utrata statusu) — przed każdym pomiarem końcowym sprawdź obie listy ponownie i zaktualizuj
`data/sources.yaml` oraz ten rozdział.

## 3. Co jest w rekordzie

Każdy rekord (`CorpusRecord`) ma: `title`, `publisher`, `publishedAt` (z źródła; `null`, gdy źródło jej nie podaje — nigdy
nie wymyślamy), `fetchedAt` (faktyczny moment pobrania; dla treści z cache'u — moment pierwotnego pobrania), `url`, `text`
(użyty fragment), `licence`, `level`, `type`, `role`, `independenceGroup`, a dla ocen — `claimReviewed` i `rating`
(`raw` dosłownie od wydawcy + `mapped` przez tabelę + `binary`). `period` opisuje okres, którego dotyczą dane (np. `2024`,
`2025-09`). Twarde reguły budowy:

1. **Tekst dosłowny.** `text` jest podciągiem treści pod `url` (po normalizacji białych znaków). Sprawdza to audyt
   `npx tsx src/corpus/verify.ts` na cache'u pobrań (strony, PDF-y, feed ClaimReview, lista EUvsDisinfo): stan na 2026-11-21 — 1244 rekordy sprawdzone, 0 niezgodnych: 502 rekordy treści (strony, PDF-y) wprost względem źródła i 742 rekordy Demagoga względem zapisanych odpowiedzi Google Fact Check Tools API (teza dosłownie, etykieta oceny; bez sieci i bez klucza), plus 189 rekordów ClaimReview względem feedu i 307 EUvsDisinfo względem listy; pominięte 1285 zdań generowanych z danych (Eurostat, API Sejmu i PE, rejestr placówek — punkt 2).
   W EUvsDisinfo `url` wskazuje stronę wpisu (`/report/…`). Tytuł i data pochodzą z publicznej listy wyników lub z MCP.
   Audyt porównuje rekordy HTML z zapisanymi odpowiedziami i sprawdza strukturę metadanych z MCP.
2. **Dane liczbowe i dane rejestrowe** (Eurostat; API Sejmu — posłowie i kluby; API Parlamentu Europejskiego — polscy europosłowie; rejestr „Polskie przedstawicielstwa na świecie” — ambasadorowie): zdanie generowane z wartości API/pól rejestru, z jawnym okresem i dokładną liczbą, tag `generated-from-data`,
   `url` = dokładne zapytanie do API (seria) albo adres wpisu (poseł: `…/sejm/term10/MP/{id}`, klub: `…/clubs/{id}`, europoseł: `…/api/v2/meps/{id}`, ambasadorowie: strona rejestru), `publishedAt` = pole `updated` zbioru (Eurostat) albo `null`, gdy źródło daty nie podaje (nie zgadujemy). Flagi jakości (`p` – tymczasowe, `e` –
   szacunek) są opisane w zdaniu.
   Tak samo oznaczamy serie GUS z API BDL, osie czasu sankcji Komisji i rozszerzenia UE oraz wartości z tabel wydatków obronnych NATO.
3. **Treści redakcyjne** (fact-checki, EUvsDisinfo, gov.pl): metadane + krótki dosłowny cytat (≤ 300 zn.) + link; nigdy całe artykuły.
4. **Akty prawne** (ELI, EUR-Lex): pełne artykuły, dzielone na kawałki ≤ 1200 znaków.
5. Tytuł rekordu ClaimReview ma postać „wydawca: teza” (feed nie zawiera tytułu strony); to jedyne pole nieprzepisane dosłownie ze źródła.

## 4. Kwalifikacja źródeł do katalogu

Źródło wchodzi do katalogu, jeżeli spełnia **wszystkie** warunki:

1. jest jednoznacznie zidentyfikowane hostem (nie „cała domena” z dziedziczeniem), ma wskazanego wydawcę;
2. jest **pierwotne/urzędowe** (akt prawny, dane statystyczne, komunikat instytucji) albo **fact-checkiem organizacji z listy
   IFCN/EFCSN** (poziom 2), albo **analizą instytucji publicznej UE/NATO** (poziom 2), albo wiarygodnym źródłem wtórnym (poziom 3);
3. można je pobierać legalnie: istnieje API/feed/otwarta strona, robots.txt nie zabrania pobrania, brak paywalla i wyzwań
   antybotowych;
4. licencja jest znana (lub jawnie oznaczona jako niepotwierdzona, a wtedy używamy tylko metadanych i krótkiego cytatu);
5. wydawcy z tej samej organizacji dostają wspólną `independenceGroup` (liczą się jako jedno potwierdzenie).

Poziom i typ nigdy nie pochodzą z odpowiedzi modelu ani konektora — wyłącznie z katalogu po dokładnym hoście. Fact-checker bez
statusu IFCN/EFCSN (np. Konkret24) jest poziomem 3 i nie spełnia warunku „fact-check IFCN/EFCSN” z PLAN §4.

## 5. Kwalifikacja i wykluczanie rekordów

| Źródło | Co bierzemy | Co wykluczamy |
|---|---|---|
| `sejm-eli` | artykuły aktów z listy w `ingest/eli.ts` (Konstytucja, ustawy o pomocy obywatelom Ukrainy, sankcyjna, o obronie Ojczyzny, o cudzoziemcach, o ochronie międzynarodowej, o ochronie granicy i Straży Granicznej, Kodeks wyborczy, ratyfikacje akcesji Finlandii i Szwecji do NATO, umowa o współpracy obronnej z USA, uchwały Sejmu o agresji Rosji, zarządzenie o Centrum Walki z Dezinformacją, najnowsze rozporządzenia graniczne i azylowe) | akty uchylone (`inForce = NOT_IN_FORCE`); artykuły „(uchylony)” i krótsze niż 60 znaków; tekst ogłoszony aktu, który ma tekst ujednolicony (bierzemy ujednolicony) |
| `eur-lex` | wybrane artykuły rozp. 833/2014 (filtr słów: ropa, węgiel, stal, diamenty, gaz, SWIFT/bank centralny, przestrzeń powietrzna, RT/Sputnik, kryptoaktywa, pułap cenowy), 269/2014, 765/2006, decyzja 2014/512/WPZiB, TUE (art. 2–7, 42, 49, 50), rozp. 2024/1359 (instrumentalizacja migracji) | wersje starsze niż najnowsza dostępna po polsku konsolidacja; znaczniki zmian ▼M…; fragmenty < 60 zn. |
| `eurostat` | seria roczna/miesięczna dla Polski (i UE-27 tam, gdzie porównanie ma sens): wnioski o azyl, ochrona czasowa obywateli Ukrainy (marzec i grudzień każdego roku + ostatni miesiąc), wydatki na obronę (% PKB i mln euro), zależność importowa energii, import gazu z Rosji, udział OZE, inflacja HICP, bezrobocie, ludność | punkty bez wartości; lata przed progiem `from` w specyfikacji serii |
| `nato` | strony tematyczne (członkowie, art. 5, rozszerzenie, Rosja, Ukraina, 5% PKB, zagrożenia hybrydowe, odstraszanie), deklaracje szczytów (Madryt 2022, Waszyngton 2024, Haga 2025), Traktat Północnoatlantycki | nawigacja i okna logowania; strony 404 |
| `eu-portal` | blok „informacje o kraju” (data przystąpienia, Schengen, euro) dla państw członkowskich | strony bez bloku z datą przystąpienia (Słowacja, Słowenia) |
| `gov-pl` | komunikaty MSZ, MON, MSWiA, KPRM z ostatnich tygodni, których tytuł/lead pasuje do tematów (Rosja, Ukraina, Białoruś, NATO, sankcje, UE, granica, migracja, dezinformacja, obrona, cyberbezpieczeństwo) | treści krótsze niż 60 zn.; tematy spoza zakresu |
| `eeas` | streszczenia stron raportów FIMI i strony o dezinformacji | pełne raporty (PDF) |
| `euvsdisinfo` | wpisy „DISINFO” z pierwszych stron wyników dla zestawu haseł oraz przypadki pobrane przez autoryzowane MCP | inne prefiksy dla HTML, dalsze strony HTML, uzasadnienia i odnośniki do materiałów rozpowszechniających narrację |
| fact-checki z feedu | wpisy ClaimReview hostów z katalogu, o tematach zakresu (filtr słów kluczowych; dla Pravdy dowolny temat polski + międzynarodowy, dla pozostałych wymagany wynik tematyczny ≥ 2), z czytelną etykietą oceny; po rankingu trafności limity: Pravda 70, dpa 60, DW 45, FactCheck.org 25, PolitiFact 25 | wpisy bez etykiety oceny (długi opis bez znanej etykiety — 434 wpisy, głównie dpa), hosty spoza katalogu |

Rekord o stałej roli z oceną spoza tabeli mapowania **zostaje** w korpusie (`mapped: null`) jako kontekst, ale nie rozstrzyga.

## 6. Licencje i zgodność

* **Akty prawne i urzędowe dokumenty** (Dz.U., M.P.): nie są chronione prawem autorskim (art. 4 pkt 1–2). Teksty ujednolicone
  Kancelarii Sejmu mają charakter informacyjny, są oparte wyłącznie na aktach; w tytule rekordu zaznaczamy „tekst ujednolicony”.
* **EUR-Lex, Eurostat, portal UE, EEAS:** ponowne wykorzystywanie z podaniem źródła (decyzja Komisji 2011/833/UE; Eurostat — CC BY 4.0).
  Konsolidacje EUR-Lex są dokumentami informacyjnymi bez mocy prawnej (autentyczny jest tylko Dz.Urz. UE) — informujemy o tym w tytule rekordu.
* **Feed ClaimReview DataCommons:** CC BY 4.0; autorem oceny jest organizacja fact-checkingowa. Przechowujemy tezę, ocenę,
  uzasadnienie ≤ 300 zn. i link do oryginału; atrybucja jest w polu `publisher` i `url`.
* **NATO, gov.pl:** brak potwierdzonej licencji otwartej → krótkie fragmenty z linkiem i wskazaniem wydawcy.
* **EUvsDisinfo:** brak jawnej licencji → wyłącznie metadane (tytuł tezy, data) + link.
* **Demagog:** robots.txt zawiera sygnał `Content-Signal: search=yes, ai-train=no, use=reference`. **Z serwisem nie łączymy się
  bezpośrednio** (bez pobierania stron, RSS, map strony, wyszukiwania na żywo i sondy dostępności). Ingestor pobiera tezy i oceny
  z Google Fact Check Tools API. Przy ładowaniu lokalnego indeksu do wybranych rekordów dołączamy krótkie cytaty z uzasadnień wskazane w bibliografii redakcyjnej.
* Wszystkie żądania: `User-Agent: PrawdowidBot/0.1 (prototyp hackathonowy)` (bez danych kontaktowych), ≤ 1 żądanie/s na host
  (`Crawl-delay` z robots.txt, np. 10 s dla EEAS, ma pierwszeństwo), sprawdzanie robots.txt dla każdego pobieranego adresu
  (brak pliku = dozwolone; błąd 403/5xx = zakaz).

## 7. Aktualizacja

```bash
npm run corpus:build                          # wszystkie źródła (odpowiedzi z cache'u .cache/corpus/ są używane ponownie)
npm run corpus:build -- --refresh             # wymuś ponowne pobranie (feed ClaimReview ok. 200 MB, ok. minuty)
npm run corpus:build -- --only eurostat,nato  # wybrane źródła: eli, eur-lex, eurostat, nato, eu-portal, gov-pl, eeas, claimreview, euvsdisinfo,
                                              #   gov-pl-officials, sejm-mp, state-officials, eu-leadership, demagog, factcheck-probe
npm run corpus:load                           # załaduj data/*.jsonl do SQLite (loadConfig().dbPath), wypisz liczby
npx tsx src/corpus/verify.ts                  # audyt dosłowności tekstu względem pobranych źródeł
npx vitest run src/corpus                     # testy modułu (80)
```

* Serwer wywołuje `ensureCorpusLoaded(db)` przy starcie — jest idempotentne (sha256 posortowanych linii jsonl); gdy migawka
  się zmieni, przeładowuje tabele, przebudowuje FTS i usuwa wektory rekordów usuniętych lub zmienionych.
* Błąd jednego źródła nie przerywa budowania, a poprzednie dane tego źródła zostają nietknięte. `data/corpus-report.json`
  zapisuje liczby, pominięte elementy i uwagi z każdego uruchomienia.
* Osoby pełniące funkcje (rząd, MSZ, ambasadorowie, Sejm, Senat, Prezydent, Komisja, PE, NATO) zmieniają się — **przed każdym pokazem**
  uruchom `npm run corpus:build -- --only gov-pl-officials,sejm-mp,state-officials,eu-leadership,nato` (ok. 1–2 min; 1 żądanie/s na host)
  i `npm run corpus:load`, a potem `npx tsx src/engine/retrieval/embed-corpus.ts`. Demagog (`npm run corpus:demagog`, wymaga `FACTCHECK_API_KEY` w `.env`) pobiera ok. 8 stron wyników z Fact Check Tools API (kilka sekund).
* Rekomendowana częstotliwość: statystyki Eurostatu i komunikaty gov.pl — przed każdym pokazem/pomiarem (tygodniowo);
  akty prawne i konsolidacje EUR-Lex — przy zmianie (miesięcznie); feed ClaimReview — tygodniowo; NATO, EEAS — miesięcznie;
  EUvsDisinfo — miesięcznie. Do narzędzia `pdftotext` (poppler, `brew install poppler`) potrzebna jest ingestia aktów w PDF
  (teksty ujednolicone); bez niego te akty są pomijane z adnotacją w raporcie.
* Rekord starzeje się wg daty (`publishedAt`/`period`); moduł werdyktu stosuje reguły 3–4 z PLAN §4 i ostrzeżenie o materiale
  archiwalnym. Po odświeżeniu stare rekordy znikają z plików jsonl (migawka się zmienia), więc nic nie wisi bez pokrycia w źródle.

## 8. Mapowanie ocen (`data/rating-map.yaml`, `src/corpus/ratings.ts`)

`mapRating(sourceId, raw)` zwraca `{ raw, mapped, binary }`. Tabele są jawne i w repozytorium: wspólne etykiety angielskie
(False, Mostly False, Misleading, Missing context, Half true, Mostly true, True, Pants on fire, Satire, Unproven…), niemieckie,
holenderskie/francuskie/hiszpańskie, polskie wspólne oraz osobne tablice Demagoga, AFP Sprawdzam, Konkret24, Pravdy i
EUvsDisinfo. Zasady: ocena spoza tabeli → `mapped: null` (nie rozstrzyga); `binary: true` tylko dla jednoznacznych ocen
prawda/fałsz (tylko takie silnik odwraca przy negacji); „DISINFO” z EUvsDisinfo → `FALSZYWE`, ale `binary: false` (zaprzeczenie
dezinformacji nie czyni jej prawdą). Etykiety Pravdy, DW, dpa, FactCheck.org, PolitiFact, EUvsDisinfo i Demagoga (Fałsz, Manipulacja, Prawda, Częściowa prawda,
Nieweryfikowalne, a u Demagoga także Brakujący kontekst, Częściowy fałsz, Przerobione zdjęcie/film, Satyra — zapisywane też małymi literami,
bez ogonków lub z kropką) zaobserwowano w danych; tablice AFP Sprawdzam i Konkret24
odpowiadają opublikowanym skalom, ale serwisy są zablokowane dla botów, więc nie dało się ich potwierdzić maszynowo — wpisano tylko etykiety jednoznaczne. Test sprawdza zgodność wszystkich ocen w korpusie z bieżącą tabelą.

## 9. Co pominięto i dlaczego (bez obchodzenia zabezpieczeń)

| Źródło / zasób | Powód | Skutek |
|---|---|---|
| `demagog.org.pl` — cały serwis (strony, RSS, mapy strony) | zasada projektu: bez bezpośredniej integracji z Demagogiem | dane tylko z Google Fact Check Tools API; recenzje starsze niż rok, z sekcji `/ua/`, z tezą krótszą niż 21 znaków lub oceną bez czytelnej etykiety pominięte |
| `euvsdisinfo.eu/report/…` (strony wpisów) | HTTP 403 dla botów (wyzwanie Cloudflare/Turnstile) | metadane z listy wyników albo z autoryzowanego MCP |
| `euvsdisinfo.eu/disinformation-cases/page/N/` | zabronione w robots.txt (`Disallow: */page/*`) | pierwsze strony wyników HTML. Paginacja dostępna przez narzędzie MCP `cases` |
| `euvsdisinfo.eu` — `/feed/`, sitemapy | `*/feed/` zabronione w robots.txt; sitemapa zwraca 403 | nie używane |
| `consilium.europa.eu` (komunikaty o sankcjach) | HTTP 403 także dla `robots.txt` (ochrona antybotowa) | pominięte; sankcje pokryte aktami z EUR-Lex i ustawą ELI |
| `eur-lex.europa.eu` (strony serwisu) | wyzwanie WAF (HTTP 202 bez treści) | treść z oficjalnego interfejsu Cellar (publications.europa.eu); `url` rekordu wskazuje stronę EUR-Lex tego samego dokumentu |
| Traktat o przystąpieniu 2003 (CELEX 12003T) | brak wersji w Cellar pod tym numerem (404) | datę przystąpienia Polski do UE pokrywa portal UE (`eu-portal`) |
| Wikidata (SPARQL i API) | robots.txt zabrania: `query.wikidata.org` — `Disallow: /sparql`; `www.wikidata.org` — `/w/` i `Special:` | Wikidata nie jest w korpusie (daty członkostwa: NATO, portal UE) |
| `sprawdzam.afp.com` | HTTP 403 „Access Denied” CDN także dla `robots.txt`, strony głównej, `/rss.xml`, `/sitemap.xml` (curl i klient Node, 2026-11-21); brak wpisów hosta w feedzie ClaimReview DataCommons (jest tylko `factuel.afp.com`, 2 wpisy, host spoza katalogu) | robots.txt nieczytelny = traktujemy jak zakaz; 0 rekordów; dane z pakietu organizatora |
| `fakehunter.pap.pl` | HTTP 200 ze stroną-wyzwaniem Incapsula zamiast treści | 0 rekordów; poziom 3, więc i tak nie rozstrzygałby werdyktu |
| `konkret24.tvn24.pl` | robots.txt zezwala, ale to poziom 3 (poza IFCN/EFCSN) — rekord o stałej roli z poziomu 3 nie rozstrzyga i nie liczy się jako źródło wtórne (VERDICT-RULES) | nie pobierane; ewentualnie z pakietu organizatora |
| `www.sejm.gov.pl` (strona Prezydium Sejmu, Marszałek) | robots.txt: `User-agent: *` → `Disallow: /` (tylko Googlebot ma dostęp) | Marszałka Sejmu bierzemy z podpisu pod obwieszczeniem w Dz.U. (API ELI) |
| `www.consilium.europa.eu` (Rada Europejska: przewodniczący) | HTTP 403 — wyzwanie Cloudflare także dla `robots.txt` | pominięte; brak rekordu o Przewodniczącym Rady Europejskiej |
| `www.europarl.europa.eu` (listy posłów, robots.txt) | HTTP 403 CloudFront | posłów do PE bierzemy z oficjalnego API otwartych danych (`data.europarl.europa.eu`, robots.txt dopuszcza `/api/`, `Crawl-delay: 2`) |
| strona Kolegium Komisarzy (`commission.europa.eu`) — narodowość komisarzy | strona listy nie podaje państw | brak rekordu „polski komisarz”; rekordy opisują tekę, nie narodowość |
| 434 wpisy ClaimReview (głównie dpa) | ocena jest wolnym tekstem bez znanej etykiety | pominięte (nie zgadujemy oceny) |
| 2 strony NATO (obecność wojskowa na wschodzie, Eastern Sentry) | HTTP 404 pod znanym adresem | pominięte |
| profile UE: Słowacja, Słowenia | brak bloku z podstawowymi informacjami | pominięte |
| 1 komunikat gov.pl | treść krótsza niż 60 zn. | pominięty |
| EEAS: pełne raporty FIMI (PDF) | poza zakresem startowym | tylko streszczenia stron |

Uwagi o IFCN: lista IFCN ładuje dane z zaplecza strony skryptem; odczytaliśmy ją po wyrenderowaniu oficjalnej publicznej strony,
nie wywoływaliśmy bezpośrednio adresów zaplecza znalezionych w kodzie strony.

## 10. Incydenty (`data/incidents/*.jsonl`)

Rekord: `id`, `title`, `summary`, `url`, `domains`, `publishedAt`, `recordId` (kolumny `incidents` w bazie: `domains_json`,
`record_id`). Źródła: (1) wszystkie wpisy EUvsDisinfo z korpusu (narracje prorosyjskie), (2) wpisy ClaimReview ocenione jako
fałsz lub wprowadzające w błąd. Każdy incydent wskazuje rekord korpusu (`recordId`) — test sprawdza, że istnieje.

**`domains` jest puste dla incydentów z ClaimReview i EUvsDisinfo — celowo.** Pole `appearance` w ClaimReview wymienia miejsca,
w których teza się *pojawiła* (także media cytujące ją krytycznie lub oficjalne wypowiedzi), a nie serwisy, które ją
rozpowszechniają. Import MCP zachowuje metadane przypadków EUvsDisinfo bez listy adresów materiałów. Wpisanie tych hostów do `domains` wywołałoby
ostrzeżenie o domenie w raporcie i niesłusznie obciążyło media głównego nurtu. Miejsca pojawienia się tezy (bez platform,
urzędów, archiwów i fact-checkerów) są wymienione opisowo w `summary`. Pole `domains` wypełnia importer pakietu organizatora,
jeśli baza organizatora jawnie wskazuje serwisy rozpowszechniające narrację; platformy społecznościowe nigdy nie są domenami incydentów.

### Dopasowanie narracji EUvsDisinfo

Przy imporcie rozróżniamy dwa rodzaje wskazań wydawcy. Pole `domains` oznacza dokładny host, łącznie z ewentualnym `www.`. Pole `channels` zawiera udokumentowane adresy profili. Obsługiwane są profile TikToka z `/@nazwa` i YouTube z `/@nazwa` lub `/channel/UC…`. Fons rozpoznaje profil w adresie filmu TikToka lub zakładki kanału YouTube. Sam adres oglądania filmu na YouTube nie identyfikuje kanału. Importer pomija domeny znanych platform społecznościowych w polu `domains`.

Ostrzeżenie zawiera odnośnik do opisu incydentu. Pojawia się wyłącznie po dopasowaniu adresu podanego przez użytkownika do takiego wskazania. Silnik wyznacza werdykt na podstawie twierdzenia i ocenionych fragmentów publikacji. Dokładny adres publikacji obecnej w korpusie może też dać informację bibliograficzną, nawet gdy bieżący odczyt się nie uda.

Fons szuka kandydatów w lokalnym indeksie incydentów i korpusie, wykorzystując m.in. angielską wersję zapytania. Gdy porównanie
wykaże zgodność sedna i czasu twierdzenia, raport pokazuje do trzech odnośników do przypadków. Ustalenie pochodzenia sprawdzanej
wiadomości wymaga osobnych dowodów. [Baza przypadków EUvsDisinfo](https://euvsdisinfo.eu/disinformation-cases/)

Aktualny serwer `https://mcp.euvsd.info/mcp` udostępnia przez Streamable HTTP narzędzia `cases`, `articles`, `search` i `narratives`.
Fons korzysta z `cases` przy odświeżaniu korpusu. Pobiera do 100 pozycji na stronę, używając parametrów `offset` i `limit`, i zachowuje
tytuł, datę oraz odnośnik. Frazy użytkowników pozostają w lokalnym wyszukiwaniu przypadków. Rekordy z etykietą wydawcy z listy HTML
zachowują swoje oceny. [Aktualna dokumentacja MCP](https://veedoo.fibery.io/Documentation/Guides/EUvsDisinfo-MCP.-API.-%2807.2025%29-262?sharing-key=b10c22de-b630-4efc-824d-e117d530a4c8), [instrukcja połączenia MCP](https://veedoo.fibery.io/Documentation/Guides/Connect-AI-tools-assistans-for-MCP-server-%285-05-2026%29-268?sharing-key=91744a47-cc53-4904-a4f4-29ef0533d304), [instrukcja paginacji (PDF)](https://euvsdisinfo.eu/public-docs/How_to_grab_all_Articles_and_Cases_from_disinfo.pdf)

Klucz uzyskany od EUvsDisinfo ustaw jako `EUVSDISINFO_MCP_TOKEN` w `.env`. Fons przekazuje go w nagłówku `Authorization`.
Bez klucza odświeżanie korzysta z publicznych list HTML. Limit domyślny to 2000 pozycji. Polecenie poniżej używa limitu 1000.
Po imporcie załaduj korpus do bazy. `npm run embed` pozwala przebudować indeks wektorowy po większym imporcie.

```sh
npm run corpus:build -- --only euvsdisinfo --limit 1000
npm run corpus:load
```

## 11. Import pakietu organizatora (`src/corpus/import-organizer.ts`)

Pakiet nie jest jeszcze opublikowany, więc importer jest napisany względem **udokumentowanego, konfigurowalnego kształtu** wejścia
(opis w nagłówku pliku) i przetestowany na próbce z `src/corpus/fixtures/` (dane wymyślone, hosty `.example`).

1. Lista źródeł (JSON lub CSV) → wpisy katalogu w `data/sources.organizer.yaml` (dołączane do katalogu przez `loadCatalog`; host
   już obecny w `sources.yaml` ma pierwszeństwo). Typ rozpoznawany z opisu (pierwotne/primary/official, fact-check, analiza/analysis),
   poziom z pakietu lub domyślny dla typu (pierwotne 1, factcheck 2, analiza 3), `ifcnEfcsn` z pola sygnatariusza.
2. Baza incydentów (JSON lub CSV) → rekordy `origin: "organizer"` w `data/corpus/organizer-*.jsonl` (rola stała, jeśli jest teza i
   ocena; ocena przez `rating-map.yaml`) + `data/incidents/organizer.jsonl`. Poziom, typ i rola wynikają z katalogu po dokładnym
   hoście; hosty spoza katalogu trafiają do źródła `organizer-base` (poziom 2, factcheck, stała rola — baza organizatora jest
   rozstrzygająca wg PLAN §4). Daty nieczytelne → `null`; niczego nie wymyślamy.
3. Nazwy pól są konfigurowalne plikiem `--mapping m.json` (`{ "sources": { "host": ["Domena"] }, "incidents": { "claim": ["Teza"] } }`).

```bash
npx tsx src/corpus/import-organizer.ts --sources pakiet/zrodla.csv --incidents pakiet/incydenty.json [--mapping m.json]
npm run corpus:load
```

Lista kontrolna na dzień publikacji pakietu (cel: ≤ 2 h): (a) sprawdź nagłówki/pola i ewentualnie dopisz `--mapping`;
(b) uruchom import na kopii (`--data-dir`) i przejrzyj pominięte wiersze; (c) uzupełnij licencję pakietu w `data/sources.organizer.yaml`;
(d) dopisz etykiety ocen organizatora do `data/rating-map.yaml` (tablica dla `organizer-base`); (e) `npx vitest run src/corpus`.

## 12. Znane ograniczenia

* Teksty ujednolicone z PDF-ów (`pdftotext`) zawierają przypisy dolne stron wmieszane w treść artykułu; to wierny zapis PDF, ale bywa nieczytelny.
* Konsolidacje EUR-Lex i teksty ujednolicone ELI są informacyjne; rekord nie zastępuje tekstu autentycznego.
* Tytuły rekordów ClaimReview są syntetyczne („wydawca: teza”); część tez Pravdy jest w feedzie po angielsku.
* Rekordy EUvsDisinfo to tylko tytuł tezy (bez uzasadnienia) — nie są dowodem rozstrzygającym same (źródło nie jest sygnatariuszem IFCN/EFCSN).
* Zasięg tematyczny filtrów to słowa kluczowe, nie klasyfikator — część rekordów jest tylko luźno związana z tematem.
* Liczba rekordów gov.pl zależy od daty budowania (lista aktualności obejmuje kilka ostatnich tygodni).
* Licencje NATO i gov.pl oraz tablice ocen AFP/Konkret24 wymagają potwierdzenia u wydawców; Demagog zastrzega `ai-train=no` (użycie jako odnośnik).
* Rekordy osób pełniących funkcje to stan z dnia pobrania (sekcja 13); tytuły rekordów o funkcjach i posłach są opisowe (nie cytaty), a tekst jest dosłowny albo oznaczony `generated-from-data`.
* FTS5 `unicode61` składa polskie ogonki poza „ł”; dla zapytań wpisanych bez ogonków jest pomocnicza tabela `records_fold`
  (`foldPolish`). Brak stemmingu — zapytania powinny zawierać odmienione formy lub prefiksy (`sankcj*`).

## 13. Osoby pełniące funkcje publiczne (pytania „kto jest …”) — faza 2

Cel: demo zaczyna się od prostych pytań („Kto jest ministrem spraw zagranicznych?”, „Czy X jest posłem?”, „Do jakiego klubu należy X?”),
na które korpus musi odpowiadać z **oficjalnych stron i API** — nie z pamięci modelu. Wszystkie rekordy pobrano na żywo 2026-11-21
(stan na dzień `fetchedAt`; skład rządu zmienia się — np. biogram nowej ministry Funduszy i Polityki Regionalnej opublikowano dzień
przed pobraniem — więc przed pokazem odśwież korpus, patrz sekcja 7).

| Zakres | Źródło (host → `sourceId`) | Rekordów | Sposób zapisu |
|---|---|---|---|
| Rada Ministrów (premier, wicepremierzy, ministrowie) | `www.gov.pl/web/premier/sklad-rady-ministrow` + biogram każdego członka → `gov-pl` | 21 | dosłowne linie z biogramu: „imię nazwisko funkcja” + zdanie o bieżącym powołaniu (jeśli jest); ≤ 300 zn. |
| Kierownictwo MSZ (minister, sekretarze i podsekretarze stanu, szefowa Służby Zagranicznej) | `www.gov.pl/web/dyplomacja/kierownictwo-ministerstwa` + biogramy → `gov-pl` | 8 | j.w. |
| Ambasadorowie i szefowie stałych przedstawicielstw | rejestr „Polskie przedstawicielstwa na świecie” (`www.gov.pl/web/dyplomacja/polskie-przedstawicielstwa-na-swiecie`, dane jako CSV w stronie) → `gov-pl` | 103 | zdanie generowane z wierszy rejestru (`generated-from-data`); pola dosłowne (także „Chargé d'affaires a.i.”, gdy placówką kieruje chargé) |
| Prezydent RP | `www.prezydent.pl/prezydent/biografia` → `prezydent-pl` | 1 | nagłówek strony + zdanie o objęciu urzędu; data = `og:article:modified_time` |
| Marszałek Sejmu | podpis „Marszałek Sejmu: X. Nazwisko” pod najnowszym obwieszczeniem Marszałka Sejmu w Dz.U./M.P. (`api.sejm.gov.pl/eli`) → `sejm-eli` | 1 | dosłowna linia podpisu z PDF; pełne imię w **tytule** tylko, gdy inicjał i nazwisko pasują do dokładnie jednego posła z API |
| Posłowie X kadencji (aktywni i z wygasłym mandatem), kluby i koła, skład Sejmu | `api.sejm.gov.pl/sejm/term{N}/MP`, `/clubs` (numer kadencji z `/sejm/term`, `current: true`) → `sejm-eli` | 499 + 12 + 1 | zdanie generowane z pól API (`generated-from-data`), `url` = `…/MP/{id}` lub `…/clubs/{id}`, `publishedAt: null`; klub, okręg, status mandatu, przyczyna wygaśnięcia i opis z API; **bez** e-maila, daty/miejsca urodzenia i wykształcenia |
| Prezydium Senatu (Marszałek, wicemarszałkowie) | `www.senat.gov.pl/sklad/senatorowie/prezydium.html` → `senat-pl` | 6 | „imię nazwisko” + „funkcja” z kafelka listy; `publishedAt: null` |
| Kolegium Komisarzy (Przewodnicząca, wiceprzewodniczący, Wysoka Przedstawiciel, komisarze) | `commission.europa.eu/about/organisation/college-commissioners_en` → `ec-commission` | 27 | „imię nazwisko teka” dosłownie; Przewodnicząca: „The President imię nazwisko” |
| Polscy posłowie do PE (z grupą polityczną) | `data.europarl.europa.eu/api/v2/meps/show-current?country-of-representation=PL` → `ep-open-data` | 53 | zdanie generowane z pól API (`generated-from-data`), `url` = `…/meps/{id}` |
| Sekretarz Generalny NATO | `www.nato.int/en/about-us/organization/nato-structure/nato-secretary-general` → `nato` | 3 | fragmenty strony (≤ 1200 zn.), m.in. „The post is currently held by …”; `publishedAt` z „Updated” |

**`publishedAt`** to data ostatniej publikacji **strony** (gov.pl: najnowsza wersja z historii zmian; prezydent.pl: `modified_time`),
a nie data objęcia urzędu — datę objęcia zawiera cytowane zdanie. Dla API Sejmu/PE, rejestru placówek i Senatu `publishedAt` to `null`
(źródło nie podaje daty). Moduł werdyktu powinien traktować te rekordy jako stan z dnia `fetchedAt` i nie wnioskować z nich o stanie
w innym dniu.

**Czego nie ma (i dlaczego):** Rada Europejska (consilium.europa.eu — blokada), strona Prezydium Sejmu (robots.txt zabrania),
narodowość komisarzy (strona nie podaje), lista ambasadorów „kluczowych państw” jako osobny wybór (zapisano cały rejestr szefów
ambasad i stałych przedstawicielstw — 103 wpisy), konsulaty i instytuty polskie. Rekord o braku funkcji („X nie jest posłem”)
nie istnieje — brak rekordu w korpusie nie dowodzi, że ktoś nie pełni funkcji; ocenę „nie jest” można oprzeć tylko na rekordzie
o aktywnym mandacie innej osoby albo o wygaśnięciu mandatu (rekordy byłych posłów są w korpusie).

**Uwaga prawna (nie jest to opinia prawna).** Zapisujemy wyłącznie informacje o osobach pełniących funkcje publiczne, w zakresie
związanym z pełnioną funkcją (nazwisko, urząd, klub poselski, okręg, status mandatu), pobrane z oficjalnych, publicznych stron
i API samych instytucji (gov.pl, prezydent.pl, senat.gov.pl, API Sejmu, dane otwarte PE, strony Komisji Europejskiej i NATO).
Jawność takich informacji wynika z art. 61 Konstytucji RP i art. 5 ust. 2 ustawy o dostępie do informacji publicznej (ograniczenie
ze względu na prywatność nie dotyczy informacji o osobach pełniących funkcje publiczne mających związek z pełnieniem tych
funkcji). Nie zapisujemy danych prywatnych (adresy, telefony, e-maile, daty i miejsca urodzenia, wykształcenia, wyniki wyborcze).
Każdy rekord ma link do strony/wpisu źródłowego, a osoba może zażądać usunięcia rekordu przez zgłoszenie do administratora usługi.
Licencje poszczególnych źródeł: sekcja 2 i `data/sources.yaml` (gov.pl, prezydent.pl, senat.gov.pl — krótki cytat + link;
Komisja — CC BY 4.0; API Sejmu — dane urzędowe; PE — krótkie zdania generowane z pól).

**Pobieranie ocen Demagoga przez Google Fact Check Tools API.** Zasada projektu: żadnej bezpośredniej integracji
z `demagog.org.pl` (IFCN i EFCSN). Ingestor `demagog` (`src/corpus/ingest/demagog.ts`) woła `claims:search` z filtrem
`reviewPublisherSiteFilter=demagog.org.pl`, `languageCode=pl`, `maxAgeDays=365` (klucz `FACTCHECK_API_KEY` w nagłówku
`X-Goog-Api-Key` jako nagłówek tajny klienta — nigdy w adresie, w raporcie ani w kluczu i treści cache'u). Bierze polskojęzyczne
recenzje z dokładnym hostem `demagog.org.pl` (bez sekcji `/ua/`), z datą recenzji z ostatniego roku (sprawdzane też lokalnie; okno
zmienia `DEMAGOG_MAX_AGE_DAYS` w `.env`), od najnowszej (najwyżej 2000). Pomiar 2026-11-21: API ma 9338 recenzji Demagoga (2015–2026);
z okna roku zapisano **742 rekordy** (fake newsy 550, wypowiedzi polityków 191, inne 1; recenzje 2025-11-24 – 2026-11-20). W surowym pliku
rekordu pole tekstu zawiera dosłowną tezę z API; ocena przez tabelę mapowania (FALSZYWE 464, WPROWADZAJACE 259, POTWIERDZONE 15, BRAK_DOWODOW 1,
NIE_PODLEGA 1, niezmapowane 2). **Autora tezy nie ma w tytule** (tytuł waży 10 w BM25 — nazwisko polityka w tytule ściągało do puli
niezwiązane fact-checki jego innych wypowiedzi); przy wypowiedziach polityków jest w `topics` (`autor-tezy:…`), przy fake newsach
nie zapisujemy go wcale (autorem bywa osoba prywatna). **Dlaczego rok, a nie 2 lata:** przy oknie 2 lat (ok. 1750 rekordów, połowa
korpusu) twierdzenia z nazwiskiem polityka dostawały w puli BM25 (30) i w ocenianej ósemce prawie wyłącznie rekordy Demagoga,
a wypadały rekordy urzędowe (np. „Prezydent RP: …”); przy roku udział wraca do poziomu sprzed migracji, a zostają nowe trafienia
(np. „Szczepionki przeciw HPV powodują menopauzę i bezpłodność”). Szersze okno ma sens dopiero z limitem rekordów jednego źródła
w wyszukiwaniu. Awaria w trakcie paginacji = brak zapisu (poprzedni plik zostaje). Wcześniejszy ingestor, który czytał kanał RSS
i strony wypowiedzi, został zastąpiony; dla hosta `liveSearch: false`, a sonda dostępności go nie obejmuje. **Wyjątek:** link do
strony Demagoga wklejony przez użytkownika jest pobierany raz jako PRZEDMIOT sprawdzenia, jak każdy inny wklejony adres — nigdy
jako dowód i nigdy do korpusu. AFP Sprawdzam: HTTP 403 także dla robots.txt, brak wpisów w feedzie DataCommons (sekcja 9) — 0 rekordów;
pozostaje pakiet organizatora. Sonda `factcheck-probe` zapisuje w `corpus-report.json` bieżący stan dostępu i liczbę wpisów
hostów w feedzie ClaimReview.

Przy przebudowie korpusu aplikacja odświeża również cztery wskazane publikacje o depeszy PAP, ulgach i wydatkach na transport we Wrocławiu oraz nagraniu Michała Wosia. Wyszukuje je w Google bez ograniczenia wieku i sprawdza adres każdej recenzji. W pliku `data/publication-links.json` redakcja może wskazać dokładne adresy omawianych postów (`appearances`), dokumenty będące przedmiotem weryfikacji (`documents`), odnośniki samego wydawcy (`references`) oraz niezależne materiały uzupełniające (`context`). Opcjonalne `excerpts` zawierają dosłowne, krótkie cytaty z uzasadnienia o wskazanym adresie. Przy wczytywaniu danych te cytaty trafiają do oddzielnych wierszy indeksowanego fragmentu. Pole `claimReviewed` nadal pochodzi w całości z API. Cytaty zachowują wskazanie wydawcy, adres i opis ich pochodzenia w polu `licence`. Migawka zawiera też dokumenty towarzyszące w `data/corpus/published-documents.jsonl`. Obejmują one nagłówek pierwotnej depeszy, dane miejskiego Wydziału Transportu, wystąpienie RPO o proteście oraz listopadową zapowiedź MSZ wraz z zestawieniem manifestacji Sky TG24. W polu `context` komunikatu zapisano także relację Sky TG24 z 20 listopada 2026 r. opisującą przebieg strajku. Obie publikacje Sky należą do jednej grupy wydawniczej.

Podczas weryfikacji lokalny indeks wektorowy wyszukuje metadane Demagoga na podstawie treści twierdzenia i wariantów zapytania.
Do dwóch mocnych trafień może przejść do oceny mimo małego pokrycia słów. Silnik sprawdza wtedy zgodność twierdzeń, w tym podmiot,
liczbę i okres. Sprawdzenie pasujące tylko do części twierdzenia może pojawić się jako kontekst. Zapytania użytkowników służą do
przeszukiwania lokalnego korpusu Demagoga.
[Dokumentacja Google Fact Check Tools API](https://developers.google.com/fact-check/tools/api/reference/rest?hl=pl),
[publiczny Fact Check Explorer](https://toolbox.google.com/factcheck/explorer/search/list:recent;hl=pl)

**Oficjalne kanały instytucji (`data/authorities.yaml`).** Gałąź `official` pobiera komunikaty MSZ i ostrzeżenia Odyseusza,
komunikaty i raport dobowy RCB, ostrzeżenia RSO i GIS oraz aktualności KG PSP, MON, MSWiA, Ministerstwa Infrastruktury,
PAA i KPRM. Dobór kanału zależy od instytucji, tematu lub regionu wskazanych w pytaniu. Rekordy z datą, odnośnikiem i fragmentem
trafiają do `live_snapshots`. [Oficjalne ostrzeżenia RSO](https://www.gov.pl/web/gov/ostrzezenia), [Raport dobowy RCB](https://www.gov.pl/web/rcb/raport-dobowy3), [Zasady doboru kanałów](TOOLS.md#1a-oficjalne-kanały-instytucji-gałąź-official--weryfikacja-u-źródła-i-triangulacja)

Historyczny komunikat Odyseusza o Włoszech ma osobny, datowany wyciąg do audytu. Dnia 22 listopada 2026 r. publiczne API MSZ zwróciło profil IT z 19 listopada w wersji 30, o identyfikatorze 1439. Obie części cytatu znaleziono w polu `trescPowiadomieniaDluga`. Zapis obejmuje wydawcę, oba adresy, daty, skrót SHA-256 odpowiedzi oraz 275 znaków wyciągu z oznaczeniem pominięcia. `npm run corpus:verify` porównuje rekord z tym materiałem bez dostępu do sieci. Polecenie `node --import tsx src/corpus/odyseusz-evidence.ts msz-odyseusz:8594d348c094` ponawia porównanie z publicznym API i sygnalizuje zmianę wersji. [Zapisany wyciąg](../data/source-excerpts/msz-odyseusz/8594d348c094.json) · [Publiczne API profilu Włoch](https://odyseusz.gov.pl/api/v1/informacje/profile-panstw/IT)

**Migawki wyszukiwania na żywo (`live_snapshots`).** `createCorpusStore(db).get/getMany` dla identyfikatorów zaczynających się od
`live:` czyta awaryjnie tabelę `live_snapshots(id, run_id, record_json, created_at, expires_at)` (poza migawką korpusu): wiersze po
`expires_at` są ignorowane (ISO-8601, `RRRR-MM-DD GG:MM:SS` jako UTC lub epoka), brak tabeli, uszkodzony JSON albo rekord niezgodny
ze schematem to „brak rekordu”, a zwrócony rekord ma `id` wiersza i `origin: "live_snapshot"`. `count()` i `snapshotId()` dotyczą
wyłącznie korpusu.

## 14. Oszacowania, sondaże i kolejne wydania danych

Kolekcję buduje `npm run corpus:build -- --only research-estimates`. Zawiera fragmenty komunikatów i raportów Straży Granicznej, CBOS, UNHCR, Eurostatu, KSE Institute, IISS, SIPRI, MON i KRRiT oraz deklaracje organizatora Marszu Niepodległości. Każdy rekord odsyła do materiału, z którego pochodzi. W rekordzie KRRiT szacunek policji jest wyraźnie przypisany w cytacie. Stowarzyszenie ma poziom 3, a oba jego komunikaty należą do jednej grupy niezależności. Datę wydarzenia i datę publikacji zapisujemy oddzielnie.

Dla Polski i wszystkich jej lądowych sąsiadów importer odczytuje trzy ostatnie dostępne kolumny roczne z arkusza `Share of GDP` wydania SIPRI 1949–2025 v1.2. Wybiera wiersz po nazwie państwa i kolumnę po roku. Mnoży zapisany ułamek przez 100 i prezentuje wynik z dokładnością do pięciu miejsc po przecinku. Tag `generated-from-data` oznacza zdanie utworzone z pól arkusza. Komunikat z 2025 r. i późniejszy odczyt za ten sam rok zachowują oddzielne daty publikacji oraz tę samą grupę niezależności. Przy komunikacie oznaczono datę udokumentowanej rewizji. Użycie danych SIPRI do celów komercyjnych wymaga licencji wydawcy. [Metodologia i warunki SIPRI](https://www.sipri.org/databases/milex)

`npm run corpus:verify -- --only research-estimates` porównuje cytaty z zachowanymi odpowiedziami HTML/PDF i odtwarza wartości liczbowe z zachowanego pliku XLSX. Do ekstrakcji służą `pdftotext` i biblioteka standardowa Pythona 3. Jeśli podczas przebudowy nie można już odczytać wymaganego ustępu lub zmieni się edycja opisana na stronie organizatora, proces zapisze błąd kolekcji w `data/corpus-report.json` i zachowa poprzedni plik wynikowy.
