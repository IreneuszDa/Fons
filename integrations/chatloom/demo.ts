import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";

const replyEnvelope = z.object({
  actions: z.array(z.object({ type: z.string(), content: z.object({ body: z.string().optional() }) })),
});

/** The same signed event and reply contract as the operator's SMS bridge, with a fictional local participant. */
export function createDemoBridge(
  dispatch: (request: Request) => Promise<Response> | Response,
  secret: string,
  now: () => number = Date.now,
) {
  const participant = randomUUID();
  return async (text: string): Promise<string> => {
    const time = now();
    const raw = JSON.stringify({
      event_id: "$" + randomUUID(), room_id: "!" + participant + ":demo.invalid",
      sender: "@" + participant + ":demo.invalid", origin_server_ts: time,
      type: "m.room.message", content: { msgtype: "m.text", body: text },
    });
    const timestamp = String(Math.floor(time / 1000));
    const response = await dispatch(new Request("http://localhost/api/channels/chatloom/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ChatLoom-Timestamp": timestamp,
        "X-ChatLoom-Signature": createHmac("sha256", secret).update(timestamp + "." + raw).digest("hex"),
      },
      body: raw,
    }));
    if (!response.ok) throw new Error("Adapter wiadomości zwrócił HTTP " + response.status);
    const envelope = replyEnvelope.parse(await response.json());
    const reply = envelope.actions.find(action => action.type === "m.room.message")?.content.body;
    if (!reply) throw new Error("Adapter nie zwrócił wiadomości dla nadawcy.");
    return reply;
  };
}
