/**
 * Server-side render tests (react-dom/server, no testing-library): the verdict card and the
 * status notice render from fixtures with the right labels, and nothing unsafe reaches an href.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationReply, VerdictReport } from "../../shared/contracts";
import { FIXTURE_REPLIES } from "../fixtures";
import { TITLES } from "../App";
import { announcementFor, replyView, VERDICT_LABEL_PL, WARNING_TITLE_PL } from "../lib/report";
import ChatConversation, { type PendingPhase } from "../pages/ChatConversation";
import ChatLanding from "../pages/ChatLanding";
import { AnswerCard } from "./AnswerCard";
import { ImageFindings } from "./ImageFindings";
import { ReplyContent } from "./ReplyContent";
import { FOOTER_TEXT_PL } from "./SiteFooter";
import { TransparencyBlock } from "./TransparencyBlock";
import { VerdictCard } from "./VerdictCard";

const html = (reply: ConversationReply) => renderToStaticMarkup(createElement(ReplyContent, { reply }));
const allVerdictLabels = Object.values(VERDICT_LABEL_PL);

describe("VerdictCard", () => {
  it.each(["potwierdzone", "falszywe", "wprowadzajace", "brak", "niePodlega"])("renders %s with label and summary", (key) => {
    const reply = FIXTURE_REPLIES[key]!;
    const report = reply.report!;
    const out = html(reply);
    expect(out).toContain(VERDICT_LABEL_PL[report.mainVerdict!]);
    expect(out).toContain("Wynik sprawdzenia");
    expect(out).toContain("Jak sprawdziłem");
    expect(out).toContain(`/w/${report.token}`);
    expect(out).toContain("Siła dowodów");
  });

  it("renders possible narrative matches with a safe link to the original case", () => {
    const reply = structuredClone(FIXTURE_REPLIES.brak!);
    reply.report!.warnings.push({
      kind: "incident_narrative",
      textPl: "EUvsDisinfo opisało wcześniej podobne twierdzenie.",
      links: [
        { title: "Sprawa EUvsDisinfo", url: "https://euvsdisinfo.eu/report/example/" },
        { title: "Nieprawidłowy link", url: "javascript:alert(1)" },
      ],
    });
    const out = html(reply);
    expect(out).toContain(WARNING_TITLE_PL.incident_narrative);
    expect(out).toContain('href="https://euvsdisinfo.eu/report/example/"');
    expect(out).not.toContain("javascript:");
  });

  it("groups evidence and shows quotes, publisher and both dates", () => {
    const out = html(FIXTURE_REPLIES.falszywe!);
    expect(out).toContain("Co przeczy");
    expect(out).toContain("Kontekst");
    expect(out).toContain("Opublikowano: 20 listopada 2026");
    expect(out).toContain("Pobrano: 20 listopada 2026");
    expect(out).toContain("Redakcja fact-checkingowa — przykład");
    expect(out).toContain("<blockquote");
    expect(out).toContain(WARNING_TITLE_PL.injection_detected);
  });

  it("shows conflicting sources side by side", () => {
    const out = html(FIXTURE_REPLIES.brak!);
    expect(out).toContain("Źródła są sprzeczne");
    expect(out).toContain("Według tych źródeł — prawda");
    expect(out).toContain("Według tych źródeł — nieprawda");
  });

  it("never puts a non-http(s) URL into an href", () => {
    const report: VerdictReport = structuredClone(FIXTURE_REPLIES.potwierdzone!.report!);
    report.verdicts[0]!.evidence[0]!.url = "javascript:alert(1)";
    report.verdicts[0]!.evidence[0]!.title = "<img src=x onerror=alert(1)>";
    const out = renderToStaticMarkup(createElement(VerdictCard, { report }));
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("status replies", () => {
  it("renders NIEPELNE as a technical notice without any verdict label", () => {
    const out = html(FIXTURE_REPLIES.niepelne!);
    expect(out).toContain("Nie udało się dokończyć sprawdzenia");
    expect(out).toContain("To nie jest ocena informacji.");
    for (const label of allVerdictLabels) expect(out).not.toContain(label);
    expect(out).not.toContain("Wynik sprawdzenia");
  });

  it("renders rate limiting and plain text replies", () => {
    expect(html({ kind: "rate_limited", textPl: "Poczekaj chwilę.", quickReplies: [] })).toContain("Za dużo wiadomości");
    const help = html({ kind: "help", textPl: "Linia 1\nLinia 2", quickReplies: [] });
    expect(help).toContain("Linia 1");
    expect(help).toContain("Linia 2");
  });
});

describe("AnswerCard (open questions)", () => {
  it("renders the answer sentence, the quote in a blockquote, source metadata, archival warning and result link", () => {
    const reply = FIXTURE_REPLIES.odpowiedz!;
    const report = reply.report!;
    const out = html(reply);
    expect(out).toContain("Odpowiedź ze źródła");
    expect(out).toContain("NATO — przykład (7 marca 2024) podaje:"); // answer sentence as assembled by code
    expect(out).toContain("<blockquote");
    expect(out).toContain("Szwecja została 32. członkiem Sojuszu");
    expect(out).toContain("Data publikacji");
    expect(out).toContain("7 marca 2024");
    expect(out).toContain("Data pobrania");
    expect(out).toContain("20 listopada 2026");
    expect(out).toContain("NATO — przykład");
    expect(out).toContain('href="https://example.org/nato/news/sweden-joins"');
    expect(out).toContain(WARNING_TITLE_PL.archival_material);
    expect(out).toContain(`/w/${report.token}`);
    for (const label of allVerdictLabels) expect(out).not.toContain(`>${label}<`);
  });

  it("keeps an unanswered chat turn short, with its warnings and a link to the full search details", () => {
    const reply = structuredClone(FIXTURE_REPLIES.brakOdpowiedzi!);
    reply.report!.warnings.push({ kind: "branch_unavailable", textPl: "Wyszukiwanie na żywo było niedostępne." });
    const out = html(reply);
    expect(out).toContain("Nie znalazłem odpowiedzi w źródłach");
    expect(out).toContain("Wyszukiwanie na żywo było niedostępne.");
    expect(out).toContain(`/w/${reply.report!.token}`);
    expect(out).not.toContain(reply.report!.summaryPl);
    const full = renderToStaticMarkup(createElement(AnswerCard, { report: reply.report! }));
    expect(full).toContain(reply.report!.summaryPl);
    expect(full).toContain("Jak sprawdziłem");
  });

  it("never links a non-http(s) answer source", () => {
    const report: VerdictReport = structuredClone(FIXTURE_REPLIES.odpowiedz!.report!);
    report.answer!.evidence[0]!.url = "javascript:alert(1)";
    const out = renderToStaticMarkup(createElement(AnswerCard, { report }));
    expect(out).not.toContain("javascript:");
  });

  it("shows no archival warning when neither the report nor strength flags it", () => {
    const report: VerdictReport = structuredClone(FIXTURE_REPLIES.odpowiedz!.report!);
    report.warnings = [];
    expect(renderToStaticMarkup(createElement(AnswerCard, { report }))).not.toContain(WARNING_TITLE_PL.archival_material);
  });

  it("a technical status on an answer reply is never shown as an answer", () => {
    const reply = structuredClone(FIXTURE_REPLIES.odpowiedz!);
    reply.report!.status = "NIEPELNE";
    reply.report!.statusMessagePl = "Nie udało się dokończyć.";
    const out = html(reply);
    expect(out).toContain("To nie jest ocena informacji.");
    expect(out).not.toContain("Odpowiedź ze źródła");
  });
});

describe("source activity", () => {
  const details = (report: VerdictReport) => renderToStaticMarkup(createElement(TransparencyBlock, { report }));

  it("shows actual search outcomes and keeps assessed fragments separate from citations", () => {
    const report = structuredClone(FIXTURE_REPLIES.odpowiedz!.report!);
    report.cacheHit = true;
    report.sourceActivity = {
      branches: [
        { id: "bm25", labelPl: "Wyszukiwanie słów", status: "completed", candidateCount: 12 },
        { id: "vector", labelPl: "Podobne znaczenie", status: "partial", candidateCount: 3 },
        { id: "live", labelPl: "Wyszukiwanie w sieci", status: "unavailable", candidateCount: 0 },
        { id: "official", labelPl: "Komunikaty urzędowe", status: "skipped", candidateCount: 0 },
      ],
      candidateCount: 13, assessedCount: 4,
    };
    const item = report.answer!.evidence[0]!;
    report.answer!.evidence.push({ ...item, recordId: "second-record-for-the-same-publication" });
    const out = details(report);
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain("Odczytałem zapisany wynik");
    expect(out).toContain("12 fragmentów");
    expect(out).toContain("Częściowe wyniki · 3 fragmenty");
    expect(out).toContain("Wyszukiwanie niedostępne");
    expect(out).toContain("Pominięto");
    expect(out).toContain("13 fragmentów");
    expect(out).toContain("Model ocenił 4 fragmenty");
    expect(out).toContain("7 marca 2024");
    expect(out.split(`href="${item.url}"`)).toHaveLength(2);
    expect(out).toContain(item.quote);
    expect(out).toContain('href="/zrodla"');
  });

  it("keeps old reports readable without reconstructing searches and avoids implying a search on early stops", () => {
    const report = structuredClone(FIXTURE_REPLIES.niepelne!.report!);
    expect(details(report)).not.toContain("Gdzie szukałem");
    report.sourceActivity = { branches: [], candidateCount: 0, assessedCount: 0 };
    const out = html({ kind: "status", report, textPl: report.summaryPl, quickReplies: [] });
    expect(out).toContain("Jak sprawdziłem");
    expect(out).toContain("nie zarejestrowano przeszukania źródeł");
    expect(out).not.toContain("Cytowane fragmenty");
    expect(html({ kind: "help", textPl: "Nazwa pochodzi od łacińskiego słowa fons.", quickReplies: [] })).not.toContain("Jak sprawdziłem");
  });
});

describe("image analysis", () => {
  it("shows provenance and the publisher's own rating in chat and expands public matches in the report", () => {
    const analysis: NonNullable<VerdictReport["imageAnalysis"]> = {
      only: true,
      images: [{
        provenance: { credential: "absent", declaration: "none", basis: "none", textPl: "Pochodzenie obrazu jest nieznane." },
        search: {
          status: "ok", messagePl: "Google znalazło dopasowania.", factCheckStatus: "ok",
          matches: [
            { kind: "full", host: "media.example.org" },
            { kind: "page", host: "news.example.org", url: "https://news.example.org/artykul", title: "Artykuł z obrazem" },
          ],
          factChecks: [{
            publisher: "Redakcja testowa", title: "Weryfikacja podpisu", url: "https://review.example.org/podpis", rating: "Błędny kontekst",
          }],
        },
      }],
    };
    const report = { ...FIXTURE_REPLIES.potwierdzone!.report!, imageAnalysis: analysis };
    const chat = html({ kind: "image_analysis", textPl: "", report, quickReplies: [] });
    const full = renderToStaticMarkup(createElement(ImageFindings, { analysis, expanded: true }));
    for (const output of [chat, full]) {
      expect(output).toContain("Pochodzenie obrazu jest nieznane.");
      expect(output).toContain("Redakcja testowa");
      expect(output).toContain("Ocena redakcji: Błędny kontekst");
      expect(output).toContain('href="https://review.example.org/podpis"');
      for (const label of allVerdictLabels) expect(output).not.toContain(label);
    }
    expect(full).toContain("media.example.org");
    expect(full).not.toContain('href="https://media.example.org');
    expect(full).toContain('href="https://news.example.org/artykul"');
  });
});

describe("chat helpers", () => {
  it("announces outcomes, not interactions", () => {
    expect(announcementFor(FIXTURE_REPLIES.falszywe!)).toMatch(/^Wynik sprawdzenia: Fałszywe\./);
    expect(announcementFor(FIXTURE_REPLIES.odpowiedz!)).toMatch(/^Odpowiedź ze źródła: NATO — przykład/);
    expect(announcementFor(FIXTURE_REPLIES.odpowiedz!)).toContain("7 marca 2024 r."); // the quote is not cut at "32."
    expect(announcementFor(FIXTURE_REPLIES.brakOdpowiedzi!)).toMatch(/^Nie znalazłem odpowiedzi/);
    const status = announcementFor(FIXTURE_REPLIES.niepelne!);
    expect(status).toContain("To nie jest ocena informacji.");
    for (const label of allVerdictLabels) expect(status).not.toContain(label);
    expect(announcementFor({ kind: "help", textPl: "Pierwsze zdanie. Drugie.", quickReplies: [] })).toBe("Pierwsze zdanie.");
  });

  it("routes answer replies to the answer view", () => {
    expect(replyView(FIXTURE_REPLIES.odpowiedz!)).toBe("answer");
    expect(replyView(FIXTURE_REPLIES.brakOdpowiedzi!)).toBe("answer");
    expect(replyView(FIXTURE_REPLIES.potwierdzone!)).toBe("verdict");
    expect(replyView({ kind: "answer", textPl: "x", quickReplies: [] })).toBe("text");
  });

  it("shows typing dots until verification starts, then shows the active tool", () => {
    const renderChat = (pending: PendingPhase | null) => renderToStaticMarkup(createElement(ChatConversation, {
      entries: [{ id: "m1", role: "user", text: "hej co to ?" }],
      pending,
      onSubmit: () => undefined,
      onAction: () => undefined,
    }));
    const responding = renderChat("responding");
    expect(responding.match(/astryx-status-dot/g)).toHaveLength(3);
    expect(responding).not.toContain("astryx-chat-tool-calls");
    expect(responding).toContain("hej co to ?");
    expect(responding).not.toContain("Cześć! Zadaj mi pytanie");
    expect(responding).toContain('aria-label="Fons pisze…"');
    expect(responding).not.toContain(">Fons<");
    expect(responding).not.toContain("Szukam źródeł…");
    expect(responding).not.toContain("Nowa rozmowa");
    const verifying = renderChat("verifying");
    expect(verifying.match(/astryx-chat-tool-calls/g)).toHaveLength(1);
    expect(verifying).toContain("Rozpoczynam sprawdzanie…");
    expect(renderChat("searching")).toContain("Szukam źródeł…");
    expect(renderChat("assessing")).toContain("Czytam znalezione fragmenty…");
    expect(renderChat("checking_quotes")).toContain("Sprawdzam cytaty…");
    expect(verifying).not.toContain("astryx-status-dot");
    expect(verifying).not.toContain(">Fons<");
    const image = renderChat("image");
    expect(image).toContain("Analizuję obraz…");
    expect(image).not.toContain("Szukam źródeł…");
    expect(renderChat(null)).not.toContain("astryx-chat-tool-calls");
    expect(renderChat(null)).not.toContain("astryx-status-dot");
  });

  it("offers the same attachment picker on the landing page and during a conversation", () => {
    const onSubmit = () => {};
    const landing = renderToStaticMarkup(createElement(ChatLanding, { onSubmit }));
    const chat = renderToStaticMarkup(createElement(ChatConversation, { entries: [], pending: null, onSubmit, onAction: onSubmit }));
    for (const output of [landing, chat]) {
      expect(output).toContain('aria-label="Dodaj plik"');
      expect(output).toContain('type="file"');
      expect(output).toContain("application/pdf");
      expect(output).toContain("image/webp");
      expect(output).not.toContain("astryx-chat-composer-drawer");
    }
  });

  it("brands the app as Fons and keeps the footer disclaimer", () => {
    expect(TITLES.chat).toBe("Fons — sprawdź informację u źródła");
    expect(FOOTER_TEXT_PL).toBe("Prototyp. Pomaga ocenić informację — nie jest automatycznym sędzią prawdy.");
  });
});
