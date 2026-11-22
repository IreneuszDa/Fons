# Podłączenie ChatLoom do Fons

Konektor działa na prywatnym urządzeniu operatora, na zalogowanym kliencie ChatLoom. Korzysta z kluczy odszyfrowania i mostów skonfigurowanych na dedykowanym koncie Fons. Przekazuje tekst, zdjęcia, głosówki, reakcje i ich wycofanie. Odpowiedź tekstową i dostępną reakcję wysyła w tej samej rozmowie. SMS, iMessage i WhatsApp można uruchomić po podłączeniu odpowiednich mostów do tego konta. [Kod ChatLoom użyty przy integracji](https://github.com/siudajakub/chatloom/tree/898aaad370f5fb8b065dacd83bab236751c287e2)

1. Skonfiguruj numer lub konta sieciowe operatora w Beeper/ChatLoom. Na dedykowanym urządzeniu zaloguj się do konta Fons, odblokuj historię kluczem odzyskiwania i poczekaj na pierwszą synchronizację.
2. Adres `webhook` to `https://<adres-fons>/api/channels/chatloom/webhook`. Na serwerze Fons ustaw `CHATLOOM_WEBHOOK_SECRET` i uruchom serwer z publicznym `PUBLIC_BASE_URL`, żeby linki do wyników dało się otworzyć z telefonu. Przekaż ten sam sekret do lokalnej konfiguracji operatora na urządzeniu. Sekret należy wyłącznie do operatora. Zapisz go w magazynie sekretów urządzenia, poza publicznym buildem aplikacji i frontendem Fons.
3. Skopiuj `attach_fons.dart` oraz `fons_connector.dart` do `lib/personal/` w prywatnym checkoutcie ChatLoom. Zależności `http`, `crypto`, `mime` i lokalny `packages/matrix` są już w jego `pubspec.yaml`.
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

Zdjęcie (`m.image`) lub głosówka (`m.audio`) zawiera w `content.attachment` pola `mime` i `base64` z bajtami pliku pobranego i odszyfrowanego przez klienta. Pole `content.caption` przekazuje podpis zdjęcia zgodnie z polami `body` i `filename` zdarzenia Matrix. Konektor zachowuje też identyfikator wskazanego zdarzenia w `m.relates_to.m.in_reply_to`. [Specyfikacja podpisów Matrix](https://spec.matrix.org/v1.17/client-server-api/#media-captions)

Konektor ustawia `media_context: true` na najwyższym poziomie żądania i przesyła zdjęcia niezależnie od kolejki odpowiedzi tekstowych. Pytanie może wtedy poczekać do 12 sekund na dosłane zdjęcie. Ostatnie zdjęcia są dostępne przez maksymalnie 5 minut do pytań odwołujących się do obrazu lub odpowiedzi bezpośrednich. Głosówka trafia do rozmowy jako transkrypcja, także gdy pytanie dotyczy zdjęcia. Włącz tę obsługę na serwerze z `OPENAI_API_KEY`, `ffmpeg` i `ffprobe`. Limit pliku zdjęcia wynosi 5 MiB, a nagrania 20 MiB. Jeśli webhook działa za proxy, ustaw dla niego limit ciała żądania co najmniej 27 MiB.

Klient musi działać i synchronizować się, by odbierać wiadomości. Konektor nasłuchuje nowych zdarzeń od momentu uruchomienia, w tym wiadomości, dla których klucz odszyfrowania dotarł później. Pomija historię, grupy, własne wiadomości oraz zdarzenia osób innych niż rozpoznany rozmówca. Kolejka i ponowienia działają w pamięci uruchomionego klienta. Chwilowe błędy transportu ponawia przez maksymalnie około 10 minut, z tymi samymi identyfikatorami transakcji Matrix. Dla dłuższej niedostępności wywołuje `onFailure`. Po zatrzymaniu klienta nie odtwarza kolejki z dysku. Gdy most nie obsługuje proponowanej reakcji, użytkownik nadal dostaje odpowiedź tekstową.

Formularz na `/telefon` wysyła numer i zgodę do `POST /api/signup/whatsapp`. Serwer przekazuje zgłoszenie do działającej usługi zapisów pod adresem `https://fons.siuda.dev`. Status `pending` oznacza przyjęcie prośby do kolejki operatora. Gdy instalujesz ten serwer pod tym samym adresem, skieruj tę trasę do dotychczasowej usługi operatora lub ustaw `WHATSAPP_SIGNUP_ORIGIN` na osobny adres HTTPS tej usługi.
