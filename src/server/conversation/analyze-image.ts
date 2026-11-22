import { cleanImage } from "../../engine/image/intake";
import { inspectImageProvenance } from "../../engine/image/provenance";
import { compareImages, searchImageReferences } from "../../engine/image/reference-search";
import { STATUS_PL } from "../../engine/messages";
import { modelProcessingWarning } from "../../engine/verify";
import type { VerdictReport } from "../../shared/contracts";
import { imageComparisonPl, imageFileLabel, imageMatchLabel, localImageMatchLabel, localImageScope } from "../../shared/reply-view";
import { detectInjection } from "../../security/detector";
import type { EngineRequest, MediaItem, ServerContext } from "../context";
import { obviousImageFocus, resolveImageFocus, shouldSearchImage } from "./image-intent";
import { searchImage } from "./image-search";
import { answerVisualQuestion } from "./visual-question";

export class UnreadableImage extends Error {}

export async function analyzeImage(ctx: ServerContext, req: EngineRequest): Promise<VerdictReport> {
  const started = performance.now();
  const originals = req.images ?? [];
  let clean: MediaItem[];
  try {
    clean = await Promise.all(originals.map(async original => ({
      mime: "image/jpeg",
      base64: (await cleanImage(original, 2400)).toString("base64"),
    })));
  } catch {
    throw new UnreadableImage();
  }

  const focus = req.imageFocus ?? obviousImageFocus(req) ?? resolveImageFocus(req);
  const lookup = focus !== "comparison" && shouldSearchImage({ ...req, imageFocus: focus });
  const visualQuestion = focus === "identity" || focus === "context" || focus === "visual";
  if (lookup && ctx.cfg.reverseImageProvider === "google_vision" && ctx.cfg.googleVisionApiKey) req.onActivity?.("searching");
  const fileResults = Promise.all(originals.map(async image => {
    const [provenance, localSearch, search] = await Promise.all([
      inspectImageProvenance(image),
      searchImageReferences(Buffer.from(image.base64, "base64")),
      lookup ? searchImage(image, ctx, { readPublications: visualQuestion || focus === "copies" }) : undefined,
    ]);
    return { provenance, localSearch, ...(search && { search }) };
  }));
  const [images, claims] = await Promise.all([
    fileResults,
    focus === "claims" ? ctx.engine.verify({ ...req, images: clean }) : undefined,
  ]);
  const searches = images.flatMap(image => image.search ? [image.search] : []);
  const costInfo = searches.some(search => search.usage) ? { costStatus: "partial" as const } : {};

  // A bare screenshot can be fact-checked directly. A bare photograph without a legible claim can still be described.
  const describeBarePhoto = !!claims && !req.text?.trim() && claims.status === "DOPRECYZUJ"
    && (claims.statusMessagePl === STATUS_PL.imageUnreadable || claims.statusMessagePl === STATUS_PL.noClaims);
  const publicImages = images.map(({ provenance, localSearch, search }) => {
    if (!search) return { provenance, localSearch };
    const { captions: _candidates, ...publicSearch } = search;
    return { provenance, localSearch, search: publicSearch };
  });
  if (claims && !describeBarePhoto) return { ...claims, ...costInfo, imageAnalysis: { only: false, images: publicImages } };

  const comparison = focus === "comparison"
    ? await compareImages(Buffer.from(originals[0]!.base64, "base64"), Buffer.from(originals[1]!.base64, "base64"))
    : undefined;

  const question = ctx.security.maskPii(req.text?.trim() || "Co widać na tym obrazie?").text;
  const mode = focus === "identity" ? "identity" : "visual";
  const localMatches = images.flatMap(image => image.localSearch.matches);
  const failedSearches = searches.filter(search => search.status !== "ok");
  let visual: Awaited<ReturnType<typeof answerVisualQuestion>> | undefined;
  if (focus === "context") {
    const citations = searches.flatMap(search => search.captions ?? []).slice(0, 4);
    const sections = citations.map(citation => `Wydawca podaje w podpisie zdjęcia „${citation.quote}”.`);
    sections.push(...localMatches.map(m => `${localImageMatchLabel(m)} · ${m.title}.`));
    sections.push("Ustalenie czasu, miejsca lub wydarzenia wymaga źródła opisującego te okoliczności.");
    sections.push(...failedSearches.map(search => search.messagePl));
    visual = { textPl: sections.join("\n"), citations, unavailable: !localMatches.length && !citations.length && failedSearches.length > 0, models: [] };
  } else if (describeBarePhoto || visualQuestion) {
    visual = await answerVisualQuestion(ctx, question, clean, images.map(image => image.search), mode);
  }

  // The model may already have read a bare photo for legible text. Account for both calls.
  const models = [...(claims?.models ?? []), ...(visual?.models ?? [])];
  const processing = ctx.engineDeps && modelProcessingWarning(models, ctx.engineDeps);
  let summaryPl = comparison ? imageComparisonPl[comparison] : visual?.textPl ?? images.map(({ provenance }) =>
    [provenance.file && imageFileLabel(provenance.file), provenance.textPl].filter(Boolean).join("\n")).join("\n");
  if (focus === "copies") {
    const localLines = images.map(({ localSearch }) => [
      localImageScope(localSearch),
      ...localSearch.matches.map(m => `${localImageMatchLabel(m)} · ${m.title}\n${m.url}`),
    ].join("\n"));
    const webLines = searches.map(search => [search.messagePl, ...search.matches.filter(m => m.url).slice(0, 3)
      .map(m => `${imageMatchLabel(m)} · ${m.title ?? m.host}\n${m.url}`)].join("\n"));
    summaryPl = [...localLines, ...webLines].join("\n");
  }
  const noWorkingIndex = !searches.length && images.every(image => image.localSearch.status === "unavailable");
  const copiesUnavailable = focus === "copies" && !localMatches.length && (failedSearches.length > 0 || noWorkingIndex);
  const transparency: string[] = [];
  if (mode === "identity" && visual) transparency.push("Tożsamość osoby może potwierdzić podpis tej samej fotografii albo jej publikacja jako portretu w oficjalnym biogramie.");
  if (visual?.models.some(model => model.purpose === "image_question")) transparency.push("Model wizyjny przeanalizował treść przesłanego zdjęcia.");
  if (comparison) transparency.push("Porównanie wykonano lokalnie. Sprawdzono zgodność plików, a przy różnicach oceniono piksele, proporcje i kolory w siatce 16 × 16. Wynik dotyczy wyłącznie przesłanych obrazów.");
  if (!visual && !comparison) transparency.push("Sprawdziłem informacje o pochodzeniu zapisane w pliku.");
  if (searches.some(search => search.status === "ok")) transparency.push("Google Cloud Vision wyszukało dopasowania obrazu w swoim indeksie.");
  return {
    id: req.requestId!, token: "", createdAt: ctx.now().toISOString(), pipelineVersion: ctx.engine.pipelineVersion,
    corpusSnapshot: ctx.engine.snapshotId(), verdictMode: ctx.cfg.verdictMode, status: visual?.unavailable || copiesUnavailable ? "NIEPELNE" : "OK",
    ...((visual?.unavailable || copiesUnavailable) && { statusMessagePl: summaryPl }),
    inputKind: "image", inputMode: "claim", inputEchoMasked: ctx.security.maskPii(req.text || "[obraz]").text, mainVerdict: null, claims: [], verdicts: [],
    summaryPl, warnings: processing ? [processing] : [],
    imageAnalysis: {
      only: true, images: publicImages, ...(comparison && { comparison }), ...(visual && { visual: { mode: focus === "context" ? "context" : mode, citations: visual.citations } }),
      ...((focus === "origin" || focus === "copies") && { focus }),
    },
    models, costUsd: models.reduce((total, usage) => total + usage.costUsd, 0), ...costInfo, transparencyPl: transparency.join(" "),
    timingsMs: { total: Math.round(performance.now() - started) }, unavailableBranches: [],
    securityEvents: claims?.securityEvents ?? detectInjection(req.text ?? "", "user_message"), cacheHit: false,
  };
}
