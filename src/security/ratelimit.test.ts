import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./ratelimit";
import { escapeHtml, safeUrl } from "./render";

describe("createRateLimiter", () => {
  it("allows perMinute requests per key in a sliding window", () => {
    let t = 0;
    const rl = createRateLimiter({ perMinute: 3, now: () => t });
    expect([rl.check("a"), rl.check("a"), rl.check("a"), rl.check("a")]).toEqual([true, true, true, false]);
    expect(rl.check("b")).toBe(true); // keys are independent
    t = 30_000;
    expect(rl.check("a")).toBe(false);
    t = 60_001; // first three fell out of the window
    expect(rl.check("a")).toBe(true);
    expect(rl.remaining("a")).toBe(2);
  });

  it("slides rather than resetting at fixed boundaries", () => {
    let t = 0;
    const rl = createRateLimiter({ perMinute: 2, now: () => t });
    rl.check("k"); // t=0
    t = 40_000;
    rl.check("k"); // t=40s
    t = 59_000;
    expect(rl.check("k")).toBe(false);
    t = 60_500; // the t=0 hit expired, the t=40s one did not
    expect(rl.check("k")).toBe(true);
    expect(rl.check("k")).toBe(false);
  });

  it("reset clears a key", () => {
    const rl = createRateLimiter({ perMinute: 1 });
    rl.check("x");
    expect(rl.check("x")).toBe(false);
    rl.reset("x");
    expect(rl.check("x")).toBe(true);
  });
});

describe("safeUrl", () => {
  it("accepts and normalises http/https", () => {
    expect(safeUrl("https://www.gov.pl/web/dyplomacja")).toBe("https://www.gov.pl/web/dyplomacja");
    expect(safeUrl("  HTTP://Example.COM  ")).toBe("http://example.com/");
  });
  it("rejects other schemes and tricks", () => {
    for (const u of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "ftp://example.com",
      "/relative/path",
      "//example.com",
      "https://gov.pl@evil.example/",
      "",
    ]) {
      expect(safeUrl(u), u).toBeNull();
    }
  });
});

describe("escapeHtml", () => {
  it("escapes markup characters", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });
});
