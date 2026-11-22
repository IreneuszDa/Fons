/**
 * User-facing Polish texts of the engine (plain language). Never include provider error text.
 */
import type { ReportWarning } from "../shared/contracts";

export const STATUS_PL = {
  llmNotConfigured:
    "Nie mogę teraz sprawdzić tej informacji, bo model językowy nie jest skonfigurowany. Nie wydaję oceny. Administrator usługi musi dodać klucz dostępu.",
  llmDown:
    "Nie mogę teraz sprawdzić tej informacji, bo model językowy jest chwilowo niedostępny. Nie wydaję oceny. Spróbuj ponownie za kilka minut.",
  llmBudget:
    "Usługa wykorzystała dzisiejszy limit sprawdzeń. Nie wydaję oceny. Spróbuj ponownie jutro.",
  corpusDown:
    "Nie mogę teraz przeszukać bazy wiarygodnych źródeł. Nie wydaję oceny. Spróbuj ponownie za kilka minut.",
  pageUnreadable:
    "Nie udało się otworzyć tej strony. Nie wydaję oceny. Skopiuj i wklej tekst, który chcesz sprawdzić.",
  pageBlocked:
    "Tego adresu nie otwieram ze względów bezpieczeństwa. Nie wydaję oceny. Skopiuj i wklej tekst, który chcesz sprawdzić.",
  pageEmpty:
    "Na tej stronie nie znalazłem tekstu do sprawdzenia. Skopiuj i wklej fragment, który chcesz sprawdzić.",
  imageUnreadable:
    "Nie znalazłem na obrazie czytelnego tekstu do sprawdzenia. Możesz dopisać, jaką informację mam zweryfikować.",
  imageUnavailable:
    "Nie mogę teraz odczytać tekstu z obrazu. Nie wydaję oceny. Wpisz albo wklej tekst, który chcesz sprawdzić.",
  emptyInput: "Napisz albo wklej informację, którą mam sprawdzić.",
  badUrl: "Ten adres wygląda na niepoprawny. Wklej pełny adres strony (zaczynający się od https://) albo sam tekst.",
  noClaims:
    "Nie znalazłem w tej wiadomości twierdzenia, które da się sprawdzić. Napisz to inaczej — jednym zdaniem: co, kto, kiedy.",
  systemError: "Wystąpił błąd systemu. Nie wydaję oceny. Spróbuj ponownie za chwilę.",
} as const;

export const WARNING_PL = {
  injection: "W materiale wykryto próbę wpłynięcia na działanie systemu. Zignorowaliśmy ją.",
  archival:
    "Część dowodów to materiał archiwalny: starsze źródło mówiło co innego niż nowsze dane. Zwróć uwagę na daty.",
  singleKey:
    "Cytaty sprawdził drugi model tego samego dostawcy co model główny (tryb jednego klucza). To słabsza kontrola niż model innego dostawcy, dlatego siła oceny zależy głównie od liczby zgodnych, niezależnych źródeł — szczegóły w karcie siły dowodów.",
  verifierUnavailable:
    "Nie udało się uzyskać niezależnego sprawdzenia cytatów, dlatego siła oceny jest obniżona.",
  imageLimits:
    "Automatyczny odczyt tekstu z obrazu może zawierać błędy. Dane widoczne na obrazie trafiają do modelu wizyjnego.",
  truncated: "Wiadomość była bardzo długa — sprawdziliśmy tylko jej początek.",
} as const;

export function branchUnavailablePl(branchId: string, partial = false): string {
  if (partial) return `Część wyszukiwań nie powiodła się w obszarze „${branchNamePl(branchId)}”. Uwzględniliśmy dostępne wyniki.`;
  return `Wyszukiwanie było niedostępne w obszarze „${branchNamePl(branchId)}”.`;
}

/** Polish name of a retrieval branch (ids are owned by the retrieval module; matched loosely). */
export function branchNamePl(id: string): string {
  const s = id.toLowerCase();
  if (s === "google_claimreview") return "indeks Google Fact Check Tools";
  if (s === "publications") return "publikacje źródłowe w katalogu";
  if (s === "catalog_url") return "dopasowanie adresu publikacji do korpusu";
  if (s === "local_transport") return "dokumenty dotyczące transportu w tej miejscowości";
  if (s === "official_membership") return "oficjalny wykaz członkostwa w NATO lub UE";
  if (s === "official_rate_series") return "bieżące i historyczne dane GUS lub NBP";
  if (s === "office_history") return "urzędowe publikacje o kadencjach";
  if (s === "sejm_club_register") return "wykazy klubów i imienne głosowania Sejmu";
  if (s === "subject_profiles") return "źródła pierwotne o wskazanych podmiotach";
  if (s === "cited_catalog_page") return "wskazana publikacja ze zbioru źródeł pierwotnych";
  if (s.includes("official")) return "oficjalne kanały instytucji";
  if (s.includes("live")) return "wyszukiwanie na żywo w serwisach z katalogu źródeł";
  if (s.includes("vector") || s.includes("embed") || s.includes("wektor")) return "wyszukiwanie po znaczeniu";
  if (s.includes("incident") || s.includes("incydent")) return "baza incydentów dezinformacyjnych";
  if (s.includes("connector") || s.includes("eli") || s.includes("isap") || s.includes("sejm")) return "serwis aktów prawnych (konektor)";
  if (s.includes("bm25") || s.includes("corpus") || s.includes("fts") || s.includes("korpus")) return "baza wiarygodnych źródeł";
  return id;
}

export function nonEeaPl(providerLabel: string, processedImage = false): string {
  if (processedImage) return `Obraz przetworzył model ${providerLabel} na serwerach w Stanach Zjednoczonych, poza Europejskim Obszarem Gospodarczym. Dane widoczne na obrazie mogły zostać odczytane.`;
  return `Tekst (po ukryciu danych osobowych) przetworzył model ${providerLabel} na serwerach w Stanach Zjednoczonych, czyli poza Europejskim Obszarem Gospodarczym.`;
}

export function incidentPl(titles: string[]): string {
  const list = titles.slice(0, 3).map((t) => `„${t}”`).join(", ");
  return `Podany adres prowadzi do domeny lub profilu wskazanego w opisie wcześniejszego incydentu (${list}). Ocenę obecnej treści ustalamy osobno na podstawie dowodów.`;
}

export function warning(kind: ReportWarning["kind"], textPl: string, links?: ReportWarning["links"]): ReportWarning {
  return { kind, textPl, ...(links?.length ? { links } : {}) };
}
