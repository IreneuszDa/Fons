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

<img src="docs/readme/screens/wa-flow.gif" alt="Przejście przez instrukcję, opis odpowiedzi ze źródłami i formularz numeru telefonu." width="100%">

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

Wklej wiadomość, link albo dodaj plik. Przy twierdzeniu Fons pokazuje ocenę i dowody dla poszczególnych części wypowiedzi. Na pytanie otwarte, np. „Kto pełnił ten urząd?”, może odpowiedzieć nazwiskiem i cytatem. Jeśli potrzebuje szczegółów albo sprawdzenie przerwała awaria, czat pokazuje osobny komunikat.

<p align="center">
  <img src="docs/readme/verdicts.svg" alt="Pięć ocen twierdzenia: potwierdzone, fałszywe, wprowadzające w błąd, brak wystarczających dowodów, nie podlega weryfikacji." width="100%">
</p>

### Co możesz sprawdzić

| Materiał | Co otrzymujesz |
|---|---|
| **Twierdzenie, pytanie lub artykuł** | Krótką odpowiedź po polsku i link do raportu. Przy rozstrzygnięciu raport wskazuje wydawcę, datę i fragment, który wspiera lub obala tezę. Fons sprawdza m.in. daty członkostwa w UE i NATO, kadencje, tury wyborów oraz stawki świadczeń dla wskazanych grup. [Reguły oceny dowodów](docs/VERDICT-RULES.md) |
| **Zdjęcie lub zrzut ekranu** | Fons może odczytać tekst, metadane i dostępne poświadczenia C2PA. W trybie **Porównaj dwa obrazy** porównuje kopie lokalnie. Przy szukaniu wcześniejszej publikacji korzysta z lokalnego katalogu, a po konfiguracji także z Google Vision. [Zakres porównania](data/image-references/README.md) |
| **Film lub nagranie** | Możesz przesłać plik albo wkleić link z TikToka, Instagrama, Facebooka lub YouTube. Zakres analizy zależy od dostępnego materiału. Przy pełnym odczycie Fons wskazuje twierdzenia z czasem w nagraniu. Gdy platforma udostępnia tylko opis lub napisy, raport wskazuje tę podstawę. Nagranie możesz też przepisać lub poprosić o jego metadane. |
| **Dokument** | Dodaj PDF z warstwą tekstową lub plik TXT i zapytaj o jego treść. W czacie możesz również podyktować pytanie i poprawić transkrypcję przed wysłaniem. |
| **Sprawdzona wiadomość w czytniku** | Otwórz publikację z ekranu startowego, zaznacz fragment i wybierz **Wyjaśnij w czacie**. Fons odnosi się do tych słów w kontekście artykułu. Z czytnika możesz przejść do źródeł. |

Wyszukiwanie łączy dopasowanie słów z wielojęzycznym wyszukiwaniem po znaczeniu. Fons może sięgnąć do urzędowego rejestru, wcześniejszej weryfikacji redakcyjnej albo publikacji z katalogu dopuszczonych wydawców. W zakładce **Źródła** możesz też zachować do 24 fragmentów z obsługiwanych zbiorów GUS BDL i Eurostatu. Każdy fragment ma do 300 znaków i wygasa po siedmiu dniach.

### Raporty i eksport plików

**W czacie** link do wyniku otwiera raport pod `/w/:token`. Raport wygasa po 30 dniach. Do integracji ten sam wynik jest dostępny jako JSON przez `GET /api/report/:token`. PDF jest obsługiwany jako załącznik wejściowy. Widok wyniku nie ma przycisku eksportu do PDF ani DOCX.

**W panelu zespołu** analityk i administrator mogą otworzyć **Eksport** i pobrać plik na dysk. Moderator prowadzi kolejkę spraw, w której system grupuje podobne zgłoszenia. [Panel eksportu](src/web/admin/AccessPanels.tsx) · [Uprawnienia](src/server/auth/permissions.ts)

| Dane do pobrania | Format | Zawartość |
|---|---|---|
| Sprawy moderatorów | CSV lub JSON | Wszystkie sprawy, także poza bieżącą stroną listy. Eksport obejmuje m.in. treść reprezentatywnego zgłoszenia, status, liczbę unikalnych nadawców, kanały, daty i notatkę moderatora. |
| Przebiegi sprawdzeń | CSV lub JSON | Dane techniczne, m.in. kanał, rodzaj wejścia, status, werdykt, czas, szacowany koszt, użycie pamięci wyników i wersja silnika. Treść wiadomości i identyfikatory nadawców są pomijane. |
| Katalog incydentów | STIX 2.1 w pliku JSON | Publiczne adresy powiązane z incydentami oraz udokumentowane przypisania technik DISARM. Po skonfigurowaniu adresu kolekcji TAXII Push i tokenów operator może wysłać pakiet do OpenCTI poleceniem `npm run export:opencti`. [Integracja OpenCTI](integrations/opencti/push.ts) |

**Integracje i audyt.** Narzędzia MCP pozwalają sprawdzić tezę, przeszukać źródła, pobrać raport i odczytać katalog wydawców. Zespół może śledzić czas i koszt sprawdzeń, korzystać z metryk Prometheusa i weryfikować integralność dziennika przebiegów. Operator może podłączyć własny kanał, model lub wyszukiwarkę. [Narzędzia MCP](docs/TOOLS.md) · [Rozszerzenia operatora](docs/MODULES.md#rozszerzenia-instalowane-przez-operatora)

![Jak Fons wybiera między zapisanym wynikiem, odczytem rejestru i wyszukaniem dowodów dla tezy.](docs/readme/screens/pipeline.gif)

[Otwórz schemat bez animacji](docs/readme/pipeline.svg)

---

## 🧠 Pod maską

![Przebieg A06 od wydzielenia tezy przez wyszukiwanie i kontrolę cytatu do werdyktu.](docs/readme/screens/backend-flow.gif)

**Jak Fons sprawdził datę uchwalenia Konstytucji RP?** W zapisanym przebiegu A06 (v31) szybki model wydzielił tezę z wiadomości. Wyszukiwanie po słowach zwróciło 48 kandydatów, po znaczeniu 43, baza incydentów 10, a wyszukiwanie na żywo 8. Wyniki częściowo się pokrywały. Po ich połączeniu silnik miał **92 różne rekordy**, z których **8 trafiło do oceny**.

Model główny wskazał zdanie Senatu RP: „2 kwietnia 1997 r. Zgromadzenie Narodowe uchwaliło Konstytucję Rzeczypospolitej Polskiej”. Kod sprawdził obecność cytatu w rekordzie, a osobne wywołanie szybkiego modelu potwierdziło, że fragment uzasadnia ocenę. Reguła 7 dała wynik **„Potwierdzone”**. Całe sprawdzenie trwało **16,33 s**, a oszacowany koszt wyniósł **0,033574 USD**, w tym **0,022093 USD** za wyszukiwanie na żywo. [Zapis przebiegu A06 w zestawie 100 raportów](eval/results/teksty-100-v31.json.gz)


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
