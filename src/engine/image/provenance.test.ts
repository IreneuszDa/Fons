import { readFileSync } from "node:fs";
import { Context, Reader } from "@contentauth/c2pa-node";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { inspectImageProvenance } from "./provenance";

const iptc = "http://iptc.org/std/Iptc4xmpExt/2008-02-29/";
const types = "http://cv.iptc.org/newscodes/digitalsourcetype/";
const xmp = (property: string, namespace = iptc) => `<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><r:Description r:about="" xmlns:i="${namespace}">
  ${property}</r:Description></r:RDF></x:xmpmeta>`;

async function picture(format: "jpeg" | "webp" | "png", metadata?: string) {
  const image = sharp({ create: { width: 12, height: 12, channels: 3, background: "gray" } });
  if (metadata) image.withXmp(metadata);
  return { mime: `image/${format}`, base64: (await image.toFormat(format).toBuffer()).toString("base64") };
}

function signedFixture(kind: "generated" | "edited") {
  return readFileSync(new URL(`./fixtures/signed-${kind}.png`, import.meta.url));
}

afterEach(() => vi.restoreAllMocks());

it.each(["generated", "edited"] as const)("reads the %s declaration only when the actual signature validates", async kind => {
  // Both solid-gray images were signed using the c2pa-js SDK's es256 test certificate.
  // Trust that leaf only for this test and keep the production trust lists intact.
  const context = new Context({ trust: { allowedList: "b7Xt2zU6gvqHILHVSkkl6qIOEosQzEs/pNPp6SDAQAE=" }, verify: { remoteManifestFetch: false, ocspFetch: false } });
  const read = Reader.fromAsset.bind(Reader);
  vi.spyOn(Reader, "fromAsset").mockImplementationOnce(asset => read(asset, context));
  const result = await inspectImageProvenance({ mime: "image/png", base64: signedFixture(kind).toString("base64") });
  expect(result).toMatchObject({ credential: "trusted", basis: "c2pa", declaration: kind });
});

it("rejects a test signer absent from the production trust list and detects a changed assertion", async () => {
  const buffer = signedFixture("generated");
  const inspect = () => inspectImageProvenance({ mime: "image/png", base64: buffer.toString("base64") });
  expect(await inspect()).toMatchObject({ credential: "untrusted", basis: "none", declaration: "none" });
  const declaration = buffer.indexOf("trainedAlgorithmicMedia");
  expect(declaration).toBeGreaterThan(0);
  buffer[declaration] = 120;
  expect(await inspect()).toMatchObject({ credential: "invalid", basis: "none", declaration: "none" });
});

it.each(["jpeg", "webp", "png"] as const)("treats an unsigned %s IPTC declaration as editable metadata", async format => {
  const image = await picture(format, xmp(`<i:DigitalSourceType r:resource="${types}compositeWithTrainedAlgorithmicMedia"/>`));
  expect(await inspectImageProvenance(image)).toMatchObject({ credential: "absent", basis: "metadata", declaration: "edited" });
});

it("ignores a mention in a caption, an unrelated namespace and another asset's metadata", async () => {
  const field = `<i:DigitalSourceType>${types}trainedAlgorithmicMedia</i:DigitalSourceType>`;
  for (const xml of [xmp(`<i:Caption>${types}trainedAlgorithmicMedia</i:Caption>`), xmp(field, "urn:unrelated"), xmp(field).replace('r:about=""', 'r:about="another.jpg"')]) {
    expect(await inspectImageProvenance(await picture("webp", xml))).toMatchObject({ credential: "absent", declaration: "none", basis: "none" });
  }
});

it("distinguishes an unsigned, unmarked image from an unreadable upload", async () => {
  expect(await inspectImageProvenance(await picture("png"))).toMatchObject({ credential: "absent", basis: "none", declaration: "none" });
  expect(await inspectImageProvenance({ mime: "image/png", base64: "aaaa" })).toMatchObject({ credential: "unavailable", basis: "none", declaration: "none" });
});

it("can still inspect unsigned metadata if the native SDK fails to load", async () => {
  vi.spyOn(Reader, "fromAsset").mockRejectedValue(new Error("Cannot load native module"));
  const image = await picture("jpeg", xmp(`<i:DigitalSourceType>${types}trainedAlgorithmicMedia</i:DigitalSourceType>`));
  expect(await inspectImageProvenance(image)).toMatchObject({ credential: "unavailable", basis: "metadata", declaration: "generated" });
  expect(await inspectImageProvenance(await picture("png"))).toMatchObject({ credential: "unavailable", basis: "none", declaration: "none" });
});

it("uses offline native validation settings for untrusted uploads", async () => {
  const spy = vi.spyOn(Reader, "fromAsset");
  await inspectImageProvenance(await picture("jpeg"));
  const context = spy.mock.calls[0]?.[1];
  expect(context && JSON.parse(await context.toJson())).toMatchObject({
    core: { allowed_network_hosts: [], decode_identity_assertions: false, max_decompressed_manifest_size_in_mb: 16 },
    verify: { ocsp_fetch: false, remote_manifest_fetch: false, verify_trust: true, verify_after_reading: true },
  });
});
