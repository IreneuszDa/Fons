# Spójność kanałów (web ↔ cli)

- Uruchomienie: 2026-11-21T20:03:05.967Z → 2026-11-21T20:07:18.486Z; baza: var/eval-final.db
- Zgodność: **100.0%** (26/26); próg: 100%

| Przypadek | Scen. | web | cli | Wynik |
|---|---|---|---|---|
| G01 | G | OK/POTWIERDZONE (zdarzenia: 0) | OK/POTWIERDZONE (zdarzenia: 0, z cache) | zgodne |
| G02 | G | OK/FALSZYWE (zdarzenia: 0) | OK/FALSZYWE (zdarzenia: 0, z cache) | zgodne |
| G03 | G | OK/BRAK_DOWODOW (zdarzenia: 0) | OK/BRAK_DOWODOW (zdarzenia: 0, z cache) | zgodne |
| E01 | E | OK/POTWIERDZONE (zdarzenia: 3) | OK/POTWIERDZONE (zdarzenia: 3, z cache) | zgodne |
| E02 | E | OK/BRAK_DOWODOW (zdarzenia: 1) | OK/BRAK_DOWODOW (zdarzenia: 1, z cache) | zgodne |
| E04 | E | OK/BRAK_DOWODOW (zdarzenia: 16) | OK/BRAK_DOWODOW (zdarzenia: 16, z cache) | zgodne |
| E06 | E | OK/BRAK_DOWODOW (zdarzenia: 2) | OK/BRAK_DOWODOW (zdarzenia: 2, z cache) | zgodne |
| E03 | E | OK/POTWIERDZONE (zdarzenia: 5) | OK/POTWIERDZONE (zdarzenia: 5, z cache) | zgodne |
| E05 | E | OK/POTWIERDZONE (zdarzenia: 0) | OK/POTWIERDZONE (zdarzenia: 0, z cache) | zgodne |
| J01 | J | NIEPELNE/- (zdarzenia: 0) | NIEPELNE/- (zdarzenia: 0) | zgodne |
| J02 | J | NIEPELNE/- (zdarzenia: 0) | NIEPELNE/- (zdarzenia: 0) | zgodne |
| J03 | J | NIEPELNE/- (zdarzenia: 0) | NIEPELNE/- (zdarzenia: 0) | zgodne |
| J05 | J | OK/POTWIERDZONE (zdarzenia: 0) | OK/POTWIERDZONE (zdarzenia: 0, z cache) | zgodne |
| A01 | A | OK/POTWIERDZONE (zdarzenia: 0) | OK/POTWIERDZONE (zdarzenia: 0, z cache) | zgodne |
| A02 | A | OK/POTWIERDZONE (zdarzenia: 0) | OK/POTWIERDZONE (zdarzenia: 0, z cache) | zgodne |
| A04 | A | OK/POTWIERDZONE (zdarzenia: 0) | OK/POTWIERDZONE (zdarzenia: 0, z cache) | zgodne |
| A06 | A | OK/BRAK_DOWODOW (zdarzenia: 0) | OK/BRAK_DOWODOW (zdarzenia: 0, z cache) | zgodne |
| A08 | A | OK/BRAK_DOWODOW (zdarzenia: 0) | OK/BRAK_DOWODOW (zdarzenia: 0, z cache) | zgodne |
| A10 | A | OK/BRAK_DOWODOW (zdarzenia: 0) | OK/BRAK_DOWODOW (zdarzenia: 0, z cache) | zgodne |
| D01 | D | OK/BRAK_DOWODOW (zdarzenia: 0) | OK/BRAK_DOWODOW (zdarzenia: 0, z cache) | zgodne |
| D02 | D | OK/BRAK_DOWODOW (zdarzenia: 0) | OK/BRAK_DOWODOW (zdarzenia: 0, z cache) | zgodne |
| D04 | D | OK/BRAK_DOWODOW (zdarzenia: 0) | OK/BRAK_DOWODOW (zdarzenia: 0, z cache) | zgodne |
| B01 | B | OK/BRAK_DOWODOW (zdarzenia: 0) | OK/BRAK_DOWODOW (zdarzenia: 0, z cache) | zgodne |
| B02 | B | OK/WPROWADZAJACE (zdarzenia: 0) | OK/WPROWADZAJACE (zdarzenia: 0, z cache) | zgodne |
| I01 | I | OK/POTWIERDZONE (zdarzenia: 0) | OK/POTWIERDZONE (zdarzenia: 0, z cache) | zgodne |
| I02 | I | OK/BRAK_DOWODOW (zdarzenia: 0) | OK/BRAK_DOWODOW (zdarzenia: 0, z cache) | zgodne |

## Ten sam atak 3 razy

- Przypadek E01: żądania ze zdarzeniem bezpieczeństwa w logu: 3/3 → spełnione

## Scenariusz H (powtórzone podobne zgłoszenie)

- H-olsztyn: werdykty BRAK_DOWODOW, BRAK_DOWODOW; nowe sprawy: 1; spełnione
- H-elblag: werdykty BRAK_DOWODOW, BRAK_DOWODOW; nowe sprawy: 2; NIESPEŁNIONE: utworzono 2 spraw zamiast co najwyżej jednej
