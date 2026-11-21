/** Teksty dla użytkownika (prosty polski) używane przez reguły werdyktu i kartę siły. */
import type { Aspect } from "../../shared/contracts";

export const ASPECT_PL: Record<Aspect, string> = {
  sedno: "główna treść",
  czas: "czas (data)",
  miejsce: "miejsce",
  liczba: "liczba lub kwota",
  autorstwo: "autor (kto to powiedział lub zrobił)",
  zakres: "zakres (kogo lub czego to dotyczy)",
};

export function aspectList(aspects: Aspect[]): string {
  const names = [...new Set(aspects)].map((a) => ASPECT_PL[a]);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} i ${names[names.length - 1]}`;
}

/** Polska odmiana: 1 dowód, 2–4 dowody, 5+ dowodów (12–14 → dowodów). */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return few;
  return many;
}

export function countEvidence(n: number): string {
  return `${n} ${plural(n, "dowód", "dowody", "dowodów")}`;
}

export const NOTE = {
  singleKey:
    "Drugi model sprawdzający jest z tej samej rodziny (ten sam dostawca) co pierwszy — to słabsza kontrola, więc o sile decyduje głównie liczba zgodnych, niezależnych źródeł.",
  verifierUnsure: "Model sprawdzający nie był pewien części cytatów — siła obniżona.",
  verifierPartial: "Model sprawdzający ocenił tylko część dowodów.",
  vetoed: (n: number) => `Model sprawdzający zakwestionował ${countEvidence(n)} — nie liczymy ich.`,
  belowThreshold: (n: number) =>
    `Znaleźliśmy ${countEvidence(n)} poniżej progu (np. tylko jedno źródło wtórne albo ocena nieznana) — to za mało na werdykt.`,
  noEvidence: "Nie znaleźliśmy w wiarygodnych źródłach niczego, co pozwala to rozstrzygnąć.",
  archival: "Najnowszy dowód ma ponad 2 lata — sytuacja mogła się zmienić.",
  archivalRule4: "Część źródeł jest nieaktualna — nowsze dane urzędowe mówią co innego.",
  eventNewer: "Zdarzenie jest nowsze niż najnowsze źródła, które mamy. Starsze podobne zdarzenie go nie obala.",
  conflict: "Wiarygodne źródła są ze sobą sprzeczne. Nie wskazujemy, które ma rację.",
  conflictDifferentPeriods: "Sprzeczne źródła mogą dotyczyć różnych okresów — sprawdź daty.",
  superseded: "Starsze źródło mówiło inaczej, ale nowsze dane urzędowe je zastępują.",
  onlyDetails: "Źródła mówią tylko o szczegółach, a nie o głównej treści informacji.",
  opinion: "To opinia albo przewidywanie, a nie fakt, który można sprawdzić w źródłach.",
  fixedRole: "Werdykt pochodzi z oceny w bazie sprawdzonych informacji (fact-check).",
  noDates: "Źródła nie mają podanej daty — nie da się ocenić, czy są aktualne.",
  reducesToSlot: (aspect: Aspect, claim: string[], quote: string[]) => {
    const what = aspect === "czas" ? "podają inną datę" : aspect === "liczba" ? "podają inną liczbę" : "mówią co innego";
    const vals = (xs: string[]) => xs.map((x) => `„${x}”`).join(", ");
    const cmp =
      claim.length > 0 && quote.length > 0
        ? ` Kod (bez modeli) porównał: źródło podaje ${vals(quote)}, a twierdzenie ${vals(claim)}.`
        : "";
    return `Twierdzenie sprowadza się do jednego szczegółu (${ASPECT_PL[aspect]}), a źródła ${what} — dlatego to fałsz, a nie tylko brak kontekstu.${cmp}`;
  },
} as const;
