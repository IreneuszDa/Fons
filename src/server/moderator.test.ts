import { describe, expect, it, vi } from "vitest";
import { matchTopics, loadHighRiskTopics } from "./moderator/topics";
import { chat, makeEnv, makeReport, type TestEnv } from "./testkit";

const brak = (req: { text?: string }) => makeReport({ verdict: "BRAK_DOWODOW", claim: req.text ?? "x" });
const n = (env: TestEnv, sql: string, ...a: unknown[]) => (env.db.prepare(sql).get(...a) as { n: number }).n;
const okFetch = () => vi.fn(async () => new Response("ok", { status: 200 }));
const WEBHOOK = "https://hooks.example.test/alert";

describe("lista tematów wysokiego ryzyka", () => {
  const rules = loadHighRiskTopics();
  it("wczytuje cztery tematy z YAML", () => {
    expect(rules.map((r) => r.id).sort()).toEqual(["bezpieczenstwo", "konsularne", "wybory", "zdrowie"]);
  });
  it("dopasowuje odmiany słów i ignoruje błahe teksty", () => {
    const id = (t: string) => matchTopics(t, rules).map((m) => m.topic.id);
    expect(id("Czy w niedzielę wybory prezydenckie zostały przesunięte?")).toContain("wybory");
    expect(id("Szczepionka powoduje zmiany w DNA")).toContain("zdrowie");
    expect(id("MSZ ewakuuje Polaków z Bejrutu")).toEqual(expect.arrayContaining(["konsularne", "bezpieczenstwo"]));
    expect(id("W kościele jest msza o 18")).toEqual([]);
    expect(id("Zaraz wracam, kupię chleb")).toEqual([]);
    expect(id("Ceny maseł rosną")).toEqual([]);
  });
});

describe("pętla informacji", () => {
  it("BRAK_DOWODOW tworzy sprawę; to samo twierdzenie od innego nadawcy ją aktualizuje; ten sam nadawca nie zwiększa licznika", async () => {
    const env = makeEnv({ engine: brak });
    const a = await chat(env, { text: "Producent lodów dodaje szkło do waniliowych" });
    expect(a.json.reply.report.moderatorCase).toMatchObject({ action: "created" });
    expect(a.json.reply.textPl).not.toContain("Sprawa #");
    expect(a.json.reply.shortAnswer.caseNotePl).toMatch(/Sprawa #1 utworzona/);
    const a2 = await chat(env, { text: "Producent lodów dodaje szkło do waniliowych!" }, a.cookie); // ten sam nadawca
    expect(a2.json.reply.report.moderatorCase).toMatchObject({ caseId: "1", action: "updated" });
    expect(n(env, "SELECT sender_count AS n FROM moderator_cases WHERE id = 1")).toBe(1);
    const b = await chat(env, { text: "producent lodów dodaje SZKŁO do waniliowych" }); // inny nadawca
    expect(b.json.reply.report.moderatorCase).toMatchObject({ caseId: "1", action: "updated" });
    expect(b.json.reply.shortAnswer.caseNotePl).toMatch(/Sprawa #1 zaktualizowana/);
    expect(n(env, "SELECT sender_count AS n FROM moderator_cases WHERE id = 1")).toBe(2);
    expect(n(env, "SELECT COUNT(*) AS n FROM moderator_cases")).toBe(1);
  });

  it("deduplikacja po podobieństwie tokenów (Jaccard >= 0,6); inne twierdzenie to nowa sprawa", async () => {
    const env = makeEnv({ engine: brak });
    await chat(env, { text: "Rząd zamyka granicę z Ukrainą od jutra" });
    const similar = await chat(env, { text: "Rząd zamyka granicę z Ukrainą od jutra rano" });
    expect(similar.json.reply.report.moderatorCase.caseId).toBe("1");
    const different = await chat(env, { text: "Bank wprowadza opłatę za wypłaty z bankomatów" });
    expect(different.json.reply.report.moderatorCase).toMatchObject({ caseId: "2", action: "created" });
    expect(n(env, "SELECT COUNT(*) AS n FROM moderator_cases")).toBe(2);
  });

  it("werdykty inne niż BRAK_DOWODOW nie tworzą spraw", async () => {
    const env = makeEnv();
    const r = await chat(env, { text: "Ziemia jest okrągła" });
    expect(r.json.reply.report.moderatorCase).toBeUndefined();
    expect(n(env, "SELECT COUNT(*) AS n FROM moderator_cases")).toBe(0);
  });

  it("alert raz na sprawę: wysyła się przy >= 3 unikalnych nadawcach, czwarty już nie wysyła", async () => {
    const fetchMock = okFetch();
    const env = makeEnv({ engine: brak, cfg: { alertWebhookUrl: WEBHOOK }, fetch: fetchMock as any });
    const text = "Sklep rozdaje bony po 500 zł za udostępnienie posta";
    const r1 = await chat(env, { text });
    await chat(env, { text });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r1.json.reply.report.moderatorCase.action).toBe("created");
    const r3 = await chat(env, { text });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r3.json.reply.report.moderatorCase.action).toBe("updated");
    expect(r3.json.reply.shortAnswer.caseNotePl).toContain("powiadomiona");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({ caseId: "1", senders: 3 });
    await chat(env, { text });
    await chat(env, { text });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(n(env, "SELECT COUNT(*) AS n FROM alerts_log WHERE outcome = 'sent'")).toBe(1);
  });

  it("temat z listy wysokiego ryzyka wysyła alert już przy pierwszym nadawcy", async () => {
    const fetchMock = okFetch();
    const env = makeEnv({ engine: brak, cfg: { alertWebhookUrl: WEBHOOK }, fetch: fetchMock as any });
    const r = await chat(env, { text: "Lokale wyborcze będą zamknięte w niedzielę z powodu zagrożenia" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.json.reply.report.moderatorCase.action).toBe("created");
  });

  it("bez webhooka: action=recommended i odpowiedź NIE twierdzi, że przekazano sprawę", async () => {
    const fetchMock = okFetch();
    const env = makeEnv({ engine: brak, fetch: fetchMock as any });
    const r = await chat(env, { text: "Szczepionka zawiera mikroczipy śledzące" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.json.reply.report.moderatorCase).toMatchObject({ action: "recommended" });
    expect(r.json.reply.shortAnswer.caseNotePl).toMatch(/Sprawa #1/);
    expect(r.json.reply.textPl).not.toMatch(/przekaz|powiadomi|wysła|poinformow/i);
    expect(n(env, "SELECT COUNT(*) AS n FROM alerts_log WHERE outcome = 'sent'")).toBe(0);
    expect((env.db.prepare("SELECT alert_state AS s FROM moderator_cases").get() as any).s).toBe("recommended");
  });

  it("webhook nie odpowiada: recommended, bez „powiadomiona”; kolejna aktualizacja może ponowić próbę", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const env = makeEnv({ engine: brak, cfg: { alertWebhookUrl: WEBHOOK }, fetch: fetchMock as any });
    const r = await chat(env, { text: "Szczepionka zawiera mikroczipy śledzące" });
    expect(r.json.reply.report.moderatorCase.action).toBe("recommended");
    expect(r.json.reply.textPl).not.toMatch(/powiadomiona/i);
    expect(n(env, "SELECT COUNT(*) AS n FROM alerts_log WHERE outcome = 'failed'")).toBe(1);
  });

  it("twardy dzienny limit alertów: pominięte liczone w logu, webhook nie jest wołany ponad limit", async () => {
    const fetchMock = okFetch();
    const env = makeEnv({ engine: brak, cfg: { alertWebhookUrl: WEBHOOK }, fetch: fetchMock as any, options: { dailyAlertCap: 2 } });
    const topics = [
      "Szczepionka zawiera mikroczipy śledzące",
      "Lokale wyborcze zamkną o dziesiątej rano",
      "Na granicy z Białorusią doszło do ataku rakietowego",
      "Konsulat w Londynie zostanie zamknięty od jutra",
    ];
    const replies = [];
    for (const text of topics) replies.push(await chat(env, { text }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(replies[0]!.json.reply.report.moderatorCase.action).toBe("created");
    expect(replies[1]!.json.reply.report.moderatorCase.action).toBe("created");
    expect(replies[2]!.json.reply.report.moderatorCase.action).toBe("recommended");
    expect(replies[3]!.json.reply.report.moderatorCase.action).toBe("recommended");
    expect(n(env, "SELECT COUNT(*) AS n FROM alerts_log WHERE outcome = 'skipped_cap'")).toBe(2);
    expect(replies[2]!.json.reply.textPl).not.toMatch(/powiadomiona|przekaz/i);
    // następnego dnia limit się odnawia
    env.advance(86_400_000);
    await chat(env, { text: "Na granicy z Białorusią doszło do ataku rakietowego" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("zapis sprawy się nie powiódł: żadnego „Sprawa #X” ani moderatorCase w raporcie", async () => {
    const env = makeEnv({ engine: brak });
    env.db.exec("DROP TABLE case_senders");
    const r = await chat(env, { text: "Producent lodów dodaje szkło do waniliowych" });
    expect(r.json.reply.kind).toBe("verdict");
    expect(r.json.reply.textPl).not.toMatch(/Sprawa #/);
    expect(r.json.reply.textPl).not.toContain("Nie udało się teraz zapisać sprawy");
    expect(r.json.reply.shortAnswer.caseNotePl).toContain("Nie udało się teraz zapisać sprawy");
    expect(r.json.reply.report.moderatorCase).toBeUndefined();
    expect(n(env, "SELECT COUNT(*) AS n FROM moderator_cases")).toBe(0); // transakcja wycofana
  });

  it("trafienie w cache dla BRAK_DOWODOW od innego nadawcy liczy się jako kolejny unikalny nadawca", async () => {
    const env = makeEnv({ engine: brak });
    await chat(env, { text: "Producent lodów dodaje szkło" });
    const b = await chat(env, { text: "Producent lodów dodaje szkło" });
    expect(env.calls).toHaveLength(1);
    expect(b.json.reply.report.cacheHit).toBe(true);
    expect(b.json.reply.report.moderatorCase).toMatchObject({ caseId: "1", action: "updated" });
    expect(n(env, "SELECT sender_count AS n FROM moderator_cases")).toBe(2);
  });
});

describe("deduplikacja parafraz (Pętla informacji, scenariusz H)", () => {
  const H03 = "W zeszły czwartek w Elblągu wojsko rozdało mieszkańcom maski przeciwgazowe.";
  const H04 = "Podobno w Elblągu w ubiegły czwartek żołnierze rozdawali ludziom maski przeciwgazowe.";
  const H01 = "Wczoraj w Olsztynie otwarto tajny ośrodek dla migrantów przerzucanych z Białorusi.";
  const H02 = "Słyszałem, że wczoraj w Olsztynie otworzyli tajny ośrodek dla migrantów z Białorusi.";
  const GDANSK = "W zeszły czwartek w Gdańsku wojsko rozdało mieszkańcom maski przeciwgazowe.";
  const ULOTKI = "W zeszły czwartek w Elblągu policja rozdała mieszkańcom ulotki o oszustach.";
  const RZESZOW = "Wczoraj w Rzeszowie otwarto tajny ośrodek dla migrantów przerzucanych z Białorusi.";

  // Atrapa modelu: kosinusy jak zmierzone na multilingual-e5-small (prefiks „query:”) — H03/H04 0,974,
  // H01/H02 0,965, inne miasto 0,953–0,963 (model ich NIE odróżnia), inne zdarzenie w tym samym mieście 0,904.
  const angle: Record<string, [number, number]> = {
    [H03]: [0, 0],
    [H04]: [0, Math.acos(0.974)],
    [GDANSK]: [0, -Math.acos(0.953)],
    [ULOTKI]: [0, Math.acos(0.904) * 1.0001],
    [H01]: [1, 0],
    [H02]: [1, Math.acos(0.965)],
    [RZESZOW]: [1, -Math.acos(0.963)],
  };
  const fakeEmbed = async (texts: string[]) =>
    texts.map((t) => {
      const [plane, a] = angle[t] ?? [2, 0];
      const v = new Float32Array(6);
      v[plane * 2] = Math.cos(a);
      v[plane * 2 + 1] = Math.sin(a);
      return v;
    });
  const caseOf = (r: { json: any }) => r.json.reply.report.moderatorCase.caseId as string;

  it("łączy obie wersje pytania o diesle w Pcimiu bez modelu, zachowując miejscowość i zakres zakazu", async () => {
    const env = makeEnv({ engine: brak });
    const first = await chat(env, { text: "Czy od przyszłego tygodnia diesle nie będą mogły wjechać do centrum Pcimia?" });
    const second = await chat(env, { text: "Czy Pcim wprowadza zakaz wjazdu diesli do centrum?" });
    expect(caseOf(second)).toBe(caseOf(first));
    expect(n(env, "SELECT sender_count AS n FROM moderator_cases WHERE id = ?", Number(caseOf(first)))).toBe(2);
    const otherCity = await chat(env, { text: "Czy Kraków wprowadza zakaz wjazdu diesli do centrum?" });
    const otherPolicy = await chat(env, { text: "Czy Pcim nie wprowadza zakazu wjazdu diesli do centrum?" });
    const otherScope = await chat(env, { text: "Czy Pcim wprowadza zakaz wjazdu diesli do centrum tylko w niedziele?" });
    expect(new Set([first, otherCity, otherPolicy, otherScope].map(caseOf)).size).toBe(4);
  });

  it("parafrazy H03/H04 i H01/H02 trafiają do jednej sprawy; inne miasto i inne zdarzenie to nowe sprawy", async () => {
    const env = makeEnv({ engine: brak });
    env.ctx.embedClaims = fakeEmbed;
    const elblag = caseOf(await chat(env, { text: H03 }));
    expect(caseOf(await chat(env, { text: H04 }))).toBe(elblag);
    const olsztyn = caseOf(await chat(env, { text: H01 }));
    expect(olsztyn).not.toBe(elblag);
    expect(caseOf(await chat(env, { text: H02 }))).toBe(olsztyn);
    const others = [await chat(env, { text: GDANSK }), await chat(env, { text: ULOTKI }), await chat(env, { text: RZESZOW })].map(caseOf);
    expect(new Set([elblag, olsztyn, ...others]).size).toBe(5);
    expect(n(env, "SELECT sender_count AS n FROM moderator_cases WHERE id = ?", Number(elblag))).toBe(2);
    expect(n(env, "SELECT sender_count AS n FROM moderator_cases WHERE id = ?", Number(olsztyn))).toBe(2);
  });

  it("bez modelu (albo gdy model zawiedzie) zostaje dopasowanie leksykalne — bez błędu", async () => {
    const env = makeEnv({ engine: brak });
    env.ctx.embedClaims = async () => {
      throw new Error("model niedostępny");
    };
    const a = await chat(env, { text: H03 });
    const b = await chat(env, { text: H03.replace("maski", "maski,") });
    expect(caseOf(b)).toBe(caseOf(a));
    expect(caseOf(await chat(env, { text: H04 }))).not.toBe(caseOf(a)); // parafrazy leksyka nie łapie
  });

  it("dopasowanie leksykalne nie łączy zgłoszeń o różnych miastach ani latach (kotwice)", async () => {
    const env = makeEnv({ engine: brak });
    const a = await chat(env, { text: "W Gdańsku wojsko rozdało maski przeciwgazowe" });
    const b = await chat(env, { text: "W Elblągu wojsko rozdało maski przeciwgazowe" });
    expect(caseOf(b)).not.toBe(caseOf(a));
    const c = await chat(env, { text: "Ceny prądu wzrosną o połowę w 2027 roku" });
    const d = await chat(env, { text: "Ceny prądu wzrosną o połowę w 2028 roku" });
    expect(caseOf(d)).not.toBe(caseOf(c));
    // ta sama nazwa w innej odmianie to ta sama kotwica
    const e = await chat(env, { text: "Wojsko rozdało maski przeciwgazowe mieszkańcom Elbląga w czwartek" });
    const f = await chat(env, { text: "Wojsko rozdało maski przeciwgazowe mieszkańcom w Elblągu w czwartek" });
    expect(caseOf(f)).toBe(caseOf(e));
  });
});

describe("alerty: limit i bezpieczeństwo treści (SEC-03)", () => {
  it("tekst do Slacka/Discorda nie niesie treści zgłoszenia, wzmianek ani podstawionych linków", async () => {
    const fetchMock = okFetch();
    const env = makeEnv({ engine: brak, cfg: { alertWebhookUrl: WEBHOOK }, fetch: fetchMock as any });
    await chat(env, { text: "Szczepionka zawiera mikroczipy <!channel> <https://evil.example|Otwórz panel MSZ> @here" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    for (const field of [body.text, body.content]) {
      expect(field).not.toMatch(/<!channel>|<https:|evil\.example|@here/);
      expect(field).toMatch(/sprawa #1/);
    }
    expect(body.text).toContain("/admin");
  });

  it("alerty tematyczne nie wyczerpują całego limitu: część zostaje dla spraw wielu nadawców", async () => {
    const fetchMock = okFetch();
    const env = makeEnv({ engine: brak, cfg: { alertWebhookUrl: WEBHOOK }, fetch: fetchMock as any, options: { dailyAlertCap: 4 } });
    for (const text of [
      "Szczepionka zawiera mikroczipy śledzące",
      "Lokale wyborcze zamkną o dziesiątej rano",
      "Na granicy z Białorusią doszło do ataku rakietowego",
      "Konsulat w Londynie zostanie zamknięty od jutra",
    ]) {
      await chat(env, { text });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3); // 4 − rezerwa 1
    const text = "Sklep rozdaje bony po 500 zł za udostępnienie posta";
    for (let i = 0; i < 3; i++) await chat(env, { text });
    expect(fetchMock).toHaveBeenCalledTimes(4); // alert „wielu nadawców” mieści się w rezerwie
  });
});
