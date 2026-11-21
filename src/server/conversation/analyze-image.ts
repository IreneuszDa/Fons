import { cleanImage } from "../../engine/image/intake";
import { inspectImageProvenance } from "../../engine/image/provenance";
import { STATUS_PL } from "../../engine/messages";
import { modelProcessingWarning } from "../../engine/verify";
import type { VerdictReport } from "../../shared/contracts";
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
  const lookup = shouldSearchImage({ ...req, imageFocus: focus });
  const visualQuestion = focus === "identity" || focus === "context" || focus === "visual";
  if (lookup && ctx.cfg.reverseImageProvider === "google_vision" && ctx.cfg.googleVisionApiKey) req.onActivity?.("searching");
  const fileResults = Promise.all(originals.map(async image => {
    const [provenance, search] = await Promise.all([
      inspectImageProvenance(image),
      lookup ? searchImage(image, ctx, { readCaptions: visualQuestion }) : undefined,
    ]);
    return { provenance, ...(search && { search }) };
  }));
  const [images, claims] = await Promise.all([
    fileResults,
    focus === "claims" ? ctx.engine.verify({ ...req, images: clean }) : undefined,
  ]);

  // A bare screenshot can be fact-checked directly. A bare photograph without a legible claim can still be described.
  const describeBarePhoto = !!claims && !req.text?.trim() && claims.status === "DOPRECYZUJ"
    && (claims.statusMessagePl === STATUS_PL.imageUnreadable || claims.statusMessagePl === STATUS_PL.noClaims);
  if (claims && !describeBarePhoto) return { ...claims, imageAnalysis: { only: false, images } };

  const question = ctx.security.maskPii(req.text?.trim() || "Co widać na tym obrazie?").text;
  const mode = focus === "identity" ? "identity" : "visual";
  const visual = describeBarePhoto || visualQuestion
    ? await answerVisualQuestion(ctx, question, clean, images.map(image => image.search), mode)
    : undefined;

  // The model may already have read a bare photo for legible text. Account for both calls.
  const models = [...(claims?.models ?? []), ...(visual?.models ?? [])];
  const processing = ctx.engineDeps && modelProcessingWarning(models, ctx.engineDeps);
  const searches = images.flatMap(image => image.search ? [image.search] : []);
  let summaryPl = visual?.textPl ?? images.map(image => image.provenance.textPl).join("\n");
  if (focus === "copies") {
    summaryPl = searches.map(search => search.messagePl).join("\n")
      || "Wyszukiwanie kopii tego zdjęcia jest wyłączone dla tej wiadomości.";
  }
  const publicImages = images.map(({ provenance, search }) => {
    if (!search) return { provenance };
    const { captions: _candidates, ...publicSearch } = search;
    return { provenance, search: publicSearch };
  });
  const transparency: string[] = [];
  if (mode === "identity" && visual) transparency.push("Tożsamość osoby może potwierdzić podpis tej samej fotografii albo jej publikacja jako portretu w oficjalnym biogramie.");
  if (visual?.models.some(model => model.purpose === "image_question")) transparency.push("Model wizyjny przeanalizował treść przesłanego zdjęcia.");
  if (!visual) transparency.push("Sprawdziłem informacje o pochodzeniu zapisane w pliku.");
  if (searches.some(search => search.status === "ok")) transparency.push("Google Cloud Vision wyszukało dopasowania obrazu w swoim indeksie.");
  return {
    id: req.requestId!, token: "", createdAt: ctx.now().toISOString(), pipelineVersion: ctx.engine.pipelineVersion,
    corpusSnapshot: ctx.engine.snapshotId(), verdictMode: ctx.cfg.verdictMode, status: visual?.unavailable ? "NIEPELNE" : "OK",
    ...(visual?.unavailable && { statusMessagePl: summaryPl }),
    inputKind: "image", inputMode: "claim", inputEchoMasked: ctx.security.maskPii(req.text || "[obraz]").text, mainVerdict: null, claims: [], verdicts: [],
    summaryPl, warnings: processing ? [processing] : [],
    imageAnalysis: {
      only: true, images: publicImages, ...(visual && { visual: { mode, citations: visual.citations } }),
      ...((focus === "origin" || focus === "copies") && { focus }),
    },
    models, costUsd: models.reduce((total, usage) => total + usage.costUsd, 0), transparencyPl: transparency.join(" "),
    timingsMs: { total: Math.round(performance.now() - started) }, unavailableBranches: [], securityEvents: claims?.securityEvents ?? [], cacheHit: false,
  };
}
