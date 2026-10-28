// Interactive setup: checks prerequisites, collects credentials, validates them live, performs
// the one-time admin grant that scopes the app to a single workbook, and writes .env.local.
// Run with: npm run setup

import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadEnvFile, readEnvFile, writeEnvFile } from "./lib/env";
import * as checks from "./lib/checks";
import { accessToken } from "../lib/graph";

const PREREQUISITES = `
Before you start, have these ready. Each item says what it is, what it needs, and where to get it.

1. Slack workspace (paid plan) and a channel for inventory, e.g. #inventory.
   - Create the app: https://api.slack.com/apps → Create New App → From a manifest → paste slack-manifest.yaml.
     Replace the request URL placeholder after you deploy (step 3 below).
   - Upload the bot icon: Basic Information → Display Information → App icon → clippy.jpg (repo root; must be at least 512x512).
   - Install to Workspace, then copy the Bot User OAuth Token (xoxb-…) and the Signing Secret (Basic Information).
   - Get the channel ID: open the channel → channel name → About → bottom of the panel.
   - Scopes the manifest requests: chat:write, channels:history, reactions:write, users:read.

2. Anthropic API key. https://console.anthropic.com → add prepaid credit (about $5) → API keys.
   Claude.ai subscriptions do not include API access.

3. Microsoft 365 business tenant and an Entra ID app registration (https://entra.microsoft.com → App registrations → New registration, single tenant).
   - Copy the Tenant ID, Application (client) ID, and create a client secret (Certificates & secrets).
   - API permissions → Add → Microsoft Graph → Application permissions → Files.SelectedOperations.Selected. Do NOT add any other Graph permission.
   - An admin must then grant consent once (this script prints the link).

4. A Microsoft 365 admin account for the one-time grant. The admin signs in once through this script and approves the Microsoft Graph Command Line Tools app. That token is used for one call (granting the bot write access to the one workbook) and is discarded. It is never saved.

5. The inventory workbook (.xlsx) uploaded to OneDrive for Business or a SharePoint library. Run "npm run make-template" to get a starter file.

6. Vercel account (Hobby is free; see README for the terms caveat) and an Upstash Redis database from Vercel Marketplace → Storage. Copy its REST URL and token.
`;

interface Prompt {
  key: string;
  label: string;
  optional?: boolean;
}

const PROMPTS: Prompt[] = [
  { key: "SLACK_BOT_TOKEN", label: "Slack bot token (xoxb-…)" },
  { key: "SLACK_SIGNING_SECRET", label: "Slack signing secret" },
  { key: "SLACK_CHANNEL_ID", label: "Slack channel ID (e.g. C0123456789)" },
  { key: "ANTHROPIC_API_KEY", label: "Anthropic API key (sk-ant-…)" },
  { key: "MS_TENANT_ID", label: "Entra tenant ID" },
  { key: "MS_CLIENT_ID", label: "Entra application (client) ID" },
  { key: "MS_CLIENT_SECRET", label: "Entra client secret" },
  { key: "KV_REST_API_URL", label: "Upstash Redis REST URL" },
  { key: "KV_REST_API_TOKEN", label: "Upstash Redis REST token" },
  { key: "WORKSHEET_NAME", label: "Worksheet name (blank = first sheet)", optional: true },
];

// Microsoft Graph Command Line Tools, a Microsoft-owned public client used for the admin's one-time sign-in.
const GRAPH_CLI_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";

async function main(): Promise<void> {
  loadEnvFile();
  const rl = readline.createInterface({ input, output });
  try {
    console.log(PREREQUISITES);
    await rl.question("Press Enter when you have these ready.");

    const existing = { ...process.env, ...readEnvFile() } as Record<string, string>;
    const values: Record<string, string> = {};
    console.log("\nEnter each value. Press Enter to keep the value already in .env.local.\n");
    for (const prompt of PROMPTS) {
      const current = existing[prompt.key];
      const shown = current ? " [keep current]" : prompt.optional ? " [optional]" : "";
      const answer = (await rl.question(`${prompt.label}${shown}: `)).trim();
      const value = answer || current || "";
      if (!value && !prompt.optional) throw new Error(`${prompt.key} is required.`);
      values[prompt.key] = value;
    }
    writeEnvFile(values);

    console.log("\nChecking the accounts...");
    const first = [await checks.checkSlack(), await checks.checkAnthropic(), await checks.checkRedis()];
    if (!checks.printResults(first)) throw new Error("Fix the failing checks above, then run npm run setup again.");

    const clientId = values.MS_CLIENT_ID;
    const tenant = values.MS_TENANT_ID;
    console.log(`
Admin consent (one time). Open this link as a tenant admin and approve the app:

  https://login.microsoftonline.com/${tenant}/adminconsent?client_id=${clientId}
`);
    await rl.question("Press Enter after the admin has consented.");

    const workbookLink = (await rl.question("\nPaste the sharing link to the inventory workbook: ")).trim();
    console.log("\nAdmin sign-in for the one-time grant. Follow the code prompt below.");
    const grant = await grantSingleFile(tenant, clientId, workbookLink);
    writeEnvFile({ MS_DRIVE_ID: grant.driveId, MS_ITEM_ID: grant.itemId });
    console.log(`Granted write access to "${grant.name}" only. Admin token discarded.\n`);

    const second = [await checks.checkMicrosoftToken(), await checks.checkWorkbookReadable(), await checks.checkWorkbookLayout()];
    const otherLink = (await rl.question("Optional: paste a link to a DIFFERENT file to confirm it is refused (Enter to skip): ")).trim();
    if (otherLink) {
      const other = await resolveItemId(otherLink);
      if (other) second.push(await checks.checkSingleFileScope(other));
    }
    const allOk = checks.printResults([...first, ...second]);

    const pushed = await maybePushToVercel(rl);
    console.log(`
Next steps:
  1. Deploy: vercel --prod (or push the repo and import it in Vercel).
  2. In Slack: app settings → Event Subscriptions → Request URL = https://<your-deployment>/api/slack/events
     Slack verifies the URL. Then Subscribe to bot events → message.channels, and Save.
  3. Invite the bot to the channel: /invite @<bot name>
  4. Add the variables from .env.local to Vercel if you did not push them above.
  5. Put the recipients in the workbook: cell A1 of the sheet, e.g. "low-inventory-slack-ids-to-tag: @dana, @lee".
`);
    if (!allOk) console.log("Some checks failed. Run npm run doctor after fixing them.");
    if (!pushed) console.log("Env vars were not pushed to Vercel automatically.");
  } finally {
    rl.close();
  }
}

// Resolves a sharing link to a driveItem ID using the app's own token (no admin needed for this read).
async function resolveItemId(link: string): Promise<string | null> {
  try {
    const res = await fetch(`https://graph.microsoft.com/v1.0/shares/${encodeShareUrl(link)}/driveItem?$select=id`, {
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    if (!res.ok) return null;
    return (await res.json()).id ?? null;
  } catch {
    return null;
  }
}

function encodeShareUrl(url: string): string {
  const b64 = Buffer.from(url).toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  return `u!${b64}`;
}

// Device-code sign-in as an admin, used once to grant the app write access to one driveItem.
// The returned token lives only in this function.
async function grantSingleFile(tenant: string, clientId: string, link: string): Promise<{ driveId: string; itemId: string; name: string }> {
  const adminToken = await adminDeviceLogin(tenant);
  const adminGraph = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      ...init,
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`Graph ${init.method ?? "GET"} ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  };

  const item = await adminGraph<{ id: string; name: string; parentReference: { driveId: string } }>(
    `/shares/${encodeShareUrl(link)}/driveItem?$select=id,name,parentReference`,
  );
  await adminGraph(`/drives/${item.parentReference.driveId}/items/${item.id}/permissions`, {
    method: "POST",
    body: JSON.stringify({
      roles: ["write"],
      grantedToIdentitiesV2: [{ application: { id: clientId, displayName: "Inventory Slack Bot" } }],
    }),
  });
  return { driveId: item.parentReference.driveId, itemId: item.id, name: item.name };
}

async function adminDeviceLogin(tenant: string): Promise<string> {
  const base = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
  const start = await fetch(`${base}/devicecode`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GRAPH_CLI_CLIENT_ID, scope: "Files.ReadWrite.All Sites.Read.All" }),
  }).then((r) => r.json());
  if (!start.device_code) throw new Error(`Device sign-in could not start: ${start.error_description ?? start.error}`);
  console.log(start.message);

  let interval = (start.interval ?? 5) * 1000;
  const deadline = Date.now() + start.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const poll = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: GRAPH_CLI_CLIENT_ID,
        device_code: start.device_code,
      }),
    }).then((r) => r.json());
    if (poll.access_token) return poll.access_token;
    if (poll.error === "slow_down") interval += 5000;
    else if (poll.error !== "authorization_pending") throw new Error(`Admin sign-in failed: ${poll.error_description ?? poll.error}`);
  }
  throw new Error("Admin sign-in timed out. Run npm run setup again.");
}

// Pushes each variable to Vercel's production environment if the Vercel CLI is installed and logged in.
async function maybePushToVercel(rl: readline.Interface): Promise<boolean> {
  const answer = (await rl.question("\nPush these variables to Vercel production with the Vercel CLI? [y/N]: ")).trim().toLowerCase();
  if (answer !== "y") return false;
  for (const [key, value] of Object.entries(readEnvFile())) {
    const res = spawnSync("npx", ["--yes", "vercel", "env", "add", key, "production"], {
      input: `${value}\n`,
      encoding: "utf8",
    });
    const ok = res.status === 0;
    console.log(`${ok ? "✅" : "❌"} ${key}${ok ? "" : `: ${res.stderr.trim().split("\n").pop()}`}`);
  }
  return true;
}

main().catch((err) => {
  console.error(`\n❌ ${(err as Error).message}`);
  process.exit(1);
});
