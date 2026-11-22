import { FakeLlmProvider } from "../../src/engine/llm/fake";
import { cliAdapter } from "../../src/server/channels/cli";
import type { FonsExtensions } from "../../src/server/extensions";

export function createExtensions(): FonsExtensions {
  return {
    version: "acceptance-v1",
    models: { main: new FakeLlmProvider() },
    branches: [{ id: "partner-index", required: false, async search() { return []; } }],
    channels: [{ ...cliAdapter, id: "partner-chat" }],
  };
}
