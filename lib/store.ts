// Redis (Upstash) state: Slack event dedupe, per-thread conversation state, and a lock so two
// messages cannot change the workbook at the same time.

import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";
import type { Plan } from "./guard";
import { requireEnv } from "./config";

export interface ThreadState {
  requester: string;
  requesterName: string;
  messages: unknown[]; // Anthropic MessageParam[], kept as JSON
  pendingPlan?: Plan;
}

let redis: Redis | null = null;
function db(): Redis {
  return (redis ??= new Redis({ url: requireEnv("KV_REST_API_URL"), token: requireEnv("KV_REST_API_TOKEN") }));
}

const THREAD_TTL_SECONDS = 60 * 60;

// Slack retries events; the first claim wins.
export async function claimEvent(eventId: string): Promise<boolean> {
  const res = await db().set(`evt:${eventId}`, 1, { nx: true, ex: 60 * 60 });
  return res === "OK";
}

export function threadKey(channel: string, threadTs: string): string {
  return `thread:${channel}:${threadTs}`;
}

export async function loadThread(key: string): Promise<ThreadState | null> {
  return db().get<ThreadState>(key);
}

export async function saveThread(key: string, state: ThreadState): Promise<void> {
  await db().set(key, state, { ex: THREAD_TTL_SECONDS });
}

// Serializes workbook work across concurrent Slack messages.
export async function withWorkbookLock<T>(fn: () => Promise<T>): Promise<T> {
  const key = "lock:workbook";
  const token = randomUUID();
  for (let attempt = 0; attempt < 60; attempt++) {
    const acquired = await db().set(key, token, { nx: true, ex: 120 });
    if (acquired === "OK") {
      try {
        return await fn();
      } finally {
        if ((await db().get<string>(key)) === token) await db().del(key);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for the workbook lock. Another update is still running; try again.");
}
