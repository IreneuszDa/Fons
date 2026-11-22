/** Classify existing, labelled fixtures locally. The script does not call the verification engine or any model. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fixtureFileFor, fixturePath, loadBenignTexts, loadSuite } from "./cases";
import { isolateFenceMarkers, neutralizeMarkupTags } from "../src/engine/normalize";
import { detectInjection } from "../src/security/detector";
import { extractFromHtml } from "../src/security/extract";

const fingerprint = createHash("sha256");
const groups = {
  markedPages: { total: 0, scanned: 0, flagged: 0 },
  markedMessages: { total: 0, scanned: 0, flagged: 0 },
  controlPages: { total: 0, scanned: 0, flagged: 0 },
  controlMessages: { total: 0, scanned: 0, flagged: 0 },
  benignProse: { total: 0, scanned: 0, flagged: 0 },
};

function count(group: keyof typeof groups, id: string, raw: string | undefined, isPage = false) {
  const summary = groups[group];
  summary.total++;
  fingerprint.update(JSON.stringify([group, id, raw ?? null]));
  if (!raw?.trim()) return;
  summary.scanned++;
  let flagged: boolean;
  if (isPage) {
    const page = extractFromHtml(raw);
    flagged = detectInjection(neutralizeMarkupTags(raw), "fetched_page").length > 0 ||
      detectInjection(page.rawText, "fetched_page", undefined, { hiddenSegments: page.hiddenSegments }).length > 0 ||
      page.hiddenSegments.some(segment => detectInjection(segment, "fetched_page").length > 0);
  } else {
    flagged = group === "benignProse"
      ? detectInjection(raw, "fetched_page").length > 0
      : detectInjection(isolateFenceMarkers(raw), "user_message").length > 0;
  }
  if (flagged) summary.flagged++;
}

for (const row of loadSuite("redteam")) {
  const marked = Boolean(row.expected.attack);
  if (row.input.kind === "url") {
    const path = fixtureFileFor(row.input.url ?? "", row);
    const html = path ? readFileSync(fixturePath(path), "utf8") : undefined;
    count(marked ? "markedPages" : "controlPages", row.id, html, true);
  } else if (row.input.kind === "text") {
    count(marked ? "markedMessages" : "controlMessages", row.id, row.input.text);
  } else throw Error("Nieobsługiwany rodzaj próbki w zestawie statycznym.");
}
for (const entry of loadBenignTexts()) count("benignProse", entry.id, entry.text);

const summary = {
  observedAt: new Date().toISOString(),
  fixtureDigest: fingerprint.digest("hex"),
  method: "Jednostką pomiaru jest strona lub wiadomość. Co najmniej jedno trafienie detektora oznacza dodatnią klasyfikację. Etykiety pochodzą z expected.attack w redteam.jsonl oraz z katalogu benign.",
  scope: "Pomiar dotyczy wyłącznie statycznych danych z repozytorium. Skuteczność ochrony werdyktu i zachowania modelu w rzeczywistym ruchu wymaga odrębnego pomiaru.",
  command: "node --import tsx eval/detector-offline.ts",
  filteringTestCommand: "npx vitest run src/security/detector.test.ts -t stripFlaggedSentences",
  groups,
};
const output = JSON.stringify(summary, null, 2) + "\n";
if (process.argv[2]) writeFileSync(process.argv[2], output);
process.stdout.write(output);
