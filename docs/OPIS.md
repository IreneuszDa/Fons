# Fons — sprawdź informację u źródła

**Zespół** Fons

Obywatel przesyła zdanie, pytanie, link lub zrzut ekranu. Fons odpowiada po polsku, pokazuje źródło i cytat. W raporcie można otworzyć publikację, sprawdzić jej datę i przeczytać uzasadnienie. Przy braku dowodów system wskazuje, czego należałoby szukać. W przypadku lokalnego zakazu wjazdu mogą to być uchwała gminy, mapa strefy oraz data wejścia przepisów w życie. Podobne nierozstrzygnięte zgłoszenia trafiają do jednej sprawy moderatora.

Czat WWW i adapter wiersza poleceń korzystają z tego samego silnika. Model wydziela tezy i przygotowuje zapytania. SQLite FTS5 i lokalny model wektorowy multilingual-e5-small przeszukują korpus. Wyszukiwanie sieciowe korzysta z jawnego katalogu źródeł. Obejmuje on m.in. akty prawne, komunikaty urzędów, dane statystyczne i publikacje organizacji fact-checkingowych. System odróżnia wypowiedź poddaną ocenie od ustalenia redakcji. Kod sprawdza obecność cytatu w rekordzie źródłowym. Osobne wywołanie modelu ocenia jego związek z tezą, a reguły przypisują jeden z pięciu werdyktów. Przy pytaniach otwartych aplikacja może podać odpowiedź z cytatem bez przypisywania etykiety.

W demonstracji wykorzystano OpenAI. Główny model to gpt-6.2-sol, a szybki gpt-6-luna. Oba korzystały z tego samego dostawcy. Zdjęcie można sprawdzić przez Google Vision, a nagranie poddać transkrypcji. Analityk ma dostęp do panelu z rolami, raportów, metryk, eksportów i narzędzi MCP. Prototyp zawiera również konektor ChatLoom/Matrix wymagający skonfigurowanego mostu.

Dosłowny cytat może dotyczyć innego zdarzenia. Modelowi zdarza się również przeoczyć odpowiedni dokument lub potraktować stary stan jako aktualny. Dobór wydawców i ograniczenie do katalogu wpływają na dostępność dowodów. Usługa zapisuje daty, ograniczenia wyszukiwania i pracę modeli. Tekst od użytkownika i z zewnętrznych stron przechodzi przez kontrole prywatności i instrukcji ukrytych w treści. Limity żądań ograniczają nadużycia. Usunięcie danych własnej sesji wymaga potwierdzenia. Dostępność zależy m.in. od konfiguracji dostawców i czytelności nadesłanego materiału.

[Film z rzeczywistego czatu, 42 s](konkurs/demo.mp4) · [Prezentacja, 7 slajdów](konkurs/prezentacja.pdf) · [Wyniki i ograniczenia](konkurs/KONTYNUACJA.md)

[Repozytorium](https://github.com/IreneuszDa/Fons) · [Instrukcja uruchomienia](../README.md) · [Kwalifikacja, licencje i aktualizacja źródeł](SOURCES.md) · [Metoda weryfikacji](METODA-WERYFIKACJI.md)
