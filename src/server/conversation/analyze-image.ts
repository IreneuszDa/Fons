import { cleanImage } from "../../engine/image/intake";
import { inspectImageProvenance } from "../../engine/image/provenance";
import type { VerdictReport } from "../../shared/contracts";
import type { EngineRequest, ServerContext } from "../context";
import { foldWords } from "../util";
import { searchImage } from "./image-search";

export class UnreadableImage extends Error {}

// Clear requests can run locally even when the dialogue provider is unavailable.
export function wantsOnlyImageAnalysis(req: EngineRequest): boolean {
  if (req.imageFocus === "origin") return true;
  const caption = foldWords(req.text ?? "");
  if (!caption) return !!req.imageOptions?.searchWeb;
  return /^(czy (to|to jest) ai|czy to ai generated|is this ai generated|sprawdz pochodzenie (obrazu|zdjecia))$/.test(caption)
    || /^czy (ten obraz|to zdjecie|ta grafika) (jest |zostal[oa]? )?(wygenerowan[yae]|stworzon[yae]) przez (ai|sztuczna inteligencje)$/.test(caption);
}

export async function analyzeImage(ctx: ServerContext, req: EngineRequest): Promise<VerdictReport> {
  const started = performance.now();
  const originals = req.images ?? [];
  const clean = [];
  try {
    for (const image of originals) {
      const bytes = await cleanImage(image, 2400);
      clean.push({ mime: "image/jpeg", base64: bytes.toString("base64") });
    }
  } catch {
    throw new UnreadableImage();
  }

  const only = wantsOnlyImageAnalysis(req);
  const analyzeFiles = async () => {
    const images = [];
    for (const original of originals) {
      const [provenance, search] = await Promise.all([
        inspectImageProvenance(original),
        req.imageOptions?.searchWeb ? searchImage(original, ctx) : undefined,
      ]);
      images.push({ provenance, ...(search ? { search } : {}) });
    }
    return { only, images };
  };

  const [analysis, claims] = await Promise.all([
    analyzeFiles(),
    only ? undefined : ctx.engine.verify({ ...req, images: clean }),
  ]);
  if (claims) return { ...claims, imageAnalysis: analysis };
  const summaryPl = analysis.images.flatMap(({ provenance, search }) => [provenance.textPl, search?.messagePl]).filter(Boolean).join("\n");
  return {
    id: req.requestId!, token: "", createdAt: ctx.now().toISOString(), pipelineVersion: ctx.engine.pipelineVersion,
    corpusSnapshot: ctx.engine.snapshotId(), verdictMode: ctx.cfg.verdictMode, status: "OK", inputKind: "image",
    inputMode: "claim", inputEchoMasked: ctx.security.maskPii(req.text || "[obraz]").text, mainVerdict: null, claims: [], verdicts: [],
    summaryPl, warnings: [], imageAnalysis: analysis, models: [], costUsd: 0,
    transparencyPl: "Sprawdziliśmy informacje o pochodzeniu zapisane w pliku. Wyszukiwanie obrazem obejmuje indeks Google tylko po wybraniu tej opcji.",
    timingsMs: { total: Math.round(performance.now() - started) }, unavailableBranches: [], securityEvents: [], cacheHit: false,
  };
}
