import sharp from "sharp";

/** Decode only supported still images; external providers receive pixels without embedded metadata. */
export async function cleanImage(image: { mime: string; base64: string }, maxEdge: number): Promise<Buffer> {
  const data = Buffer.from(image.base64, "base64");
  const source = sharp(data, { limitInputPixels: 32_000_000, failOn: "warning" });
  const metadata = await source.metadata();
  if (!["jpeg", "png", "webp"].includes(metadata.format) || image.mime !== `image/${metadata.format}` || (metadata.pages ?? 1) > 1) {
    throw new Error("unsupported_image");
  }
  return source.autoOrient().resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "white" }).jpeg({ quality: 92 }).toBuffer();
}
