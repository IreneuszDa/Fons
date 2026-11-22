import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { z } from "zod";
import catalog from "../../../data/image-references/catalog.json";
import type { ImageComparison, LocalImageSearch } from "../../shared/image-search";

const ImageReference = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1), publisher: z.string().min(1),
  url: z.url({ protocol: /^https$/ }), originalUrl: z.url({ protocol: /^https$/ }),
  publishedAt: z.iso.date(), sha256: z.hash("sha256"), referenceSha256: z.hash("sha256"),
});
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const imageCatalogVersion = sha256(JSON.stringify(catalog));

// A coarse colour grid tolerates scaling and normal JPEG recompression. A local patch
// limit also rejects conspicuously changed details that disappear in a whole-image average.
async function fingerprint(bytes: Buffer) {
  const input = sharp(bytes, { limitInputPixels: 32_000_000, failOn: "warning" });
  const { autoOrient: size } = await input.metadata();
  // Normalise the decoder's sampling grid before comparing small cells across formats.
  const pixels = await input.autoOrient().flatten({ background: "white" }).resize(128, 128, { fit: "fill", fastShrinkOnLoad: false })
    .toColourspace("srgb").removeAlpha().raw().toBuffer();
  const grid = await sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } }).resize(16, 16).raw().toBuffer();
  return { ...size, ratio: size.width / size.height, grid };
}

type Fingerprint = Awaited<ReturnType<typeof fingerprint>>;

function looksSimilar(input: Fingerprint, reference: Fingerprint): boolean {
  if (Math.abs(Math.log(input.ratio / reference.ratio)) > 0.025) return false;
  let total = 0;
  let maxError = 0;
  for (let i = 0; i < input.grid.length; i++) {
    const error = Math.abs(input.grid[i]! - reference.grid[i]!);
    total += error * error;
    maxError = Math.max(maxError, error);
  }
  return total <= input.grid.length * 7 ** 2 && maxError <= 44;
}

async function pixelDigest(bytes: Buffer): Promise<string> {
  const hash = createHash("sha256");
  const rgba = sharp(bytes, { limitInputPixels: 32_000_000, failOn: "warning" })
    .autoOrient().toColourspace("srgb").ensureAlpha().raw({ depth: "uchar" });
  for await (const chunk of rgba) hash.update(chunk);
  return hash.digest("hex");
}

/** Compare validated still images. The full raster is hashed sequentially only for a plausible pixel match. */
export async function compareImages(first: Buffer, second: Buffer): Promise<ImageComparison> {
  if (first.equals(second)) return "identical_file";
  const [a, b] = await Promise.all([fingerprint(first), fingerprint(second)]);
  if (a.width === b.width && a.height === b.height && a.grid.equals(b.grid)
    && await pixelDigest(first) === await pixelDigest(second)) return "same_pixels";
  return looksSimilar(a, b) ? "similar" : "no_match";
}

async function loadReferences() {
  return Promise.all(z.array(ImageReference).max(500).parse(catalog).map(async row => {
    const bytes = await readFile(new URL(`../../../data/image-references/${row.id}.jpg`, import.meta.url));
    if (sha256(bytes) !== row.referenceSha256) throw new Error("image_reference_integrity");
    return { row, fingerprint: await fingerprint(bytes) };
  }));
}
let references: ReturnType<typeof loadReferences> | undefined;

/** Submitted bytes and their fingerprints stay in memory. Matches never enter the verdict engine. */
export async function searchImageReferences(bytes: Buffer): Promise<LocalImageSearch> {
  try {
    references ??= loadReferences().catch(error => { references = undefined; throw error; });
    const [items, sample] = await Promise.all([references, fingerprint(bytes)]);
    const hash = sha256(bytes);
    const matches: LocalImageSearch["matches"] = [];
    for (const { row, fingerprint: known } of items) {
      const identical = hash === row.sha256;
      if (identical || looksSimilar(sample, known)) {
        const { title, publisher, url, publishedAt } = row;
        matches.push({ recordId: `image:${row.id}`, title, publisher, url, publishedAt, kind: identical ? "identical" : "similar" });
      }
    }
    return { status: "ok", checked: items.length, catalogVersion: imageCatalogVersion, matches: matches.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)) };
  } catch {
    return { status: "unavailable", checked: 0, matches: [] };
  }
}
