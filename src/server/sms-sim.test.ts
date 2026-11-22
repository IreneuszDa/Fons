import { describe, expect, it } from "vitest";
import { makeEnv } from "./testkit";

describe("dostępne kanały", () => {
  it("nie udostępnia symulatora SMS ani niewdrożonej bramki", async () => {
    const env = makeEnv();
    try {
      expect(env.ctx.channels.getWebhook("sms")).toBeUndefined();
      const post = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
      expect((await env.app.request("/api/sim/sms", post)).status).toBe(404);
      expect((await env.app.request("/api/channels/sms/webhook", post)).status).toBe(501);
    } finally {
      env.ctx.db.close();
    }
  });
});
