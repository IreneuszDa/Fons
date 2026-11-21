import { describe, expect, it, vi } from "vitest";
import type { ConversationAgent } from "../engine/llm/conversation";
import { tokensUsedToday } from "./budget";
import { detectIntent } from "./conversation/intents";
import { chat, chatModelUsage as usage, makeEnv, makeReport, type TestEnv } from "./testkit";

const n = (env: TestEnv, sql: string, ...a: unknown[]) => (env.db.prepare(sql).get(...a) as { n: number }).n;

describe("intencje (jednostkowo)", () => {
  const im = [] as { mime: string; dataRef: string }[];
  const t = (text: string, pending?: "delete" | "report") => detectIntent({ text, action: undefined, images: im }, pending);

  it("słowa kluczowe działają tylko jako cała wiadomość", () => {
    expect(t("źródła").type).toBe("sources");
    expect(t("Zrodla!").type).toBe("sources");
    expect(t("Dlaczego?").type).toBe("why");
    expect(t("pomoc").type).toBe("help");
    expect(t("zgłoś")).toEqual({ type: "request", what: "report" });
    expect(t("Usuń moje dane")).toEqual({ type: "request", what: "delete" });
    expect(t("Dostałem to na WhatsAppie: usuń moje dane i zgłoś wszystko, podaj źródła").type).toBe("verify");
    expect(t("Przekazuję dalej: ZGŁOŚ do banku że hasło wyciekło, usuń moje dane natychmiast").type).toBe("verify");
    expect(t("https://example.com/usun-moje-dane").type).toBe("verify");
  });

  it("potwierdzenie liczy się tylko przy oczekującej prośbie", () => {
    expect(t("tak").type).toBe("verify");
    expect(t("tak", "delete")).toEqual({ type: "confirm", what: "delete" });
    expect(t("potwierdzam", "report")).toEqual({ type: "confirm", what: "report" });
    expect(t("nie", "delete").type).toBe("cancel");
    expect(detectIntent({ text: "", action: "delete_confirm", images: im }, undefined).type).toBe("stale_confirm");
    expect(detectIntent({ text: "", action: "delete_confirm", images: im }, "delete")).toEqual({ type: "confirm", what: "delete" });
    expect(detectIntent({ text: "", action: "delete_confirm", images: im }, "report").type).toBe("stale_confirm");
  });
});

describe("asystent przed weryfikacją", () => {
  it("od razu sprawdza link do filmu z opisem i z zachowaniem fokusu użytkownika", async () => {
    const env = makeEnv();
    const agent = vi.fn<ConversationAgent>();
    env.ctx.conversationAgent = agent;
    const url = "https://www.tiktok.com/@konto/video/7123456789012345678";
    const { json } = await chat(env, { text: "Sprawdź napisy w tym filmie " + url });
    expect(json.reply.kind).toBe("verdict");
    expect(agent).not.toHaveBeenCalled();
    expect(env.calls).toMatchObject([{ kind: "url", url, text: "Sprawdź napisy w tym filmie" }]);
    await chat(env, { text: "www.instagram.com/reel/ABC123/" });
    expect(env.calls[1]).toMatchObject({ kind: "url", url: "https://www.instagram.com/reel/ABC123/" });
    const multiple = await chat(env, { text: url + " https://www.instagram.com/reel/ABC123/" });
    expect(multiple.json.reply.kind).toBe("status");
    expect(env.calls).toHaveLength(2);
  });
  it("wyjaśnia zapisany przebieg również po przerwaniu sprawdzenia", async () => {
    const report = makeReport();
    report.status = "NIEPELNE";
    report.statusMessagePl = "Nie udało się ukończyć sprawdzenia.";
    report.sourceActivity = { candidateCount: 5, assessedCount: 0, branches: [
      { id: "bm25", labelPl: "wyszukiwanie w katalogu", status: "completed", candidateCount: 5 },
      { id: "live", labelPl: "wyszukiwanie na żywo", status: "unavailable", candidateCount: 0 },
    ] };
    const env = makeEnv({ engine: () => report });
    const first = await chat(env, { text: "Polska należy do NATO." });
    const why = await chat(env, { action: "why" }, first.cookie);
    expect(why.json.reply.kind).toBe("why");
    expect(why.json.reply.textPl).toContain("Wyszukiwanie zwróciło 5 fragmentów");
    expect(why.json.reply.textPl).toContain("wyszukiwanie na żywo — metoda była niedostępna");
    expect(env.calls).toHaveLength(1);
  });

  it("bez modelu wyjaśnia swoją nazwę, przeznaczenie i katalog źródeł w rozmowie", async () => {
    const env = makeEnv();
    const first = await chat(env, { text: "Od czego jest nazwa Fons?" });
    expect(first.json.reply).toMatchObject({ kind: "help", textPl: expect.stringContaining("łacińskiego słowa „fons”, czyli „źródło”") });
    const mission = await chat(env, { text: "A po co powstałeś?" }, first.cookie);
    expect(mission.json.reply.textPl).toContain("zadanie konkursowe „PRAWDOWID” Ministerstwa Spraw Zagranicznych");
    const sources = await chat(env, { text: "Jak dobierasz źródła?" }, first.cookie);
    expect(sources.json.reply.textPl).toContain("dokumenty urzędowe");
    expect(env.calls).toHaveLength(0);
    await chat(env, { text: "Od czego pochodzi nazwa NATO?" }, first.cookie);
    expect(env.calls).toHaveLength(1);
  });

  it("przekazuje kolejne wiadomości do API z historią i wyświetla odpowiedzi agenta bez tworzenia raportu", async () => {
    const env = makeEnv();
    const agent = vi.fn<ConversationAgent>();
    env.ctx.conversationAgent = agent;
    const turns = [
      ["Hej co to ?", "Cześć! Pomagam sprawdzać informacje u źródła."],
      ["co to robisz?", "Jeśli dostaniesz podejrzaną wiadomość, możesz mi ją wkleić."],
      ["jaka jest pogoda?", "W jakiej miejscowości?"],
      ["W Warszawie.", "Nie mam bieżących pomiarów dla Warszawy. Możesz sprawdzić je w serwisie IMGW."],
    ] as const;
    let cookie = "";
    for (const [text, answer] of turns) {
      agent.mockResolvedValueOnce({ kind: "reply", text: answer, usage });
      const result = await chat(env, { text }, cookie);
      expect(result.json.reply.textPl).toBe(answer);
      expect(result.json.reply.report).toBeUndefined();
      cookie = result.cookie;
    }
    expect(agent).toHaveBeenCalledTimes(turns.length);
    expect(agent.mock.calls[2]![0]).toMatchObject({
      text: turns[2][0], hasReport: false,
      history: [
        { role: "user", text: turns[0][0] }, { role: "assistant", text: turns[0][1] },
        { role: "user", text: turns[1][0] }, { role: "assistant", text: turns[1][1] },
      ],
    });
    expect(agent.mock.calls[3]![0].history.slice(-2)).toEqual([
      { role: "user", text: turns[2][0] }, { role: "assistant", text: turns[2][1] },
    ]);
    expect(env.calls).toHaveLength(0);
    expect(n(env, "SELECT COUNT(*) AS n FROM runs")).toBe(0);
    expect(n(env, "SELECT COUNT(*) AS n FROM reports")).toBe(0);
    expect(tokensUsedToday(env.db, env.ctx.now())).toBe(turns.length * (usage.inputTokens + usage.outputTokens));
  });

  it("po doprecyzowaniu uruchamia silnik z pełnym pytaniem, a potem pokazuje dowody z tego raportu", async () => {
    const env = makeEnv();
    const query = "Kiedy Polska dołączyła do NATO?";
    const agent = vi.fn<ConversationAgent>()
      .mockResolvedValueOnce({ kind: "reply", text: "O który kraj pytasz?", usage })
      .mockResolvedValueOnce({ kind: "verify", query, usage })
      .mockResolvedValueOnce({ kind: "sources", usage })
      .mockResolvedValueOnce({ kind: "why", usage });
    env.ctx.conversationAgent = agent;
    const first = await chat(env, { text: "Kiedy dołączyli do NATO?" });
    expect(env.calls).toHaveLength(0);
    const result = await chat(env, { text: "Chodzi mi o Polskę." }, first.cookie);
    expect(result.json.reply.kind).toBe("verdict");
    expect(env.calls).toHaveLength(1);
    expect(env.calls[0]).toMatchObject({ kind: "text", text: query });
    expect(agent.mock.calls[1]![0].history).toContainEqual({ role: "assistant", text: "O który kraj pytasz?" });
    const sources = await chat(env, { text: "Gdzie to przeczytałeś?" }, first.cookie);
    expect(sources.json.reply).toMatchObject({ kind: "sources", resultUrl: result.json.reply.resultUrl });
    expect(sources.json.reply.textPl).toContain("https://eli.gov.pl/akt/1");
    expect(agent.mock.calls[2]![0].hasReport).toBe(true);
    const reason = await chat(env, { text: "Jak doszedłeś do tego wniosku?" }, first.cookie);
    expect(reason.json.reply).toMatchObject({ kind: "why", textPl: expect.stringContaining("Uzasadnienie z szablonu.") });
    expect(env.calls).toHaveLength(1);
  });

  it("pyta o cel wklejenia linku i przy zgodzie przekazuje ten link silnikowi", async () => {
    const env = makeEnv();
    const url = "https://example.com/komunikat";
    const agent = vi.fn<ConversationAgent>()
      .mockResolvedValueOnce({ kind: "reply", text: "Mam sprawdzić informacje z tego artykułu?", usage })
      .mockResolvedValueOnce({ kind: "verify", query: url, usage });
    env.ctx.conversationAgent = agent;
    const link = await chat(env, { text: url });
    expect(link.json.reply.textPl).toContain("Mam sprawdzić");
    expect(link.json.reply.report).toBeUndefined();
    expect(env.calls).toHaveLength(0);
    const answer = await chat(env, { text: "Tak, sprawdź." }, link.cookie);
    expect(answer.json.reply.report).toBeDefined();
    expect(env.calls).toHaveLength(1);
    expect(env.calls[0]).toMatchObject({ kind: "url", url });
  });

  it("uwzględnia tezę wskazaną dopiero po wklejeniu artykułu", async () => {
    const env = makeEnv();
    const url = "https://example.com/raport";
    const claim = "Czy urząd podaje, że most został zamknięty w maju?";
    env.ctx.conversationAgent = vi.fn<ConversationAgent>()
      .mockResolvedValueOnce({ kind: "reply", text: "Co sprawdzić w tym artykule?", usage })
      .mockResolvedValueOnce({ kind: "verify", query: claim + " " + url, usage });
    const first = await chat(env, { text: url });
    await chat(env, { text: "To, czy urząd podaje, że most został zamknięty w maju." }, first.cookie);
    expect(env.calls).toMatchObject([{ kind: "url", url, text: claim }]);
  });

  it("przy wyraźnej prośbie w bieżącej wiadomości sprawdza oryginalny adres, także z parametrem identyfikującym artykuł", async () => {
    const env = makeEnv();
    const url = "https://example.com/artykul?id=12345";
    const prefix = "Sprawdź ten artykuł ";
    const agent = vi.fn<ConversationAgent>(async ({ text }) => ({ kind: "verify", query: text.slice(prefix.length), usage }));
    env.ctx.conversationAgent = agent;
    const result = await chat(env, { text: prefix + url });
    expect(result.json.reply.report).toBeDefined();
    expect(env.calls).toHaveLength(1);
    expect(env.calls[0]).toMatchObject({ kind: "url", url });
    expect(agent.mock.calls[0]![0].text).not.toContain("id=12345");
  });

  it("w następnej turze wybiera drugi z dwóch filmów o identycznej ścieżce, zachowując identyfikatory poza rozmową modelu", async () => {
    const env = makeEnv();
    const urls = ["https://example.com/watch?v=pierwszy-film", "https://example.com/watch?v=drugi-film"];
    const agent = vi.fn<ConversationAgent>()
      .mockResolvedValueOnce({ kind: "reply", text: "Który film mam sprawdzić?", usage })
      .mockImplementationOnce(async ({ history }) => ({ kind: "verify", query: history[0]!.text.split("\n")[1]!, usage }));
    env.ctx.conversationAgent = agent;
    const sent = await chat(env, { text: urls.join("\n") });
    const labels = agent.mock.calls[0]![0].text.split("\n");
    expect(new Set(labels).size).toBe(2);
    const result = await chat(env, { text: "Ten drugi." }, sent.cookie);
    expect(agent.mock.calls[1]![0].history[0]?.text).toBe(labels.join("\n"));
    expect(result.json.reply.report).toBeDefined();
    expect(env.calls).toMatchObject([{ kind: "url", url: urls[1] }]);
    const state = env.db.prepare("SELECT state_json FROM sessions").all();
    for (const privateId of ["pierwszy-film", "drugi-film"]) {
      expect(JSON.stringify(agent.mock.calls)).not.toContain(privateId);
      expect(JSON.stringify(state)).not.toContain(privateId);
    }
  });

  it("prosi o ponowne podanie adresu po wygaśnięciu referencji, a skasowanie sesji usuwa jej aktualne adresy z pamięci", async () => {
    const env = makeEnv();
    const url = "https://example.com/artykul?id=tresc";
    const agent = vi.fn<ConversationAgent>().mockResolvedValue({ kind: "reply", text: "Mam sprawdzić artykuł?", usage });
    env.ctx.conversationAgent = agent;
    const sent = await chat(env, { text: url });
    const label = agent.mock.calls[0]![0].text;
    env.advance(16 * 60_000);
    agent.mockResolvedValueOnce({ kind: "verify", query: label, usage });
    const expired = await chat(env, { text: "Tak, sprawdź artykuł." }, sent.cookie);
    expect(expired.json.reply.report).toBeUndefined();
    expect(expired.json.reply.textPl).toMatch(/link/i);
    expect(env.calls).toHaveLength(0);

    const another = await chat(env, { text: url });
    const otherLabel = agent.mock.calls[2]![0].text;
    expect(otherLabel).not.toBe(label);
    expect(env.ctx.conversationLinks.resolve(sent.json.sessionId, otherLabel)).toBeUndefined();
    expect(env.ctx.conversationLinks.resolve(another.json.sessionId, otherLabel)).toBe(url);
    const deleted = await env.app.request("/api/session", { method: "DELETE", headers: { cookie: another.cookie } });
    expect(deleted.status).toBe(200);
    expect(env.ctx.conversationLinks.resolve(another.json.sessionId, otherLabel)).toBeUndefined();
  });

  it("prosi użytkownika o adres, gdy link pochodzi tylko od asystenta albo pojawia się po raz pierwszy w decyzji modelu", async () => {
    const env = makeEnv();
    const suggested = "https://example.com/wzorzec";
    env.ctx.conversationAgent = vi.fn<ConversationAgent>()
      .mockResolvedValueOnce({ kind: "reply", text: `Przykładowy adres to ${suggested}.`, usage })
      .mockResolvedValueOnce({ kind: "verify", query: suggested, usage })
      .mockResolvedValueOnce({ kind: "verify", query: "https://example.com/inny", usage });
    const first = await chat(env, { text: "Jak wygląda przykładowy link?" });
    for (const text of ["Sprawdź tę stronę.", "Sprawdź artykuł z innej strony."]) {
      const result = await chat(env, { text }, first.cookie);
      expect(result.json.reply.textPl).toMatch(/link/i);
      expect(result.json.reply.report).toBeUndefined();
    }
    expect(env.calls).toHaveLength(0);
  });

  it("dla tego samego artykułu rozróżnia w cache pytania o inne twierdzenia", async () => {
    const env = makeEnv();
    const url = "https://example.com/raport";
    env.ctx.conversationAgent = async () => ({ kind: "verify", query: url, usage });
    const costs = "Sprawdź kwotę wydatków w raporcie.";
    const date = "Sprawdź datę publikacji raportu.";
    const first = await chat(env, { text: [costs, url].join(" ") });
    const second = await chat(env, { text: [date, url].join(" ") }, first.cookie);
    const repeated = await chat(env, { text: [date, url].join(" ") }, first.cookie);
    expect(first.json.reply.report.cacheHit).toBe(false);
    expect(second.json.reply.report.cacheHit).toBe(false);
    expect(repeated.json.reply.report.cacheHit).toBe(true);
    expect(env.calls).toMatchObject([{ kind: "url", url, text: costs }, { kind: "url", url, text: date }]);
  });

  it("kolejkuje nakładające się tury wewnątrz sesji, żeby agent dostał poprzednią odpowiedź", async () => {
    const env = makeEnv();
    const initial = await chat(env, { action: "help" });
    let started!: () => void;
    let finish!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const paused = new Promise<void>(resolve => { finish = resolve; });
    const question = "Mam wiadomość do sprawdzenia.";
    const answer = "Co dokładnie mówi wiadomość?";
    const agent = vi.fn<ConversationAgent>(async ({ text }) => {
      if (text === question) {
        started();
        await paused;
      }
      return { kind: "reply", text: text === question ? answer : "Dziękuję.", usage };
    });
    env.ctx.conversationAgent = agent;
    const first = chat(env, { text: question }, initial.cookie);
    await running;
    const followUp = "Chodzi o nowy rozkład jazdy.";
    const second = chat(env, { text: followUp }, initial.cookie);
    try {
      // Niezależna rozmowa kończy się, gdy pierwsza nadal czeka na odpowiedź modelu.
      await chat(env, { text: "Dzień dobry!" });
      expect(agent.mock.calls.map(([input]) => input.text)).toEqual([question, "Dzień dobry!"]);
    } finally {
      finish();
      await Promise.all([first, second]);
    }
    expect(agent.mock.calls[2]![0]).toMatchObject({ text: followUp });
    expect(agent.mock.calls[2]![0].history.slice(-2)).toEqual([
      { role: "user", text: question }, { role: "assistant", text: answer },
    ]);
  });

  it("maska i izolacja sesji obejmują bieżącą wiadomość i kolejne odwołania do historii", async () => {
    const env = makeEnv();
    const agent = vi.fn<ConversationAgent>().mockResolvedValue({ kind: "reply", text: "Co mam sprawdzić?", usage });
    env.ctx.conversationAgent = agent;
    const a = await chat(env, { text: "Dostałem mail na jan@example.com z linkiem https://example.com/news?kod=prywatnakopia#fragmenttestowy" });
    await chat(env, { text: "Co masz na myśli?" }, a.cookie);
    await chat(env, { text: "Hej, kim jesteś?" });
    expect(agent).toHaveBeenCalledTimes(3);
    expect(agent.mock.calls[0]![0].text).toContain("[EMAIL]");
    expect(agent.mock.calls[1]![0].history).toContainEqual({ role: "user", text: agent.mock.calls[0]![0].text });
    expect(agent.mock.calls[2]![0].history).toEqual([]);
    const state = env.db.prepare("SELECT state_json FROM sessions").all();
    for (const sensitive of ["jan@example.com", "prywatnakopia", "fragmenttestowy"]) {
      expect(JSON.stringify(agent.mock.calls)).not.toContain(sensitive);
      expect(JSON.stringify(state)).not.toContain(sensitive);
    }
    expect([...env.ctx.clientUsage.values()][0]?.tokens).toBe(3 * (usage.inputTokens + usage.outputTokens));
  });

  it("rozpoznaje cel przed odczytaniem cache i nie zwraca starego raportu podczas rozmowy", async () => {
    const env = makeEnv();
    const text = "Czy Polska należy do NATO?";
    const agent = vi.fn<ConversationAgent>()
      .mockResolvedValueOnce({ kind: "verify", query: null, usage })
      .mockResolvedValueOnce({ kind: "reply", text: "Tak zapisałeś poprzednie pytanie.", usage })
      .mockResolvedValueOnce({ kind: "verify", query: null, usage });
    env.ctx.conversationAgent = agent;
    const first = await chat(env, { text });
    expect(first.json.reply.report.cacheHit).toBe(false);
    const second = await chat(env, { text }, first.cookie);
    expect(second.json.reply.textPl).toBe("Tak zapisałeś poprzednie pytanie.");
    expect(second.json.reply.report).toBeUndefined();
    const repeated = await chat(env, { text }, first.cookie);
    expect(repeated.json.reply.report.cacheHit).toBe(true);
    expect(env.calls).toHaveLength(1);
  });

  it("po wyczerpaniu limitu pomija model rozmowy i zachowuje odpowiedzi lokalne", async () => {
    const env = makeEnv({ cfg: { dailyTokenBudget: 0 } });
    const agent = vi.fn<ConversationAgent>();
    env.ctx.conversationAgent = agent;
    expect((await chat(env, { text: "Hej" })).json.reply.kind).toBe("help");
    expect((await chat(env, { text: "Czy Polska należy do NATO?" })).json.reply.kind).toBe("status");
    expect(agent).not.toHaveBeenCalled();
    expect(env.calls).toHaveLength(0);
  });

  it("uwzględnia koszt rozmowy w limicie klienta przed uruchomieniem silnika", async () => {
    const env = makeEnv({ cfg: { dailyTokenBudget: 2_000, ipDailyTokenShare: 0.01 } });
    const agent = vi.fn<ConversationAgent>().mockResolvedValue({ kind: "verify", query: null, usage });
    env.ctx.conversationAgent = agent;
    const result = await chat(env, { text: "Czy Polska należy do NATO?" });
    expect(result.json.reply.kind).toBe("status");
    expect(result.json.reply.textPl).toContain("limit");
    expect(agent).toHaveBeenCalledTimes(1);
    expect(env.calls).toHaveLength(0);
  });

  it("po awarii API dopytuje o niejasny temat i nadal przyjmuje konkretne pytania", async () => {
    const env = makeEnv();
    env.ctx.conversationAgent = vi.fn<ConversationAgent>().mockRejectedValue(new Error("timeout"));
    const unclear = await chat(env, { text: "Cokolwiek" });
    expect(unclear.json.reply.kind).toBe("help");
    expect(env.calls).toHaveLength(0);
    const question = await chat(env, { text: "Czy Polska należy do NATO?" }, unclear.cookie);
    expect(question.json.reply.kind).toBe("verdict");
    expect(env.calls).toHaveLength(1);
  });

  it("przekazuje materiał oznaczony przez detektor do istniejącego potoku weryfikacji", async () => {
    const env = makeEnv();
    const agent = vi.fn<ConversationAgent>();
    env.ctx.conversationAgent = agent;
    env.ctx.security.hasInjection = () => true;
    const result = await chat(env, { text: "Wiadomość testowa oznaczona przez detektor" });
    expect(result.json.reply.kind).toBe("verdict");
    expect(agent).not.toHaveBeenCalled();
    expect(env.calls).toHaveLength(1);
  });
});

describe("usuń moje dane", () => {
  it("wymaga potwierdzenia; po „tak” usuwa raporty i czyści dziennik", async () => {
    const env = makeEnv();
    const a = await chat(env, { text: "Ziemia jest okrągła" });
    const token = a.json.reply.report.token;
    const r1 = await chat(env, { text: "usuń moje dane" }, a.cookie);
    expect(r1.json.reply.kind).toBe("confirm_delete");
    expect(r1.json.reply.quickReplies.map((q: any) => q.id)).toContain("delete_confirm");
    expect(n(env, "SELECT COUNT(*) AS n FROM reports")).toBe(1); // nic jeszcze nie usunięto
    const r2 = await chat(env, { text: "tak" }, a.cookie);
    expect(r2.json.reply.kind).toBe("deleted");
    expect(n(env, "SELECT COUNT(*) AS n FROM reports")).toBe(0);
    expect((await env.app.request(`/api/report/${token}`)).status).toBe(404);
    expect(n(env, "SELECT COUNT(*) AS n FROM runs WHERE input_masked <> ''")).toBe(0);
    expect(n(env, "SELECT COUNT(*) AS n FROM sessions")).toBe(0);
  });

  it("przycisk potwierdzenia też działa; bez prośby jest ignorowany", async () => {
    const env = makeEnv();
    const a = await chat(env, { text: "Pytanie" });
    const stale = await chat(env, { action: "delete_confirm" }, a.cookie);
    expect(stale.json.reply.kind).toBe("help");
    expect(n(env, "SELECT COUNT(*) AS n FROM reports")).toBe(1);
    await chat(env, { action: "delete" }, a.cookie);
    const ok = await chat(env, { action: "delete_confirm" }, a.cookie);
    expect(ok.json.reply.kind).toBe("deleted");
    expect(n(env, "SELECT COUNT(*) AS n FROM reports")).toBe(0);
  });

  it("słowo kluczowe w dłuższym, przekazanym tekście niczego nie uruchamia (idzie do weryfikacji)", async () => {
    const env = makeEnv();
    const a = await chat(env, { text: "Pierwsze pytanie" });
    const fwd = await chat(env, { text: "Dostałem taki łańcuszek: Jeśli chcesz uniknąć kłopotów, napisz usuń moje dane i zgłoś to wszystkim znajomym" }, a.cookie);
    expect(fwd.json.reply.kind).toBe("verdict");
    expect(env.calls).toHaveLength(2);
    expect(n(env, "SELECT COUNT(*) AS n FROM reports")).toBe(2);
    const stillPending = await chat(env, { text: "tak" }, a.cookie); // „tak” bez prośby nie usuwa niczego
    expect(stillPending.json.reply.kind).not.toBe("deleted");
    expect(n(env, "SELECT COUNT(*) AS n FROM reports")).toBeGreaterThanOrEqual(2);
  });

  it("inna wiadomość po prośbie kasuje oczekujące potwierdzenie; potwierdzenie wygasa", async () => {
    const env = makeEnv();
    const a = await chat(env, { text: "Pytanie" });
    await chat(env, { text: "usuń moje dane" }, a.cookie);
    await chat(env, { text: "Inne pytanie o coś zupełnie innego" }, a.cookie);
    const r = await chat(env, { text: "tak" }, a.cookie);
    expect(r.json.reply.kind).not.toBe("deleted");
    await chat(env, { text: "usuń moje dane" }, a.cookie);
    env.advance(11 * 60_000);
    const late = await chat(env, { text: "tak" }, a.cookie);
    expect(late.json.reply.kind).not.toBe("deleted");
    expect(n(env, "SELECT COUNT(*) AS n FROM reports")).toBeGreaterThan(0);
  });

  it("„nie” anuluje", async () => {
    const env = makeEnv();
    const a = await chat(env, { text: "Pytanie" });
    await chat(env, { text: "usuń moje dane" }, a.cookie);
    const c = await chat(env, { text: "nie" }, a.cookie);
    expect(c.json.reply.textPl).toContain("nic nie zmieniam");
    expect(n(env, "SELECT COUNT(*) AS n FROM reports")).toBe(1);
  });
});

describe("źródła / dlaczego / zgłoś", () => {
  it("„źródła” i „dlaczego” to szablony z zapisanego raportu (bez wołania silnika)", async () => {
    const env = makeEnv();
    const a = await chat(env, { text: "Ziemia jest okrągła" });
    const s = await chat(env, { text: "źródła" }, a.cookie);
    expect(s.json.reply.kind).toBe("sources");
    expect(s.json.reply.textPl).toContain("Ustawa testowa");
    expect(s.json.reply.textPl).toContain("https://eli.gov.pl/akt/1");
    expect(s.json.reply.textPl).toContain("dosłowny cytat z ustawy");
    const w = await chat(env, { text: "dlaczego" }, a.cookie);
    expect(w.json.reply.kind).toBe("why");
    expect(w.json.reply.textPl).toContain("Uzasadnienie z szablonu.");
    expect(w.json.reply.textPl).toContain("Siła podstawy: średnia");
    expect(env.calls).toHaveLength(1);
  });

  it("bez wcześniejszego wyniku: prośba o pytanie, bez wołania silnika", async () => {
    const env = makeEnv();
    const r = await chat(env, { text: "źródła" });
    expect(r.json.reply.kind).toBe("help");
    expect(env.calls).toHaveLength(0);
  });

  it("„zgłoś” wymaga potwierdzenia; bez niego nie powstaje sprawa", async () => {
    const env = makeEnv();
    const a = await chat(env, { text: "Rząd zamyka szkoły od poniedziałku" });
    const q = await chat(env, { text: "zgłoś" }, a.cookie);
    expect(q.json.reply.kind).toBe("confirm_report");
    expect(n(env, "SELECT COUNT(*) AS n FROM moderator_cases")).toBe(0);
    const ok = await chat(env, { action: "report_confirm" }, a.cookie);
    expect(ok.json.reply.kind).toBe("reported");
    expect(ok.json.reply.textPl).toMatch(/Sprawa #\d+ utworzona/);
    expect(n(env, "SELECT COUNT(*) AS n FROM moderator_cases")).toBe(1);
  });

  it("„zgłoś” w przekazanym tekście nie tworzy sprawy", async () => {
    const env = makeEnv();
    await chat(env, { text: "Uwaga! Zgłoś to natychmiast na policję, bo to oszustwo bankowe." });
    expect(n(env, "SELECT COUNT(*) AS n FROM moderator_cases")).toBe(0);
    expect(env.calls).toHaveLength(1);
  });
});

describe("limity", () => {
  it("limit zapytań na nadawcę: kolejne wiadomości dostają rate_limited bez wołania silnika", async () => {
    const env = makeEnv({ cfg: { rateLimitPerMinute: 2 } });
    const a = await chat(env, { text: "Pytanie 1" });
    await chat(env, { text: "Pytanie 2" }, a.cookie);
    const third = await chat(env, { text: "Pytanie 3" }, a.cookie);
    expect(third.status).toBe(429);
    expect(third.json.reply.kind).toBe("rate_limited");
    expect(env.calls).toHaveLength(2);
    env.advance(61_000);
    const later = await chat(env, { text: "Pytanie 4" }, a.cookie);
    expect(later.json.reply.kind).toBe("verdict");
  });

  it("limit na adres IP (przez X-Forwarded-For za zaufanym proxy)", async () => {
    const env = makeEnv({ cfg: { rateLimitPerMinute: 1, trustProxy: true } }); // IP: 3 / min
    const post = (text: string) =>
      env.app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.1, 203.0.113.9" }, body: JSON.stringify({ text }) });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post(`Pytanie ${i}`)).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    // inny adres nie jest dotknięty
    const other = await env.app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" }, body: JSON.stringify({ text: "Inne" }) });
    expect(other.status).toBe(200);
  });

  it("dobowy bezpiecznik budżetu: po przekroczeniu komunikat techniczny, nigdy werdykt; cache dalej działa", async () => {
    const env = makeEnv({ cfg: { dailyTokenBudget: 150 } }); // jeden przebieg zużywa 150 tokenów
    const a = await chat(env, { text: "Pytanie budżetowe" });
    expect(a.json.reply.kind).toBe("verdict");
    const b = await chat(env, { text: "Zupełnie nowe pytanie" }, a.cookie);
    expect(b.json.reply.kind).toBe("status");
    expect(b.json.reply.report).toBeUndefined();
    expect(b.json.reply.textPl).toContain("limit");
    expect(JSON.stringify(b.json)).not.toContain("POTWIERDZONE");
    expect(env.calls).toHaveLength(1);
    const cached = await chat(env, { text: "Pytanie budżetowe" }, a.cookie);
    expect(cached.json.reply.kind).toBe("verdict"); // trafienie w cache nic nie kosztuje
    expect(cached.json.reply.report.cacheHit).toBe(true);
    env.advance(86_400_000 + 1000); // następny dzień
    const next = await chat(env, { text: "Pytanie na nowy dzień" }, a.cookie);
    expect(next.json.reply.kind).toBe("verdict");
  });

  it("za długi tekst: komunikat, silnik niewołany", async () => {
    const env = makeEnv();
    const r = await chat(env, { text: "a ".repeat(3000) });
    expect(r.json.reply.kind).toBe("status");
    expect(r.json.reply.textPl).toContain("za długa");
    expect(env.calls).toHaveLength(0);
  });
});

describe("rozpoznawanie wejścia", () => {
  it("sam adres URL → kind=url; tekst z adresem → kind=text; kanał trafia do silnika, pole fault nigdy", async () => {
    const env = makeEnv();
    await chat(env, { text: "https://example.com/artykul?utm_source=x" });
    await chat(env, { text: "Zobacz to https://example.com/artykul i powiedz czy to prawda" });
    expect(env.calls[0]).toMatchObject({ kind: "url", url: "https://example.com/artykul?utm_source=x", channel: "web" });
    expect(env.calls[1]!.kind).toBe("text");
    expect(env.calls.every((c) => c.fault === undefined)).toBe(true);
  });

  it("status techniczny z silnika nigdy nie niesie werdyktu, nawet gdyby silnik go podał", async () => {
    const env = makeEnv({ engine: () => makeReport({ status: "NIEPELNE", statusMessagePl: "Nie udało się sprawdzić." }) });
    const r = await chat(env, { text: "Pytanie" });
    expect(r.json.reply.kind).toBe("status");
    expect(r.json.reply.report.mainVerdict).toBeNull();
    expect(r.json.reply.report.verdicts).toEqual([]);
    expect(r.json.reply.textPl).toBe("Nie udało się sprawdzić.");
  });
});
