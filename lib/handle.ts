// Handles one Slack message end to end. Every step is a NEW message in the thread (or a new
// channel message for alerts). Nothing is edited or deleted.

import Anthropic from "@anthropic-ai/sdk";
import { LowStockEvent } from "./alerts";
import { limits } from "./config";
import { parseConfig, parseRecipients } from "./sheet";
import { resolveMentions } from "./mentions";
import { applyConfirmed, runAgent, Session } from "./agent";
import { addReaction, postMessage, requesterName, workspaceUsers } from "./slack";
import { loadThread, saveThread, ThreadState, threadKey, withWorkbookLock } from "./store";
import { escapeMrkdwn, buildAlertView, renderAlert } from "./template";
import { loadWorkbook } from "./workbook";

export interface MessageEvent {
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

const CONFIG_KEY = "low-inventory-slack-ids-to-tag";

export async function handleMessage(ev: MessageEvent): Promise<void> {
  const threadTs = ev.thread_ts ?? ev.ts;
  const isFollowUp = !!ev.thread_ts && ev.thread_ts !== ev.ts;
  const text = ev.text.trim();
  const key = threadKey(ev.channel, threadTs);

  let state: ThreadState | null = null;
  if (isFollowUp) {
    state = await loadThread(key);
    if (!state) return; // a thread the bot is not handling
    if (state.requester !== ev.user) return; // only the original requester can answer
  }

  const name = state?.requesterName ?? (await requesterName(ev.user));
  const requester = state?.requester ?? ev.user;

  if (isFollowUp) {
    await postMessage(ev.channel, "⏳ Working on it…", threadTs);
  } else {
    await postMessage(ev.channel, `*${escapeMrkdwn(name)}* requested:\n${quote(text)}\n⏳ Working on it…`, threadTs);
  }

  // One lock covers load -> decide -> write, so concurrent messages cannot interleave.
  await withWorkbookLock(async () => {
    const loaded = await loadWorkbook();
    if (!loaded.ok) {
      await postMessage(ev.channel, loaded.reason, threadTs);
      return;
    }

    const session: Session = {
      workbook: loaded.workbook,
      requester,
      requestText: text,
      limits: limits(),
      alerts: [],
      applied: [],
    };

    const next: ThreadState = { requester, requesterName: name, messages: state?.messages ?? [] };
    let reply: string;

    if (isFollowUp && isConfirm(text) && state?.pendingPlan) {
      reply = await applyConfirmed(state.pendingPlan, session);
    } else {
      const messages = next.messages as Anthropic.MessageParam[];
      messages.push({
        role: "user",
        content: isFollowUp ? text : `Request from ${name}: ${text}`,
      });
      reply = await runAgent(session, messages);
      next.pendingPlan = session.pendingPlan;
    }

    if (session.applied.length > 0) await addReaction(ev.channel, ev.ts, "white_check_mark");
    await postMessage(ev.channel, reply, threadTs);
    await postAlerts(ev.channel, session, name, text);
    await saveThread(key, next);
  });
}

async function postAlerts(channel: string, session: Session, requester: string, requestText: string): Promise<void> {
  if (session.alerts.length === 0) return;
  const config = parseConfig(session.workbook.grid)[CONFIG_KEY];
  const names = config ? parseRecipients(config.value) : [];
  const users = await workspaceUsers();
  const { mentions, unresolved } = resolveMentions(names, users);

  const byItem = new Map<string, LowStockEvent[]>();
  for (const event of session.alerts) {
    byItem.set(event.item, [...(byItem.get(event.item) ?? []), event]);
  }
  for (const group of byItem.values()) {
    const view = buildAlertView(group, { requester, requestText, mentions: mentions.join(" "), unresolved });
    await postMessage(channel, renderAlert(view));
  }
}

function isConfirm(text: string): boolean {
  return /^confirm\b/i.test(text);
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${escapeMrkdwn(line)}`)
    .join("\n");
}
