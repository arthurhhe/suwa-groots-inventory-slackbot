import { after } from "next/server";
import { requireEnv } from "@/lib/config";
import { handleMessage, MessageEvent } from "@/lib/handle";
import { postMessage } from "@/lib/slack";
import { claimEvent } from "@/lib/store";
import { verifySlackSignature } from "@/lib/slack-signature";

export const runtime = "nodejs";
export const maxDuration = 60;

// Slack expects a fast HTTP response (about 3 seconds). The work runs after the response
// in after(), which keeps the function alive for up to maxDuration.
export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const valid = verifySlackSignature({
    signingSecret: requireEnv("SLACK_SIGNING_SECRET"),
    timestamp: req.headers.get("x-slack-request-timestamp"),
    signature: req.headers.get("x-slack-signature"),
    rawBody,
  });
  if (!valid) return new Response("invalid signature", { status: 401 });

  const payload = JSON.parse(rawBody);
  if (payload.type === "url_verification") {
    return Response.json({ challenge: payload.challenge });
  }
  if (payload.type !== "event_callback" || !isInventoryMessage(payload.event)) {
    return new Response("ignored");
  }
  if (!(await claimEvent(payload.event_id))) {
    return new Response("duplicate");
  }

  const ev = payload.event as MessageEvent;
  after(async () => {
    try {
      await handleMessage(ev);
    } catch (err) {
      console.error("handleMessage failed", err);
      await postMessage(
        ev.channel,
        `⚠️ Something went wrong while handling that request: ${(err as Error).message}. The workbook may not have changed; check the BotLog sheet before retrying.`,
        ev.thread_ts ?? ev.ts,
      ).catch((postErr) => console.error("could not post error", postErr));
    }
  });
  return new Response("ok");
}

function isInventoryMessage(event: any): boolean {
  return (
    event?.type === "message" &&
    !event.subtype &&
    !event.bot_id &&
    typeof event.user === "string" &&
    typeof event.text === "string" &&
    event.channel === process.env.SLACK_CHANNEL_ID
  );
}
