// Live validation of each account and permission. Shared by `npm run setup` and `npm run doctor`.

import { Redis } from "@upstash/redis";
import { accessToken, readGrid, sheetName } from "../../lib/graph";
import { loadWorkbook } from "../../lib/workbook";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function run(name: string, requires: string[], fn: () => Promise<string>): Promise<CheckResult> {
  const missing = requires.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    return { name, ok: false, detail: `not configured yet (missing ${missing.join(", ")})` };
  }
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    return { name, ok: false, detail: (err as Error).message };
  }
}

export function checkSlack(): Promise<CheckResult> {
  return run("Slack bot token", ["SLACK_BOT_TOKEN"], async () => {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`auth.test said ${json.error}`);
    return `bot ${json.user} in workspace ${json.team}`;
  });
}

export function checkAnthropic(): Promise<CheckResult> {
  return run("Anthropic API key", ["ANTHROPIC_API_KEY"], async () => {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) throw new Error(`models list returned ${res.status}; check the key and that credit is available`);
    return "key accepted";
  });
}

const MS_APP = ["MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET"];
const WORKBOOK = [...MS_APP, "MS_DRIVE_ID", "MS_ITEM_ID"];

export function checkMicrosoftToken(): Promise<CheckResult> {
  return run("Entra app sign-in (client credentials)", MS_APP, async () => {
    await accessToken();
    return "token issued";
  });
}

export function checkWorkbookReadable(): Promise<CheckResult> {
  return run("Workbook readable by the app", WORKBOOK, async () => {
    const sheet = await sheetName();
    const grid = await readGrid(sheet);
    return `sheet "${sheet}" has ${grid.length} rows`;
  });
}

export function checkWorkbookLayout(): Promise<CheckResult> {
  return run("Workbook layout (row 2 has a Threshold column)", WORKBOOK, async () => {
    const loaded = await loadWorkbook();
    if (!loaded.ok) throw new Error(loaded.reason);
    const regions = loaded.workbook.layout.regions.map((r) => r.name).join(", ") || "none yet";
    return `threshold in column ${loaded.workbook.layout.thresholdCol + 1}; regions: ${regions}`;
  });
}

export function checkRedis(): Promise<CheckResult> {
  return run("Upstash Redis", ["KV_REST_API_URL", "KV_REST_API_TOKEN"], async () => {
    const redis = new Redis({ url: process.env.KV_REST_API_URL ?? "", token: process.env.KV_REST_API_TOKEN ?? "" });
    const pong = await redis.ping();
    return `ping: ${pong}`;
  });
}

// Confirms the app cannot reach a second file: a read of an unrelated item must fail with 404.
export function checkSingleFileScope(otherItemId: string): Promise<CheckResult> {
  return run("Single-file scope (unrelated file is refused)", WORKBOOK, async () => {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${process.env.MS_DRIVE_ID}/items/${otherItemId}/workbook/worksheets`,
      { headers: { authorization: `Bearer ${await accessToken()}` } },
    );
    if (res.ok) throw new Error("the app can read the other file; the grant is too broad");
    return `refused with ${res.status}, as expected`;
  });
}

export function printResults(results: CheckResult[]): boolean {
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}: ${r.detail}`);
  }
  return results.every((r) => r.ok);
}
