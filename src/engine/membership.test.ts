import { describe, expect, it } from "vitest";
import { readCorpus } from "../corpus/files";
import type { CorpusRecord, CorpusStore } from "../shared/contracts";
import { memoryStore } from "./testing/stubs";
import { membershipEntries, parseMembership } from "./membership";
import { verifyInput, type EngineDeps } from "./verify";
import { FakeLlmProvider } from "./llm/fake";

const records = readCorpus().records.filter(r => r.sourceId === "eu-portal" || r.sourceId === "nato");
const now = new Date("2026-11-22T12:00:00Z");
function entries(text: string, source: CorpusStore = memoryStore(records)) {
  return membershipEntries(source, parseMembership(text)!, now) ?? [];
}
describe("bieżące członkostwo państw w wykazach instytucji", () => {
  it.each([
    ["Niemcy należą do Unii Europejskiej.", true, false],
    ["Czy Chorwacja nie jest członkiem NATO?", true, true],
    ["Albania jest w UE.", false, false],
    ["Czy Serbia nie należy do UE?", false, true],
    ["Czy Czechy obecnie są w NATO?", true, false],
  ] as const)("%s", (text, member, negated) => {
    const q = parseMembership(text)!;
    expect(q.negated).toBe(negated);
    const found = entries(text);
    expect(found.length).toBeGreaterThan(0);
    for (const entry of found) {
      expect(entry.member).toBe(member);
      expect(entry.record.text).toContain(entry.quote);
    }
  });
  it.each(["Czy Niemcy należą do NATO od 1955 roku?", "Czy Niemcy i Austria należą do NATO?", "Czy jeżeli Serbia jest w UE?",
    "Czy Ukraina będzie członkiem UE?", "Kto jest członkiem UE?", "Nie jest prawdą, że Polska nie jest w NATO.",
    "Czy Czechy są członkiem UE, a jeśli tak, to od kiedy?", "Czy miasto należy do NATO?", "Czy Austria była członkiem UE?",
    "Czy Czechy są w strefie euro?", "Czy Szwecja już nie jest członkiem NATO?"])("przekazuje pozostałą składnię zwykłemu silnikowi: %s", text => {
    expect(parseMembership(text)).toBeUndefined();
  });
  it("wyprowadza nieczłonkostwo tylko z kompletnego świeżego wykazu", () => {
    const question = "Norwegia nie jest członkiem UE.";
    const complete = entries(question)[0]!;
    expect(complete).toMatchObject({ member: false, complete: true, country: "Norwegia" });
    expect(complete.quote).toContain("Liczba państw");
    expect(entries(question, memoryStore(records.filter(r => !r.topics.includes("pelny-wykaz-czlonkow"))))).toEqual([]);
    const parts = complete.record.text.split("\n");
    const names = parts[1]!.slice(0, -1).split(", ");
    for (const altered of [names.slice(1), [...names.slice(1), names[1]!], [...names.slice(1), "nieznany podmiot"]]) {
      const damaged = { ...complete.record, text: parts[0] + "\n" + altered.join(", ") + "." };
      expect(entries(question, memoryStore([damaged]))).toEqual([]);
    }
    for (const fetchedAt of ["2026-09-01", "2026-12-01"]) {
      expect(entries(question, memoryStore([{ ...complete.record, fetchedAt }]))).toEqual([]);
    }
  });
  it("pomija stare i przyszłe odczyty oraz podmieniony wiersz dla innego państwa", () => {
    const text = "Czy Grecja jest w NATO?";
    const original = entries(text)[0]!.record;
    for (const fields of [
      { fetchedAt: "2026-09-01" }, { fetchedAt: "2027-01-01" }, { sourceId: "inne" }, { level: 3 },
      { text: original.text.replace("Greece 1952", "Germany 1955") },
    ] as Partial<CorpusRecord>[]) expect(entries(text, memoryStore([{ ...original, ...fields }]))).toEqual([]);
  });
  it("błąd odczytu nie staje się pustym wykazem", () => {
    expect(() => entries("Czy Austria jest w UE?", { ...memoryStore([]), catalogPage: () => { throw new Error("SQLite"); } })).toThrow("SQLite");
  });
  it("sprzeczne statusy oraz niedostępny wykaz nie generują stanowczej odpowiedzi", async () => {
    const candidate = entries("Serbia jest w UE.")[0]!.record;
    const source = entries("Austria jest w UE.")[0]!.record;
    const contradictory: CorpusRecord = { ...source, title: source.title.replace("Austria", "Serbia"), text: source.text.replace(/Austrii/g, "Serbii") };
    const store = memoryStore([candidate, contradictory]);
    const model = new FakeLlmProvider();
    const deps = { store, llm: model, verifier: model, db: {} as EngineDeps["db"], branches: [], singleKey: false,
      fetchPage: async () => { throw new Error("unused"); }, now: () => now, verdictMode: "rules" } satisfies EngineDeps;
    const input = { kind: "text", text: "Serbia jest w UE.", channel: "web", receivedAt: now.toISOString() } as const;
    const contradictoryReport = await verifyInput(input, deps);
    expect(contradictoryReport).toMatchObject({ status: "OK", mainVerdict: "BRAK_DOWODOW" });
    expect(contradictoryReport.verdicts[0]?.registerFactPl).toBeUndefined();
    const down = await verifyInput(input, { ...deps, store: { ...store, catalogPage: () => { throw new Error("unavailable"); } } });
    expect(down).toMatchObject({ status: "NIEPELNE", mainVerdict: null, unavailableBranches: ["official_membership"] });
  });
});
