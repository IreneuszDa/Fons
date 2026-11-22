import { describe, expect, it } from "vitest";
import { createDemoBridge } from "../../integrations/chatloom/demo";
import { citizenAnswerPl } from "../shared/citizen-answer";
import type { Verdict } from "../shared/contracts";
import { chat, makeEnv, makeReport } from "./testkit";

describe("krótka odpowiedź obywatelowi", () => {
  it.each([
    ["POTWIERDZONE", "Tak."], ["FALSZYWE", "Nie."], ["BRAK_DOWODOW", "Nie wiem."],
    ["WPROWADZAJACE", "Nie w tej formie."],
  ] as const)("zwraca %s przez WWW i adapter, z osobnym zapisanym raportem", async (verdict, lead) => {
    const claim = "Wystawa jest otwarta przez cały tydzień.";
    const env = makeEnv({ cfg: { chatloomWebhookSecret: "local-demo" }, engine: () => makeReport({ verdict, claim }) });
    try {
      const { reply } = (await chat(env, { text: claim })).json;
      const bridge = createDemoBridge(req => env.app.fetch(req), "local-demo", () => env.clock.now);
      const sms = await bridge(claim);
      expect(reply.shortAnswer.bodyPl.startsWith(lead)).toBe(true);
      expect(reply.shortAnswer.bodyPl.length).toBeLessThan(200);
      expect(sms.startsWith(reply.shortAnswer.bodyPl)).toBe(true);
      expect(sms).not.toContain("Możesz odpowiedzieć");
      expect(sms).toContain("/w/");
      expect(env.db.prepare("SELECT channel, verdict FROM runs ORDER BY seq").all()).toEqual([
        { channel: "web", verdict }, { channel: "chatloom", verdict },
      ]);
      expect(env.db.prepare("SELECT COUNT(*) AS n FROM reports").get()).toEqual({ n: 2 });
    } finally { env.db.close(); }
  });

  it("przy odpowiedzi przeczącej pokazuje wyłącznie sprawdzony polski fragment stanowiący podstawę", () => {
    const report = makeReport({ verdict: "FALSZYWE", claim: "Kadencja trwa rok." });
    const item = report.verdicts[0]!.evidence[0]!;
    Object.assign(item, { relation: "OBALA", lang: "pl", passageKind: "excerpt", quote: "Kadencja trwa dwa lata." });
    expect(citizenAnswerPl(report)).not.toContain("dwa lata");
    item.usedForVerdict = true;
    expect(citizenAnswerPl(report)).toBe("Nie. „Kadencja trwa dwa lata.”");
    item.passageKind = "reviewed_claim";
    expect(citizenAnswerPl(report)).not.toContain("dwa lata");
  });

  it("nazywa każdą składową, sprzeczność, opinię i awarię osobno", () => {
    const report = makeReport({ verdict: "WPROWADZAJACE" });
    report.verdicts[0]!.parts = [{ text: "Bilet obejmuje autobus.", verdict: "POTWIERDZONE" }, { text: "Bilet obejmuje prom.", verdict: "FALSZYWE" }];
    expect(citizenAnswerPl(report)).toMatch(/autobus” — tak.+prom” — nie/);
    report.verdicts[0]!.verdict = "BRAK_DOWODOW" satisfies Verdict;
    report.verdicts[0]!.conflicting = { supporting: ["s"], refuting: ["r"] };
    expect(citizenAnswerPl(report)).toBe("Nie wiem. Źródła podają sprzeczne informacje.");
    report.verdicts[0]!.verdict = "NIE_PODLEGA";
    report.claims[0]!.type = "opinia";
    expect(citizenAnswerPl(report)).toBe("To opinia.");
    report.status = "AWARIA";
    report.statusMessagePl = "Serwis jest chwilowo niedostępny.";
    expect(citizenAnswerPl(report)).toBe(report.statusMessagePl);
  });
});
