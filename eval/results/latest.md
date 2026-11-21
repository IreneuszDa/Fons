# Wyniki ewaluacji Fons

- Uruchomienie: 2026-11-21T21:33:54.357Z → 2026-11-21T21:39:27.706Z
- Zestaw: **main**, podział: **dev**, przebiegi na przypadek: 1; wyszukiwanie na żywo: nie (offline)
- Model główny: openai (gpt-6.2-sol / gpt-6-luna); weryfikator: openai (tryb jednego klucza); tryb werdyktu: rules
- Migawka korpusu: e47b5fb476ff4b13202cbdf159875b6ab6d16e13bd56256cc340919385d683c0 (2529 rekordów); wersja potoku: engine-2026.11.22-8
- Commit: brak commita (niezatwierdzone zmiany w drzewie roboczym)
- Przypadki policzone: 32

## Podsumowanie względem progów

| Miara | Wynik | Próg | Status |
|---|---|---|---|
| Macro-F1 (klasy obecne w zestawie) | 0.729 | ≥ 0.75 | NIESPEŁNIONY |
| Pokrycie cytatami | 100.0% (29/29) | ≥ 95.0% | spełniony |
| Poprawność cytatów — proxy (cytat jest podciągiem rekordu) | 100.0% (48/48) | ≥ 85.0% | spełniony |
| Poprawne wstrzymanie (scenariusz D) | — (0 przypadków) | ≥ 80.0% | — |
| Odporność na wstrzyknięcia (najgorszy z N) | — (0 przypadków) | ≥ 90.0% | — |
| Mediana czasu (tekst/URL) | 9.4 s (p95 17.0 s, n=32) | ≤ 30 s | spełniony |
| Działanie end-to-end (raport zamiast wyjątku) | 100.0% (32/32) | 100% | spełniony |
| Usterki J (status ≠ OK, brak werdyktu) | — (0 przypadków) | 100% | — |
| Trafność odpowiedzi na pytania otwarte (osobno od macro-F1) | — (0 przypadków) (przebiegi: — (0 przypadków)) | raportowana | — |
| Koszt 100 testów | 1.4441 USD (łącznie 0.4621 USD za 32 przebiegów) | raportowany | — |

## Macierz pomyłek (wiersze: oczekiwane, kolumny: otrzymane)

| oczekiwane \ otrzymane | POTWIERDZONE | FALSZYWE | WPROWADZAJACE | BRAK_DOWODOW | NIE_PODLEGA | BRAK_WYNIKU |
|---|---|---|---|---|---|---|
| POTWIERDZONE | 11 | 0 | 2 | 4 | 0 | 0 |
| FALSZYWE | 0 | 9 | 0 | 2 | 0 | 0 |
| WPROWADZAJACE | 0 | 0 | 2 | 2 | 0 | 0 |
| BRAK_DOWODOW | 0 | 0 | 0 | 0 | 0 | 0 |
| NIE_PODLEGA | 0 | 0 | 0 | 0 | 0 | 0 |

| Klasa | Liczność | Precyzja | Czułość | F1 |
|---|---|---|---|---|
| POTWIERDZONE | 17 | 1.000 | 0.647 | 0.786 |
| FALSZYWE | 11 | 1.000 | 0.818 | 0.900 |
| WPROWADZAJACE | 4 | 0.500 | 0.500 | 0.500 |
| BRAK_DOWODOW | 0 | 0.000 | 0.000 | 0.000 |
| NIE_PODLEGA | 0 | 0.000 | 0.000 | 0.000 |

Trafność ogólna: 68.8% (32 par). Macro-F1 liczone po klasach: POTWIERDZONE, FALSZYWE, WPROWADZAJACE.

## Trafność wg scenariusza (najgorszy z N)

| Scenariusz | Trafność |
|---|---|
| A | 73.9% (17/23) |
| B | 50.0% (2/4) |
| G | 100.0% (1/1) |
| I | 100.0% (1/1) |
| X | 33.3% (1/3) |

| Etykieta | Trafność |
|---|---|
| negation | 100.0% (1/1) |
| wrong_context | 50.0% (2/4) |
| politician | 100.0% (6/6) |
| fresh | 100.0% (1/1) |
| link | 100.0% (4/4) |
| official_link | 100.0% (2/2) |
| misused_link | 100.0% (2/2) |
| disinfo_page | 100.0% (2/2) |
| rated_claim | 100.0% (2/2) |
| compound | 100.0% (1/1) |

## Trafność wg trybu wejścia

Pytania tak/nie liczą się do macro-F1 według werdyktu; pytania otwarte — tylko do trafności odpowiedzi (odpowiedź jest ∧ zawiera każdy oczekiwany fragment ∧ cytat zgadza się z rekordem).

| Tryb (oczekiwany) | Trafność przypadków | Tryb rozpoznany poprawnie (przebiegi) |
|---|---|---|
| twierdzenie | 65.5% (19/29) | 100.0% (3/3) |
| pytanie tak/nie | 100.0% (3/3) | 100.0% (3/3) |
| pytanie otwarte | — (0 przypadków) | — (0 przypadków) |

## Wstrzymanie

- Scenariusz D: — (0 przypadków)
- Wszystkie przypadki z oczekiwanym BRAK_DOWODOW (D, C, H): — (0 przypadków)
- Nadmierne wstrzymanie (oczekiwany werdykt rozstrzygający, otrzymano BRAK_DOWODOW): 25.0% (8/32)

## Bezpieczeństwo

- Odporność: — (0 przypadków); wykrywalność (zdarzenie bezpieczeństwa w każdym przebiegu): — (0 przypadków)
- Fałszywe alarmy detektora — korpus: 0.0% (0/2529); teksty łagodne (eval/fixtures/benign): 0.0% (0/31)

## Sprawdzenia pomocnicze (nie wpływają na F1)

- C — blok „źródła sprzeczne” przy twierdzeniu głównym: — (0 przypadków)
- I — ostrzeżenie o domenie z bazy incydentów / statusie źródła: 0.0% (0/1)
- Oczywiste przypadki — poprawny werdykt i co najmniej oczekiwana siła dowodów: 100.0% (4/4)
- Siła dowodów przy poprawnych werdyktach FAŁSZYWE/POTWIERDZONE: mocna 8, średnia 9, słaba 3
- Silnik sam deklaruje sprawę moderatora (nie powinien — robi to warstwa rozmowy po zapisie): brak
