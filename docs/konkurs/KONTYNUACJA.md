# Fons — końcowy odbiór silnika i scenariuszy konkursowych

**22 listopada 2026 r.** Na 100 stałych tekstach wydanie uzyskało **64/100** odpowiedzi zgodnych z kluczem projektu. Macro-F1 na jawnej części wyniosło **0,653** przy celu **0,75**. Mediana odpowiedzi silnika wyniosła **15,06 s** przy limicie 30 s. Silnik nadaje się do demonstracji z możliwością przeczytania źródeł i przekazania trudnej sprawy moderatorowi. Brakujące rozstrzygnięcia oraz jakość uzasadnień ograniczają jego przydatność w samodzielnej obsłudze obywateli.

[Pakiet z kodem dokładnie testowanego wydania, pełnymi odpowiedziami i instrukcją odtworzenia](../../eval/results/msz-odbior-koncowy-2026-11-22.zip) · [Prezentacja](prezentacja.pdf) · [Film, 42 s](demo.mp4) · [Pierwszy odbiór po naprawach](WYNIKI.md)

## Ten sam klucz w kolejnych wersjach

| Pełna seria | Zgodność | F1 dev | F1 heldout | F1 heldout-v2 | F1 łącznie, 89 tez | Mediana | Koszt 100 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Pierwszy audyt | 58/100 | 0,573 | 0,583 | 0,554 | — | 15,89 s | 6,04 USD |
| Wcześniejsze wydanie v24 | 69/100 | 0,719 | 0,525 | 0,588 | — | 16,53 s | 3,90 USD |
| Porównywalny pełny pomiar v29 | 72/100 | 0,700 | 0,634 | 0,640 | 0,666 | 16,96 s | 3,68 USD |
| Pierwsza pełna seria tej rundy, v31 | 70/100 | 0,736 | 0,623 | 0,592 | 0,665 | 15,48 s | 3,76 USD |
| Ostatnie wydanie | 64/100 | 0,653 | 0,531 | 0,604 | 0,613 | 15,06 s | 3,70 USD |

Użyto 38 wejść dev, 21 heldout i 41 heldout-v2, w tym łącznie 11 pytań otwartych. Nazwy zbiorów pochodzą z repozytorium. Ich treść była dostępna autorom poprawek. Wcześniej przygotowane przykłady DOCX także mają w części specjalnie uzupełnioną bibliografię. Oczekiwane zachowania sześciu dodatkowych pytań i późniejszych czterech pytań zapisano przed ich odpowiednimi przebiegami. Dostęp do zestawu jury i niezależna ocena eksperta pozostają osobnymi warunkami odbioru.

Wersja końcowa to `engine-2026.11.22-32-registers-and-dates`, SHA-256 katalogu `src/` to `d36d1b97e37fa650a48e5f0b665906cc2d0833b238be9df2201e1d19ae7abcf9`, a identyfikator korpusu to `98c4f29a544289072d7037ece970708a6424b3662f8ce9898dd1a9ff85e2d717`. Obie pełne serie użyły manifestu `17fda7673b7516d2e5eb2fbf745cce549c9300f9c22b14c56f0eefac2b426928`. Prawdziwe wywołania modeli OpenAI gpt-6.2-sol i gpt-6-luna, lokalny E5 i silnik produkcyjny przedstawiono w telemetrycznych zapisach poszczególnych odpowiedzi. Każde wejście przekazano bez etykiety. Wszystkie zakończone pomiary tej rundy są w pakiecie. Powtórzenie przy tych samych pytaniach może dać inny wynik.

### Skąd spadek z 70 do 64

Na tych samych wejściach w obu seriach 59 odpowiedzi spełniło klucz i 25 go nie spełniło. Pięć poprzednich błędów przeszło w poprawną odpowiedź. Jedenaście wcześniejszych trafień przestało spełniać klucz, w dziewięciu z nich Fons wstrzymał werdykt. Przykładem jest zdanie o trzech państwach bałtyckich, które przystąpiły do NATO w 2004 r. Poprawiły się proste odpowiedzi o członkostwie Białorusi w UE i NATO. Zmiany w kodzie, dobór fragmentów i wyniki wywołań modeli wystąpiły w tym samym porównaniu. Same dwie serie nie pozwalają podzielić różnicy na wpływ każdego z tych czynników. Szczegółowy wykaz spraw zapisano w pakiecie w pliku `dowody/roznice.md`.

## Mierniki MSZ

| Miernik | Wynik i zakres |
|---|---|
| Trafność pięciu klas | Macro-F1 0,613 łącznie, 0,653 w jawnej części. Warunki odpowiedzi otwartych spełniło 11/11. |
| Pokrycie cytowaniami ≥95% | 53/53 rozstrzygniętych tez faktograficznych miało dowód. Ta definicja wyłącza abstencje. |
| Trafność znaczeniowa cytowania ≥85% | Automat odnalazł 120/120 sprawdzanych fragmentów w rekordach. Poniżej podano również recenzję sensu pierwszego i pełnego zestawu dowodów. |
| Właściwe wstrzymanie ≥80% | 5/7 dla spraw z etykietą BRAK_DOWODOW. Dodatkowo silnik wstrzymał 24/72 spraw z oczekiwanym rozstrzygnięciem. Siedem etykiet „konflikt” szczegółowo zweryfikowano ze źródłami. |
| Mediana tekstu/URL ≤30 s | Mediana silnika 15,06 s, p95 22,09 s i maksimum 35,67 s. Mediana 12 podstawowych prób tekst/URL przez WWW 11,37 s. |
| Koszt | Telemetria 3,701326 USD/100. Przy takim samym ruchu i cenach około 37,01 USD/1000. Kwoty obejmują wycenione wywołania w serii tekstowej. Hosting, operator wiadomości i odrębne próby multimedialne wymagają oddzielnego rozliczenia. |
| Automatyczna ścieżka | 100/100 uruchomień serii zwróciło raport. W 21/21 przebiegach WWW odczytano ten sam zapisany raport. Scenariusze awaryjne mają własny oczekiwany status. |
| Spójność kanałów | Porównanie G przez WWW oraz lokalny podpisany webhook ChatLoom zawiera ocenę i uporządkowane adresy dowodów. Pola `sameVerdict` i `sameSources` wyniosły true i true. Adapter użył wspólnego cache. Dostawa SMS lub WhatsApp na urządzenie pozostaje do potwierdzenia. |
| Odporność na instrukcje w źródle ≥90% | Załącznik zawiera placeholder kontrolowanego URL. Wykonano neutralną kontrolę E. Bieżący procent odporności end-to-end pozostaje nieustalony. Historyczne sprawdzenia i ich ograniczenia opisuje wcześniejszy odbiór. |

### Czy cytat rzeczywiście wystarczył

Na tych samych dziesięciu tezach dwukrotnie przeczytano tekst odpowiedzi, dowody, tytuły i daty. W pierwszej serii tej rundy pierwszy fragment uzasadniał odpowiedź w 6/10 przypadków, w ostatniej w 7/10. Rozpatrzenie wszystkich pokazanych fragmentów dało te same liczniki. W obu seriach silnik rozstrzygnął 8 spraw. Wśród tych ośmiu odpowiedzi podpartych cytatem wynik wzrósł z 6/8 do **7/8**. W całej dziesiątce 8/10 werdyktów ostatniej wersji zgodziło się z kluczem. Dla polskiej akcesji do UE raport zaczął pokazywać 1 maja 2004 r. W pytaniu o lato cytat wskazał jedynie czerwiec, a w dwóch sprawach raport pozostał bez dowodu. To recenzja asystenta AI na małej celowej próbie. Potwierdzenie konkursowego progu 85% wymaga szerszej, niezależnej oceny redakcyjnej.

### Pytania dodatkowe i priorytet napraw

| Próba przez WWW | Wynik |
|---|---|
| Sześć pytań ze spisanym z góry kryterium, pierwszy kontakt | 5/6 zachowań poprawnych. W pytaniu o Estonię i Łotwę raport zawierał daty obu akcesji do strefy euro, ale silnik wstrzymał ocenę. |
| Powtórzenie tych samych sześciu po poprawkach | 6/6. Odpowiedzi na pięć pytań faktograficznych miały wystarczające dowody. Przy anonimowym pytaniu o przystanek silnik się wstrzymał. W przypadku K2 i K3 autorzy widzieli wcześniejszy błąd przy poprawianiu kodu. |
| Cztery dalsze pytania z ustalonym wcześniej kluczem | 3/4. Prawidłowe były oba porównania krajów i wstrzymanie przy nieokreślonym urzędzie. Przy niemieckiej marce silnik znalazł źródło o roku wejścia do strefy euro. Do ustalenia dnia wymiany gotówki zabrakło osobnej podstawy. |

W kolejnej iteracji największą wartość ma dobranie źródła do dokładnego zdarzenia z pytania. W odpowiedzi o walucie trzeba sprawdzać, czy obywatel pyta o rozliczenia, czy o gotówkę. W pytaniu o półrocze prezydencji potrzebna jest publikacja z zakresem dat. Warto też wielokrotnie przepuścić stałe pytania i porównać, które źródła utraciły głos przy tych samych danych. Dla nowszej wersji rozbieżność etykiet między przebiegami i puste podstawy niektórych abstencji mają większe znaczenie użytkowe niż kolejny wzrost liczby testów jednostkowych.

## Rzeczywiste źródła i rozbieżności

Korpus ma 3852 rekordów z 43 hostów, w tym 2453 źródeł pierwotnych, 934 weryfikacji i 465 analiz. Katalog incydentów ma 604 wpisów. W podstawowym audycie porównano 1778 rekordów, poza jego zakresem znalazły się 2074, zgłoszono 0 niezgodności. Osobne kontrole objęły listy państw i rewizje szacunków, feed ClaimReview oraz zestawienie EUvsDisinfo. Dla pięciu dodatkowych fragmentów publikacji Demagoga brakowało lokalnej kopii HTML do porównania. Audyt GUS i NBP porównał 46 i 94 rekordy ze źródłowymi CSV/XML. Niezależny przelicznik potwierdził 538 miesięcznych danych CPI i 96 pozycji NBP. (Liczba źródłowych obserwacji różni się od liczby zbiorczych rekordów wyszukiwania.)

W pierwotnym kluczu siedem spraw oczekuje pokazania sprzecznych źródeł. W tej serii dwie przeciwstawne podstawy wyświetlono w **0/7**. Wartość zachowuje definicję starego klucza. W przeglądzie siedmiu przykładów nie znaleźliśmy aktualnej pary wiarygodnych szacunków o dokładnie tym samym obiekcie, okresie i definicji, po przeciwnych stronach danego progu. W C01 komunikat SG wręcz potwierdza tezę o liczbie prób przekroczenia granicy w 2023 r. W V2-C03 budżetowy plan i późniejsze wykonanie są różnymi wielkościami. Pełny przegląd wraz z datami i adresami znajduje się w pakiecie w `dowody/zrodla/ocena.md`. [Komunikat Straży Granicznej](https://www.strazgraniczna.pl/pl/aktualnosci/12829,Miniona-doba-bez-prob-nielegalnego-przekroczenia.html)

W dwóch osobnych kontrolach pozytywnych czat pokazał oba źródła i ich fragmenty. Dla stanu publikacji w kwietniu 2025 r. zestawił 7,1% SIPRI z 6,7% IISS dla rosyjskich wydatków w 2024 r. Przy pytaniu bez daty odcięcia odczytał późniejszą rewizję SIPRI na około 6,87%. W drugim sporze o warszawski marsz porównał szacunek organizatora z szacunkiem policji przytoczonym przez KRRiT. Chrome wyświetlił właściwy cytat i odsyłacz w każdej z czterech kolumn. Silnik wymaga zgodności okresu i jednostki, datuje rewizje publikacji i w krótkiej odpowiedzi przedstawia obie strony. [Publikacja SIPRI z kwietnia 2025 r.](https://www.sipri.org/publications/2025/sipri-fact-sheets/trends-world-military-expenditure-2024) · [Szacunek IISS](https://www.iiss.org/publications/the-military-balance/2025/dr-bastian-giegerichs-launch-event-remarks/) · [Zaktualizowany zbiór SIPRI](https://www.sipri.org/sites/default/files/SIPRI-Milex-data-1949-2025_v1.2.xlsx)

## Przejście przez scenariusze z DOCX

| Scenariusz | Wynik przez WWW w wydaniu końcowym |
|---|---|
| A1, A2 — depesza PAP i strajk we Włoszech | Przy PAP odpowiedź opisała przywrócenie depeszy bez zmian i stały dostęp odbiorców serwisu. Podała nagłówek i datę. Przy strajku odpowiedziała na podstawie włoskiej relacji z 20 listopada. W dodatkowym wariancie z ANSA odpowiedziała na obie części i przypisała szacunki do CGIL. |
| B — datowanie filmu | Recenzja Demagoga pozwoliła odróżnić nagranie z marca 2021 r. od rzekomego protestu z 2026 r. Wynik dotyczy identyfikacji wcześniej sprawdzonego materiału. |
| C — budżet transportu Wrocławia | Odpowiedź wyjaśniła czyj to szacunek 700 mln zł, czego dotyczyło około 650 mln zł w 2023 r. i jak Demagog ocenił całą wypowiedź. Raport odróżnił zakres, rok i dzisiejszy stan. |
| D, H — bilety i ograniczenia w Pcimiu | D wskazało potrzebę regulaminu sprzedaży lub komunikatu organizatora. Dwie wersje H wskazały potrzebę uchwały, granic strefy i daty. W bazie dla H zapisano jedną sprawę z dwoma nadawcami. Stan powiadomienia oznaczał rekomendację pilnego sprawdzenia. |
| E — strona kontrolowana | Publiczny neutralny link dał prawidłową odpowiedź bez alarmu o instrukcji w treści. Właściwy kontrolowany URL nie znalazł się w załączniku. |
| F — obraz | Na rzeczywistym wycinku publikacji odczytano tezę i widoczną datę 15.09.2024. Odpowiedź przypisała weryfikację Demagogowi i oddzieliła datę na obrazie od daty opublikowania wpisu. W transkrypcji obrazu zostały zbędne cudzysłowy. |
| G — kolejny kanał | Ten sam tekst dotyczący bezpłatnej komunikacji dał tę samą ocenę i publikację przez WWW i rzeczywisty lokalny adapter wiadomości. |
| I — dopasowanie konkretnej publikacji | Silnik prawidłowo rozróżnił dwie depesze PAP z różnymi nagłówkami i datami oraz odnalazł bezpośredni adres wpisu na X w publikacji recenzenta. |
| J — dostępność dostawców | Z działającym indeksem podał publikację i ocenę Demagoga. Po odłączeniu konfiguracji indeksu i w osobnym wariancie OCR zgłosił status NIEPEŁNE oraz przyczynę. Raporty opisują te konkretne warunki awarii. |

**Poza przykładami z załącznika.** Publiczne nagranie zostało przepisane po polsku zgodnie z tekstem źródłowym. Przy fotografii Blue Marble otrzymano jedno lokalne dopasowanie do materiału NASA oraz 20 dopasowań sieciowych. Publiczny zrzut i MP3 wraz z pochodzeniem są w katalogu `wejscia/` pakietu. [Oryginalna publikacja NASA](https://www.nasa.gov/image-article/blue-marble-image-of-earth-from-apollo-17/)

**Dwie tezy w jednej wiadomości.** W dodatkowej próbie o Szwecji i Finlandii v31 prawidłowo wskazał odpowiednio potwierdzenie i fałsz. Pierwszy końcowy przebieg wstrzymał ocenę Szwecji i odrzucił tezę o Finlandii. Poprawka prezentacji pokazuje wynik każdej części również przy takiej mieszance. Na dokładnie tym samym zapisanym raporcie wyświetlono obie oceny. W nowym przebiegu przez WWW silnik rozdzielił obie tezy, zwrócił poprawne „tak” i „nie” oraz odczytano ten sam raport. To przykład zmienności ekstrakcji i wyszukiwania, widoczny również po poprawkach. W A22 zabrakło podstawy do werdyktu o obecnej obecności wojska na froncie.

## Wymagania dodatkowe i formalne

- **Archiwum i eksport.** Na czystej instancji zapisano dwa rzeczywiste fragmenty Eurostatu i GUS, sprawdzono ich zgodność i siedmiodniowe terminy retencji. Administrator pobrał CSV, JSON i STIX 2.1. Eksport STIX zawierał 595 obiektów URL oraz 1 notatkę. Po usunięciu własnej sesji próby poprzedni raport zwrócił HTTP 404. Eksport nie potwierdza importu do zewnętrznej instancji OpenCTI. Tabela DISARM obejmuje przypisane techniki dla konkretnych incydentów.
- **Katalog, języki i dostawcy.** Edytowalny katalog, identyfikatory niezależnych wydawców, daty oraz zasady aktualizacji opisuje dokumentacja. Fons korzysta z lokalnego korpusu i E5. W tej demonstracji weryfikację językową zapewniały dwa modele tego samego zewnętrznego dostawcy. Przetwarzanie wyłącznie w EOG pozostaje niepotwierdzone. Przy wyczerpaniu dziennego budżetu silnik pokazał osobne ostrzeżenie i oparł odpowiedź o składzie Sejmu na Konstytucji. W pełnej serii tekstowej ten komunikat wystąpił w 0/100 raportów. [Katalog i warunki wykorzystania](../SOURCES.md)
- **Technika.** Końcowy TypeScript i build przeszły. Regresja projektu z włączonym rzeczywistym modelem E5 wyniosła 1754/1754. Istniejące testy izolowane komponentów uwzględniają duble testowe. Wyniki merytoryczne wyżej pochodzą z rzeczywistego produktu. Astryx Doctor zgłosił 25 zaliczonych kontroli i 0 błędów. Budowa Vite ostrzega o wielkości głównego pakietu.
- **Materiały do zgłoszenia.** Film trwa 42,08 s, prezentacja ma 7 slajdów, a opis mieści się w limicie 4000 znaków. Przyjęta w materiałach nazwa zespołu to Fons. Kod i materiały dostarczono lokalnie. W trakcie kontroli katalogu konkursowego brakowało na głównej gałęzi prywatnego repozytorium. Dla odbioru przez jury potrzebny jest faktycznie dostępny link do filmu i kodu. [Opis i instrukcja](../OPIS.md)

Archiwum zawiera dokładny kod i dane ostatniego pomiaru oraz różnice potrzebne do odtworzenia poprzedniej serii tej rundy. Wspólny katalog roboczy był równolegle modyfikowany. Po ostatnim pomiarze zmienił się jeden z 383 plików źródłowych. Dotyczył wyświetlania odpowiedzi złożonej w czacie. Wszystkie 113 plików w grafie zależności pomiaru silnika mają identyczne skróty. Obie wersje pliku, sprawdzenie grafu, powtórny odczyt 100 zapisanych raportów i rzeczywisty test czatu są w pakiecie, wraz z dziennikami pełnej regresji po poprawce.
