# Plan wdrożenia i odbioru Fonsa

Podstawą są sekcje 3, 5, 6 i 8 zadania „Prawdowid”. Przyjmuję kolejność, w której najpierw trzeba móc bezpiecznie odpowiedzieć obywatelowi, potem odtworzyć tę odpowiedź, a następnie ocenić funkcje premiowane. Wariant demonstracyjny używa czatu WWW i adaptera SMS przez podpisany webhook ChatLoom. Współdzielą silnik, lecz zachowują osobne rozmowy.

| Etap | Co ma dostać użytkownik | Jak to odbieramy |
|---|---|---|
| 1. Tekst, link i kanały | Czat WWW działający na telefonie i komputerze. Adapter przyjmuje wiadomość, zwraca tekst do rozmówcy i zapisuje raport. | Próba przez `/api/chat`, podpisany webhook i odczyt `/api/report/:token`. Porównanie tezy, oceny i przypisanych jej cytatów. |
| 2. Zrozumienie pytania | Oddzielna ocena każdej tezy. Pytania o osobę, datę i liczbę dostają konkretną odpowiedź. Przy pytaniu „czy” zachowujemy negację, liczby i czas. | Kontrole pytania dodatniego i przeczącego, kilku tez, opinii oraz pytania otwartego. |
| 3. Wyszukanie podstawy | Przeszukanie korpusu źródeł urzędowych, analiz i weryfikacji redakcyjnych. Oryginalny cytat pozostaje w języku źródła. | Otworzyć publikację. Sprawdzić osobno dosłowność cytatu, autora wypowiedzi, datę i znaczenie fragmentu dla konkretnej tezy. |
| 4. Decyzja i odpowiedź | Krótkie „Tak”, „Nie” lub „Nie wiem”, a przy materiale mylącym wskazanie problemu. Jedno kliknięcie prowadzi do pełnego raportu z siłą podstawy i ograniczeniami. | Testy informacji sprzecznych, źródła częściowego, utraty negacji, zapowiedzi mylonej z faktem i błędu dostawcy. Ocena za samo pochodzenie domeny jest niedopuszczalna. |
| 5. Zapis i moderacja | Automatyczny zapis zamaskowanego pytania, czasu, wyniku i dokumentów. Powtórzona pogłoska może zasilić istniejącą sprawę. | Porównać raport z dziennikiem, sprawdzić łańcuch skrótów, dwóch różnych nadawców w jednej sprawie oraz zakres usuwania danych. |
| 6. Obraz i audio | OCR, transkrypcja, dostępne metadane i poświadczenia, porównanie obrazu z katalogiem oraz opcjonalne wyszukiwanie sieciowe. | Sprawdzić znany plik, zmienioną kopię i zdjęcie spoza katalogu. Powiązać każde trafienie z publikacją. Odróżnić datę publikacji, fotografii i przesłania pliku. |
| 7. Katalog, języki i rozszerzenia | Edytowalny katalog ze źródłem, licencją, warunkami aktualizacji i wykluczenia. Wymienne modele, wyszukiwarki i adaptery. | Sprawdzić odczyt źródła obcojęzycznego przy polskim pytaniu, działanie bez opcjonalnej usługi i neutralną prezentację dopasowania incydentu. |
| 8. Archiwum i eksport | Świadomy zapis licencjonowanego fragmentu z okresem retencji i możliwością usunięcia. Analityk może wyeksportować przebiegi i sprawy. | Sprawdzić zgodę, zakres licencji, izolację użytkowników, wygaśnięcie, odwołanie zapisu oraz strukturę CSV, JSON i STIX. |
| 9. Ocena przed pokazem | Wyniki z licznikami, mianownikami, pomyłkami, czasem i kosztami. | Uruchomić testy, build i Astryx Doctor. Osobno przeprowadzić próbę z rzeczywistymi dostawcami. Puste próby, awaria w obu kanałach i zgodne błędne odpowiedzi nie potwierdzają trafności. |

## Jak odtworzyć odbiór

1. Skonfiguruj projekt według README. Do pomiaru jakości odpowiedzi potrzebny jest działający dostawca modelu. Testy jednostkowe mają również konfiguracje deterministyczne.
2. Uruchom `npm test`, `npm run typecheck`, `npm run build` i `npx astryx doctor --built web-dist`. Dodatkowy audyt pobranych materiałów uruchamia `npm run corpus:verify` przy dostępnym cache źródeł.
3. Uruchom `npm run eval:acceptance`. Program przesyła stałą próbę 30 publicznych tekstów i adresów przez handlery HTTP aplikacji, po czym powtarza cztery pytania przez demonstracyjny most SMS. Używa osobnej bazy w pamięci i zapisuje wynik JSON w `eval/results`. Usługi zewnętrzne rozliczają rzeczywiste wykorzystanie. Trzy równoległe rozmowy i pierwsze uruchomienie indeksu wpływają na czas. Drugi kanał może odczytać wspólny cache, tak jak w aplikacji.
4. Otwórz zapisany raport i porównaj tezę z dokładnym fragmentem publikacji. W szczególności sprawdź przypadki, w których cytat jedynie przytacza ocenianą wypowiedź, zawiera inną liczbę albo pochodzi z innego okresu.
5. Porównaj wynik z pełnym zbiorem publicznym i przypadkami spoza próbki. Miarą przejścia do pilotażu są progi jakości z sekcji 6 specyfikacji, w tym macro-F1 ≥ 0,75, poprawność znaczenia cytatów ≥ 85% i mediana ≤ 30 s. Ocenę cytatów przez człowieka należy ewidencjonować osobno od sprawdzenia obecności ciągu znaków.

Próbę porównawczą 100 tekstów uruchamia `node --import tsx eval/real-text.mjs .cache/moj-pomiar`. Wynik zawiera manifest pytań, identyfikator korpusu, modele, skrót kodu, czasy, szacowane koszty i pełne odpowiedzi. Komenda wznawia serię w podanym katalogu po sprawdzeniu wersji. Do następnej wersji kodu użyj nowego katalogu. Przy trzech równoległych wywołaniach czas oczekiwania zależy także od dostawcy. [Wyniki i ocena według pięciu kryteriów jury](ODBIOR-SILNIKA.md)


### Odtworzenie wydania z 22 listopada

Pakiet pomiarowy zawiera pliki wykonywalne silnika w TypeScript, konfigurację projektu oraz migawkę rekordów i incydentów. Służy do porównania z bieżącym repozytorium. Konfigurację dostawców, zależności, opcjonalne indeksy, dane do porównania obrazów i pliki testowe pobiera się zgodnie z README. Każda seria zapisuje identyfikator wersji, migawki i skrót sprawdzanego kodu. Jeżeli dane w repozytorium są późniejsze, jako odniesienia użyj migawki i paczki przypisanej do konkretnej serii. [Pakiet kodu i korpusu wydania](../eval/results/kod-pomiaru-v31.zip)
