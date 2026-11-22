import { expect, it } from "vitest";
import { asksForTranscript } from "./intake";

it.each([
  "Co zostało powiedziane w tym nagraniu?", "Co mówi ta osoba na nagraniu?",
  "Proszę o transkrypcję nagrania", "Czy możesz przepisać to nagranie?",
  "Przepisz nagranie słowo w słowo.", "Co słychać w nagraniu?",
])("rozpoznaje prośbę o sam zapis mowy: %s", text => expect(asksForTranscript(text)).toBe(true));

it.each([
  "", "Czy to prawda?", "Przepisz i sprawdź wypowiedź.", "Sprawdź transkrypcję.",
  "Czy to, co zostało powiedziane na nagraniu, jest prawdziwe?",
  "Przepisz nagranie i powiedz, kiedy to było.",
])("pozostawia sprawdzenie twierdzeń i pytań w dotychczasowym trybie: %s", text => expect(asksForTranscript(text)).toBe(false));
