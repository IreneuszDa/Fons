import { describe, expect, it } from "vitest";
import { createConversationAgent } from "./conversation";
import { FakeLlmProvider } from "./fake";
import { parseFences } from "./fence";
import { OpenAiProvider } from "./openai";

describe("conversation agent", () => {
  it("sends ordered, role-labelled history to the chat API and returns the generated reply with usage", async () => {
    const provider = new OpenAiProvider({
      apiKey: "test",
      models: { fast: "chat-fast", main: "chat-main" },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        expect(body.model).toBe("chat-fast");
        expect(body.response_format.json_schema.schema).toMatchObject({
          type: "object",
          required: ["kind", "text", "query"],
          additionalProperties: false,
        });
        expect(body.messages[0].role).toBe("system");
        expect(body.messages[0].content).toContain("łacińskiego słowa „fons”, czyli „źródło”");
        expect(body.messages[0].content).toContain("zadanie konkursowe „PRAWDOWID” Ministerstwa Spraw Zagranicznych");
        expect(body.messages[1].role).toBe("user");
        expect(parseFences(body.messages[1].content).map(({ label, content }) => [label, content])).toEqual([
          ["UZYTKOWNIK", "Cześć, jestem [EMAIL]."],
          ["FONS", "Cześć!"],
          ["WIADOMOSC", "Jaka jest pogoda?"],
        ]);
        return Response.json({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ kind: "reply", text: "Dla jakiej miejscowości?", query: null }) } }],
          usage: { prompt_tokens: 343, completion_tokens: 27 },
        });
      },
    });
    const agent = createConversationAgent(provider);
    const decision = await agent({
      text: "Jaka jest pogoda?",
      history: [{ role: "user", text: "Cześć, jestem [EMAIL]." }, { role: "assistant", text: "Cześć!" }],
      hasReport: false,
    });
    expect(decision).toMatchObject({ kind: "reply", text: "Dla jakiej miejscowości?", usage: { purpose: "router", inputTokens: 343, outputTokens: 27 } });
  });

  it("returns a standalone tool argument after clarification", async () => {
    const query = "Czy w województwie śląskim obowiązuje dziś alert IMGW o oblodzeniu?";
    const agent = createConversationAgent(new FakeLlmProvider({ override: () => ({ kind: "verify", text: null, query }) }));
    await expect(agent({
      text: "W śląskim",
      history: [
        { role: "user", text: "Czy obowiązuje dziś alert IMGW o oblodzeniu?" },
        { role: "assistant", text: "W jakim województwie?" },
      ],
      hasReport: false,
    })).resolves.toMatchObject({ kind: "verify", query });
  });

  it.each([
    { kind: "reply", text: "  ", query: null },
    { kind: "verify", text: "Zweryfikowano", query: "teza" },
    { kind: "sources", text: "zmyślone źródło", query: null },
  ])("rejects a malformed $kind decision in the provider", async raw => {
    const agent = createConversationAgent(new FakeLlmProvider({ override: () => raw }));
    await expect(agent({ text: "Wiadomość", history: [], hasReport: false })).rejects.toMatchObject({ reason: "schema" });
  });
});
