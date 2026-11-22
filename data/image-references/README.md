# Lokalne porównywanie zdjęć

Fons porównuje każdy obraz przesłany do czatu z dwoma wzorcami. Porównanie działa także po wyłączeniu Google. Wzorce pochodzą z publicznych publikacji NASA. Obie fotografie przedstawiają Ziemię, mają różnych autorów lub załogi oraz różne kadry.

W czacie menu „Dodaj plik” → „Porównaj dwa obrazy” przyjmuje dwa pliki JPG, PNG lub WebP, po maksymalnie 5 MiB każdy. Drugi obraz można także dodać z podglądu pierwszego. W tym trybie porównanie odbywa się na serwerze Fons bez wysyłania plików do modelu ani Google. Wynik podaje rozmiar, wymiary i format każdego pliku. Algorytm rozróżnia zgodność bajtów, zgodność pikseli po uwzględnieniu orientacji i konwersji do 8-bitowego RGBA w sRGB, bliskie podobieństwo całego kadru oraz brak dopasowania. Różnice samych metadanych mogą zmienić plik przy zachowaniu tych samych pikseli.

Katalog fotografii ma własny rejestr publikacji i wzorców. Jego redaktor odpowiada za sprawdzenie praw do kopii, daty strony i integralności pliku według zasad poniżej. Wycofanie wpisu wymaga usunięcia rekordu i odpowiadającego mu wzorca. Źródła tekstowe Fons mają odrębny katalog i reguły kwalifikacji.

Przy wyszukiwaniu wcześniejszych publikacji pojedynczego zdjęcia skonfigurowane Google Cloud Vision może wskazać kolejne strony. Fons odczytuje maksymalnie trzy strony z katalogu źródeł i sprawdza obecność dokładnego adresu obrazu w HTML. Datę publikacji wyświetla, gdy strona podaje datę i zawiera dopasowany obraz. Redakcja może wymienić ilustrację po opublikowaniu strony.

| Wzorzec | Autor | Data publikacji wskazanej strony | Źródło |
| --- | --- | --- | --- |
| Blue Marble | NASA, załoga Apollo 17 | 30 listopada 2007 | [NASA](https://www.nasa.gov/image-article/blue-marble-image-of-earth-from-apollo-17/) |
| Earthrise | NASA, Bill Anders, Apollo 8 | 23 grudnia 2020 | [NASA](https://www.nasa.gov/image-article/apollo-8-earthrise/) |

Repozytorium zawiera pomniejszone kopie JPEG do analizy i demonstracji. Szczegóły dotyczące wykorzystania fotografii publikuje wydawca. [Zasady korzystania z mediów NASA](https://www.nasa.gov/nasa-brand-center/images-and-media/)

**Jak czytać wynik.** Etykieta „Identyczny plik” wymaga zgodności SHA-256 oryginalnego pliku wydawcy. Etykieta „Podobny obraz” oznacza bliską zgodność proporcji kadru oraz kolorów w siatce 16 × 16. Przeskalowanie i zwykła rekompresja mogą dać takie dopasowanie. Mocne kadrowanie może je uniemożliwić, a drobny retusz może pozostać niewykryty. Raport wskazuje datę konkretnej publikacji. Pierwsze wystąpienie w całym internecie, czas wykonania, autorstwo przesłanej kopii i prawdziwość podpisu wymagają odrębnych dowodów. Bajty i siatka kolorów przesłanego zdjęcia pozostają w pamięci podczas porównania.

**Utrzymanie katalogu.** Nowy rekord wymaga publicznej strony przypisującej zdjęcie autorowi, jawnej daty publikacji oraz warunków pozwalających na przechowanie wzorca. Redaktor sprawdza zgodność zdjęcia ze stroną, zapisuje jego wersję JPEG o szerokości 224 pikseli pod nazwą odpowiadającą polu `id` i dodaje pozycję w [catalog.json](catalog.json). Pola `sha256` i `referenceSha256` obejmują odpowiednio pobrany oryginał i pomniejszoną kopię. Przy korekcie opisu, zmianie pliku lub podstawy wykorzystania należy zweryfikować źródło, zaktualizować rekord albo usunąć go wraz z lokalną kopią i uruchomić ponownie serwer. Zmiana katalogu zmienia klucz pamięci podręcznej. Błąd integralności sygnalizuje niedostępność porównania.

**Próba przez WWW.** Wyślij jedną z fotografii z tego folderu z pytaniem „Gdzie wcześniej opublikowano to zdjęcie?”. Raport poda źródło i datę. Testy porównania i zapisu przez API uruchamia `npx vitest run src/server/conversation/image-references.test.ts`.

**Próba z usługami zewnętrznymi.** Po rozpakowaniu katalogu `dowody` z paczki audytu uruchom `node --import tsx eval/media-smoke.mjs /ścieżka/do/dowody /ścieżka/do/wynik.json`. Polecenie używa kluczy z konfiguracji Fons i obejmuje płatne wywołania dostawców. Weryfikuje sumy kontrolne trzech publicznych plików, przesyła je przez trasy aplikacji w odrębnej bazie w pamięci i odczytuje zapisane raporty. Wynik obejmuje dopasowanie do publikacji, OCR i transkrypcję z porównaniem do tekstu wzorcowego. [Pakiet z materiałami i atrybucją](../../eval/results/audyt-msz-2026-11-22.zip)
