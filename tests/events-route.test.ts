import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { POST } from "../app/api/slack/events/route";

const secret = "test-signing-secret";

function signed(body: string, timestamp = Math.floor(Date.now() / 1000)): Request {
  const signature = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return new Request("https://example.test/api/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature,
    },
    body,
  });
}

describe("POST /api/slack/events", () => {
  beforeAll(() => {
    process.env.SLACK_SIGNING_SECRET = secret;
    process.env.SLACK_CHANNEL_ID = "C_INVENTORY";
  });

  it("rejects requests without a valid Slack signature", async () => {
    const req = new Request("https://example.test/api/slack/events", {
      method: "POST",
      headers: { "x-slack-request-timestamp": "0", "x-slack-signature": "v0=nope" },
      body: "{}",
    });
    expect((await POST(req)).status).toBe(401);
  });

  it("answers the url_verification challenge with a valid signature", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const res = await POST(signed(body));
    expect(await res.json()).toEqual({ challenge: "abc123" });
  });

  it("ignores messages from other channels without touching the workbook", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev1",
      event: { type: "message", channel: "C_OTHER", user: "U1", text: "used 5 bolts in east coast", ts: "1.0" },
    });
    const res = await POST(signed(body));
    expect(await res.text()).toBe("ignored");
  });

  it("ignores bot and edited messages", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev2",
      event: { type: "message", subtype: "message_changed", channel: "C_INVENTORY", user: "U1", text: "x", ts: "1.0" },
    });
    expect(await (await POST(signed(body))).text()).toBe("ignored");
  });
});
