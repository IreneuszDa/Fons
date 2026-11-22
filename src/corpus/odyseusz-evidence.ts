/** Ograniczony wyciąg do kontroli historycznego cytatu z komunikatu krajowego MSZ. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { CorpusRecord } from "../shared/contracts";
import { loadOfficialRegistry } from "../engine/retrieval/official-plan";
import { MAX_QUOTE_CHARS, PoliteClient, squash } from "./ingest/common";
import { readCorpus } from "./files";
import { dataDir } from "./paths";

const apiNotice = z.object({
  kodISO: z.string(), dataAktualizacji: z.iso.date(), nrWersji: z.number().int().positive(),
  idWersjiProfiluPanstwa: z.number().int().positive(), trescPowiadomieniaDluga: z.string().min(1),
});
const snapshot = z.object({
  recordId: z.string(), pageUrl: z.url(), apiUrl: z.url(), publisher: z.string(), iso: z.string(),
  publishedAt: z.iso.date(), fetchedAt: z.iso.datetime(), version: z.number().int().positive(),
  versionId: z.number().int().positive(), field: z.literal("trescPowiadomieniaDluga"),
  responseSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  slices: z.array(z.object({ offset: z.number().int().nonnegative(), text: z.string().min(1) })).min(1),
});

function identity(r: CorpusRecord) {
  const iso = /^https:\/\/odyseusz\.gov\.pl\/([A-Z]{2})$/u.exec(r.url)?.[1];
  const agency = loadOfficialRegistry().authorities.find(a => a.id === r.sourceId && a.connector === "odyseusz");
  if (!iso || agency?.connector !== "odyseusz" || agency.profileUrl.replace("{ISO}", iso) !== r.url ||
      !r.publishedAt || !/^msz-odyseusz:[0-9a-f]+$/u.test(r.id)) throw new Error("Brak zgodnego profilu kraju MSZ.");
  return { iso, apiUrl: agency.profileApi.replace("{ISO}", iso), publishedAt: r.publishedAt,
    path: resolve(dataDir(), "source-excerpts", r.sourceId, r.id.split(":")[1]! + ".json") };
}

/** Compare against the downloaded API field before storing any excerpt. Offsets refer to its whitespace-normalized text. */
export function captureNotice(r: CorpusRecord, body: string, fetchedAt: string) {
  const source = identity(r);
  const notice = apiNotice.parse(JSON.parse(body));
  if (notice.kodISO !== source.iso || notice.dataAktualizacji !== source.publishedAt) {
    throw new Error("Kraj lub data aktualizacji komunikatu MSZ nie odpowiada rekordowi.");
  }
  const field = squash(notice.trescPowiadomieniaDluga);
  const fragments = squash(r.text).split(/\[(?:…|\.\.\.)\]/u).map(s => s.trim()).filter(Boolean);
  const separator = " […] ";
  const remaining = MAX_QUOTE_CHARS - fragments.join(separator).length;
  if (!fragments.length || remaining < 0) throw new Error("Cytat poza limitem katalogu.");
  const extra = Math.floor(remaining / fragments.length);
  let end = 0;
  const matches = fragments.map(text => {
    const offset = field.indexOf(text, end);
    if (offset < 0) throw new Error("Fragmentu cytatu nie ma w odpowiedniej kolejności w komunikacie MSZ.");
    end = offset + text.length;
    return { offset, end };
  });
  const slices = matches.map((m, i) => {
    // Preserve words following the citation from the actual response as additional evidence of context.
    let to = Math.min(field.length, m.end + extra, matches[i + 1]?.offset ?? field.length);
    if (to < field.length && field[to] !== " ") to = Math.max(m.end, field.lastIndexOf(" ", to));
    return { offset: m.offset, text: field.slice(m.offset, to).trimEnd() };
  });
  return snapshot.parse({ recordId: r.id, pageUrl: r.url, apiUrl: source.apiUrl, publisher: r.publisher,
    iso: source.iso, publishedAt: source.publishedAt, fetchedAt, version: notice.nrWersji,
    versionId: notice.idWersjiProfiluPanstwa, field: "trescPowiadomieniaDluga",
    responseSha256: createHash("sha256").update(body, "utf8").digest("hex"), slices });
}

export function odyseuszSourceTexts(r: CorpusRecord): string[] {
  const source = identity(r);
  if (!existsSync(source.path)) return [];
  const proof = snapshot.parse(JSON.parse(readFileSync(source.path, "utf8")));
  const excerpt = proof.slices.map(s => s.text).join(" […] ");
  if (proof.pageUrl !== r.url || proof.recordId !== r.id || proof.publisher !== r.publisher ||
      proof.iso !== source.iso || proof.apiUrl !== source.apiUrl || proof.publishedAt !== source.publishedAt ||
      proof.fetchedAt.slice(0, 10) < proof.publishedAt || excerpt.length > MAX_QUOTE_CHARS ||
      proof.slices.some((s, i) => i > 0 && s.offset < proof.slices[i - 1]!.offset + proof.slices[i - 1]!.text.length)) {
    throw new Error("Metadane lub zakres wyciągu MSZ nie odpowiadają publikacji.");
  }
  return [excerpt];
}

if (process.argv[1]?.endsWith("/odyseusz-evidence.ts")) {
  const record = readCorpus().records.find(r => r.id === process.argv[2] && r.sourceId === "msz-odyseusz");
  if (!record) throw new Error("Podaj identyfikator rekordu Odyseusza.");
  const source = identity(record);
  const response = await new PoliteClient().get(source.apiUrl, { accept: "application/json", cache: false });
  if (response.status !== 200 || response.finalUrl !== source.apiUrl || !/application\/json/i.test(response.contentType)) {
    throw new Error("Brak odpowiedzi JSON z przypisanego urzędowego adresu.");
  }
  const proof = captureNotice(record, response.body, response.fetchedAt);
  // Keep the first observation of a historical publication. A newer version cannot silently replace it.
  if (existsSync(source.path)) {
    const previous = snapshot.parse(JSON.parse(readFileSync(source.path, "utf8")));
    if (previous.responseSha256 !== proof.responseSha256 || previous.versionId !== proof.versionId ||
        previous.version !== proof.version || JSON.stringify(previous.slices) !== JSON.stringify(proof.slices)) {
      throw new Error("Odpowiedź źródła zmieniła się. Zachowano poprzedni wyciąg.");
    }
    if (!odyseuszSourceTexts(record).length) throw new Error("Brak zapisanego wyciągu.");
  } else {
    mkdirSync(dirname(source.path), { recursive: true });
    writeFileSync(source.path, JSON.stringify(proof, null, 2) + "\n", { flag: "wx" });
  }
  console.log(`Potwierdzono ${record.id} w komunikacie ${proof.iso} z ${proof.publishedAt}, wersja ${proof.version}.`);
}
