import { describe, expect, it } from "vitest";
import { chat, makeEnv, makeReport } from "./testkit";

const evidence = {
  recordId: "eli:ustawa-1",
  title: "Ustawa o ochronie konkurencji",
  publisher: "Sejm RP",
  publishedAt: "2024-03-01",
  fetchedAt: "2026-11-01",
  url: "https://eli.gov.pl/akt/42",
  quote: "Prezes Urzędu jest centralnym organem administracji rządowej.",
  relation: "WSPIERA" as const,
  aspect: "sedno" as const,
  sourceType: "pierwotne" as const,
  level: 1 as const,
  role: "tresc" as const,
  group: "wspierajace" as const,
};

const answerReport = (text: string) =>
  makeReport({
    claim: text,
    inputMode: "question_open",
    verdicts: [],
    mainVerdict: null,
    summaryPl: "Znalazłem odpowiedź w źródle.",
    answer: {
      questionPl: text,
      answerPl: "Według Sejm RP (2024-03-01): «Prezes Urzędu jest centralnym organem administracji rządowej.»",
      evidence: [evidence],
    },
  });

describe("tryb odpowiedzi na pytanie otwarte", () => {
  it("raport z answer → odpowiedź kind=answer z answerPl i odnośnikiem do źródła", async () => {
    const env = makeEnv({ engine: (r) => answerReport(r.text ?? "") });
    const c = await chat(env, { text: "Kim jest Prezes UOKiK?" });
    expect(c.status).toBe(200);
    const reply = c.json.reply;
    expect(reply.kind).toBe("answer");
    expect(reply.textPl).toContain("Według Sejm RP (2024-03-01): «Prezes Urzędu jest centralnym organem administracji rządowej.»");
    expect(reply.textPl).toContain("Źródło: Ustawa o ochronie konkurencji (Sejm RP): https://eli.gov.pl/akt/42");
    expect(reply.textPl).not.toContain("Wynik:"); // to nie werdykt
    expect(reply.report.answer.evidence).toHaveLength(1);
    expect(reply.resultUrl).toContain("/w/");
    expect(reply.quickReplies.map((q: any) => q.id)).not.toContain("report");
  });

  it("źródła i „dlaczego” działają dla odpowiedzi (cytat ze źródła, bez werdyktu)", async () => {
    const env = makeEnv({ engine: (r) => answerReport(r.text ?? "") });
    const c = await chat(env, { text: "Kim jest Prezes UOKiK?" });
    const src = await chat(env, { action: "sources" }, c.cookie);
    expect(src.json.reply.kind).toBe("sources");
    expect(src.json.reply.textPl).toContain("Ustawa o ochronie konkurencji");
    expect(src.json.reply.textPl).toContain("Prezes Urzędu jest centralnym organem");
    expect(src.json.reply.textPl).not.toContain("nie ma źródeł");
    const why = await chat(env, { action: "why" }, c.cookie);
    expect(why.json.reply.kind).toBe("why");
    expect(why.json.reply.textPl).toContain("dosłowny cytat");
  });

  it("dziennik przebiegów zawiera rekord z answer.evidence, a log JSON ma inputMode", async () => {
    const env = makeEnv({ engine: (r) => answerReport(r.text ?? "") });
    await chat(env, { text: "Kim jest Prezes UOKiK?" });
    const row = env.db.prepare("SELECT record_ids_json FROM runs").get() as any;
    expect(JSON.parse(row.record_ids_json)).toEqual(["eli:ustawa-1"]);
    const v = env.logs.map((l) => JSON.parse(l)).find((l) => l.event === "verification");
    expect(v.inputMode).toBe("question_open");
  });

  it("pytanie otwarte bez answer → zwykła odpowiedź verdict z podsumowaniem (BRAK_DOWODOW), bez udawania odpowiedzi", async () => {
    const env = makeEnv({
      engine: (r) => makeReport({ verdict: "BRAK_DOWODOW", claim: r.text, inputMode: "question_open", summaryPl: "Nie znalazłem w źródłach odpowiedzi na to pytanie." }),
    });
    const c = await chat(env, { text: "Kim jest Prezes UOKiK?" });
    expect(c.json.reply.kind).toBe("verdict");
    expect(c.json.reply.textPl).toContain("Nie znalazłem w źródłach odpowiedzi na to pytanie.");
    expect(c.json.reply.report.answer).toBeUndefined();
  });

  it("pytanie otwarte bez answer i bez werdyktu → podsumowanie jako verdict; status techniczny nadal kind=status", async () => {
    const env = makeEnv({
      engine: (r) => makeReport({ claim: r.text, inputMode: "question_open", verdicts: [], mainVerdict: null, summaryPl: "Brak odpowiedzi w źródłach." }),
    });
    const c = await chat(env, { text: "Kto jest sekretarzem generalnym NATO?" });
    expect(c.json.reply.kind).toBe("verdict");
    expect(c.json.reply.textPl).toBe("Brak odpowiedzi w źródłach.");
    const st = makeEnv({ engine: (r) => makeReport({ claim: r.text, inputMode: "question_open", status: "NIEPELNE", mainVerdict: null, verdicts: [] }) });
    expect((await chat(st, { text: "Kto jest sekretarzem generalnym NATO?" })).json.reply.kind).toBe("status");
  });

  it("odpowiedź z cache jest nadal odpowiedzią (kind=answer), z nowym tokenem", async () => {
    const env = makeEnv({ engine: (r) => answerReport(r.text ?? "") });
    const a = await chat(env, { text: "Kim jest Prezes UOKiK?" });
    const b = await chat(env, { text: "Kim jest Prezes UOKiK?" }, a.cookie);
    expect(env.calls).toHaveLength(1);
    expect(b.json.reply.kind).toBe("answer");
    expect(b.json.reply.report.cacheHit).toBe(true);
    expect(b.json.reply.report.token).not.toBe(a.json.reply.report.token);
  });

  it("renderery kanałów CLI i WWW obsługują kind=answer (tekst + odnośnik do wyniku)", async () => {
    const env = makeEnv({ engine: (r) => answerReport(r.text ?? "") });
    const c = await chat(env, { text: "Kim jest Prezes UOKiK?" });
    for (const id of ["web", "cli"]) {
      const out = env.ctx.channels.get(id)!.render(c.json.reply);
      expect(out, id).toContain("Według Sejm RP");
      expect(out, id).toContain("Pełny wynik ze źródłami:");
    }
  });
});
