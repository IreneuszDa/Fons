import { selectedVideoProvider, type AppConfig } from "../../server/config";
import { createGeminiVideoAnalyzer } from "./gemini";
import type { VideoServices } from "./intake";
import { createOpenAiVideoAnalyzer } from "./openai-video";
import { createVideoLoader, loadVideoCaption } from "./platforms";

export function createVideoServices(cfg: AppConfig): VideoServices {
  const provider = selectedVideoProvider(cfg);
  if (provider === "openai" && cfg.openaiApiKey) {
    return {
      provider, processingRegion: cfg.openaiDataResidency === "eu" ? "eea" : "us",
      load: createVideoLoader(cfg.socialKitApiKey, provider),
      analyze: createOpenAiVideoAnalyzer({ apiKey: cfg.openaiApiKey, model: cfg.openaiVideoModel, dataResidency: cfg.openaiDataResidency }),
    };
  }
  if (provider === "gemini" && cfg.geminiApiKey) {
    return {
      provider, load: createVideoLoader(cfg.socialKitApiKey, provider),
      analyze: createGeminiVideoAnalyzer({ apiKey: cfg.geminiApiKey, model: cfg.geminiVideoModel }),
    };
  }
  return { loadCaption: loadVideoCaption };
}
