import { describe, expect, it } from "vitest";
import { compareChannels, comparePair, reportTokenFromSms, smsDeliveryProblems } from "./consistency";

const ch = (channel: "web" | "cli" | "sms", over: Partial<{ status: string; mainVerdict: string | null; recordIds: string[]; securityEvents: number }> = {}) => ({ ...base(channel), ...over });
function base(channel: "web" | "cli" | "sms") {
  return { channel, replyKind: "verdict", status: "OK", mainVerdict: "FALSZ", recordIds: ["r1", "r2"], securityEvents: 0, cacheHit: false };
}

describe("consistency comparison", () => {
  it("identical results across three channels are consistent", () => {
    expect(compareChannels(ch("web"), ch("cli"), ch("sms"), false)).toEqual([]);
  });

  it("flags verdict and record-id differences of sms against web, labelled (sms)", () => {
    const r = compareChannels(ch("web"), ch("cli"), ch("sms", { mainVerdict: "PRAWDA", recordIds: ["r1"] }), false);
    expect(r.some((x) => x.startsWith("werdykt") && x.endsWith("(sms)"))).toBe(true);
    expect(r.some((x) => x.startsWith("różne zestawy") && x.endsWith("(sms)"))).toBe(true);
  });

  it("keeps the web/cli reasons unlabelled and works without sms", () => {
    expect(compareChannels(ch("web"), ch("cli", { status: "BLAD" }), undefined, false)).toEqual(["status OK ≠ BLAD"]);
  });

  it("attack must raise a security event on every channel", () => {
    const withEv = ch("web", { securityEvents: 2 });
    expect(comparePair(withEv, ch("sms"), true, " (sms)")).toEqual(["zdarzenie bezpieczeństwa tylko w jednym kanale (sms)"]);
    expect(compareChannels(withEv, ch("cli", { securityEvents: 1 }), ch("sms", { securityEvents: 3 }), true)).toEqual([]);
  });

  it("a missing report on sms is reported", () => {
    const r = compareChannels(ch("web"), ch("cli"), ch("sms", { status: "BRAK_RAPORTU", mainVerdict: null, recordIds: [] }), false);
    expect(r.some((x) => /brak raportu.*\(sms\)/.test(x))).toBe(true);
  });

  it("sms delivery: needs messages within the limit", () => {
    expect(smsDeliveryProblems([], 320)).toHaveLength(1);
    expect(smsDeliveryProblems(undefined, 320)).toHaveLength(1);
    expect(smsDeliveryProblems(["x".repeat(321)], 320)).toHaveLength(1);
    expect(smsDeliveryProblems(["ok"], 320)).toEqual([]);
  });
});

describe("reportTokenFromSms", () => {
  it("extracts the result-link token from the simulator outbox", () => {
    const tok = "AbCdEfGhIjKlMnOpQrStUv";
    expect(reportTokenFromSms(["Fałsz.\nWynik i źródła: https://fons.example/w/" + tok + "\n"])).toBe(tok);
    expect(reportTokenFromSms(["bez linku"])).toBeUndefined();
    expect(reportTokenFromSms([])).toBeUndefined();
  });
});
