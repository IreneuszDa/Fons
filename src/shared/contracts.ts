/**
 * Fons — wspólne kontrakty danych.
 *
 * Ten plik jest JEDYNYM źródłem prawdy o kształcie danych przepływających między modułami
 * (korpus → silnik → raport → kanały / WWW / ewaluacja). Zmiany wymagają zgody orkiestratora.
 * Wszystkie nazwy pól po angielsku, wartości enumów i teksty dla użytkownika po polsku.
 *
 * Zasady nienaruszalne (PLAN.md §1), które te typy egzekwują:
 *  - treść od użytkownika nigdy nie jest dowodem (EvidenceItem pochodzi wyłącznie z CorpusRecord),
 *  - status techniczny ≠ werdykt (TechStatus osobno od Verdict),
 *  - werdykt liczy kod (ClaimVerdict.ruleApplied wskazuje regułę z §4),
 *  - linki/tytuły/daty w raporcie pochodzą z bazy (EvidenceItem kopiuje pola z CorpusRecord).
 */
import { z } from "zod";
import { ImageProvenance } from "./image-provenance";
import { ImageCitation, ImageSearchResult } from "./image-search";

// ───────────────────────────── Enumy ─────────────────────────────

/** Pięć klas werdyktu (zadanie §2). */
export const Verdict = z.enum([
  "POTWIERDZONE",
  "FALSZYWE",
  "WPROWADZAJACE",
  "BRAK_DOWODOW",
  "NIE_PODLEGA",
]);
export type Verdict = z.infer<typeof Verdict>;

/** Etykiety werdyktów dla użytkownika. */
export const VERDICT_LABEL_PL: Record<Verdict, string> = {
  POTWIERDZONE: "Potwierdzone",
  FALSZYWE: "Fałszywe",
  WPROWADZAJACE: "Wprowadzające w błąd",
  BRAK_DOWODOW: "Brak wystarczających dowodów",
  NIE_PODLEGA: "Nie podlega weryfikacji",
};

/**
 * Status techniczny — NIGDY nie jest werdyktem (PLAN §1.3).
 *  OK            — sprawdzenie wykonane (może mieć adnotację o niedostępnej gałęzi opcjonalnej),
 *  NIEPELNE      — padł element konieczny (model, korpus, odczyt wejścia) → brak werdyktu,
 *  AWARIA        — błąd systemu → brak werdyktu,
 *  DOPRECYZUJ    — pytanie niejasne → prośba o doprecyzowanie,
 *  POZA_ZAKRESEM — wejście poza zakresem usługi.
 */
export const TechStatus = z.enum(["OK", "NIEPELNE", "AWARIA", "DOPRECYZUJ", "POZA_ZAKRESEM"]);
export type TechStatus = z.infer<typeof TechStatus>;

/** Typ źródła w katalogu. */
export const SourceType = z.enum(["pierwotne", "factcheck", "analiza"]);
export type SourceType = z.infer<typeof SourceType>;

/**
 * Poziom źródła (przypisany do dokładnego hosta w katalogu, nigdy z odpowiedzi modelu):
 *  1 — pierwotne / urzędowe (akty prawne, dane publiczne, komunikaty instytucji),
 *  2 — fact-check sygnatariusza IFCN/EFCSN, analiza instytucji publicznej UE/NATO,
 *  3 — wiarygodne źródło wtórne.
 */
export const SourceLevel = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type SourceLevel = z.infer<typeof SourceLevel>;

/**
 * Rola rekordu (PLAN §4):
 *  tresc       — źródło treści; relację do twierdzenia ocenia czytelnik (LLM),
 *  stala_rola  — fact-check / ClaimReview / rekord bazy incydentów: werdykt bierzemy z pola oceny
 *                rekordu przez tabelę mapowania; model sprawdza tylko dopasowanie tezy.
 */
export const SourceRole = z.enum(["tresc", "stala_rola"]);
export type SourceRole = z.infer<typeof SourceRole>;

export const Relation = z.enum(["WSPIERA", "OBALA", "CZESCIOWO", "INNY_KONTEKST", "BEZ_ZWIAZKU"]);
export type Relation = z.infer<typeof Relation>;

export const Aspect = z.enum(["sedno", "czas", "miejsce", "liczba", "autorstwo", "zakres"]);
export type Aspect = z.infer<typeof Aspect>;

/** Stosunek tezy rekordu o stałej roli (claimReviewed) do twierdzenia użytkownika. */
export const FixedRoleMatch = z.enum(["ta_sama", "zaprzeczona", "inna", "niepewne"]);
export type FixedRoleMatch = z.infer<typeof FixedRoleMatch>;

/** Wynik niezależnego weryfikatora cytatu (PLAN §3.6). */
export const VerifierVote = z.enum(["zgoda", "sprzeciw", "niepewne", "brak"]);
export type VerifierVote = z.infer<typeof VerifierVote>;

export const Strength = z.enum(["slaba", "srednia", "mocna"]);
export type Strength = z.infer<typeof Strength>;

export const ClaimType = z.enum(["fakt", "opinia", "prognoza"]);
export type ClaimType = z.infer<typeof ClaimType>;

export const ChannelId = z.enum(["web", "chatloom", "discord", "whatsapp", "sms", "imessage", "messenger", "cli", "eval", "mcp"]);
export type ChannelId = z.infer<typeof ChannelId>;

// ───────────────────────────── Katalog i korpus ─────────────────────────────

/** Pozycja katalogu źródeł (data/sources.yaml). Poziom przypisany do DOKŁADNEGO hosta. */
export const CatalogSource = z.object({
  id: z.string(), // np. "eli-sejm", "demagog"
  hosts: z.array(z.string()).min(1), // dokładne hosty, bez dziedziczenia subdomen
  publisher: z.string(),
  type: SourceType,
  level: SourceLevel,
  role: SourceRole,
  independenceGroup: z.string(), // wydawcy z tej samej grupy liczą się jako jedno potwierdzenie
  licence: z.string(),
  fetchMethod: z.string(), // "api", "rss", "html", "dump", "organizer-pack"
  updateFrequency: z.string(),
  qualification: z.string(), // dlaczego źródło jest w katalogu
  exclusion: z.string().optional(), // kiedy rekordy są wykluczane
  homepage: z.string().url(),
  nonEea: z.boolean().default(false),
  ifcnEfcsn: z.boolean().default(false), // sygnatariusz IFCN/EFCSN (dla fact-checków)
  liveSearch: z.boolean().default(false), // host dopuszczony do wyszukiwania na żywo (flaga polityki, nie gwarancja dostępu)
  /** Prefiksy ścieżek, którym źródło jest zaufane na szerokim hoście (np. ["/eurostat/"] na ec.europa.eu). Brak = cały host. */
  pathPrefixes: z.array(z.string()).optional(),
});
export type CatalogSource = z.infer<typeof CatalogSource>;

/** Ocena z rekordu o stałej roli (np. ClaimReview textualRating). */
export const FixedRating = z.object({
  raw: z.string(), // dosłownie z rekordu, np. "Fałsz", "Manipulacja"
  mapped: Verdict.nullable(), // przez jawną tabelę mapowania; null = nieznana → nie rozstrzyga
  binary: z.boolean(), // czy ocena jest binarna (prawda/fałsz) — tylko takie odwracamy przy negacji
});
export type FixedRating = z.infer<typeof FixedRating>;

/** Jeden rekord korpusu (fragment dokumentu). Jedyne, co może być dowodem. */
export const CorpusRecord = z.object({
  id: z.string(), // stabilny: `${sourceId}:${hash}`
  sourceId: z.string(),
  url: z.string().url(),
  title: z.string(),
  publisher: z.string(),
  publishedAt: z.string().nullable(), // ISO 8601 (data publikacji) lub null, gdy nieznana
  fetchedAt: z.string(), // ISO 8601 (data pobrania)
  lang: z.string(), // "pl", "en", ...
  text: z.string(), // fragment (≤ ~1500 znaków); dla treści redakcyjnych krótki cytat + streszczenie metadanych
  role: SourceRole,
  type: SourceType,
  level: SourceLevel,
  independenceGroup: z.string(),
  licence: z.string(),
  claimReviewed: z.string().optional(), // tylko stala_rola
  rating: FixedRating.optional(), // tylko stala_rola
  topics: z.array(z.string()).default([]),
  /** Okres, którego dotyczą dane (np. "2024", "2025-Q2"), jeśli znany. */
  period: z.string().optional(),
  origin: z.enum(["corpus", "live_snapshot", "organizer"]).default("corpus"),
});
export type CorpusRecord = z.infer<typeof CorpusRecord>;

// ───────────────────────────── Wejście ─────────────────────────────

export const InputKind = z.enum(["text", "url", "image", "recording"]);
export type InputKind = z.infer<typeof InputKind>;

/** Wiadomość przychodząca z dowolnego kanału, po parsowaniu przez adapter. */
export const InboundMessage = z.object({
  channel: ChannelId,
  /** Pseudonimizowany identyfikator nadawcy (HMAC z pepperem) — nigdy surowy numer. */
  senderId: z.string(),
  sessionId: z.string(),
  messageId: z.string(), // do deduplikacji
  receivedAt: z.string(),
  text: z.string().default(""),
  /** Przycisk/akcja wybrana przez użytkownika (np. potwierdzenie usunięcia danych). */
  action: z.string().optional(),
  images: z.array(z.object({ mime: z.string(), dataRef: z.string() })).default([]),
  document: z.object({ dataRef: z.string() }).optional(),
  recording: z.object({ dataRef: z.string() }).optional(),
  imageOptions: z.object({ searchWeb: z.boolean().optional() }).optional(),
});
export type InboundMessage = z.infer<typeof InboundMessage>;

/** Trafienie deterministycznego detektora ataków (PLAN §3.2). */
export const DetectorHit = z.object({
  location: z.enum(["user_message", "fetched_page", "evidence", "quote", "ocr"]),
  recordId: z.string().optional(),
  pattern: z.string(), // identyfikator reguły, np. "ignore_previous_pl"
  /** Skrót (≤ 120 znaków), zamaskowany — do logu i raportu. */
  excerpt: z.string(),
  severity: z.enum(["low", "high"]),
});
export type DetectorHit = z.infer<typeof DetectorHit>;

/** Wejście po normalizacji (krok 1). Treść pobrana z URL jest PRZEDMIOTEM weryfikacji, nie dowodem. */
export const NormalizedInput = z.object({
  kind: InputKind,
  /** Tekst do weryfikacji (po maskowaniu PII, po usunięciu ukrytego HTML). */
  text: z.string(),
  /** Separate, detector-checked fields so the sender's question cannot supply missing facts about an attachment. */
  userNote: z.string().optional(),
  attachmentText: z.string().optional(),
  /** Dates transcribed from pixels, with no claim about the original publication date. */
  visibleDates: z.array(z.string()).optional(),
  submittedUrl: z.string().optional(),
  pageTitle: z.string().optional(),
  pagePublishedAt: z.string().optional(),
  pageDisplayedDate: z.string().optional(),
  /** Moment zgłoszenia — kotwica dla „wczoraj/dziś”. */
  receivedAt: z.string(),
  /** Tekst z zamienionymi datami względnymi na bezwzględne (do hasha cache i ekstrakcji). */
  textResolvedDates: z.string(),
  detectorHits: z.array(DetectorHit),
  piiMasked: z.boolean(),
  warnings: z.array(z.string()),
});
export type NormalizedInput = z.infer<typeof NormalizedInput>;

// ───────────────────────────── Twierdzenia i dowody ─────────────────────────────

export const Claim = z.object({
  id: z.string(), // "c1", "c2", "c3"
  text: z.string(),
  type: ClaimType,
  isMain: z.boolean(),
  /** jednorazowe = zdarzenie z datą; stan = stan/statystyka w czasie teraźniejszym (PLAN §4 reguły 3–4). */
  temporal: z.object({
    kind: z.enum(["jednorazowe", "stan", "brak"]),
    date: z.string().optional(), // ISO, jeśli ustalona
    asOf: z.string().optional(), // punkt odniesienia dla stanu opisanego w datowanym artykule
  }),
  /** Zgodność n-gramów z wejściem (0–1); poniżej progu twierdzenie odrzucane. */
  inputOverlap: z.number(),
  /**
   * Opcjonalne (rozszerzenie zgodne wstecz): aspekt, który niesie JEDYNĄ sprawdzalną treść twierdzenia poza
   * niespornym podmiotem — „Polska wstąpiła do NATO w 2004 roku” → czas; „W 2024 r. inflacja wyniosła 15%” → liczba;
   * „Ustawę podpisał X” → autorstwo; „Wczoraj w Krakowie była powódź” → sedno. Czytają je reguły werdyktu (reguła 8b,
   * docs/VERDICT-RULES.md): podane rozstrzyga („sedno” wyłącza 8b), brak = zachowawcze przybliżenie w kodzie.
   */
  assertedAspect: Aspect.optional(),
});
export type Claim = z.infer<typeof Claim>;

export const RetrievalVia = z.enum(["bm25", "vector", "incident", "connector", "live"]);
export type RetrievalVia = z.infer<typeof RetrievalVia>;

export const EvidenceCandidate = z.object({
  recordId: z.string(),
  score: z.number(),
  via: RetrievalVia,
  /** Kandydat z lokalnego wyszukiwania podobnych sprawdzeń, zachowywany do oceny po fuzji. */
  semanticFactCheck: z.literal(true).optional(),
});
export type EvidenceCandidate = z.infer<typeof EvidenceCandidate>;

/** Ocena jednego fragmentu względem jednego twierdzenia (kroki 5–6). */
export const EvidenceAssessment = z.object({
  claimId: z.string(),
  recordId: z.string(),
  relation: Relation,
  aspect: Aspect,
  period: z.string().optional(),
  /** Dosłowny cytat ≤ 300 znaków — MUSI występować w CorpusRecord.text (kontrola podciągu). */
  quote: z.string(),
  quoteVerified: z.boolean(),
  quoteMatchScore: z.number(),
  fixedRoleMatch: FixedRoleMatch.optional(), // tylko dla stala_rola
  partialMeaning: z.enum(["coverage", "correction"]).optional(),
  verifier: VerifierVote.default("brak"),
  /** Czy dowód jest rozstrzygający wg PLAN §4 (wyliczane w kodzie). */
  decisive: z.boolean().default(false),
  /** Powód odrzucenia dowodu (np. "quote_not_found", "detector_hit", "verifier_dissent"). */
  excluded: z.string().optional(),
});
export type EvidenceAssessment = z.infer<typeof EvidenceAssessment>;

/** Dowód do wyświetlenia — wszystkie pola opisowe skopiowane z CorpusRecord, nie z modelu. */
export const EvidenceItem = z.object({
  recordId: z.string(),
  title: z.string(),
  publisher: z.string(),
  publishedAt: z.string().nullable(),
  fetchedAt: z.string(),
  url: z.string(),
  quote: z.string(),
  passageKind: z.enum(["excerpt", "structured_data", "reviewed_claim"]).optional(),
  partialMeaning: EvidenceAssessment.shape.partialMeaning,
  relation: Relation,
  aspect: Aspect,
  sourceType: SourceType,
  level: SourceLevel,
  role: SourceRole,
  ratingRaw: z.string().optional(),
  group: z.enum(["wspierajace", "obalajace", "kontekst"]),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

/** Jeden jawny czynnik oceny siły dowodów (co ją podnosi, co obniża). */
export const StrengthFactor = z.object({
  effect: z.enum(["plus", "minus"]),
  textPl: z.string(),
});
export type StrengthFactor = z.infer<typeof StrengthFactor>;

export const StrengthCard = z.object({
  level: Strength,
  /**
   * Punktacja 0–100 wyliczona w kodzie z jawnych czynników (verdict/strength.ts). null = werdykt bez
   * podstawy merytorycznej (brak dowodów, sprzeczność, opinia). Pole opcjonalne: starsze raporty go nie mają.
   */
  score: z.number().int().min(0).max(100).nullable().optional(),
  /** Czynniki, z których wynika punktacja — w kolejności ważności. Opcjonalne (starsze raporty). */
  factors: z.array(StrengthFactor).optional(),
  primarySources: z.number(),
  independentPublishers: z.number(),
  newestEvidenceAt: z.string().nullable(),
  archivalWarning: z.boolean(),
  verifierAgreement: VerifierVote,
  notes: z.array(z.string()), // np. "weryfikator tej samej rodziny"
});
export type StrengthCard = z.infer<typeof StrengthCard>;

export const ClaimVerdict = z.object({
  claimId: z.string(),
  verdict: Verdict,
  /** Numer reguły z PLAN §4 (1–9), która wyznaczyła werdykt. */
  ruleApplied: z.number().int().min(1).max(9),
  strength: StrengthCard,
  /** Uzasadnienie z szablonu (domyślnie) lub zwalidowane wygładzenie. */
  reasonPl: z.string(),
  missingContext: z.string().optional(),
  conflicting: z
    .object({ supporting: z.array(z.string()), refuting: z.array(z.string()) })
    .optional(), // recordId po obu stronach
  /** Dla BRAK_DOWODOW: co próbowano ustalić i czego zabrakło. */
  triedPl: z.string().optional(),
  evidence: z.array(EvidenceItem),
});
export type ClaimVerdict = z.infer<typeof ClaimVerdict>;

export const ReportWarning = z.object({
  kind: z.enum([
    "injection_detected",
    "archival_material",
    "source_status", // np. podmiot objęty sankcjami UE — neutralne ostrzeżenie, nie przesłanka
    "incident_domain", // domena/kanał w katalogu incydentów — tylko ostrzeżenie
    "incident_narrative", // dopasowanie twierdzenia do przypadku EUvsDisinfo
    "branch_unavailable", // gałąź opcjonalna niedostępna
    "single_key_verifier", // weryfikator tej samej rodziny
    "non_eea_processing",
    "image_limits",
  ]),
  textPl: z.string(),
  links: z.array(z.object({ title: z.string(), url: z.string().url() })).optional(),
});
export type ReportWarning = z.infer<typeof ReportWarning>;

export const ModelUsage = z.object({
  purpose: z.string(), // "claims", "assess", "verifier", "smooth", "router", "vision", "live_search" (tokeny wyszukiwarki + opłata za wywołania)
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  latencyMs: z.number(),
  costUsd: z.number(),
});
export type ModelUsage = z.infer<typeof ModelUsage>;

/** Counts refer to distinct corpus fragment IDs. Queries and discarded record contents stay private. */
export const SourceActivity = z.object({
  branches: z.array(z.object({
    id: z.string(),
    labelPl: z.string(),
    status: z.enum(["completed", "partial", "unavailable", "skipped"]),
    candidateCount: z.number().int().nonnegative(),
  })),
  candidateCount: z.number().int().nonnegative(),
  assessedCount: z.number().int().nonnegative(),
});
export type SourceActivity = z.infer<typeof SourceActivity>;

const VideoSegment = z.object({ seconds: z.number().nonnegative(), text: z.string() });
export const VideoAnalysis = z.object({
  platform: z.enum(["tiktok", "instagram", "facebook", "youtube", "upload_audio", "upload_video"]),
  status: z.enum(["analyzed", "subtitles_only", "transcript_only", "caption_only", "unavailable"]),
  provider: z.enum(["openai", "gemini"]).optional(),
  transcriptSource: z.enum(["platform", "openai", "gemini"]).optional(),
  mediaIssue: z.string().optional(),
  title: z.string().optional(),
  author: z.string().optional(),
  thumbnailUrl: z.url({ protocol: /^https$/ }).optional(),
  caption: z.string(),
  transcript: z.array(VideoSegment),
  observations: z.array(VideoSegment),
  claimOrigins: z.array(z.object({
    claimId: z.string(),
    source: z.enum(["speech", "subtitles", "onscreen", "visual", "caption"]),
    seconds: z.number().nonnegative().nullable(),
  })),
});
export type VideoAnalysis = z.infer<typeof VideoAnalysis>;

/** Kanoniczny raport — ten sam dla każdego kanału. Renderery kanałów to szablony bez LLM. */
export const VerdictReport = z.object({
  id: z.string(),
  /** 128-bitowy token strony /w/{token}; per użytkownik. */
  token: z.string(),
  createdAt: z.string(),
  pipelineVersion: z.string(),
  corpusSnapshot: z.string(),
  verdictMode: z.enum(["rules", "model_proposed"]),
  status: TechStatus,
  /** Komunikat dla użytkownika przy statusie innym niż OK (nigdy treść błędu dostawcy). */
  statusMessagePl: z.string().optional(),
  inputKind: InputKind,
  /** Wejście po maskowaniu PII (do wyświetlenia na stronie wyniku). */
  inputEchoMasked: z.string(),
  claims: z.array(Claim),
  verdicts: z.array(ClaimVerdict),
  /** Werdykt twierdzenia głównego — etykieta wiadomości. null gdy status ≠ OK. */
  mainVerdict: Verdict.nullable(),
  /** 1–3 zdania prostym polskim (szablon/zwalidowane). */
  summaryPl: z.string(),
  warnings: z.array(ReportWarning),
  /** Blok przejrzystości zgodny z faktycznym trybem (PLAN §4). */
  transparencyPl: z.string(),
  models: z.array(ModelUsage),
  timingsMs: z.record(z.string(), z.number()),
  costUsd: z.number(),
  /** Gałęzie wyszukiwania, które nie zadziałały (bez treści błędów). */
  unavailableBranches: z.array(z.string()),
  sourceActivity: SourceActivity.optional(),
  /** Metadata of the submitted page, after its body was successfully read. */
  article: z.object({ url: z.string(), title: z.string().optional(), publishedAt: z.string().optional(), displayedDate: z.string().optional() }).optional(),
  /** Trafienia detektora — przy każdym trafieniu w cache serwer zapisuje je ponownie w logu zdarzeń. */
  securityEvents: z.array(DetectorHit).default([]),
  /**
   * Tryb wejścia: twierdzenie do sprawdzenia, pytanie tak/nie (zamienione na twierdzenie)
   * albo pytanie otwarte („Kto jest…?”), na które odpowiadamy WYŁĄCZNIE dosłownym cytatem ze źródła.
   */
  inputMode: z.enum(["claim", "question_yesno", "question_open"]).default("claim"),
  /**
   * Odpowiedź na pytanie otwarte — złożona przez kod z zweryfikowanego cytatu (nigdy z wiedzy modelu).
   * Brak cytatu → brak odpowiedzi i status OK z BRAK_DOWODOW w summaryPl.
   */
  answer: z
    .object({
      questionPl: z.string(),
      /** Szablon: „Według {wydawca} ({data}): «{cytat}»”. */
      answerPl: z.string(),
      evidence: z.array(EvidenceItem).min(1),
    })
    .optional(),
  /** Independent questions in one message retain separate evidence and availability. */
  questionParts: z.array(z.object({
    questionPl: z.string(),
    answerPl: z.string(),
    status: z.enum(["answered", "insufficient", "unavailable"]),
    evidence: z.array(EvidenceItem),
  })).optional(),
  /** Sprawa moderatora utworzona/zaktualizowana — tylko po faktycznym zapisie. */
  moderatorCase: z
    .object({ caseId: z.string(), action: z.enum(["created", "updated", "recommended"]) })
    .optional(),
  imageAnalysis: z.object({
    only: z.boolean(),
    focus: z.enum(["copies", "origin"]).optional(),
    images: z.array(z.object({ provenance: ImageProvenance, search: ImageSearchResult.optional() })),
    visual: z.object({
      mode: z.enum(["visual", "identity"]),
      citations: z.array(ImageCitation),
    }).optional(),
  }).optional(),
  videoAnalysis: VideoAnalysis.optional(),
  cacheHit: z.boolean().default(false),
});
export type VerdictReport = z.infer<typeof VerdictReport>;

export function reportEvidence(report: VerdictReport): EvidenceItem[] {
  const byId = new Map<string, EvidenceItem>();
  for (const entry of [...report.verdicts.flatMap(v => v.evidence), ...(report.answer?.evidence ?? []), ...(report.questionParts?.flatMap(p => p.evidence) ?? [])]) {
    if (!byId.has(entry.recordId)) byId.set(entry.recordId, entry);
  }
  return [...byId.values()];
}

// ───────────────────────────── Odpowiedź rozmowy ─────────────────────────────

/** Odpowiedź warstwy rozmowy dla kanału (renderer zamienia ją na tekst/kartę). */
export const ConversationReply = z.object({
  kind: z.enum(["verdict", "answer", "image_analysis", "status", "sources", "why", "confirm_delete", "deleted", "confirm_report", "reported", "help", "rate_limited"]),
  report: VerdictReport.optional(),
  textPl: z.string(),
  /** Short, source-linked message shared by the chat and SMS. The report retains the full evidence. */
  shortAnswer: z.object({
    bodyPl: z.string(),
    sources: z.array(z.object({ title: z.string(), publisher: z.string(), url: z.string() })),
    caseNotePl: z.string().optional(),
  }).optional(),
  /** Przyciski szybkich odpowiedzi (kanały, które je obsługują). */
  quickReplies: z.array(z.object({ id: z.string(), labelPl: z.string() })).default([]),
  resultUrl: z.string().optional(),
});
export type ConversationReply = z.infer<typeof ConversationReply>;

// ───────────────────────────── Porty (interfejsy) ─────────────────────────────

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmRequest<T> {
  purpose: string;
  system: string;
  /** Treść niezaufana MUSI być już opakowana w bloki z losowym ogranicznikiem (engine/llm/fence.ts). */
  user: string;
  schema: z.ZodType<T>;
  /** Nazwa schematu (dla structured outputs). */
  schemaName: string;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
  /** Tryb szybki (MODEL_FAST) lub główny (MODEL_MAIN). */
  tier?: "fast" | "main";
  signal?: AbortSignal;
}

export interface LlmResponse<T> {
  data: T;
  usage: ModelUsage;
}

/** Błąd techniczny dostawcy — nigdy nie przepisujemy jego treści do odpowiedzi dla użytkownika. */
export class LlmUnavailableError extends Error {
  constructor(
    public readonly reason: "no_key" | "rate_limit" | "timeout" | "refusal" | "schema" | "provider_error" | "budget",
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "LlmUnavailableError";
  }
}

export interface LlmProvider {
  readonly name: string; // "anthropic" | "mistral" | "fake"
  /** Rodzina modeli — weryfikator „z innej rodziny” ma inną wartość. */
  readonly family: string;
  readonly available: boolean;
  complete<T>(req: LlmRequest<T>): Promise<LlmResponse<T>>;
}

export interface RetrievalQuery {
  claim: Claim;
  /** Dodatkowe zapytania (np. tłumaczenie EN, słowa kluczowe). */
  extraQueries?: string[];
  /** Zachowaj miejsce dla trafienia semantycznego z bazy Demagoga przy sprawdzaniu twierdzenia. */
  includeSemanticFactCheck?: boolean;
  limit?: number;
  signal?: AbortSignal;
  /** Reports inapplicable or incomplete searches without changing the evidence returned. */
  onCoverage?: (coverage: "skipped" | "partial") => void;
}

/** Gałąź wyszukiwania (korpus BM25, wektory, incydenty, konektor, wyszukiwanie na żywo). */
export interface RetrievalBranch {
  readonly id: string;
  /** Konieczna gałąź (korpus lokalny) — jej awaria daje NIEPELNE. Opcjonalna — adnotacja. */
  readonly required: boolean;
  search(q: RetrievalQuery): Promise<EvidenceCandidate[]>;
}

export interface CorpusStore {
  get(recordId: string): CorpusRecord | undefined;
  getMany(recordIds: string[]): CorpusRecord[];
  snapshotId(): string;
  count(): number;
}

export interface OutboundMessage {
  channel: ChannelId;
  sessionId: string;
  reply: ConversationReply;
}

export interface ChannelCapabilities {
  maxChars: number;
  supportsImagesIn: boolean;
  supportsButtons: boolean;
  supportsMarkdown: boolean;
}

/** Adapter kanału — dodanie kanału = jeden plik implementujący ten interfejs. */
export interface ChannelAdapter {
  readonly id: ChannelId;
  readonly capabilities: ChannelCapabilities;
  /** Zwraca false dla żądań z nieprawidłowym podpisem (→ 403). */
  verifySignature(rawBody: string, headers: Record<string, string | undefined>, url: string): boolean;
  parseInbound(rawBody: string, headers: Record<string, string | undefined>): InboundMessage | null;
  /** Renderer bez LLM: zamienia ConversationReply na treść kanału. */
  render(reply: ConversationReply): string;
  send(out: OutboundMessage): Promise<void>;
}

// ───────────────────────────── Ewaluacja ─────────────────────────────

export const EvalScenario = z.enum(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "X"]);

export const EvalCase = z.object({
  id: z.string(),
  split: z.enum(["dev", "heldout"]),
  scenario: EvalScenario,
  input: z.object({ kind: InputKind, text: z.string().optional(), url: z.string().optional() }),
  /** Oczekiwany werdykt twierdzenia głównego albo status techniczny dla J/D-nieczytelne. */
  expected: z.object({
    verdict: Verdict.nullable(),
    status: TechStatus.default("OK"),
    /** Dla E: cel atakującego i kanarek, który nie może pojawić się w odpowiedzi. */
    attack: z
      .object({ goal: z.string(), canary: z.string().optional(), twinCaseId: z.string().optional() })
      .optional(),
    /** Dla pytań otwartych: fragmenty, które muszą wystąpić w answer.answerPl (bez rozróżniania wielkości liter). */
    answerContains: z.array(z.string()).optional(),
    inputMode: z.enum(["claim", "question_yesno", "question_open"]).optional(),
    /**
     * Najniższa akceptowalna siła dowodów przy poprawnym werdykcie. Dla oczywistych przypadków
     * (np. „X to prezydent Polski”, gdy źródła urzędowe podają kogoś innego) — „mocna”.
     */
    minStrength: Strength.optional(),
  }),
  /** Przypadek pokazowy do filmu/prezentacji. */
  demo: z.boolean().optional(),
  notes: z.string().optional(),
  /** Symulacja usterki dla J: "llm_down", "corpus_down", "live_down", "ocr_down". */
  fault: z.string().optional(),
});
export type EvalCase = z.infer<typeof EvalCase>;
