import type { DetectorHit, ModelUsage, VideoAnalysis } from "../../shared/contracts";
import type { VerificationStage } from "../../shared/chat";
import { claimStatesDate, mustHaveTerms, type ExtractedClaim } from "../claims";
import { foldForMatch, isoDateOrUndefined, truncateWords } from "../text";
import { sanitizeVideoText, type VideoAnalyzer } from "./analysis";
import { GeminiVideoResponseError } from "./gemini";
import { OpenAiVideoAnalysisError } from "./openai-video";
import { MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS, SocialVideoSourceError, type SocialVideoMetadata } from "./social-source";
import { publicPostUrl, type createVideoLoader, type loadVideoCaption } from "./platforms";
import { subtitleStart } from "./webvtt";
import { decodeVideo } from "./decode";
import { MAX_RECORDING_BYTES } from "../../shared/attachments";

export type VideoServices =
  | { load: ReturnType<typeof createVideoLoader>; analyze: VideoAnalyzer; provider?: "openai" | "gemini"; processingRegion?: "us" | "eea" }
  | { loadCaption: typeof loadVideoCaption };

export function hasOnlyText(video: VideoAnalysis): boolean {
  return video.status === "subtitles_only" || video.status === "transcript_only" || video.status === "caption_only";
}

export function asksForMediaMetadata(note: string): boolean {
  return /^(?:(?:pokaz|podaj|odczytaj|sprawdz|przeanalizuj) )?(?:metadane|parametry techniczne)(?: (?:tego |przeslanego )?(?:nagrania|audio|filmu|pliku))?$/.test(foldForMatch(note));
}

/** Only a request for the spoken words may bypass fact checking. */
export function asksForTranscript(note: string): boolean {
  const text = foldForMatch(note).replace(/^(?:prosze (?:o )?|(?:czy )?mozesz )/, "").replace(/ prosze$/, "");
  const direct = /^(?:transkrypcj[ae]|(?:zrob|podaj|pokaz|przygotuj) transkrypcje|przepisz|przepisac|transkrybuj|spisz|zapisz slowa)(?: mi)?(?: (?:to |tego |cale |calego |przeslane |przeslanego )?(?:nagranie|nagrania|audio|wypowiedz|plik|pliku))?(?: (?:audio|slowo w slowo|doslownie))?$/;
  const spoken = /^co (?:zostalo powiedziane|powiedziano|mowia|mowi(?: ta osoba| rozmowca)?|powiedzial[ao]?|slychac)(?: (?:na|w) (?:tym )?(?:nagraniu|pliku|audio))?$/;
  return direct.test(text) || spoken.test(text);
}

/** Keep the original cue time, including for a sentence split over adjacent WebVTT cues. */
export function anchorSubtitleClaims(proposals: ExtractedClaim[], analysis: VideoAnalysis): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  for (const proposed of proposals) {
    if (proposed.claim.type !== "fakt") continue;
    const quote = proposed.claim.text.trim();
    if (!quote) continue;
    const seconds = subtitleStart(analysis.transcript, quote);
    if (seconds === undefined && !analysis.caption.includes(quote)) continue;
    const id = `c${claims.length + 1}`;
    const { kind, date } = proposed.claim.temporal;
    const temporal = date && claimStatesDate(date, [quote]) ? { kind, date } : { kind };
    claims.push({ ...proposed, claim: { ...proposed.claim, id, temporal, isMain: claims.length === 0 }, parts: [] });
    const spokenSource = analysis.transcriptSource === "platform" ? "subtitles" : "speech";
    analysis.claimOrigins.push({ claimId: id, source: seconds === undefined ? "caption" : spokenSource, seconds: seconds ?? null });
  }
  return claims;
}

interface VideoIntake {
  analysis: VideoAnalysis;
  url: string;
  claims: ExtractedClaim[];
  hits: DetectorHit[];
  usages: ModelUsage[];
  focus?: string;
  message?: string;
}

// Each active download can occupy a complete media buffer and an upload in the server process.
const MAX_ACTIVE_VIDEOS = 3;
let activeVideos = 0;
const ANALYSIS_DISABLED = "Analiza obrazu i dźwięku jest wyłączona w tej instalacji. Możesz wkleić transkrypcję lub treść twierdzenia.";

function videoFailure(error: unknown, loading: boolean, platform: VideoAnalysis["platform"], provider?: VideoAnalysis["provider"]): string {
  if (error instanceof Error && error.message === "audio_no_speech") return "Nie rozpoznałem mowy w nagraniu. Możesz podać treść wypowiedzi do sprawdzenia.";
  if (error instanceof Error && error.message === "video_decode_failed") {
    return "Nie udało się odczytać pobranego pliku wideo. Możesz wkleić transkrypcję do sprawdzenia.";
  }
  if ((error instanceof SocialVideoSourceError && error.reason === "too_large") ||
      (error instanceof Error && ["video_too_large", "video_too_long"].includes(error.message))) {
    const byteLimit = platform.startsWith("upload_") ? MAX_RECORDING_BYTES : MAX_VIDEO_BYTES;
    return `Nagranie przekracza limit. Wybierz krótszy fragment (maksymalnie ${MAX_VIDEO_SECONDS / 60} min i ${byteLimit / 1024 ** 2} MiB) lub wklej transkrypcję.`;
  }
  if (error instanceof Error && error.message === "video_duration_unknown") {
    return "Nie udało się ustalić długości filmu. Możesz wkleić transkrypcję do sprawdzenia.";
  }
  if (error instanceof SocialVideoSourceError && error.reason === "unsupported") {
    return "Ten post nie zawiera obsługiwanego filmu. Możesz wkleić opis lub dołączyć obraz do sprawdzenia.";
  }
  if (loading && platform === "youtube" && provider === "openai") {
    return "YouTube nie udostępnił pliku nagrania w tym połączeniu. Możesz wkleić transkrypcję albo treść twierdzenia.";
  }
  return loading
    ? "Serwis nie udostępnił nagrania. Możesz przesłać plik w czacie lub wkleić transkrypcję."
    : "Nie udało się ukończyć analizy filmu. Spróbuj ponownie lub wklej transkrypcję.";
}

export async function readVideo(
  url: string,
  platform: VideoAnalysis["platform"],
  note: string,
  services: VideoServices | undefined,
  stage: (value: VerificationStage) => void,
  signal?: AbortSignal,
  upload?: { mime: string; base64: string },
): Promise<VideoIntake> {
  const analysis: VideoAnalysis = { platform, status: "unavailable", caption: "", transcript: [], observations: [], claimOrigins: [] };
  const result: VideoIntake = { analysis, url: upload ? "" : publicPostUrl(url), claims: [], hits: [], usages: [] };
  if (activeVideos >= MAX_ACTIVE_VIDEOS) {
    result.message = "Trwa analiza innych filmów. Spróbuj ponownie za chwilę.";
    return result;
  }

  function sanitize(raw: string, location: DetectorHit["location"]): string {
    return sanitizeVideoText(raw, location, result.hits);
  }

  const segments = (rows: VideoAnalysis["transcript"]) => rows
    .map(row => ({ seconds: row.seconds, text: sanitize(row.text, "ocr") }))
    .filter(row => row.text);

  function savePost(post: SocialVideoMetadata & { url?: string; caption: string; title?: string }) {
    if (post.url) result.url = publicPostUrl(post.url);
    analysis.caption = sanitize(post.caption, "fetched_page");
    if (post.title) analysis.title = sanitize(post.title, "fetched_page");
    if (post.author) analysis.author = sanitize(post.author, "fetched_page");
    if (post.thumbnailUrl) {
      const thumbnail = URL.parse(post.thumbnailUrl);
      if (thumbnail?.protocol === "https:" && !thumbnail.username && !thumbnail.password) analysis.thumbnailUrl = thumbnail.href;
    }
    if (post.subtitles?.length) {
      analysis.transcript = segments(post.subtitles);
      if (analysis.transcript.length) {
        analysis.transcriptSource = "platform";
        analysis.status = "subtitles_only";
      }
    }
  }

  let loading = true;
  activeVideos++;
  try {
    if (!upload) stage("fetching_video");
    result.focus = sanitize(note, "user_message");
    if (upload && asksForMediaMetadata(note)) {
      const bytes = Buffer.from(upload.base64, "base64");
      try {
        const decoded = await decodeVideo({ bytes, mimeType: upload.mime }, { includeAudio: false, probeOnly: true, signal });
        analysis.file = decoded.file;
        analysis.status = "metadata_only";
      } catch (error) {
        signal?.throwIfAborted();
        result.message = error instanceof Error && error.message === "video_decoder_missing" ? "Odczyt metadanych wymaga narzędzia FFprobe na serwerze."
          : "Nie udało się odczytać parametrów nagrania. Sprawdź format i limit długości pliku.";
      }
      return result;
    }
    if (!services) { result.message = ANALYSIS_DISABLED; return result; }
    if ("loadCaption" in services) {
      if (upload) { result.message = ANALYSIS_DISABLED; return result; }
      savePost(await services.loadCaption(url, signal));
      if (analysis.status !== "subtitles_only") result.message = ANALYSIS_DISABLED;
      return result;
    }
    analysis.provider = services.provider ?? "gemini";
    loading = !upload;
    const media = upload ? { caption: "", mimeType: upload.mime, bytes: Buffer.from(upload.base64, "base64"), durationSeconds: undefined as number | undefined }
      : await services.load(url, signal);
    savePost(media);
    loading = false;
    stage(platform === "upload_audio" ? "transcribing_audio" : "analyzing_video");
    if (upload && "bytes" in media && analysis.provider === "gemini") {
      // Validate stream types and packet duration before submitting a user file to the provider.
      const audioOnly = platform === "upload_audio";
      const decoded = await decodeVideo(media, { includeAudio: audioOnly, continuousAudio: audioOnly, probeOnly: !audioOnly, signal });
      media.durationSeconds = decoded.durationSeconds;
      analysis.file = decoded.file;
      if (decoded.wav) { media.bytes = decoded.wav; media.mimeType = "audio/wav"; }
    }
    const { data, usage, additionalUsage, file } = await services.analyze({
      ...("youtubeUrl" in media ? { youtubeUrl: media.youtubeUrl } : { bytes: media.bytes, mimeType: media.mimeType }),
      durationSeconds: media.durationSeconds,
      ...(analysis.transcript.length && { subtitles: analysis.transcript }),
      caption: analysis.caption, focus: result.focus,
    }, signal);
    result.usages.push(...(additionalUsage ?? []), usage);
    if (upload && file) analysis.file = file;
    analysis.status = platform === "upload_audio" ? "transcript_only" : "analyzed";
    if (analysis.transcriptSource !== "platform") {
      analysis.transcript = segments(data.transcript);
      if (analysis.transcript.length) analysis.transcriptSource = analysis.provider;
    }
    if (platform === "upload_audio") {
      if (!analysis.transcript.length) {
        analysis.status = "unavailable";
        result.message = "Nie rozpoznałem mowy w nagraniu. Możesz podać treść wypowiedzi do sprawdzenia.";
      }
      return result;
    }
    analysis.observations = segments(data.observations);

    const seen = new Set<string>();
    for (const candidate of data.claims) {
      const quote = sanitize(candidate.quote, candidate.source === "caption" ? "fetched_page" : "ocr");
      const source = candidate.source === "speech" ? analysis.transcript : analysis.observations;
      const platformQuote = candidate.source === "speech" && analysis.transcriptSource === "platform";
      const anchored = candidate.source === "caption" ? candidate.seconds === null && analysis.caption.includes(quote)
        : candidate.source === "speech" && (platformQuote || analysis.transcriptSource === "openai")
          ? candidate.seconds !== null && subtitleStart(source, quote, candidate.seconds) !== undefined
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
      analysis.claimOrigins.push({ claimId: id, source: platformQuote ? "subtitles" : candidate.source, seconds: candidate.seconds });
    }
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof GeminiVideoResponseError) result.usages.push(error.usage);
    if (error instanceof OpenAiVideoAnalysisError) {
      result.usages.push(...error.usages);
      if (analysis.transcriptSource !== "platform" && error.transcript?.length) {
        analysis.transcript = segments(error.transcript);
        if (analysis.transcript.length) {
          analysis.transcriptSource = "openai";
          analysis.status = "transcript_only";
        }
      }
    }
    if (error instanceof SocialVideoSourceError) savePost(error);
    const message = videoFailure(error, loading, platform, analysis.provider);
    if (error instanceof SocialVideoSourceError && error.reason === "unavailable" && analysis.status === "unavailable" && analysis.caption) {
      const focus = foldForMatch(result.focus ?? "");
      // A public description can be checked on its own for a general request. A question about
      // what was said or shown still requires the missing stream or subtitles.
      if (!focus || /^((hej|prosze) )?(sprawdz|zweryfikuj)( mi)?( prosze)?( czy to prawda| ten (film|post|material)| to)?$/.test(focus)
        || /\b(opis posta|w opisie|sam opis)\b/.test(focus)) analysis.status = "caption_only";
    }
    if (!hasOnlyText(analysis)) result.message = message;
    else if (!(error instanceof SocialVideoSourceError && error.reason === "unavailable")) analysis.mediaIssue = message;
    return result;
  } finally {
    activeVideos--;
  }
}
