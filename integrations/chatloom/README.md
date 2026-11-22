# Podłączenie ChatLoom do Fons

Konektor działa na prywatnym urządzeniu operatora, na zalogowanym kliencie ChatLoom. Korzysta z kluczy odszyfrowania i mostów skonfigurowanych na dedykowanym koncie Fons. Przekazuje tekst, reakcje i ich wycofanie. Odpowiedź tekstową i dostępną reakcję wysyła w tej samej rozmowie. SMS, iMessage i WhatsApp można uruchomić po podłączeniu odpowiednich mostów do tego konta. [Kod ChatLoom użyty przy integracji](https://github.com/siudajakub/chatloom/tree/898aaad370f5fb8b065dacd83bab236751c287e2)

1. Skonfiguruj numer lub konta sieciowe operatora w Beeper/ChatLoom. Na dedykowanym urządzeniu zaloguj się do konta Fons, odblokuj historię kluczem odzyskiwania i poczekaj na pierwszą synchronizację.
2. Adres `webhook` to `https://<adres-fons>/api/channels/chatloom/webhook`. Na serwerze Fons ustaw `CHATLOOM_WEBHOOK_SECRET` i uruchom serwer z publicznym `PUBLIC_BASE_URL`, żeby linki do wyników dało się otworzyć z telefonu. Przekaż ten sam sekret do lokalnej konfiguracji operatora na urządzeniu. Sekret należy wyłącznie do operatora. Zapisz go w magazynie sekretów urządzenia, poza publicznym buildem aplikacji i frontendem Fons.
3. Skopiuj `attach_fons.dart` oraz `fons_connector.dart` do `lib/personal/` w prywatnym checkoutcie ChatLoom. Zależności `http`, `crypto` i lokalny `packages/matrix` są już w jego `pubspec.yaml`.
4. W `lib/widgets/matrix.dart` trzymaj jeden `FonsConnector` dla dedykowanego klienta. Wywołaj `attachFons` z `_registerSubs` w bloku `!kIsWeb && c.isLogged()`, raz dla skonfigurowanego `c.userID`. W `_cancelSubs` oraz `dispose` wywołaj `close()` i usuń referencję. Po zmianie konfiguracji utwórz nową instancję. [Miejsce podłączenia](https://github.com/siudajakub/chatloom/blob/898aaad370f5fb8b065dacd83bab236751c287e2/lib/widgets/matrix.dart#L418)

Do `MatrixState` dodaj pole `final fonsByClient = <String, FonsConnector>{};`. Zaimportuj `personal/attach_fons.dart` i `personal/fons_connector.dart` z pakietu `chatloom`. Poniższe wartości `operatorMatrixId`, `webhook`, `operatorSecret` i `protocolByBot` pochodzą z lokalnej konfiguracji operatora.

```dart
// W _registerSubs, po zalogowaniu klienta c.
if (c.userID == operatorMatrixId) {
  fonsByClient.putIfAbsent(c.clientName, () => attachFons(
    client: c, operatorMatrixId: operatorMatrixId, webhook: webhook,
    operatorSecret: operatorSecret, protocolByBot: protocolByBot,
  ));
}
// W _cancelSubs(name).
unawaited(fonsByClient.remove(name)?.close());
// W dispose().
for (final connector in fonsByClient.values) { unawaited(connector.close()); }
```


Dla każdej sieci odczytaj ze stanu pokoju operatora identyfikator Matrix bota (`bridgebot`) i dokładne `protocol.id`. Do mapy `protocolByBot` wpisz identyfikator bota jako klucz i `protocol.id` jako wartość. Konektor przyjmuje też nowe rozmowy prywatne utworzone przez taki most. Sprawdza tożsamość nadawcy deklaracji w stanie pokoju i członkostwo bota w pokoju. W konstruktorze `FonsConnector` dla pojedynczego pokoju testowego można przekazać `acceptsRoom: (room) => room.id == testRoomId`. Używaj dedykowanego konta, bo filtr bota i protokołu obejmuje wszystkie jego rozmowy prywatne na tym moście.

Żądanie `POST` przekazuje odszyfrowane zdarzenie Matrix z polami `room_id`, `sender`, `event_id`, `origin_server_ts`, `type` i `content`. Nagłówek `X-ChatLoom-Timestamp` zawiera sekundy Unix, a `X-ChatLoom-Signature` zawiera szesnastkowy HMAC-SHA256 z `timestamp + "." + surowe ciało UTF-8`, obliczony przy użyciu wspólnego sekretu. Fons zwraca `{ "actions": [...] }`. Przy ponowieniu tego samego zdarzenia zwraca te same identyfikatory `txn_id`, które klient przekazuje do `Room.sendEvent`.

Klient musi działać i synchronizować się, by odbierać wiadomości. Konektor nasłuchuje nowych zdarzeń od momentu uruchomienia, w tym wiadomości, dla których klucz odszyfrowania dotarł później. Pomija historię, grupy, własne wiadomości oraz zdarzenia osób innych niż rozpoznany rozmówca. Kolejka i ponowienia działają w pamięci uruchomionego klienta. Chwilowe błędy transportu ponawia przez maksymalnie około 10 minut, z tymi samymi identyfikatorami transakcji Matrix. Dla dłuższej niedostępności wywołuje `onFailure`. Po zatrzymaniu klienta nie odtwarza kolejki z dysku. Gdy most nie obsługuje proponowanej reakcji, użytkownik nadal dostaje odpowiedź tekstową.

## Zapis na WhatsAppie i skrzynka powitań

Publiczny formularz zapisu działa na osobnej stronie (https://fons.siuda.dev). Ekran `/telefon` w Fons tylko do niej kieruje i nie przechowuje numeru. Formularz wysyła `POST /api/signup/whatsapp` z JSON `{ "phone": "500 000 000", "consent": true }`. Fons przyjmuje 9 cyfr polskiego numeru albo pełny numer z `+` lub `00`, zapisuje go w E.164 i odpowiada `{ "ok": true, "status": "pending" | "sent" }`. Brak zgody daje `400 consent_required`, zły numer `400 invalid_phone`, a więcej niż 5 prób na minutę z jednego IP daje `429`. Żądanie wymaga `Content-Type: application/json`. Nagłówki `Origin` i `Sec-Fetch-Site`, jeśli są, muszą wskazywać host Fons lub `PUBLIC_BASE_URL`. Formularz z innej domeny musi więc wysyłać zapis z własnego backendu. Ponowny zapis tego samego numeru zwraca bieżący status i nie tworzy nowego powitania. Wyjątkiem jest wcześniejsza nieudana wysyłka. Numer znika po 30 dniach od ostatniej zmiany albo po „usuń moje dane” wysłanym z tego numeru. Logi zawierają tylko zamaskowany numer.

Przekaźnik operatora podpisuje oba żądania jak webhook: `X-ChatLoom-Timestamp` (sekundy Unix, okno 5 minut) i `X-ChatLoom-Signature` = hex HMAC-SHA256 z `timestamp + "." + surowe ciało`, z tym samym `CHATLOOM_WEBHOOK_SECRET`. Dla `GET` ciało jest pustym napisem. Bez sekretu oba adresy zwracają `501`, a przy złym podpisie `403`.

- `GET /api/channels/chatloom/outbox` zwraca `{ "items": [{ "id": "…", "phone": "+48500000000", "text": "…" }] }`. Lista zawiera najstarsze oczekujące powitania, maksymalnie 20. Wydane pozycje są zablokowane na 5 minut. Bez potwierdzenia wracają w kolejnym odpytaniu.
- `POST /api/channels/chatloom/outbox/:id` z `{ "status": "sent" }` albo `{ "status": "failed", "error": "…" }` zwraca `{ "ok": true }`. Powtórzone potwierdzenie niczego nie zmienia. Nieznany `id` daje `404`. Próba oznaczenia wysłanej pozycji jako nieudanej daje `409`. Fons zastępuje ciągi cyfr w `error` znacznikiem `[numer]`.

Odpowiedzi z WhatsAppa przekaźnik przesyła na `/api/channels/chatloom/webhook` jak zwykłe zdarzenia Matrix. Polecenie „usuń moje dane” usuwa też zapis numeru, jeśli część lokalna `sender` zawiera numer w postaci cyfr E.164, np. `@whatsapp_48500000000:relay`.

Konfiguracja numeru operatora i weryfikacja użytkowników należą do właściwego wdrożenia ChatLoom.
