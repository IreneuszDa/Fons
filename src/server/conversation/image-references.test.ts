import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { searchImageReferences } from "../../engine/image/reference-search";
import { chat, makeEnv } from "../testkit";

const blueMarble = new URL("../../../data/image-references/apollo17-blue-marble.jpg", import.meta.url);
const earthrise = new URL("../../../data/image-references/apollo8-earthrise.jpg", import.meta.url);

describe("lokalny katalog wcześniejszych publikacji fotografii", () => {
  it("odróżnia dwie fotografie NASA po zmianie formatu i rozmiaru", async () => {
    for (const [file, date] of [[blueMarble, "2007-11-30"], [earthrise, "2020-12-23"]] as const) {
      const copy = await sharp(await readFile(file)).resize({ width: 150 }).webp({ quality: 70 }).toBuffer();
      expect(await searchImageReferences(copy)).toMatchObject({ status: "ok", checked: 2, matches: [
        { kind: "similar", publisher: "NASA", publishedAt: date },
      ] });
    }
  });

  it("odróżnia brak dopasowania, silnie zmieniony kadr i błąd odczytu", async () => {
    const cropped = await sharp(await readFile(blueMarble)).extract({ left: 60, top: 50, width: 120, height: 120 }).png().toBuffer();
    const plain = await sharp({ create: { width: 200, height: 200, channels: 3, background: "black" } }).png().toBuffer();
    for (const bytes of [cropped, plain]) {
      expect(await searchImageReferences(bytes)).toMatchObject({ status: "ok", checked: 2, matches: [] });
    }
    expect(await searchImageReferences(Buffer.from("invalid"))).toEqual({ status: "unavailable", checked: 0, matches: [] });
  });

  it("porównuje dwa przesłane obrazy lokalnie i zachowuje wynik po otwarciu raportu", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const env = makeEnv({ fetch: fetcher, cfg: { reverseImageProvider: "google_vision", googleVisionApiKey: "test", dailyTokenBudget: 0 } });
    const bytes = await readFile(blueMarble);
    const image = { mime: "image/jpeg", base64: bytes.toString("base64") };
    const png = (b: Buffer) => ({ mime: "image/png", base64: b.toString("base64") });
    // Use two lossless encodings to keep every decoded pixel identical while changing the file bytes.
    const pixels = png(await sharp(bytes).png({ compressionLevel: 1 }).toBuffer());
    const encoded = png(await sharp(bytes).png({ compressionLevel: 9 }).toBuffer());
    const scaled = png(await sharp(bytes).resize({ width: 150 }).png().toBuffer());
    const other = { mime: "image/jpeg", base64: (await readFile(earthrise)).toString("base64") };
    for (const [first, second, expected] of [
      [image, image, "identical_file"], [pixels, encoded, "same_pixels"], [image, scaled, "similar"], [image, other, "no_match"],
    ] as const) {
      const response = await chat(env, { image: first, comparisonImage: second, text: "Porównaj obrazy." });
      const report = response.json.reply.report;
      expect(report).toMatchObject({ status: "OK", mainVerdict: null, models: [], imageAnalysis: {
        comparison: expected, images: [ { provenance: { file: { bytes: Buffer.from(first.base64, "base64").length } } },
          { provenance: { file: { bytes: Buffer.from(second.base64, "base64").length } } } ],
      } });
      const saved = await env.app.request(`/api/report/${report.token}`);
      expect(await saved.json()).toMatchObject({ imageAnalysis: report.imageAnalysis });
      expect(JSON.stringify(report)).not.toContain(first.base64);
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(env.calls).toHaveLength(0);
    expect(env.ctx.media.size).toBe(0);
    expect((await chat(env, { comparisonImage: image })).status).toBe(400);
    expect((await chat(env, { image, comparisonImage: { ...image, mime: "image/png" } })).status).toBe(400);
    expect((await chat(env, { image, comparisonImage: image, imageOptions: { searchWeb: true } })).status).toBe(400);
    expect((await chat(env, { image, text: "Pokaż metadane tego zdjęcia." })).json.reply.report)
      .toMatchObject({ mainVerdict: null, summaryPl: expect.stringContaining("JPEG"), models: [] });
  });

  it("przyjmuje plik w WWW, znajduje publikację bez Google i odczytuje zapisany wynik bez wpływu na werdykt", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const env = makeEnv({ fetch: fetcher, cfg: { reverseImageProvider: "off", dailyTokenBudget: 0 } });
    const image = { mime: "image/jpeg", base64: (await readFile(blueMarble)).toString("base64") };
    const body = { image, text: "Gdzie wcześniej opublikowano to zdjęcie?", imageOptions: { searchWeb: false } };
    const first = await chat(env, body);
    expect(first.status).toBe(200);
    const report = first.json.reply.report;
    expect(report).toMatchObject({ mainVerdict: null, status: "OK", claims: [], verdicts: [], models: [],
      imageAnalysis: { focus: "copies", images: [{ localSearch: { status: "ok", matches: [{ publishedAt: "2007-11-30", kind: "similar" }] } }] } });
    expect(report.summaryPl).toContain("https://www.nasa.gov/image-article/blue-marble-image-of-earth-from-apollo-17/");
    expect(report.summaryPl).toContain("Data publikacji dotyczy wskazanej strony");
    const saved = await env.app.request(`/api/report/${report.token}`);
    expect(await saved.json()).toMatchObject({ imageAnalysis: report.imageAnalysis, mainVerdict: null });
    expect(env.db.prepare("SELECT input_masked, record_ids_json FROM runs WHERE request_id = ?").get(report.id))
      .toEqual({ input_masked: body.text, record_ids_json: '["image:apollo17-blue-marble"]' });
    expect((await chat(env, body, first.cookie)).json.reply.report.cacheHit).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(env.calls).toHaveLength(0);
    expect(JSON.stringify(report)).not.toContain(image.base64);
  });

  it("nie zgaduje miejsca na podstawie pikseli i rozróżnia niedostępność żądanego indeksu", async () => {
    const env = makeEnv({ cfg: { reverseImageProvider: "off", dailyTokenBudget: 0 } });
    const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: "blue" } }).png().toBuffer();
    const image = { mime: "image/png", base64: png.toString("base64") };
    const context = await chat(env, { image, text: "Gdzie wykonano to zdjęcie?", imageOptions: { searchWeb: false } });
    expect(context.json.reply.report).toMatchObject({ status: "OK", mainVerdict: null, models: [],
      summaryPl: expect.stringContaining("wymaga źródła"), imageAnalysis: { visual: { mode: "context", citations: [] } } });
    const missing = await chat(env, { image, text: "Gdzie wcześniej opublikowano to zdjęcie?", imageOptions: { searchWeb: true } });
    expect(missing.json.reply.report).toMatchObject({ status: "NIEPELNE", mainVerdict: null, models: [],
      imageAnalysis: { images: [{ localSearch: { checked: 2, matches: [] }, search: { status: "disabled" } }] } });
  });
});
