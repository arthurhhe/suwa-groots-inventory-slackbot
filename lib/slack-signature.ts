import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_SKEW_SECONDS = 60 * 5;

// Verifies Slack's request signature: v0=HMAC-SHA256(secret, "v0:{timestamp}:{rawBody}").
export function verifySlackSignature(opts: {
  signingSecret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowSeconds?: number;
}): boolean {
  const { signingSecret, timestamp, signature, rawBody } = opts;
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_SECONDS) return false;

  const expected = "v0=" + createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
