# Co pokazało 100 pytań w wersji v31

22 listopada 2026 r. Na tych samych 100 tekstach Fons spełnił warunki klucza w 70 przypadkach w wersji v31 i w 72 w wersji v29. W 64 przypadkach obie wersje spełniły warunki, a w 22 obie się z nimi rozminęły. Sześć odpowiedzi przeszło z wyniku błędnego według klucza na zgodny, osiem w przeciwną stronę. Korpus wzrósł z 3675 do 3850 rekordów. Oba przebiegi korzystały również z wyszukiwania na żywo. Porównanie mierzy zmianę całego rozwiązania w tych dwóch przebiegach. [Pełne odpowiedzi v29](teksty-100-v29.json.gz) · [Pełne odpowiedzi v31](teksty-100-v31.json.gz) · [Podsumowanie metryk v31](podsumowanie-v31.json)

### 1. Silnik miał odpowiedź w Konstytucji i wstrzymał się

W przypadku `heldout/A07` użytkownik podał, że kadencja Prezydenta RP trwa pięć lat. Obie wersje znalazły zdanie „Prezydent Rzeczypospolitej jest wybierany na pięcioletnią kadencję i może być ponownie wybrany tylko raz”. V29 potwierdziła twierdzenie. V31 pokazała ten przepis w raporcie i pominęła go przy wydawaniu werdyktu. Tutaj klucz ma oparcie w cytacie. Krótka odpowiedź na tak postawione pytanie brzmi **„Tak. Kadencja trwa pięć lat.”** Rekord `sejm-eli:d430f9bd90c8`. [Konstytucja RP, art. 127 ust. 2](https://api.sejm.gov.pl/eli/acts/DU/1997/483/text/U/D19970483Lj.pdf)

### 2. Zgodność z kluczem ukryła błąd w ocenie cytatu

W `dev/R05` użytkownik napisał, że Donald Trump mówił o rzekomym bankructwie NATO. Obie wersje oznaczyły całe zdanie jako fałszywe i dostały punkt. Zachowany wpis ClaimReview z 12 lutego 2024 r. wskazuje Donalda Trumpa jako autora wypowiedzi z 10 lutego. Wydawca nadał ocenę „False” twierdzeniu o NATO. Uzasadnił ocenę m.in. wzrostem wydatków sojuszników już przed objęciem urzędu przez Trumpa. Odpowiedź zgodna z tymi polami brzmi **„Tak, Trump tak powiedział. FactCheck.org uznał jego twierdzenie za fałszywe.”** Rekord `factcheck-org:10879ac6346a`, pola `itemReviewed.author.name`, `claimReviewed` i `reviewRating` w źródłowym feedzie. [Analiza FactCheck.org](https://www.factcheck.org/2024/02/trumps-distorted-nato-delinquent-comments/)

### 3. Klucz oczekiwał konfliktu mimo bezpośredniej odpowiedzi w źródle

W `dev/C01` chodziło o ponad 26 tys. prób nielegalnego przekroczenia granicy z Białorusi do Polski w 2023 r. Komenda Główna Straży Granicznej podała właśnie tę wielkość 9 stycznia 2024 r. V29 znalazła tę informację i wstrzymała się zgodnie z kluczem. V31 użyła komunikatu i straciła punkt. Materiały przeanalizowane dla tego przypadku nie zawierają odmiennej liczby porównywalnych prób za ten sam okres. Odpowiedź oparta na przytoczonej publikacji brzmi **„Tak. Straż Graniczna odnotowała ponad 26 tys. takich prób w 2023 r.”** Rekord `sg-pl:8868605f417d`. [Komunikat Straży Granicznej](https://www.strazgraniczna.pl/pl/aktualnosci/12829,Miniona-doba-bez-prob-nielegalnego-przekroczenia.html) · [Porównanie okresów i miar](comparison-c01-c02-2026-11-22.md)

Przykłady wybrał celowo asystent AI. Końcowe liczby oraz trzy przypadki sprawdzono w kompletnych zapisanych wynikach obu serii. Ustalenia wyjaśniają konkretne rozbieżności. Wskaźnik częstości takich błędów wymagałby osobnej recenzji reprezentatywnej próby.
