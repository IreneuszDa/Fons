# Opis rozwiązania (wymagania formalne, sekcja 4)

**Zespół:** _[nazwa zespołu — do uzupełnienia przez zespół]_
**Tytuł:** Fons — sprawdź informację u źródła

**Opis (do 4 000 znaków):**

Fons to obywatelska usługa do szybkiego sprawdzania informacji po polsku. Obywatel wkleja zdanie, link albo zadaje pytanie („Czy Szwecja jest w NATO?”, „Kto jest ministrem spraw zagranicznych?”) i dostaje odpowiedź z dosłownym cytatem, linkiem i datą albo jeden z pięciu werdyktów: Potwierdzone, Fałszywe, Wprowadzające w błąd, Brak wystarczających dowodów, Nie podlega weryfikacji. Fons pomaga ocenić informację; nie jest automatycznym sędzią prawdy.

Jak działa: szybki model wydziela twierdzenia i rozpoznaje, czy to twierdzenie, pytanie tak/nie, czy pytanie otwarte. Wyszukiwanie hybrydowe (BM25 w SQLite FTS5 i lokalne wektory multilingual-e5-small) przeszukuje zamknięty, jawny katalog źródeł: akty prawne (API ELI Sejmu), API Sejmu, gov.pl, prezydent.pl, NATO, instytucje UE, Eurostat, EUvsDisinfo oraz fact-checki sygnatariuszy IFCN/EFCSN. Fact-checki Demagoga trafiają do korpusu wyłącznie przez Google Fact Check Tools API, bez łączenia się z serwisem Demagoga. Główny model ocenia tylko znalezione fragmenty. Kod sprawdza, że cytat występuje dosłownie w zapisanym rekordzie, a werdykt liczą jawne reguły w kodzie, nie model. Gdy źródła milczą, odpowiedź brzmi „Brak wystarczających dowodów” — bez odpowiadania z pamięci modelu.

Dla analityków MSZ: każde sprawdzenie to audytowalny raport (dowody, cytaty, modele, koszt, czas) z dziennikiem w łańcuchu hashy. Nierozstrzygnięte zgłoszenia trafiają do kolejki spraw moderatora z deduplikacją. Panel z rolami pokazuje metryki i eksporty, a serwer MCP pozwala podłączyć Fons do narzędzi analitycznych.

Kanały: czat WWW (od 360 px), demonstracyjny kanał SMS (symulator telefonu i podpisany webhook HMAC, bez operatora i bez opłat), CLI i MCP. Rdzeń i raport są wspólne, więc werdykt jest ten sam w każdym kanale.

Bezpieczeństwo i prywatność: deterministyczny detektor prompt injection na surowej treści (PL/EN/RU/UA, ukryty HTML, homoglify, zero-width, base64), treść niezaufana tylko w blokach z losowym ogranicznikiem, odpowiedzi modeli w schemacie JSON, niezależna kontrola cytatów, ochrona SSRF. PESEL, telefony, e-maile, IBAN i karty są maskowane przed modelem i logiem; nadawca jest pseudonimizowany; retencja 30/7 dni; „usuń moje dane” działa w czacie i przez API. Przetwarzanie u OpenAI odbywa się w USA (bez rezydencji danych w UE) i każdy raport to ujawnia.

Wyniki z prawdziwym modelem (21.11.2026, potok sprzed ostatnich poprawek): macro-F1 0,639 na dev i 0,586 na held-out (cel 0,75 — niespełniony; głównie fałszywe wstrzymania z luk w korpusie), pokrycie i poprawność cytatów 100%, poprawne wstrzymanie 100%, mediana czasu ok. 8 s, odporność na wstrzyknięcia 84% (najgorszy z 3, tylko podział dev; cel 90% — niespełniony), koszt ok. 11 USD za 1000 sprawdzeń tekstu. Słabe strony opisujemy jawnie w README: scenariusz „nieaktualne” (0/4), linki do stron dezinformacyjnych, sprzeczne źródła i ostrzeżenia o domenach incydentów nie zostały potwierdzone na prawdziwym modelu.

Dalsze kroki: komunikatory (WhatsApp, SMS operatora), wiadomości głosowe, dokumenty, pilotaż z wybraną komórką MSZ, profil przetwarzania tylko w UE.

---

- Prezentacja PDF (do 12 slajdów): _do dodania przez zespół (`docs/prezentacja.pdf`)_
- Film demonstracyjny (do 3 min): _link do dodania przez zespół_
- Repozytorium i instrukcja uruchomienia: [README](../README.md)
