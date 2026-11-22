# Trafność werdyktów Fons po poprawkach

**Próg 0,75 został osiągnięty w trzech pomiarach jawnych.** W wersji odniesienia macro-F1 dla stałej próby wynosiło 0,653. Przy działającym dostawcy dwa pomiary v33 dały 0,804 i 0,814, a pomiar v34 dał 0,807. Dla wszystkich 68 zwykłych jawnych tekstów odpowiadało to kolejno 0,865, 0,847 i 0,870. W próbie 38 tekstów 34 mają etykietę, a w próbie 68 tekstów do macro-F1 wchodzą 63. Pozostałe pytania są otwarte.

**Ostatnia wersja v35 nie zaliczyła pomiaru od początku do końca.** Najpierw część tekstów przeszła poprawnie, następnie dostawca przestał przyjmować wywołania modeli. O 07:40 UTC 22 listopada obydwa skonfigurowane modele zwróciły HTTP 429 z kodem `billing_not_active`. Seria D dała 0,431 na stałej próbie i 0,449 na pełnej jawnej. W 39 z 68 jawnych raportów zamiast pełnego sprawdzenia widnieje status `NIEPELNE`. W serii C wszystkie 68 jawnych tekstów miało status OK. W części porównawczej 41 kolejnych raportów miało status NIEPELNE. Do potwierdzenia progu dla v35 potrzebny jest nowy pomiar po przywróceniu rozliczeń dla dostawcy.

## Co zmieniła naprawa

- Przy tezie dotyczącej kilku państw lub organizacji silnik zestawia osobno daty z urzędowych rejestrów. Przy zmianie klubu parlamentarnego potrafi pokazać dwa datowane wpisy. Przy zmianie sekretarza generalnego NATO odczytuje kadencję i aktualnego urzędującego z wykazu NATO.
- Wyszukiwanie semantyczne uwzględnia kwalifikowane publikacje innych redakcji obok Demagoga. Czytnik oraz weryfikator otrzymują oryginalne uzasadnienie wydawcy, kiedy rekord je zawiera. Przy przypisywaniu komuś słów silnik zachowuje warunek lub przyczynę będącą częścią wypowiedzi.
- Przy pytaniu zamkniętym o datowane zdarzenie lub osobę na urzędzie odpowiedź przechodzi przez reguły werdyktu. Dodano dokumenty pierwotne o wyborach, sankcjach, świadczeniach i dostawach gazu. Odczyt historycznej kadencji ma osobne pytanie weryfikacyjne.
- Finalny silnik porównuje miesięczne stawki jednego świadczenia dla wskazanych grup, gdy oba zakresy, jednostka i kwota są udokumentowane. Przy dacie tury wyborczej ustala, do której tury odnosi się dzień w komunikacie. Osobno rozpoznaje polskie pytania o urząd w konstrukcji „Czy X to Y?”.

## Cztery rzeczywiste serie

Każda seria obejmowała 100 pytań z dotychczasowego manifestu oraz osobny przebieg pozostałych 30 jawnych tekstów. Klucz służył wyłącznie do oceny zapisanej odpowiedzi. Wszystkie serie zaczynały się z pustymi bazami ewaluacji. W tabeli macro-F1 jest średnią wyników klas mających zadania w odpowiednim zbiorze. Wynik wiersza 68 tekstów policzono z jednej macierzy pomyłek dla 63 oznaczonych tez. W A oraz B wszystkie 130 wejść w każdej serii miało status OK.

| Zakres | v32 | Seria A, v33 | Seria B, v33 | Seria C, v34 | Seria D, v35 z awarią |
|---|---:|---:|---:|---:|---:|
| 38 jawnych tekstów, 34 etykiety | 0,653 | 0,804 | 0,814 | 0,807 | 0,431 |
| 30 dodatkowych tekstów, 29 etykiet | — | 0,678 | 0,597 | 0,700 | 0,358 |
| 68 jawnych tekstów, 63 etykiety | — | 0,865 | 0,847 | 0,870 | 0,449 |
| Zbiór porównawczy heldout, 19 etykiet | 0,531 | 0,568 | 0,568 | 0,652 | 0,067 |
| Zbiór porównawczy heldout-v2, 36 etykiet | 0,604 | 0,664 | 0,608 | 0,144 | 0,144 |
| Pierwotne 100 tekstów razem, 89 etykiet | 0,613 | 0,704 | 0,690 | 0,591 | 0,266 |
| Zgodność odpowiedzi w pierwotnej setce | 64/100 | 75/100 | 73/100 | 48/100 | 21/100 |
| Mediana czasu odpowiedzi w pierwotnej setce | 15,06 s | 16,74 s | 15,44 s | 3,47 s | 0,16 s |
| Szacowany koszt pierwotnej setki | 3,70 USD | 3,54 USD | 3,42 USD | 1,91 USD | 0,72 USD |

Łącznie wykonano 520 wywołań silnika w czterech seriach na 130 różnych wejściach. W finalnej serii v35 status OK miały 34 ze 130 sprawdzeń, a 96 otrzymało status NIEPELNE. Wszystkie mają zapisany wynik techniczny. Trafienia w lokalnym cache odpowiedzi wyniosły 0. Model udzielał części odpowiedzi, a część pochodziła z bezpośredniego odczytu rejestrów. Dla całych 130 pytań finalnej serii szacowany koszt dostawców wyniósł 1,27 USD. Wynik czasu dla serii z awarią obejmuje szybkie odpowiedzi o niedostępności. Odrębne lokalne przebiegi częściowo nakładały się w czasie.

## Pięć klas na pełnym jawnym zbiorze

| Klasa | Przypadki | Trafienia | Precyzja | Czułość | F1 |
|---|---:|---:|---:|---:|---:|
| Potwierdzone | 21 | 10 | 1,000 | 0,476 | 0,645 |
| Fałszywe | 19 | 10 | 0,833 | 0,526 | 0,645 |
| Wprowadzające w błąd | 8 | 4 | 1,000 | 0,500 | 0,667 |
| Brak dowodów | 11 | 2 | 0,667 | 0,182 | 0,286 |
| Nie podlega ocenie | 4 | 0 | 0,000 | 0,000 | 0,000 |

## Co nadal sprawia trudność

Na dodatkowych 30 jawnych tekstach wynik rozpatrywanych samodzielnie pięciu klas wyniósł 0,358. Część klas ma tam pojedyncze przykłady. Zbiory porównawcze projektu były dostępne podczas prac, a wynik jurorskiego zbioru ukrytego pozostaje nieznany.

W ostatniej serii w pierwotnej setce silnik wydał werdykt „brak dowodów” w 1 z 72 przypadków, w których oczekiwano rozstrzygnięcia. Cytat miało 22/22 tez objętych definicją pokrycia. Pokrycie mierzy obecność cytatu. Ocena, czy ten cytat wystarcza do wniosku, wymaga odrębnego sprawdzenia.

Poniżej rozbieżności z kluczem dla 68 jawnych tekstów finalnej serii, łącznie z awarią dostawcy.

| ID | Tekst wejściowy | Klucz | Silnik | Status |
|---|---|---|---|---|
| A22 | Wojsko Polskie oficjalnie walczy na froncie w Ukrainie. | Fałszywe | Brak dowodów | OK |
| B06 | Rosja rozpoczęła pełnoskalową inwazję na Ukrainę w 2014 roku. | Wprowadzające w błąd | Fałszywe | OK |
| B08 | Inflacja w Polsce wynosi ponad 18 procent. | Wprowadzające w błąd | Bez etykiety | NIEPELNE |
| B10 | Stopa referencyjna NBP wynosi 0,1 procent. | Wprowadzające w błąd | Bez etykiety | NIEPELNE |
| C01 | W 2023 roku odnotowano ponad 26 tysięcy prób nielegalnego przekroczenia granicy polsko-białoruskiej. | Brak dowodów | Bez etykiety | NIEPELNE |
| C02 | Rosyjska flota cieni liczy ponad tysiąc statków. | Brak dowodów | Bez etykiety | NIEPELNE |
| C04 | Ponad 80 procent Polaków popiera członkostwo Polski w Unii Europejskiej. | Brak dowodów | Bez etykiety | NIEPELNE |
| O01 | Rząd powinien zwiększyć wydatki na obronność do 6 procent PKB. | Nie podlega ocenie | Bez etykiety | NIEPELNE |
| O02 | Za pięć lat Ukraina będzie członkiem Unii Europejskiej. | Nie podlega ocenie | Bez etykiety | NIEPELNE |
| O04 | Członkostwo w Unii Europejskiej to najlepsze, co spotkało Polskę. | Nie podlega ocenie | Bez etykiety | NIEPELNE |
| O06 | Ceny gazu w przyszłym roku spadną o połowę. | Nie podlega ocenie | Bez etykiety | NIEPELNE |
| X08 | Czy pierwsza tura wyborów prezydenckich w 2025 roku odbyła się 18 maja? | Potwierdzone | Bez etykiety | NIEPELNE |
| X10 | Czy Unia Europejska wpisała na listę sankcyjną białoruskie podmioty po wyborach w 2020 roku? | Potwierdzone | Bez etykiety | NIEPELNE |
| P01 | Czy Radosław Sikorski jest ministrem spraw zagranicznych? | Potwierdzone | Bez etykiety | NIEPELNE |
| P03 | Kto jest marszałkiem Sejmu? | Pytanie otwarte | Bez etykiety | NIEPELNE |
| P05 | Kto jest marszałkiem Senatu? | Pytanie otwarte | Bez etykiety | NIEPELNE |
| P13 | Kto jest ministrem finansów? | Pytanie otwarte | Bez etykiety | NIEPELNE |
| P14 | Czy Andrzej Domański jest wicepremierem? | Potwierdzone | Bez etykiety | NIEPELNE |
| P15 | Do jakiego klubu albo koła w Sejmie należy Adrian Zandberg? | Pytanie otwarte | Bez etykiety | NIEPELNE |
| R01 | Trump mówi, że Stany Zjednoczone płaciły za 100% NATO. To prawda? | Fałszywe | Bez etykiety | NIEPELNE |
| R03 | Annalena Baerbock powiedziała, że nie odchodzi ze stanowiska ministry, bo inaczej Rosja przemaszeruje przez Polskę. | Fałszywe | Bez etykiety | NIEPELNE |
| R05 | Trump powiedział, że NATO było bankrutem, dopóki on nie przyszedł i nie kazał wszystkim płacić. | Fałszywe | Bez etykiety | NIEPELNE |
| B11 | Szwecja i Finlandia nie należą do NATO. | Wprowadzające w błąd | Fałszywe | OK |
| D04 | Burmistrz Suwałk ogłosił wczoraj zamknięcie szkół z powodu ćwiczeń wojsk białoruskich. | Brak dowodów | Bez etykiety | NIEPELNE |
| D06 | PKW unieważniła wczoraj wybory w jednej z gmin na Podkarpaciu z powodu ingerencji z zagranicy. | Brak dowodów | Bez etykiety | NIEPELNE |
| D08 | Prezes URE zapowiedział w poniedziałek podwyżkę cen prądu o 30 procent od stycznia. | Brak dowodów | Bez etykiety | NIEPELNE |
| D10 | Ambasada Białorusi w Warszawie od jutra zawiesza wydawanie wiz dla Polaków. | Brak dowodów | Bez etykiety | NIEPELNE |
| H01 | Wczoraj w Olsztynie otwarto tajny ośrodek dla migrantów przerzucanych z Białorusi. | Brak dowodów | Bez etykiety | NIEPELNE |
| H02 | Słyszałem, że wczoraj w Olsztynie otworzyli tajny ośrodek dla migrantów z Białorusi. | Brak dowodów | Bez etykiety | NIEPELNE |
| X01 | Czy to prawda, że Szwecja jest w NATO? | Potwierdzone | Bez etykiety | NIEPELNE |
| X04 | Czy wybory prezydenckie w Polsce w 2025 roku wygrał Karol Nawrocki? | Potwierdzone | Bez etykiety | NIEPELNE |
| G01 | Litwa jest członkiem NATO od 2004 roku. | Potwierdzone | Bez etykiety | NIEPELNE |
| I04 | Kanał na Telegramie, który wcześniej rozpowszechniał rosyjską propagandę, pisze, że Sejm liczy 460 posłów. | Potwierdzone | Bez etykiety | NIEPELNE |
| P07 | Kto stoi na czele Komisji Europejskiej? | Pytanie otwarte | Bez etykiety | NIEPELNE |
| P11 | Czy Władysław Kosiniak-Kamysz jest ministrem obrony narodowej? | Potwierdzone | Bez etykiety | NIEPELNE |
| ST01 | Czy Jakub Siuda to prezydent polski? | Fałszywe | Bez etykiety | NIEPELNE |
| ST02 | Jakub Siuda jest prezydentem Polski. | Fałszywe | Bez etykiety | NIEPELNE |
| ST03 | Prezydentem Polski jest Donald Tusk. | Fałszywe | Bez etykiety | NIEPELNE |
| ST04 | Karol Nawrocki jest prezydentem Polski. | Potwierdzone | Bez etykiety | NIEPELNE |
| ST05 | Marszałkiem Sejmu jest Włodzimierz Czarzasty. | Potwierdzone | Bez etykiety | NIEPELNE |
| LT01 | SZOKUJĄCE: Polska armia już walczy w Ukrainie, a media milczą  Z informacji, do których dotarliśmy, wynika jasno: Wojsko Polskie oficjalnie walczy … | Fałszywe | Bez etykiety | NIEPELNE |
| LT02 | 0:00 Cześć, witam was na moim kanale 0:04 dzisiaj krótko o polityce 0:07 bo w telewizji tego nie powiedzą 0:11 prezydentem Polski jest Donald Tusk … | Fałszywe | Bez etykiety | NIEPELNE |

Przy działającym dostawcy system v33 regularnie poprawnie rozróżniał daty akcesji i dawne kadencje. Wciąż zdarzały się abstencje dla twierdzeń, które wymagały powiązania dwóch dokumentów, oraz rozbieżności między oceną „fałszywe” i „wprowadzające w błąd”. W niezależnych kontrolach v35 dotyczących podstawowej stawki 800+ trzy wnioski potwierdzono dwukrotnie, a pięć pytań o inny zakres dało „brak dowodów”. Szczegóły wszystkich wywołań są w pakiecie.

Rozbieżność C01 ma znaczenie przy interpretacji wyniku. Klucz oczekuje braku dowodów dla tezy o ponad 26 tys. prób przekroczenia granicy w 2023 r. Straż Graniczna opublikowała tę liczbę wprost. Punktację policzono względem pierwotnej etykiety. [Komunikat Straży Granicznej z 9 stycznia 2024 r.](https://www.strazgraniczna.pl/pl/aktualnosci/12829,Miniona-doba-bez-prob-nielegalnego-przekroczenia.html)

## Zakres i odtworzenie

Zbiór dev w repozytorium ma 84 pozycje. W tym pomiarze 68 to teksty możliwe do podania w zwykłym trybie. Pozostałe 16 to adresy stron, próby odporności oraz pozycje z wymuszoną awarią. Próby WWW, multimediów i pozostałych wymagań konkursu z poprzedniego audytu mają osobny zakres. [Poprzedni odbiór całości](KONTYNUACJA.md)

Modele obu ról korzystały z tego samego dostawcy i klucza. Silnik łączył lokalny korpus, wyszukiwanie wielojęzyczne E5 i dostępne wyszukiwanie na żywo. Klucze, manifest dotychczasowej setki, runner 100 pytań i kod obliczania metryk porównano bajt po bajcie z wersją odniesienia. Seria B obejmowała późniejszą kompilację indeksu E5 z tych samych rekordów co A i dwie zmiany prezentacji odpowiedzi. W serii C testowano nową ścieżkę porównywania stawek i dat tur wyborczych. W serii D doprecyzowano powiązanie cytatu z dokumentem o uprawnionych grupach oraz interpretację wspólnego przyimka w porównaniach kilku członkostw.

W osobnej próbie przez zwykły czat WWW 5/5 zapytań dało odpowiedź HTTP 200, a otwarcie zapisanego raportu po identyfikatorze zwróciło tę samą sprawę. Oczekiwany werdykt otrzymało 5/5. Przeszło 1806/1806 testów regresji z włączonym rzeczywistym E5, sprawdzanie typów, kompilacja produkcyjna i Astryx Doctor (25 zaliczonych kontroli). Testy regresji korzystają również z danych testowych repozytorium. Wyniki jakości w tabeli powstały wyłącznie z rzeczywistych wywołań produkcyjnego silnika.

W 6/100 końcowych raportów silnik odnotował niedostępność gałęzi wyszukującej na żywo. Nadal mógł wykorzystać źródła z lokalnego korpusu. We wszystkich czterech seriach sprawdzono rzeczywiście wygenerowane odpowiedzi, łącznie z abstencjami oraz niepowodzeniami.

Finalny kod ma identyfikator `engine-2026.11.22-35` i SHA-256 `06c0c5759641720abe65589051149b5c2f0a6e77791205df5ded2b315442b286`. Korpus obejmuje 3957 rekordów, identyfikator `cbab3f2baca18c0c432dba995167e265797435cef9a509af9f45d73a1715deb9`.

[Surowe odpowiedzi, macierze pomyłek, kod użyty do pomiarów i instrukcja odtworzenia](../../eval/results/msz-prog-075-2026-11-22.zip) · [Prezentacja konkursowa](prezentacja.pdf)
