import { describe, expect, it } from "vitest";
import { makeTestConfig } from "../../server/testkit";
import { loadVideoCaption } from "./platforms";
import { createVideoServices } from "./services";

describe("production video provider selection", () => {
  const keys = { openaiApiKey: "test-openai", geminiApiKey: "test-gemini" };

  it("prefers OpenAI when both keys are present and respects the configured processing region", () => {
    const services = createVideoServices(makeTestConfig({ ...keys, openaiDataResidency: "eu" }));
    expect(services).toMatchObject({ provider: "openai", processingRegion: "eea", analyze: expect.any(Function) });
  });

  it("uses Gemini when explicitly selected", () => {
    const services = createVideoServices(makeTestConfig({ ...keys, videoProvider: "gemini" }));
    expect(services).toMatchObject({ provider: "gemini", analyze: expect.any(Function) });
  });

  it("keeps caption lookup available when the selected OpenAI key is missing or video processing is off", () => {
    const captionOnly = { loadCaption: loadVideoCaption };
    expect(createVideoServices(makeTestConfig({ geminiApiKey: keys.geminiApiKey, videoProvider: "openai" }))).toEqual(captionOnly);
    expect(createVideoServices(makeTestConfig({ ...keys, videoProvider: "off" }))).toEqual(captionOnly);
  });
});
