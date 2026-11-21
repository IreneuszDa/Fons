import type { DetectorHit, ModelUsage, VideoAnalysis } from "../../shared/contracts";
import type { VerificationStage } from "../../shared/chat";
import { claimStatesDate, mustHaveTerms, type ExtractedClaim } from "../claims";
import { isolateFenceMarkers } from "../normalize";
import { detectInjection, maskPii, stripFlaggedSentences } from "../ports";
import { cleanText, foldForMatch, isoDateOrUndefined, truncateWords } from "../text";
import { GeminiVideoResponseError, type GeminiVideoAnalyzer } from "./gemini";
import { MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS, SocialVideoSourceError, type loadSocialCaption, type loadSocialVideo } from "./social-source";

export type VideoServices =
  | { load: typeof loadSocialVideo; analyze: GeminiVideoAnalyzer }
  | { loadCaption: typeof loadSocialCaption };

interface VideoIntake {
  analysis: VideoAnalysis;
  url: string;
  claims: ExtractedClaim[];
  hits: DetectorHit[];
  usage?: ModelUsage;
  message?: string;
}

// Each active download can occupy a complete media buffer and an upload in the server process.
const MAX_ACTIVE_VIDEOS = 3;
let activeVideos = 0;
const ANALYSIS_DISABLED = "Analiza obrazu i dźwięku jest wyłączona w tej instalacji. Możesz wkleić transkrypcję lub treść twierdzenia.";

function videoFailure(error: unknown, loading: boolean): string {
  if ((error instanceof SocialVideoSourceError && error.reason === "too_large") ||
      (error instanceof Error && ["video_too_large", "video_too_long"].includes(error.message))) {
    return `Ten film przekracza limit pobierania lub analizy. Wybierz krótsze nagranie (maksymalnie ${MAX_VIDEO_SECONDS / 60} min i ${MAX_VIDEO_BYTES / 1024 ** 2} MiB) lub wklej transkrypcję.`;
  }
  if (error instanceof Error && error.message === "video_duration_unknown") {
    return "Nie udało się ustalić długości filmu. Możesz wkleić transkrypcję do sprawdzenia.";
  }
  if (error instanceof SocialVideoSourceError && error.reason === "unsupported") {
    return "Ten post nie zawiera obsługiwanego filmu. Możesz wkleić opis lub dołączyć obraz do sprawdzenia.";
  }
  return loading
    ? "Serwis nie udostępnił nagrania. Jeśli post jest prywatny lub wymaga logowania, wklej jego transkrypcję albo konkretne twierdzenie."
    : "Nie udało się odczytać obrazu i dźwięku przez Gemini. Spróbuj ponownie lub wklej transkrypcję.";
}

function publicPostUrl(raw: string): string {
  const url = new URL(raw);
  return url.origin + url.pathname;
}

export async function readVideo(
  url: string,
  platform: VideoAnalysis["platform"],
  note: string,
  services: VideoServices | undefined,
  stage: (value: VerificationStage) => void,
  signal?: AbortSignal,
): Promise<VideoIntake> {
  const analysis: VideoAnalysis = { platform, status: "unavailable", caption: "", transcript: [], observations: [], claimOrigins: [] };
  const result: VideoIntake = { analysis, url: publicPostUrl(url), claims: [], hits: [] };
  if (!services) {
    result.message = ANALYSIS_DISABLED;
    return result;
  }
  if (activeVideos >= MAX_ACTIVE_VIDEOS) {
    result.message = "Trwa analiza innych filmów. Spróbuj ponownie za chwilę.";
    return result;
  }

  function sanitize(raw: string, location: DetectorHit["location"]): string {
    const input = isolateFenceMarkers(raw);
    const hits = detectInjection(input, location);
    result.hits.push(...hits);
    return maskPii(cleanText(hits.length ? stripFlaggedSentences(input, hits) : input)).text;
  }

  let loading = true;
  activeVideos++;
  try {
    stage("fetching_video");
    if ("loadCaption" in services) {
      const post = await services.loadCaption(url, signal);
      result.url = publicPostUrl(post.url);
      analysis.caption = sanitize(post.caption, "fetched_page");
      result.message = ANALYSIS_DISABLED;
      return result;
    }
    const media = await services.load(url, signal);
    result.url = publicPostUrl(media.url);
    analysis.caption = sanitize(media.caption, "fetched_page");
    loading = false;
    stage("analyzing_video");
    const { data, usage } = await services.analyze({
      bytes: media.bytes, mimeType: media.mimeType, durationSeconds: media.durationSeconds,
      caption: analysis.caption, focus: sanitize(note, "user_message"),
    }, signal);
    result.usage = usage;
    analysis.status = "analyzed";
    const segments = (rows: VideoAnalysis["transcript"]) => rows
      .map(row => ({ seconds: row.seconds, text: sanitize(row.text, "ocr") }))
      .filter(row => row.text);
    analysis.transcript = segments(data.transcript);
    analysis.observations = segments(data.observations);

    const seen = new Set<string>();
    for (const candidate of data.claims) {
      const quote = sanitize(candidate.quote, candidate.source === "caption" ? "fetched_page" : "ocr");
      const source = candidate.source === "speech" ? analysis.transcript : analysis.observations;
      const anchored = candidate.source === "caption"
        ? candidate.seconds === null && analysis.caption.includes(quote)
        : source.some(row => row.seconds === candidate.seconds && row.text.includes(quote));
      const key = foldForMatch(quote);
      if (!anchored || !key || seen.has(key)) continue;
      seen.add(key);
      const id = `c${result.claims.length + 1}`;
      const date = isoDateOrUndefined(candidate.date);
      const query = sanitize(candidate.text, "ocr");
      // Assess the assertion in its original wording. The Polish paraphrase only helps retrieve sources.
      result.claims.push({
        claim: {
          id, text: quote, type: "fakt", isMain: result.claims.length === 0, inputOverlap: 1,
          temporal: { kind: candidate.temporalKind, ...(date && claimStatesDate(date, [quote]) ? { date } : {}) },
        },
        extraQueries: query && query !== quote ? [truncateWords(query, 200)] : [],
        mustHave: mustHaveTerms(quote, []),
        parts: [],
      });
      analysis.claimOrigins.push({ claimId: id, source: candidate.source, seconds: candidate.seconds });
    }
    return result;
  } catch (error) {
    if (error instanceof GeminiVideoResponseError) result.usage = error.usage;
    if (error instanceof SocialVideoSourceError && error.caption) analysis.caption = sanitize(error.caption, "fetched_page");
    result.message = videoFailure(error, loading);
    return result;
  } finally {
    activeVideos--;
  }
}
