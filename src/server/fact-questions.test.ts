import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCorpusStore, ensureCorpusLoaded } from "../corpus/store";
import { FakeLlmProvider } from "../engine/llm/fake";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseFences } from "../engine/llm/fence";
import { handleInbound } from "./conversation";
import type { CorpusRecord } from "../shared/contracts";
import { createBm25Branch } from "../engine/retrieval/bm25";
import { createDemagogTopicIndex } from "../engine/retrieval/demagog-topic";
import { PIPELINE_VERSION, verifyInput, type EngineDeps } from "../engine/verify";
import instructionExample from "../../tests/fixtures/web/reply-falszywe-injection.json";
import { chat, makeEnv } from "./testkit";

const fareQuestion = "Czy Wrocław był jedynym miastem w Polsce, w którym 65-latkowie jeździli komunikacją miejską za darmo?";
const reviewQuestion = "Czy Demagog sprawdzał, czy Wrocław był jedynym miastem z darmowymi przejazdami dla 65-latków?";
const reviewUrl = "https://demagog.org.pl/wypowiedzi/darmowa-komunikacja-dla-65-latkow-tylko-we-wroclawiu-sprawdzamy/";

describe("pytania obywatela przez publiczne kanały", () => {
  let env: ReturnType<typeof makeEnv>;
  let deps: EngineDeps;
  beforeEach(() => {
    env = makeEnv();
    ensureCorpusLoaded(env.db);
    const llm = new FakeLlmProvider({ available: false });
    deps = {
      llm, verifier: llm, singleKey: true, db: env.db, store: createCorpusStore(env.db),
      branches: [createBm25Branch(env.db)], fetchPage: vi.fn(), now: env.ctx.now, verdictMode: "rules",
    };
    env.ctx.engineDeps = deps;
    env.ctx.engine.verify = req => verifyInput(req, deps);
    env.ctx.engine.pipelineVersion = PIPELINE_VERSION;
    env.ctx.conversationAgent = async () => { throw Error("niedostępny model rozmowy"); };
  });
  afterEach(() => env.db.close());

  // Replace only the model at the network boundary. Its quote must come from the retrieved document.
  function quoteRetrieved(title: RegExp) {
    const model = new FakeLlmProvider({ override(req) {
      if (req.schemaName === "SourceAnswerCheck") return { supported: true };
      if (req.schemaName !== "SourceAnswer") return;
      const parts = parseFences(req.user).filter(f => f.label.startsWith("FRAGMENT_"));
      for (const part of parts) {
        const doc = JSON.parse(part.content) as { title: string; text: string; claimReviewed?: string; rating?: string };
        if (!title.test(doc.title)) continue;
        const quote = doc.text.split("\n").at(-1)!.split(/(?<=[.!?])\s/)[0]!.slice(0, 180);
        const ref = part.label.slice("FRAGMENT_".length);
        return { answerPl: quote, evidence: [{ ref, quote }], reviewRef: doc.rating ? ref : "",
          claimPl: doc.rating ? doc.claimReviewed : "", neededEvidencePl: "" };
      }
      return { answerPl: "", evidence: [], reviewRef: "", claimPl: "", neededEvidencePl: "" };
    } });
    deps.llm = model;
    deps.verifier = model;
  }

  it("wysyła ocenę wyszukanej publikacji zarówno przez WWW, jak i CLI", async () => {
    quoteRetrieved(/65-latków tylko we Wrocławiu/i);
    const web = (await chat(env, { text: fareQuestion })).json.reply;
    const cli = await handleInbound({ channel: "cli", text: fareQuestion, senderId: "cli-user", sessionId: "cli-session", messageId: "cli-first",
      images: [], receivedAt: env.ctx.now().toISOString() }, env.ctx);
    expect(web).toMatchObject({ kind: "answer", report: { mainVerdict: "FALSZYWE" },
      shortAnswer: { sources: expect.arrayContaining([expect.objectContaining({ url: reviewUrl })]) } });
    expect(cli.shortAnswer).toEqual(web.shortAnswer);
    expect(web.report.sourceActivity.branches).toContainEqual(expect.objectContaining({ id: "bm25", status: "completed" }));
  });

  it("to samo nowe pytanie po zmianie źródła zwraca aktualny cytat, a po usunięciu go już nie cytuje", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fons-query-change-"));
    mkdirSync(join(dir, "corpus"));
    writeFileSync(join(dir, "sources.yaml"), JSON.stringify([{ id: "planetarium", hosts: ["planetarium.example"], publisher: "Planetarium",
      type: "pierwotne", role: "tresc", level: 1, independenceGroup: "planetarium", licence: "test", fetchMethod: "dump",
      updateFrequency: "test", qualification: "test", homepage: "https://planetarium.example" }]));
    const question = "Ile miejsc oferuje planetarium w Brzozowej Dolinie?";
    quoteRetrieved(/Planetarium w Brzozowej Dolinie/);
    env.ctx.engine.snapshotId = () => deps.store.snapshotId();
    try {
      for (const capacity of [72, 93, null]) {
        const text = `Planetarium w Brzozowej Dolinie oferuje ${capacity} miejsca na widowni.`;
        const record: CorpusRecord = { id: "planetarium:capacity", sourceId: "planetarium", title: "Planetarium w Brzozowej Dolinie",
          publisher: "Planetarium", text, url: "https://planetarium.example/widownia", publishedAt: "2026-10-01",
          fetchedAt: "2026-10-01T10:00:00Z", lang: "pl", role: "tresc", type: "pierwotne", level: 1,
          independenceGroup: "planetarium", licence: "test", topics: [], origin: "corpus" };
        writeFileSync(join(dir, "corpus", "planetarium.jsonl"), capacity ? JSON.stringify(record) + "\n" : "");
        ensureCorpusLoaded(env.db, { dataDir: dir });
        const reply = (await chat(env, { text: question })).json.reply;
        if (capacity) {
          expect(reply.shortAnswer.bodyPl).toBe(text);
          expect(reply.shortAnswer.sources[0].url).toBe(record.url);
        } else {
          expect(reply.textPl).not.toMatch(/72|93|planetarium\.example/);
          expect(reply.report?.answer).toBeUndefined();
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("po trafieniu odpytuje indeks ponownie i pokazuje rzeczywisty status dostępu", async () => {
    const fetchIndex = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ claims: [{ text: "Wrocław był jedynym miastem z darmowymi przejazdami dla 65-latków.",
        claimReview: [{ publisher: { name: "Demagog" }, url: reviewUrl, textualRating: "Fałsz" }] }] }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockImplementation(async () => Response.json({}));
    deps.demagogTopicIndex = createDemagogTopicIndex("test", fetchIndex);
    const first = await chat(env, { text: reviewQuestion });
    expect(first.json.reply).toMatchObject({ shortAnswer: { bodyPl: expect.stringMatching(/^Tak.*fałsz/i) },
      report: { mainVerdict: "FALSZYWE" } });
    const failed = (await chat(env, { text: reviewQuestion }, first.cookie)).json.reply;
    expect(failed).toMatchObject({ kind: "status", textPl: "Nie mogę teraz sprawdzić indeksu Google z powodu błędu dostępu.",
      report: { status: "NIEPELNE", mainVerdict: null, cacheHit: false } });
    const empty = (await chat(env, { text: reviewQuestion }, first.cookie)).json.reply;
    expect(empty).toMatchObject({ report: { status: "OK", mainVerdict: null }, textPl: expect.stringContaining("w indeksie Google") });
    expect(fetchIndex.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("wyjaśnia brak dowodu i łączy dwie wersje pytania o diesle w SQLite", async () => {
    const results = [];
    for (const text of ["Czy od wczoraj w Pcimiu bilety autobusowe można kupić tylko przez aplikację?",
      "Czy od przyszłego tygodnia diesle nie będą mogły wjechać do centrum Pcimia?",
      "Czy Pcim wprowadza zakaz wjazdu diesli do centrum?"]) {
      const reply = (await chat(env, { text })).json.reply;
      expect(reply).toMatchObject({ report: { mainVerdict: "BRAK_DOWODOW" }, shortAnswer: { bodyPl: expect.stringMatching(/^Nie wiem\./), caseNotePl: expect.any(String) } });
      results.push(reply);
    }
    for (const reply of results) expect(reply.report.sourceActivity.branches).toContainEqual(expect.objectContaining({ id: "bm25" }));
    expect(results[1].report.moderatorCase.caseId).toBe(results[2].report.moderatorCase.caseId);
    expect(results[0].report.moderatorCase.caseId).not.toBe(results[1].report.moderatorCase.caseId);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM moderator_cases").get()).toEqual({ n: 2 });
  });

  it.each([
    ["Czy PAP usunęła depeszę o wypowiedzi Donalda Tuska przed powodzią w 2024 r.?", /Donald Tusk uspokajał przed powodzią/i],
    ["Czy we Włoszech odbył się strajk generalny zapowiedziany na 20 listopada 2026 r.?", /komunikat MSZ/i],
    ["Dlaczego w wypowiedzi o komunikacji we Wrocławiu pada 700 mln zł, a w analizie Demagoga 650 mln zł?", /Darmowa komunikacja. Jaką kwotę/i],
  ] as const)("wyszukuje publikację dla pytania %s", async (question, title) => {
    quoteRetrieved(title);
    const reply = (await chat(env, { text: question })).json.reply;
    expect(reply.shortAnswer?.sources).toContainEqual(expect.objectContaining({ title: expect.stringMatching(title) }));
    expect(reply.report.sourceActivity.branches).toContainEqual(expect.objectContaining({ id: "bm25", status: "completed" }));
  });

  it("rejestruje instrukcję w dodatkowej stronie i opiera odpowiedź na wyszukanej publikacji", async () => {
    quoteRetrieved(/65-latków tylko we Wrocławiu/i);
    const url = "https://example.org/strona-testowa";
    const instruction = instructionExample.report.securityEvents[0]!.excerpt;
    deps.fetchPage = vi.fn(async () => ({ finalUrl: url, status: 200, contentType: "text/plain",
      rawText: instruction, cleanText: instruction, hiddenSegments: [] }));
    const reply = (await chat(env, { text: fareQuestion + " Sprawdź też tę stronę: " + url })).json.reply;
    expect(reply.report?.mainVerdict).toBe("FALSZYWE");
    expect(reply.shortAnswer?.sources.map((source: { url: string }) => source.url)).toEqual([reviewUrl]);
    expect(env.db.prepare("SELECT location FROM security_events WHERE location = 'fetched_page' LIMIT 1").get()).toEqual({ location: "fetched_page" });
  });

  it("rozróżnia strony o tym samym temacie po tytule i dacie depeszy", async () => {
    const question = "Czy ten wpis dotyczy tej samej depeszy PAP, którą sprawdzał Demagog?";
    for (const [path, headline, expected] of [
      ["opis", "Premier: nie ma powodu do paniki, prognozy nie są przesadnie alarmujące", /^Tak\./],
      ["inna-depesza", "Nowe ostrzeżenie hydrologiczne", /^Nie\..+inny nagłówek/s],
    ] as const) {
      const url = "https://example.org/" + path;
      const text = `Tytuł depeszy PAP: „${headline}”. Depesza PAP z 13 września 2024 r. Donald Tusk mówił o zagrożeniu powodziowym.`;
      deps.fetchPage = async () => ({ finalUrl: url, status: 200, contentType: "text/plain", rawText: text, cleanText: text, hiddenSegments: [] });
      const reply = (await chat(env, { text: question + " " + url })).json.reply;
      expect(reply.shortAnswer?.bodyPl).toMatch(expected);
      expect(reply.shortAnswer?.sources.map((source: { url: string }) => source.url)).toContain("https://www.pap.pl/aktualnosci/premier-nie-ma-powodu-do-paniki-prognozy-nie-sa-przesadnie-alarmujace-0");
    }
  });

  it("dopasowuje skrócony link dopiero po otrzymaniu adresu posta od platformy", async () => {
    quoteRetrieved(/Policja zasłania protest parawanem/i);
    const short = "https://vm.tiktok.com/ZshareTest/";
    const resolved = "https://www.tiktok.com/@mwospl/video/7685116354155826465";
    const loadCaption = vi.fn(async () => ({ url: resolved, caption: "" }));
    deps.video = { loadCaption };
    const note = "Czy film Michała Wosia z 2026 r. pokazywał ówczesny protest pod Trybunałem Konstytucyjnym?";
    const reply = (await chat(env, { text: note + " " + short })).json.reply;
    expect(loadCaption).toHaveBeenCalledOnce();
    expect(reply.shortAnswer?.bodyPl).toMatch(/2021/);
    expect(reply.report?.mainVerdict).toBe("FALSZYWE");
    expect(reply.report?.videoAnalysis).toBeUndefined();
    loadCaption.mockResolvedValue({ url: resolved.replace(/65$/, "66"), caption: "" });
    const other = (await chat(env, { text: note + " " + short.replace("Test", "Other") })).json.reply;
    expect(other.report).toMatchObject({ status: "NIEPELNE", mainVerdict: null });
  });
});
