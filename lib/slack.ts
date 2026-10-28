// Slack Web API helpers. The bot only ever CREATES messages (chat.postMessage). There is
// deliberately no chat.update or chat.delete here, so every step stays visible in the thread.

import { WebClient } from "@slack/web-api";
import { SlackUser } from "./mentions";
import { requireEnv } from "./config";

let client: WebClient | null = null;
function slack(): WebClient {
  return (client ??= new WebClient(requireEnv("SLACK_BOT_TOKEN")));
}

export async function postMessage(channel: string, text: string, threadTs?: string): Promise<void> {
  await slack().chat.postMessage({ channel, text, thread_ts: threadTs, unfurl_links: false, unfurl_media: false });
}

export async function addReaction(channel: string, ts: string, name: string): Promise<void> {
  await slack().reactions.add({ channel, timestamp: ts, name }).catch(() => undefined);
}

export async function requesterName(userId: string): Promise<string> {
  const res = await slack().users.info({ user: userId });
  const profile = res.user?.profile;
  return profile?.display_name || profile?.real_name || res.user?.real_name || res.user?.name || userId;
}

let usersCache: { at: number; users: SlackUser[] } | null = null;

// Cached for 10 minutes so handle lookups do not hit users.list on every message.
export async function workspaceUsers(): Promise<SlackUser[]> {
  if (usersCache && Date.now() - usersCache.at < 10 * 60_000) return usersCache.users;
  const users: SlackUser[] = [];
  let cursor: string | undefined;
  do {
    const res = await slack().users.list({ cursor, limit: 200 });
    for (const m of res.members ?? []) {
      if (m.deleted || !m.id) continue;
      users.push({
        id: m.id,
        name: m.name ?? "",
        displayName: m.profile?.display_name ?? "",
        realName: m.real_name ?? m.profile?.real_name ?? "",
      });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  usersCache = { at: Date.now(), users };
  return users;
}
