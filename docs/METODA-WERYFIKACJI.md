# Jak Fons sprawdza materiał

## Od artykułu do odpowiedzi

Po otrzymaniu publicznego linku Fons próbuje odczytać treść strony. W zwykłym poleceniu „sprawdź ten artykuł” przedmiotem analizy jest artykuł. Model wydziela z niego konkretne twierdzenia, zachowując podmiot, datę, zakres i liczby. Jedno sprawdzenie obejmuje do sześciu głównych tez długiego materiału. Silnik szuka źródeł dla każdej sprawdzalnej tezy w bazie i może wykonać dodatkowe wyszukiwanie internetowe dla pierwszych trzech sprawdzalnych tez lub ich składowych. Pytania o odrębne sprawy mogą mieć różne odpowiedzi i osobne zestawy źródeł.

Wyszukiwanie łączy indeks słów w SQLite FTS5 z wielojęzycznymi embeddingami E5. Do tego dochodzą sprawdzenia fact-checkerów, konektory źródeł oraz wyszukiwanie na żywo. GPT może wskazać publikacje za pomocą narzędzia `web_search` w Responses API. Serwer sam sprawdza docelowy adres i pobiera materiał. Opis wyniku z wyszukiwarki służy do odnalezienia publikacji. Podstawą oceny jest odczytany fragment albo zapisany rekord źródłowy. Zakres katalogu można sprawdzić w aplikacji, a stan poszczególnych wyszukiwań w raporcie. [Dokumentacja OpenAI](https://developers.openai.com/api/docs/guides/tools-web-search)

W raporcie można przejść od konkretnej tezy do uzasadnienia, publikacji i użytego fragmentu. Dla danych tabelarycznych pojawia się oznaczenie „Odczyt z danych źródłowych”. Zdanie poskładane z daty, kraju i wartości liczbowej jest opracowaniem rekordu. Dla materiałów typu ClaimReview istotne jest również, kto wypowiedział dane słowa. Pole opisujące ocenianą tezę może przytaczać wypowiedź osoby sprawdzanej przez redakcję. [Specyfikacja ClaimReview](https://schema.org/ClaimReview)

## Co wpływa na ocenę

| Sytuacja | Jak czytać wynik |
| --- | --- |
| Opinia lub prognoza | Ocenie faktograficznej podlegają sprawdzalne przesłanki. Sam sąd wartościujący i przewidywanie są oznaczane osobno. |
| Informacja archiwalna | Liczą się okres danych i data opisywanego zdarzenia. Data wyświetlona na obrazie opisuje treść obrazu. Ustalenie daty rzeczywistej publikacji wymaga dodatkowego źródła. |
| Liczby się zgadzają, wniosek budzi wątpliwości | Trzeba sprawdzić, kogo obejmują liczby, za jaki okres oraz czy materiał miesza zapowiedź, pomiar i szacunek. |
| Dokument mówi tylko o części sprawy | Jeśli publikacja opisuje jedno z dziesięciu państw, może pomóc przy tym państwie. Do podważenia całej tezy potrzebny jest fragment wskazujący konkretną niezgodność. |
| Źródła się wykluczają | Raport pokazuje materiały przemawiające za każdym stanowiskiem. Nierozstrzygnięty konflikt dotyczący tej samej kwestii prowadzi do wstrzymania oceny. |
| Brakuje dowodów lub dostępu | Użytkownik widzi zakres sprawdzenia. Awaria API, zamknięty post i brak publikacji odpowiadającej na pytanie to trzy różne wyniki. |

Punktacja w pełnym raporcie opisuje podstawę dowodową według jawnych reguł Fonsa. Uwzględnia rodzaj źródła, niezależność wydawców, daty i sprawdzenie cytatów. Odczyt tego samego dokumentu przez dwa modele nadal opiera się na jednym dokumencie. Dwa identyczne długie fragmenty treści u różnych wydawców nie dają dwóch niezależnych potwierdzeń. Rozpoznawanie przedruków ma ograniczenia przy tłumaczeniach i parafrazach. [Reguły silnika](./VERDICT-RULES.md)

## Co chroni przebieg sprawdzenia

Pobrana strona może zawierać polecenia skierowane do modelu. Serwer bada tekst i metadane pod kątem takich instrukcji, oznacza wykrycia w raporcie i wyklucza podejrzane fragmenty. Model otrzymuje materiał oddzielony od instrukcji aplikacji. Kod sprawdza strukturę odpowiedzi i pochodzenie wskazanych dowodów. Przy zwykłej weryfikacji artykułu wyklucza sam zgłoszony dokument oraz rozpoznane kopie.

Przed pobraniem źródła serwer sprawdza adres docelowy i przekierowania, blokuje połączenia do sieci prywatnych i ogranicza rozmiar odpowiedzi. Osobne limity obejmują przesłane pliki, czas nagrania, tempo żądań oraz dzienny budżet wywołań. W widoku „Jak to sprawdziłeś?” można odczytać, które etapy rzeczywiście wykonano. [Wyszukiwanie i jego limity](./TOOLS.md)

## Co wynika ze standardów redakcyjnych

- **IFCN** wymaga spójnych kryteriów, jawnej metodologii, przejrzystości źródeł i otwartej polityki korekt. W Fonsie czytelnik może odtworzyć drogę od tezy do konkretnego fragmentu publikacji. [Zobowiązania IFCN](https://ifcncodeofprinciples.poynter.org/the-commitments)
- **EFCSN** zaleca wskazanie materiału zarówno wspierającego tezę, jak i podważającego ją, preferowanie źródeł pierwotnych oraz co najmniej dwóch źródeł dla centralnej tezy, z wyjątkiem sytuacji, w której istnieje tylko jedno istotne źródło. Fons dopuszcza rozstrzygnięcie na podstawie jednego trafnego źródła pierwotnego i ujawnia liczbę niezależnych wydawców. Ustalenie, czy na świecie istnieje tylko jedna stosowna publikacja, wymaga oceny redakcyjnej. [Kodeks EFCSN, art. 2.1](https://efcsn.com/code-of-standards/)
- **EDMO** opisuje niezależność od fundatorów, przejrzystość, neutralność i odpowiedzialność organizacji. Podobieństwo wiadomości do znanej narracji jest wskazówką do dalszej analizy. Przypisanie autorstwa lub intencji kampanii wymaga odrębnych dowodów. [Zasady sieci EDMO](https://belux.edmo.eu/about-us/guiding-principles-for-the-edmo-network/)
- **NASK** zaleca sprawdzenie nadawcy i szukanie potwierdzenia poza platformą społecznościową. Przy filmie ważne jest, czy udało się odczytać obraz, dźwięk, napisy czy wyłącznie opis. Z oceną pochodzenia materiału trzeba zaczekać na dowód jego wcześniejszej publikacji lub inny sprawdzalny ślad. [Wskazówki OAD NASK](https://oad.nask.pl/aktualnosci/jak-obywatele-moga-pomoc-w-zwalczaniu-dezinformacji)

Te kodeksy dotyczą także ludzi i organizacji. Ujawnienie finansowania, niezależność decyzji, odpowiedzialność redakcyjna oraz publiczny proces korekt wymagają działań operatora. Powyższe porównanie opisuje metodę techniczną Fonsa, a uzyskanie statusu sygnatariusza wymaga odrębnej oceny.
