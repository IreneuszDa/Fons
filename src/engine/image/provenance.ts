import { readFileSync } from "node:fs";
import type * as C2pa from "@contentauth/c2pa-node";
import { SaxesParser, type SaxesTagNS } from "saxes";
import sharp from "sharp";
import { IMAGE_MIMES, MAX_ATTACHMENT_BYTES } from "../../shared/attachments";
import type { ImageProvenance } from "../../shared/image-provenance";

type Declaration = ImageProvenance["declaration"];
type Credential = ImageProvenance["credential"];

let context: C2pa.Context | undefined;
function verificationContext(Context: typeof C2pa.Context): C2pa.Context {
  if (context) return context;
  const trustList = (file: string) => readFileSync(new URL(`../../../data/c2pa/${file}`, import.meta.url), "utf8");
  // The JS binding forwards c2pa-rs core options but only types its higher-level settings.
  const settings = {
    core: { allowedNetworkHosts: [], decodeIdentityAssertions: false, maxDecompressedManifestSizeInMb: 16 },
    trust: { trustAnchors: trustList("C2PA-TRUST-LIST.pem") },
    tsaTrust: { trustAnchors: trustList("C2PA-TSA-TRUST-LIST.pem") },
    verify: { verifyTrust: true, verifyTimestampTrust: true, verifyAfterReading: true, ocspFetch: false, remoteManifestFetch: false },
  };
  context = new Context(settings, { maxSizeInBytes: MAX_ATTACHMENT_BYTES });
  return context;
}

const statusText: Record<Credential, string> = {
  trusted: "Podpis C2PA jest prawidłowy. Podpisany opis pliku nie wskazuje, czy użyto generatywnej AI.",
  untrusted: "Plik zawiera podpis C2PA, ale jego wystawcy nie udało się potwierdzić na liście zaufanych wystawców. Pochodzenie obrazu pozostaje nieustalone.",
  invalid: "Weryfikacja poświadczenia C2PA nie powiodła się. Na jego podstawie nie można ustalić pochodzenia obrazu.",
  absent: "W pliku nie znaleziono poświadczenia C2PA ani oznaczenia AI w polu źródła IPTC. Pochodzenie obrazu pozostaje nieustalone.",
  unavailable: "Nie udało się odczytać poświadczenia pochodzenia tego obrazu.",
};

function inconclusive(credential: Credential): ImageProvenance {
  return { credential, basis: "none", declaration: "none", textPl: statusText[credential] };
}

function sourceDeclaration(uri: unknown): Declaration {
  switch (uri) {
    case "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia":
      return "generated";
    case "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia":
    case "http://cv.iptc.org/newscodes/digitalsourcetype/compositeSynthetic":
      return "edited";
    default:
      return "none";
  }
}

function signedResult(reader: C2pa.Reader, isActionsAssertion: typeof C2pa.isActionsAssertion): ImageProvenance {
  const store = reader.json();
  if (store.validation_state === "Invalid") return inconclusive("invalid");
  if (store.validation_state === "Valid") return inconclusive("untrusted");
  const active = store.active_manifest && store.manifests?.[store.active_manifest];
  if (store.validation_state !== "Trusted" || !active) return inconclusive("unavailable");

  let declaration: Declaration = "none";
  for (const assertion of active.assertions ?? []) {
    if (!isActionsAssertion(assertion)) continue;
    for (const action of assertion.data.actions) {
      if (!action || typeof action !== "object" || !("digitalSourceType" in action)) continue;
      const source = sourceDeclaration(action.digitalSourceType);
      if (source === "none") continue;
      if (action.action === "c2pa.created" && source === "generated") {
        return { credential: "trusted", basis: "c2pa", declaration: "generated",
          textPl: "W zweryfikowanym poświadczeniu C2PA oznaczono ten obraz jako wygenerowany przez AI." };
      }
      if (["c2pa.created", "c2pa.edited", "c2pa.placed"].includes(action.action)) declaration = "edited";
    }
  }
  if (declaration === "none") return inconclusive("trusted");
  return { credential: "trusted", basis: "c2pa", declaration,
    textPl: "W zweryfikowanym poświadczeniu C2PA wskazano użycie generatywnej AI do edycji obrazu lub stworzenia jego części." };
}

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const IPTC = "http://iptc.org/std/Iptc4xmpExt/2008-02-29/";

/** Read the IPTC DigitalSourceType property of the asset itself. Ignore unrelated descriptions and free text. */
function metadataDeclaration(xml: string | undefined): Declaration {
  if (!xml || xml.length > 256_000) return "none";
  const parser = new SaxesParser({ xmlns: true });
  const tags: SaxesTagNS[] = [];
  const sources = new Set<string>();
  let descriptionDepth = -1;
  let propertyDepth = -1;
  let property = "";
  parser.on("opentag", tag => {
    const parent = tags.at(-1);
    tags.push(tag);
    const attributes = Object.values(tag.attributes);
    if (tag.uri === RDF && tag.local === "Description" && parent?.uri === RDF && parent.local === "RDF" &&
      tags.length <= 3 && !attributes.some(a => a.uri === RDF && a.local === "about" && a.value)) {
      descriptionDepth = tags.length;
      for (const a of attributes) if (a.uri === IPTC && a.local === "DigitalSourceType") sources.add(a.value.trim());
    } else if (tag.uri === IPTC && tag.local === "DigitalSourceType" && tags.length === descriptionDepth + 1) {
      propertyDepth = tags.length;
      property = "";
      for (const a of attributes) if (a.uri === RDF && a.local === "resource") sources.add(a.value.trim());
    }
  });
  parser.on("text", value => { if (tags.length === propertyDepth) property += value; });
  parser.on("closetag", () => {
    if (tags.length === propertyDepth) {
      if (property.trim()) sources.add(property.trim());
      propertyDepth = -1;
    }
    if (tags.length === descriptionDepth) descriptionDepth = -1;
    tags.pop();
  });
  parser.on("doctype", () => { throw new Error("unsupported_xmp_doctype"); });
  try { parser.write(xml).close(); } catch { return "none"; }
  return sources.size === 1 ? sourceDeclaration([...sources][0]) : "none";
}

export async function inspectImageProvenance(image: { mime: string; base64: string }): Promise<ImageProvenance> {
  if (!IMAGE_MIMES.some(mime => image.mime === mime) || image.base64.length > 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3)) {
    return inconclusive("unavailable");
  }
  try {
    const buffer = Buffer.from(image.base64, "base64");
    if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) return inconclusive("unavailable");
    const info = await sharp(buffer, { limitInputPixels: 32_000_000 }).metadata();
    if ((info.format !== "jpeg" && info.format !== "png" && info.format !== "webp")
      || image.mime !== `image/${info.format}` || (info.pages ?? 1) > 1) return inconclusive("unavailable");
    const file = { format: info.format, ...info.autoOrient, bytes: buffer.length };
    let credential: "absent" | "unavailable" = "absent";
    try {
      const { Context, isActionsAssertion, Reader } = await import("@contentauth/c2pa-node");
      const reader = await Reader.fromAsset({ buffer, mimeType: image.mime }, verificationContext(Context));
      if (reader) return { ...signedResult(reader, isActionsAssertion), file };
    } catch {
      // Unsupported host, inaccessible trust store, or unreadable manifest. Unsigned XMP can still be inspected.
      credential = "unavailable";
    }

    const declaration = metadataDeclaration(info.xmpAsString);
    if (declaration === "none") return { ...inconclusive(credential), file };
    const action = declaration === "generated" ? "wygenerowanie obrazu przez AI" : "użycie generatywnej AI do edycji obrazu lub stworzenia jego części";
    const caveat = credential === "absent" ? "W pliku nie znaleziono podpisu C2PA." : "Weryfikacja podpisu C2PA była niedostępna.";
    return { credential, basis: "metadata", declaration, file,
      textPl: `Edytowalne pole IPTC w metadanych wskazuje na ${action}. ${caveat} Pochodzenie pozostaje niepotwierdzone.` };
  } catch {
    return inconclusive("unavailable");
  }
}
