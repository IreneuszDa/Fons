import { describe, expect, it, vi } from "vitest";
import { CorpusRecord } from "../../shared/contracts";
import { loadCatalog } from "../catalog";
import { IncidentRecord } from "../types";
import { recordId } from "./common";
import { ingestEuvsdisinfoMcp, EUVSDISINFO_MCP_TOPIC } from "./euvsdisinfo-mcp";
import { preserveEuvsdisinfoSnapshot } from "./euvsdisinfo";

const token = "mcp-test-token";
const endpoint = "https://mcp.euvsd.info/mcp";
const day = Date.parse("2026-10-11") / 1000;
const exampleCase = {
  title: "Example of a narrative documented in the database",
  url: "https://euvsdisinfo.eu/report/example/?tracking=example",
  date: day,
  claim: "Full claim deliberately ignored",
  fact: "Full fact-check deliberately ignored",
  linksToDisinformation: [{ url: "https://untrusted.example/post" }],
};
const options = (limit: number) => ({ refresh: false, limit, catalog: loadCatalog(), log: vi.fn() });

function mockServer(pages: unknown[]) {
  const toolArguments: unknown[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    expect(String(input)).toBe(endpoint);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(init?.redirect).toBe("error");
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body));
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });
    if (request.method === "initialize") {
      return new Response(
        `event: message\ndata: ${JSON.stringify(reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1.0.0" } }))}\n\n`,
        { headers: { "Content-Type": "text/event-stream", "Mcp-Session-Id": "test-session" } },
      );
    }
    expect(headers.get("mcp-session-id")).toBe("test-session");
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    expect(request.method).toBe("tools/call");
    expect(request.params.name).toBe("cases");
    const page = pages[toolArguments.length];
    toolArguments.push(request.params.arguments);
    if (page instanceof Error) throw page;
    return Response.json(reply({ content: [], structuredContent: page }));
  };
  return { fetch: mockFetch, paceMs: 0, toolArguments };
}

describe("EUvsDisinfo MCP", () => {
  it("paginates over the Streamable HTTP session and keeps only canonical case metadata", async () => {
    const deps = mockServer([
      { offset: 0, hasNextPage: true, cases: [exampleCase, { ...exampleCase, url: "https://example.org/report/fake/" }] },
      { offset: 2, hasNextPage: false, cases: [
        exampleCase,
        { ...exampleCase, url: "https://euvsdisinfo.eu/report/second" },
        { ...exampleCase, url: "https://euvsdisinfo.eu/report/future/", date: Date.parse("2099-01-01") / 1000 },
      ] },
    ]);
    const result = await ingestEuvsdisinfoMcp(options(5), token, deps);
    expect(deps.toolArguments).toEqual([{ offset: 0, limit: 5 }, { offset: 2, limit: 3 }]);
    expect(result.requests).toBe(2);
    expect(result.records.map((record) => record.url)).toEqual([
      "https://euvsdisinfo.eu/report/example/",
      "https://euvsdisinfo.eu/report/second/",
    ]);
    const record = CorpusRecord.parse(result.records[0]);
    const incident = IncidentRecord.parse(result.incidents[0]);
    expect(record.id).toBe(recordId("euvsdisinfo", "/report/example/"));
    expect(record.claimReviewed).toBe(exampleCase.title);
    expect(record.publishedAt).toBe("2026-10-11");
    expect(record.topics).toContain(EUVSDISINFO_MCP_TOPIC);
    expect(record.rating).toBeUndefined();
    expect(incident.recordId).toBe(record.id);
    expect(incident.domains).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/Full claim|Full fact-check|untrusted\.example|mcp-test-token|tracking=example/);
  });

  it("rejects a failed continuation without handing partial data or transport secrets to the builder", async () => {
    const deps = mockServer([
      { offset: 0, hasNextPage: true, cases: [exampleCase] },
      new Error(`secret error: ${token}`),
    ]);
    await expect(ingestEuvsdisinfoMcp(options(2), token, deps)).rejects.toThrow(/^EUvsDisinfo MCP: pobieranie nie powiodło się \(offset 1\)\. Sprawdź dostęp do serwera i EUVSDISINFO_MCP_TOKEN\.$/);
  });

  it("preserves saved cases and prefers an existing original rating for the same report", async () => {
    const result = await ingestEuvsdisinfoMcp(options(2), token, mockServer([
      { offset: 0, hasNextPage: false, cases: [exampleCase] },
    ]));
    const record = result.records[0]!;
    const incident = result.incidents[0]!;
    const scored = { ...record, rating: { raw: "DISINFO", mapped: "FALSZYWE" as const, binary: false } };
    const oldId = recordId("euvsdisinfo", "/report/older/");
    const old = { ...record, id: oldId, url: "https://euvsdisinfo.eu/report/older/" };
    const oldIncident = { ...incident, id: oldId, recordId: oldId, url: old.url };
    const combined = preserveEuvsdisinfoSnapshot(result, () => ({
      records: [scored, old],
      incidents: [incident, oldIncident],
      errors: [],
    }));
    expect(combined.records).toEqual([scored, old]);
    expect(combined.incidents).toEqual([incident, oldIncident]);
  });
});
