/**
 * Kalibracja deduplikacji spraw na prawdziwym modelu multilingual-e5-small (lokalny cache transformers.js).
 * Wyłączony domyślnie (model ~120 MB, ładowanie kilka sekund):
 *   RUN_E5_TESTS=1 npx vitest run src/server/moderator-e5.integration.test.ts
 */
import { describe, expect, it } from "vitest";
import { createE5Embedder } from "../engine/retrieval/embedder";
import { chat, makeEnv, makeReport } from "./testkit";

const brak = (req: { text?: string }) => makeReport({ verdict: "BRAK_DOWODOW", claim: req.text ?? "x" });

const GROUPS: Record<string, string[]> = {
  "H-elblag": [
    "W zeszły czwartek w Elblągu wojsko rozdało mieszkańcom maski przeciwgazowe.",
    "Podobno w Elblągu w ubiegły czwartek żołnierze rozdawali ludziom maski przeciwgazowe.",
  ],
  "H-olsztyn": [
    "Wczoraj w Olsztynie otwarto tajny ośrodek dla migrantów przerzucanych z Białorusi.",
    "Słyszałem, że wczoraj w Olsztynie otworzyli tajny ośrodek dla migrantów z Białorusi.",
  ],
  "H-paliwo": [
    "Od jutra na stacjach Orlenu na Lubelszczyźnie zabraknie oleju napędowego, bo Białoruś blokuje dostawy.",
    "Słyszałem, że Białoruś zablokowała dostawy i od jutra na Lubelszczyźnie Orlen nie będzie miał diesla. To prawda?",
  ],
};
const NEGATIVES = [
  "W zeszły czwartek w Gdańsku wojsko rozdało mieszkańcom maski przeciwgazowe.",
  "W zeszły czwartek w Elblągu policja rozdała mieszkańcom ulotki o oszustach.",
  "Wczoraj w Olsztynie otwarto nowy basen miejski.",
  "Od jutra na stacjach Orlenu na Podkarpaciu zabraknie benzyny.",
  "Wczoraj w Rzeszowie otwarto tajny ośrodek dla migrantów przerzucanych z Białorusi.",
];

describe.skipIf(!process.env.RUN_E5_TESTS)("deduplikacja spraw — prawdziwy model e5", () => {
  it("każda para parafraz = jedna sprawa; negatywy = osobne sprawy", { timeout: 300_000 }, async () => {
    const env = makeEnv({ engine: brak });
    const embedder = createE5Embedder({ offline: true });
    env.ctx.embedClaims = (texts) => embedder.embed(texts, "query");
    await embedder.embed(["rozgrzewka"], "query");
    const caseIds = new Map<string, Set<string>>();
    for (const [group, texts] of Object.entries(GROUPS)) {
      for (const text of texts) {
        const r = await chat(env, { text });
        const set = caseIds.get(group) ?? new Set<string>();
        set.add(r.json.reply.report.moderatorCase.caseId);
        caseIds.set(group, set);
      }
    }
    for (const [group, ids] of caseIds) expect(ids.size, group).toBe(1);
    const negIds = [];
    for (const text of NEGATIVES) negIds.push((await chat(env, { text })).json.reply.report.moderatorCase.caseId as string);
    const groupIds = [...caseIds.values()].flatMap((s) => [...s]);
    expect(new Set([...groupIds, ...negIds]).size).toBe(groupIds.length + NEGATIVES.length);
  });
});
