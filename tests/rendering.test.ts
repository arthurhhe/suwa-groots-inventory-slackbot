import { describe, expect, it } from "vitest";
import { buildAlertView, renderAlert } from "../lib/template";
import { resolveMentions, SlackUser } from "../lib/mentions";
import { verifySlackSignature } from "../lib/slack-signature";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const templateSource = readFileSync(path.join(__dirname, "..", "templates", "low-inventory-alert.md"), "utf8");

describe("alert template", () => {
  it("renders the item, each low region, the requester and mentions", () => {
    const view = buildAlertView(
      [{ item: "Bolts", region: "East Coast", quantity: 8, previous: 12, threshold: 10 }],
      { requester: "Maria Lopez", requestText: "used 4 bolts in east coast", mentions: "<@U1> <@U2>", unresolved: [] },
    );
    const text = renderAlert(view, templateSource);
    expect(text).toContain("Low inventory: Bolts");
    expect(text).toContain("East Coast: *8* on hand (threshold 10)");
    expect(text).toContain("Maria Lopez");
    expect(text).toContain("<@U1> <@U2>");
    expect(text).not.toContain("Could not find");
  });

  it("mentions unresolved names so the config can be fixed", () => {
    const view = buildAlertView(
      [{ item: "Bolts", region: "East Coast", quantity: 1, previous: 2, threshold: 10 }],
      { requester: "Maria", requestText: "x", mentions: "", unresolved: ["@ghost"] },
    );
    expect(renderAlert(view, templateSource)).toContain("Could not find Slack users: @ghost");
  });
});

describe("mentions", () => {
  const users: SlackUser[] = [
    { id: "U1", name: "dana", displayName: "Dana R", realName: "Dana Rivera" },
    { id: "U2", name: "lee.k", displayName: "", realName: "Lee Kim" },
  ];

  it("matches handle, display name or real name, case-insensitively", () => {
    expect(resolveMentions(["@dana", "Dana Rivera", "lee kim"], users)).toEqual({
      mentions: ["<@U1>", "<@U1>", "<@U2>"],
      unresolved: [],
    });
  });

  it("collects names it cannot find", () => {
    expect(resolveMentions(["@nobody"], users)).toEqual({ mentions: [], unresolved: ["@nobody"] });
  });
});

describe("slack signature", () => {
  const secret = "test-secret";
  const body = "token=x&command=%2Finv";
  const ts = "1700000000";
  const signature = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");

  it("accepts a valid signature inside the time window", () => {
    expect(verifySlackSignature({ signingSecret: secret, timestamp: ts, signature, rawBody: body, nowSeconds: Number(ts) + 30 })).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, or a stale timestamp", () => {
    const now = Number(ts) + 30;
    expect(verifySlackSignature({ signingSecret: secret, timestamp: ts, signature, rawBody: body + "x", nowSeconds: now })).toBe(false);
    expect(verifySlackSignature({ signingSecret: "other", timestamp: ts, signature, rawBody: body, nowSeconds: now })).toBe(false);
    expect(verifySlackSignature({ signingSecret: secret, timestamp: ts, signature, rawBody: body, nowSeconds: Number(ts) + 600 })).toBe(false);
  });
});
