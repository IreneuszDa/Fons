import { describe, expect, it } from "vitest";
import { isAppPath, matchRoute, shouldIntercept } from "./router";

describe("matchRoute", () => {
  it("matches the four pages", () => {
    expect(matchRoute("/")).toEqual({ name: "chat" });
    expect(matchRoute("/zrodla")).toEqual({ name: "sources" });
    expect(matchRoute("/zrodla/")).toEqual({ name: "sources" });
    expect(matchRoute("/admin")).toEqual({ name: "admin" });
    expect(matchRoute("/telefon")).toEqual({ name: "notfound" });
    expect(matchRoute("/w/abc123")).toEqual({ name: "result", token: "abc123" });
  });
  it("returns notfound for anything else", () => {
    expect(matchRoute("/w/")).toEqual({ name: "notfound" });
    expect(matchRoute("/w/a/b")).toEqual({ name: "notfound" });
    expect(matchRoute("/w/%E0%A4%A")).toEqual({ name: "notfound" });
    expect(matchRoute("/cokolwiek")).toEqual({ name: "notfound" });
  });
  it("never claims /api paths", () => {
    expect(isAppPath("/api/report/x")).toBe(false);
    expect(isAppPath("/zrodla")).toBe(true);
  });
});

describe("shouldIntercept", () => {
  const ev = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
  const a = (href: string, target = "", hasDownload = false) => ({ href, target, hasDownload });
  const origin = "http://localhost:5173";

  it("intercepts plain same-origin app links", () => {
    expect(shouldIntercept(ev, a("/zrodla"), origin)).toBe("/zrodla");
    expect(shouldIntercept(ev, a("/w/tok?x=1"), origin)).toBe("/w/tok?x=1");
  });
  it("lets the browser handle everything else", () => {
    expect(shouldIntercept({ ...ev, metaKey: true }, a("/zrodla"), origin)).toBeNull();
    expect(shouldIntercept({ ...ev, button: 1 }, a("/zrodla"), origin)).toBeNull();
    expect(shouldIntercept(ev, a("/zrodla", "_blank"), origin)).toBeNull();
    expect(shouldIntercept(ev, a("/api/admin/export.csv", "", true), origin)).toBeNull();
    expect(shouldIntercept(ev, a("/api/admin/export.csv"), origin)).toBeNull();
    expect(shouldIntercept(ev, a("https://example.org/zrodla"), origin)).toBeNull();
    expect(shouldIntercept(ev, a("/nieznana"), origin)).toBeNull();
  });
});
