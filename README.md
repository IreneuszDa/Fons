<p align="center">
  <img src="docs/readme/hero.svg" alt="Fons — sprawdź informację u źródła" width="100%">
</p>

<p align="center">
  <b>Obywatelski fact-checker po polsku ze źródłami i uzasadnieniem.</b><br>
  Sprawdź informację w przeglądarce, na WhatsAppie przez most operatora lub z terminala. Otwórz źródło i przeczytaj fragment, który uzasadnia odpowiedź.
</p>

<p align="center">
  <img alt="HackNation 2026" src="https://img.shields.io/badge/HackNation-2026%20·%20zadanie%20MSZ-493734?style=for-the-badge">

  <img alt="MCP" src="https://img.shields.io/badge/MCP-serwer-7a5a4f?style=for-the-badge">
  <br>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-Node%2022-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black">
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite-FTS5%20%2B%20wektory-003B57?style=flat-square&logo=sqlite&logoColor=white">
  <img alt="Hono" src="https://img.shields.io/badge/Hono-API-E36002?style=flat-square&logo=hono&logoColor=white">

  <img alt="Licencja" src="https://img.shields.io/badge/licencja-ISC-lightgrey?style=flat-square">
</p>

<p align="center">
  <a href="#-czym-jest-fons">Czym jest</a> ·
  <a href="#kanały">Kanały</a> ·
  <a href="#-aplikacja-webowa">Aplikacja</a> ·
  <a href="#-co-potrafi">Funkcje</a> ·

  <a href="#-pod-maską">Technologia</a> ·
  <a href="#-wyniki">Wyniki</a> ·
  <a href="#-szybki-start">Start</a>
</p>

---

<p align="center">
  <a href="docs/konkurs/demo.mp4"><img src="docs/readme/screens/web-flow.gif" alt="Sprawdzenie informacji o przejazdach dla seniorów w czacie Fons. Kliknij, aby obejrzeć pełne nagranie." width="100%"></a>
</p>

## 🌊 Czym jest Fons

*Fons* to po łacinie „źródło”. Ta nazwa opisuje cały projekt.

Znasz to: ciocia przesyła na grupę rodzinną „PILNE!!! MSZ od jutra zakazuje wyjazdów do Niemiec, udostępnij, zanim usuną”. Albo kolega z pracy rzuca, że „inflacja znowu ma 18%”. Albo na TikToku krąży film, w którym ktoś pewnym głosem mówi rzeczy, które *brzmią* prawdziwie.

Na nagraniu obywatel pyta o darmową komunikację dla seniorów. Widać wyszukiwanie, odpowiedź po polsku, publikację Demagoga oraz odczyt zapisanego raportu. [Film z działania usługi](docs/konkurs/demo.mp4) · [Prezentacja](docs/konkurs/prezentacja.pdf)

Fons nie mówi „wierz mi”. Pokazuje cytat, wydawcę, datę i link, żebyś mógł sam to sprawdzić. **Gdy źródła milczą, mówi to wprost: „Brak wystarczających dowodów”.** Nie dopowiada niczego z pamięci modelu.

<table>
<tr>
<td width="50%" valign="top">

### 👵 Dla obywatela
- jedna rozmowa po polsku, prostym językiem
- w przeglądarce na komputerze i telefonie od 360 px
- wysyłasz tekst, link, zrzut ekranu, PDF, nagranie głosowe albo film z TikToka, Instagrama, Facebooka lub YouTube
- zamiast kolejnej opinii dostajesz **źródło, które sam otworzysz**
- możesz usunąć dane rozmowy, wpisując „usuń moje dane” i potwierdzając wybór

</td>
<td width="50%" valign="top">

### 🏛️ Dla analityka MSZ
- każde sprawdzenie to **audytowalny raport**: dowody, cytaty, modele, koszt, czas
- nierozstrzygnięte zgłoszenia trafiają do **kolejki spraw z deduplikacją**
- panel z rolami, metryki Prometheus, eksport spraw do CSV i JSON oraz katalogu incydentów do STIX 2.1 z mapowaniem DISARM
- **dziennik audytu w łańcuchu hashy** (manipulację widać od razu)
- **serwer MCP**, który podłącza Fons do narzędzi analitycznych i asystentów AI

</td>
</tr>
</table>

> Fons pomaga ocenić informację. Nie jest automatycznym sędzią prawdy. To nasza zasada projektowa, nie drobny druk.

---

## Kanały

### Fons na WhatsAppie

Na stronie `/telefon` przechodzisz przez trzy kroki. W ostatnim podajesz polski numer bez +48 lub zagraniczny z kodem kraju, wyrażasz zgodę i wybierasz **Poproś o wiadomość**. Formularz pokazuje, czy powitanie czeka w kolejce operatora, czy zostało już wysłane. W tej samej rozmowie możesz potem przesłać pytanie, twierdzenie lub link.

<details>
<summary>Zobacz trzy kroki zapisu na WhatsApp</summary>

<img src="docs/readme/screens/wa-flow.gif" alt="Przejście przez instrukcję, opis odpowiedzi ze źródłami i formularz numeru telefonu." width="500">

</details>

**Jak to działa technicznie:**

```text
WhatsApp → Beeper / ChatLoom (most Matrix) → POST /api/channels/chatloom/webhook → ten sam silnik co WWW
WhatsApp ← odpowiedź tekstowa i reakcja    ← akcje Matrix ze stałymi txn_id      ← wynik sprawdzenia
```

- **Podpis i czas.** Przy każdym żądaniu webhook sprawdza HMAC-SHA256 obejmujący znacznik czasu i treść. Dopuszczalna różnica czasu wynosi pięć minut.
- **Ponowienia.** Ponowna dostawa obsłużonego zdarzenia zwraca zapisaną odpowiedź i te same identyfikatory transakcji. Gdy serwer przerwie pracę, po wygaśnięciu dzierżawy może podjąć ponowioną dostawę. Odpowiedź tekstowa dociera także przez most bez obsługi reakcji.
- **Prywatność i zapis.** Serwer pseudonimizuje identyfikatory rozmów i nadawców z Matrixa. Formularz przekazuje numer i zgodę przez HTTPS do usługi zapisów operatora. To ona kolejkuje powitanie i zleca wysyłkę. Fons ogranicza liczbę prób zapisu z jednego IP.

<p align="center">
  <img src="docs/readme/screens/landing-wa.png" alt="Trzeci krok zapisu na WhatsApp w Fons. Formularz z polem numeru telefonu, zgodą na kontakt i przyciskiem „Poproś o wiadomość”." width="100%">
</p>

Do rozmowy na telefonie potrzebne są zalogowany klient operatora, działający most i wspólny sekret webhooka. Adres usługi zapisów można wskazać przez `WHATSAPP_SIGNUP_ORIGIN`. [Konfiguracja ChatLoom i zapisów](integrations/chatloom/README.md)

### Terminal i demonstracja SMS

Jury może sprawdzić adapter SMS bez zakładania konta i bez opłat operatora. Po konfiguracji modelu uruchom `npm run demo:sms -- "Czy Polska jest członkiem NATO?"`. Polecenie wysyła wiadomość demonstracyjną przez podpisany webhook ChatLoom, odbiera odpowiedź tekstową i zapisuje raport w tej samej bazie co WWW. Aby otworzyć link do raportu, uruchom też aplikację z tym samym `DB_PATH` i `PUBLIC_BASE_URL`. Wywołanie bez argumentów otwiera jedną rozmowę na standardowym wejściu. Każde uruchomienie rozpoczyna nową sesję. Koszt sprawdzenia przez model jest taki jak w WWW.

Czat WWW i adapter CLI prowadzą od pytania do zapisanego raportu. W teście tej samej tezy o przejazdach dla seniorów obie ścieżki wskazały tę samą publikację, ocenę i cytat. Narzędzia analityczne mogą pobierać raporty przez MCP.

## 🖥️ Aplikacja webowa

W **Historii czatów** możesz wrócić do wcześniejszej rozmowy lub ją usunąć. Podczas sprawdzania widzisz etapy pracy, a z odpowiedzi przechodzisz do pełnego raportu. Pytanie otwarte, np. o osobę pełniącą urząd, może dostać krótką odpowiedź z cytatem bez etykiety werdyktu.

W sekcji **Najnowsze sprawdzone wiadomości** otworzysz jedną z czterech ostatnich publikacji Fons. Artykuł wskazuje redakcję, która oceniła tezę, oraz źródła. Możesz zaznaczyć fragment, wybrać **Podkreśl** lub **Wyjaśnij w czacie**. Fons wyjaśnia zaznaczone słowa w kontekście artykułu. Na komputerze czytasz obok rozmowy, a na telefonie przełączasz się między artykułem i czatem.

W menu **Dodaj plik** wybierasz dokument lub zdjęcie, porównanie dwóch obrazów, film albo plik audio. Każdy tryb pokazuje obsługiwane formaty i przyjmuje pliki przeciągnięte do okna. Limit wynosi 5 MB na dokument lub obraz. Dla nagrań audio i wideo wynosi 20 MB i 10 minut.

W filmie można prześledzić całe sprawdzenie w Chrome. Pokaz trwa 42 sekundy. [Obejrzyj film](docs/konkurs/demo.mp4)

## ⚡ Co potrafi

<p align="center">
  <img src="docs/readme/verdicts.svg" alt="Pięć werdyktów Fons" width="100%">
</p>

| | Funkcja | Dlaczego to robi różnicę |
|---|---|---|
| 🔬 | **Od twierdzenia do dowodu** | W pełnym raporcie każda sprawdzona część tezy ma własny wynik i przypisane fragmenty wspierające, obalające lub uzupełniające kontekst. Kod sprawdza dosłowność cytatu w zapisanym rekordzie. Przy fragmencie znajdziesz wydawcę, datę i link. |
| 🗓️ | **Daty, urzędy i liczby** | Fons potrafi zestawić daty przystąpienia kilku państw do UE lub NATO, odróżnić tury wyborów i sprawdzić, kto pełnił urząd w danym okresie. Przy porównaniu stawek świadczenia sprawdza grupę uprawnionych, okres i jednostkę. Gdy źródła podają różne szacunki tego samego zjawiska, może pokazać obie wartości z datami i cytatami. |
| 📐 | **Jawne reguły werdyktu** | Dziewięć reguł zamienia ocenę dowodów w werdykt. Przy tych samych ocenach i metadanych reguły dają ten sam wynik. [Reguły werdyktu](docs/VERDICT-RULES.md) |
| 🧑‍⚖️ | **Weryfikacja wniosku** | Osobne wywołanie modelu sprawdza, czy cytaty i metadane uzasadniają wniosek. Raport wskazuje, czy weryfikator korzystał z innego dostawcy. |
| 🎬 | **Filmy z TikToka, Instagrama, Facebooka i YouTube** | Wklejasz link. Fons czyta opis i napisy, próbkuje do 32 klatek, transkrybuje dźwięk i wskazuje do 6 twierdzeń z **czasem w nagraniu**. |
| 🖼️ | **Zrzuty ekranu i obrazy** | OCR, metadane, C2PA i wyszukiwanie wcześniejszych publikacji. Wybierz „Dodaj plik” → „Porównaj dwa obrazy”, żeby sprawdzić zgodność dwóch kopii lokalnie. [Zakres porównania i katalog zdjęć](data/image-references/README.md) |
| 🎙️ | **Głos i dokumenty** | Prześlij nagranie z prośbą „Przepisz nagranie” lub z twierdzeniem do sprawdzenia. Polecenie „Pokaż metadane nagrania” odczytuje lokalnie m.in. czas, kodek, częstotliwość próbkowania i liczbę kanałów. Czat obsługuje również dyktowanie, PDF i TXT. |
| 🔎 | **Wyszukiwanie wielojęzyczne** | Polskie pytanie może prowadzić do publikacji w innym języku. Odpowiedź jest po polsku, a cytat zachowuje język oryginału. Fons łączy indeks tekstowy BM25 z lokalnym modelem `multilingual-e5-small`. |
| | **Prywatne archiwum materiałów** | W zakładce **Źródła** wklejasz adres z katalogu danych GUS BDL lub Eurostatu, przeglądasz fragment dopuszczony do zapisu i zatwierdzasz wybór. Archiwum mieści 24 fragmenty do 300 znaków każdy. Zapis wygasa po siedmiu dniach. Możesz go też wcześniej usunąć. |
| | **Rozszerzenia operatora** | Moduł wskazany przez `FONS_EXTENSIONS_MODULE` może dodać kanał wiadomości, model lub wyszukiwarkę przy starcie usługi. [Kontrakt i sposób podłączenia](docs/MODULES.md#rozszerzenia-instalowane-przez-operatora) |
| 🌐 | **Wyszukiwanie i ponowne użycie źródeł** | Serwer pobiera publikacje z hostów dopuszczonych w katalogu i sprawdza każde przekierowanie. Jeśli zasady wydawcy pozwalają na zapis, może ponownie wykorzystać dokument lub fragment przez maksymalnie 48 godzin. Przy jednoznacznych dowodach pomija dodatkowe wyszukiwanie adresów. Pytania o stan bieżący wymagają świeżego odczytu. |
| 🗂️ | **Indeks fact-checków** | Pytanie „czy Demagog to sprawdzał?” trafia do Google Fact Check Tools i porównuje tezę z publikacją. |
| 🛡️ | **Pancerz na prompt injection** | Deterministyczny detektor (PL/EN/RU/UA, homoglify, zero-width, base64, ukryty HTML) działa na **surowej** treści, zanim zobaczy ją model. Treść niezaufana trafia do modelu tylko w blokach z losowym ogranicznikiem. |
| 🔐 | **Maskowanie i retencja danych** | Fons maskuje wykryte w tekście numery PESEL, telefony, adresy e-mail, numery IBAN i numery kart. Nadawcę identyfikuje pseudonim HMAC. Raport wygasa po 30 dniach, a sesja po 7 dniach bez aktywności. |
| 🧭 | **Dobór modelu do zadania** | Konfiguracja przykładowa używa OpenAI. Główny model to `gpt-6.2-sol`, a szybki to `gpt-6-luna`. Operator może je zmienić przez `MODEL_MAIN` i `MODEL_FAST`. Przejście na zapasowego dostawcę wymaga skonfigurowania drugiej rodziny modeli i jej klucza. |
| 📋 | **Kolejka spraw dla moderatora** | „Zgłoś do sprawdzenia” pozwala połączyć podobne zgłoszenia w jedną sprawę. Panel rozdziela uprawnienia moderatora, analityka i administratora. |
| 🤖 | **Serwer MCP** | `verify_claim`, `search_sources`, `get_report`, `list_sources` przez stdio i HTTP z tokenem. Fons wpina się w Claude, IDE i narzędzia analityczne. |
| 📈 | **Obserwowalność** | Logi JSON z `X-Request-Id`, `/metrics` dla Prometheusa (czas na krok, koszt) i weryfikowalny łańcuch hashy przebiegów. |
| 💾 | **Pamięć wyników** | Trafienie w pamięć wyników pozwala pominąć ponowne sprawdzanie tezy. Każda ponowiona próba z wykrytą instrukcją w materiale dostaje osobny wpis w logu bezpieczeństwa. |

<p align="center">
  <img src="docs/readme/pipeline.svg" alt="Potok weryfikacji krok po kroku" width="100%">
</p>

---

## 🧠 Pod maską

**Ile kosztuje sprawdzenie?** W dwóch seriach v33 te same 100 pytań tekstowych kosztowało według telemetrii dostawców **3,54 USD i 3,42 USD**. To około **3,5 centa amerykańskiego za pytanie**, przy medianie czasu odpowiedzi odpowiednio **16,74 s i 15,44 s**. Obie serie zaczynały się z pustą bazą. To pomiar kosztu wywołań dla tej próby, bez hostingu i obsługi operatora. [Wyniki i metodologia](docs/konkurs/PROG-075.md)

1. **Gotowy wynik lub odczyt rejestru.** Przy trafieniu w pamięć wyników backend wydaje osobny raport dla użytkownika i pomija ponowne uruchomienie silnika. Nawet przy pierwszym pytaniu może sięgnąć bezpośrednio do danych urzędowych. W dziewięciu próbach dotyczących członkostwa w UE i NATO silnik zapisał odpowiedzi bez żadnego wywołania modelu. [Pomiar odczytu rejestrów](eval/results/membership-mvp-2026-11-22.json)
2. **Wyszukiwanie dowodów.** Fons łączy wyszukiwanie tekstowe SQLite FTS5 z lokalnym wielojęzycznym modelem E5. Przy wyszukiwaniu w sieci może wykorzystać wcześniej sprawdzoną publikację. Jeśli materiał jednoznacznie odpowiada na pytanie, silnik pomija dodatkowe wyszukiwanie adresów. Pytania o stan bieżący uruchamiają świeży odczyt. [Kod wyszukiwania](src/engine/retrieval/live.ts)
3. **Ocena i raport.** Dla złożonej wypowiedzi silnik wydziela tezy i ocenia dowody dla kilku z nich równolegle. Model wskazuje pasujące fragmenty, kod sprawdza dosłowność cytatów, a weryfikator ocenia, czy uzasadniają wniosek. Jawne reguły wyznaczają werdykt. Użytkownik dostaje krótką odpowiedź, a w raporcie może otworzyć źródło i sprawdzić podstawę oceny każdej tezy. [Silnik weryfikacji](src/engine/verify.ts)

<details>
<summary><b>🔩 Stos technologiczny</b></summary>

| Warstwa | Technologia |
|---|---|
| Serwer | Node 22, TypeScript, Hono, Zod (kontrakty i schematy odpowiedzi modeli) |
| Baza | SQLite (better-sqlite3), FTS5, wektory, łańcuch hashy audytu |
| Wyszukiwanie | BM25 + `multilingual-e5-small` (ONNX, lokalnie, `@huggingface/transformers`) + RRF + reranking |
| Modele | OpenAI w bieżącej konfiguracji. Model główny to `gpt-6.2-sol`, szybki to `gpt-6-luna`. Wideo analizuje OpenAI na podstawie wybranych klatek i dostępnych napisów lub transkrypcji |
| Media | FFmpeg, yt-dlp (przypięta wersja), sharp, C2PA |
| WWW | React 19, Vite 7, system komponentów Astryx, motyw `fons-paper` |
| Kanały | Czat WWW (strumień NDJSON z etapami), CLI, konektor ChatLoom wymagający konfiguracji, MCP |
| Testy | Vitest, integracje z lokalnym E5 oraz odrębne pomiary rzeczywistego silnika z dostawcą sieciowym |

</details>

<details>
<summary><b>🗺️ Mapa repozytorium</b></summary>

```
src/
  engine/        potok weryfikacji: twierdzenia, retrieval/, verdict/, llm/ (router), video/, prompty
  security/      detektor injection, PII, ochrona SSRF, rate limit, ekstrakcja treści
  server/        Hono API, warstwa rozmowy, kanały (web, cli, chatloom), auth i role, obserwowalność
  web/  app/     interfejs React: czat, raport /w/:token, źródła, panel /admin
  mcp/           serwer MCP (stdio + HTTP)
  corpus/        budowa i weryfikacja korpusu z prawdziwych źródeł
eval/            zestawy dev / held-out / red-team / demo, metryki, raporty z prawdziwym modelem
data/            katalog źródeł, korpus, embeddingi, incydenty, mapy ocen
integrations/    konektor ChatLoom (most do WhatsAppa, SMS, iMessage)
docs/            metoda, reguły werdyktu, router, narzędzia, ewaluacja, dokumentacja techniczna
```

</details>

<details>
<summary><b>🛡️ Bezpieczeństwo warstwa po warstwie</b></summary>

1. **Wejście:** limity IP i użytkownika, dobowy budżet tokenów, allowlista schematów linków.
2. **Pobieranie:** ochrona SSRF (blokada sieci prywatnych, kontrola każdego przekierowania, limit 5 MB).
3. **Detektor:** deterministyczny, na surowej treści, w PL/EN/RU/UA, wykrywa homoglify, znaki zero-width, base64, ukryty HTML i `aria-hidden`.
4. **Izolacja:** treść niezaufana trafia do modelu tylko w blokach z losowym ogranicznikiem, a odpowiedzi muszą pasować do schematu JSON.
5. **Weryfikacja:** kod sprawdza dosłowność cytatu w rekordzie. W pełnej ścieżce oceny osobne wywołanie weryfikatora sprawdza związek dowodu z tezą.
6. **Wynik:** werdykt liczą reguły, awaria nigdy nie udaje werdyktu, a treść od użytkownika nigdy nie jest dowodem.
7. **Ślad:** każde zdarzenie bezpieczeństwa trafia do logu, także przy trafieniu w cache.

</details>

---

## 📊 Wyniki

[Plan wdrożenia i testy odbiorcze MSZ](docs/WDROZENIE-MSZ.md) · [Krótka odpowiedź, pomiary i samoocena według kryteriów jury](docs/ODBIOR-SILNIKA.md)

Na zestawie 68 jawnych tekstów (63 z etykietą) wersja v34 uzyskała macro-F1 **0,870**. W serii v35 dostawca modeli przestał przyjmować żądania. Wynik wyniósł **0,449**, a 39 z 68 raportów miało status `NIEPELNE`. Pomiary dotyczą wersji wskazanych w raporcie. [Wyniki, ograniczenia i dane do odtworzenia](docs/konkurs/PROG-075.md)

Pełne odpowiedzi, wyniki według zbioru, koszt i opóźnienie znajdują się w raporcie konkursowym. Zawiera też ocenę znaczenia cytatów, próby WWW z załącznikami i wyniki działania adaptera wiadomości. [Końcowy odbiór i pakiet do odtworzenia](docs/konkurs/KONTYNUACJA.md) · [Wcześniejszy pomiar po poprawkach](docs/konkurs/WYNIKI.md) · [Pierwszy audyt](docs/AUDYT-MSZ-2026-11-22.md)

---

## 🚀 Szybki start

Wymagania: Node.js ≥ 22 i npm.

```bash
cp .env.example .env          # OPENAI_API_KEY dla modelu, FACTCHECK_API_KEY dla indeksu Google
npm install
npm run corpus:load           # data/corpus/*.jsonl → SQLite, ok. 0,1 s
npm run dev                   # API :8787 + WWW :5173 → http://localhost:5173
```

```bash
npm run ask "Szwecja jest członkiem NATO"   # sprawdzenie z terminala
npm test                                     # regresja kodu; RUN_E5_TESTS=1 włącza integracje E5
npm run build && npm start                   # produkcja: jeden proces, http://localhost:8787
```

Ustawienia modeli, wideo, MCP, panelu `/admin` i rezydencji danych opisują [przykładowa konfiguracja](.env.example) i [dokumentacja techniczna](docs/TECHNICAL.md#szybki-start).

---

## 📚 Dokumentacja

| | |
|---|---|
| 📘 [Dokumentacja techniczna](docs/TECHNICAL.md) | pełny opis funkcji, wyniki ewaluacji, architektura, ograniczenia i ryzyka |
| 🧪 [Metoda weryfikacji](docs/METODA-WERYFIKACJI.md) | standardy redakcyjne i sposób oceny |
| 📐 [Reguły werdyktu](docs/VERDICT-RULES.md) | reguły 1–9 krok po kroku |
| 📚 [Źródła](docs/SOURCES.md) | katalog wydawców i poziomy źródeł |
| 🧭 [Router modeli](docs/ROUTER.md) · 🔧 [Narzędzia i MCP](docs/TOOLS.md) | jak dobieramy modele i jak działa wyszukiwanie na żywo |
| 📊 [Ewaluacja](docs/EVAL.md) · 📝 [Dziennik jakości](docs/QUALITY-LOG.md) | definicje miar i historia strojenia |
| 🏁 [Opis konkursowy](docs/OPIS.md) | zgłoszenie na HackNation 2026 |
| 💬 [Konektor ChatLoom](integrations/chatloom/README.md) | podłączenie WhatsAppa, SMS i iMessage |
| [Eksport do OpenCTI](integrations/opencti/push.ts) | `npm run export:opencti` wysyła publiczny katalog STIX z przypisaniami DISARM do kolekcji TAXII Push i sprawdza wynik importu |

<p align="center">
  <br>
  <img src="https://img.shields.io/badge/Fons-źródło%2C%20nie%20opinia-493734?style=for-the-badge">
  <br><sub>Zbudowane na HackNation 2026 · Licencja <a href="LICENSE">ISC</a></sub>
</p>
