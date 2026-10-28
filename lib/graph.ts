// Microsoft Graph client, app-only, scoped to ONE workbook.
// Auth is client-credentials. The app only has Files.SelectedOperations.Selected, and an admin
// has granted it write access to this single driveItem (see scripts/setup.ts), so every call
// here targets MS_DRIVE_ID / MS_ITEM_ID and nothing else in the tenant.

import { Plan, Structural, CellChange } from "./guard";
import { Grid, colLetter, parseNumber } from "./sheet";
import { requireEnv } from "./config";

const GRAPH = "https://graph.microsoft.com/v1.0";

let tokenCache: { token: string; expiresAt: number } | null = null;

export async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const body = new URLSearchParams({
    client_id: requireEnv("MS_CLIENT_ID"),
    client_secret: requireEnv("MS_CLIENT_SECRET"),
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(`https://login.microsoftonline.com/${requireEnv("MS_TENANT_ID")}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Microsoft token request failed (${res.status}): ${json.error_description ?? json.error}`);
  tokenCache = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

interface GraphOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function graph<T = unknown>(path: string, opts: GraphOptions = {}): Promise<T> {
  const res = await fetch(`${GRAPH}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph ${opts.method ?? "GET"} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function workbookBase(): string {
  return `/drives/${requireEnv("MS_DRIVE_ID")}/items/${requireEnv("MS_ITEM_ID")}/workbook`;
}

let sheetNameCache: string | null = null;

export async function sheetName(): Promise<string> {
  if (sheetNameCache) return sheetNameCache;
  const configured = process.env.WORKSHEET_NAME;
  if (configured) {
    sheetNameCache = configured;
    return configured;
  }
  const res = await graph<{ value: { name: string }[] }>(`${workbookBase()}/worksheets?$select=name&$orderby=position`);
  sheetNameCache = res.value[0].name;
  return sheetNameCache;
}

function sheetRef(name: string): string {
  return `${workbookBase()}/worksheets('${name.replace(/'/g, "''")}')`;
}

// Reads the used range anchored at A1, so grid[0][0] is always cell A1.
export async function readGrid(name?: string): Promise<Grid> {
  const sheet = name ?? (await sheetName());
  const res = await graph<{ address: string; values: string[][] }>(
    `${sheetRef(sheet)}/usedRange(valuesOnly=true)?$select=address,values`,
  );
  const start = /!([A-Za-z]+)(\d+)(?::|$)/.exec(res.address);
  const startCol = start ? colIndex(start[1]) : 0;
  const startRow = start ? Number(start[2]) - 1 : 0;
  const grid: Grid = Array.from({ length: startRow }, () => []);
  for (const row of res.values) {
    grid.push([...Array.from({ length: startCol }, () => ""), ...row.map((v) => String(v ?? ""))]);
  }
  return grid;
}

export async function listSheetNames(): Promise<string[]> {
  const res = await graph<{ value: { name: string }[] }>(`${workbookBase()}/worksheets?$select=name`);
  return res.value.map((s) => s.name);
}

export async function ensureSheet(name: string): Promise<void> {
  if ((await listSheetNames()).includes(name)) return;
  await graph(`${workbookBase()}/worksheets`, { method: "POST", body: { name } });
}

// Runs fn inside a workbook session so the batch is applied as one persisted unit.
export async function withSession<T>(fn: (sessionId: string) => Promise<T>): Promise<T> {
  const session = await graph<{ id: string }>(`${workbookBase()}/createSession`, {
    method: "POST",
    body: { persistChanges: true },
  });
  try {
    return await fn(session.id);
  } finally {
    await graph(`${workbookBase()}/closeSession`, {
      method: "POST",
      headers: { "workbook-session-id": session.id },
    }).catch(() => undefined);
  }
}

export async function applyPlan(plan: Plan, sheet: string, sessionId: string): Promise<void> {
  const headers = { "workbook-session-id": sessionId, "content-type": "application/json" };
  const ref = sheetRef(sheet);
  for (const op of plan.structural) await applyStructural(op, ref, headers);
  for (const change of plan.changes) await applyCell(change, ref, headers);
}

async function applyStructural(op: Structural, ref: string, headers: Record<string, string>): Promise<void> {
  if (op.kind === "insertColumn") {
    const col = colLetter(op.index);
    await graph(`${ref}/range(address='${col}:${col}')/insert`, { method: "POST", body: { shift: "Right" }, headers });
  } else if (op.kind === "deleteColumn") {
    const col = colLetter(op.index);
    await graph(`${ref}/range(address='${col}:${col}')/delete`, { method: "POST", body: { shift: "Left" }, headers });
  } else {
    const row = op.index + 1;
    await graph(`${ref}/range(address='${row}:${row}')/delete`, { method: "POST", body: { shift: "Up" }, headers });
  }
}

async function applyCell(change: CellChange, ref: string, headers: Record<string, string>): Promise<void> {
  const address = `${colLetter(change.col)}${change.row + 1}`;
  const num = parseNumber(change.after);
  const value = num !== null && change.after.trim() !== "" ? num : change.after;
  await graph(`${ref}/range(address='${address}')`, {
    method: "PATCH",
    body: { values: [[value]] },
    headers,
  });
}

function colIndex(letters: string): number {
  let col = 0;
  for (const ch of letters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col - 1;
}

export const BOT_LOG_SHEET = "BotLog";
export const BOT_LOG_HEADERS = ["timestamp", "batchId", "requester", "request", "summary", "address", "before", "after"];

// BotLog holds one row per changed cell: the audit trail and the source for undo.
export async function initBotLogIfEmpty(): Promise<void> {
  await ensureSheet(BOT_LOG_SHEET);
  const grid = await readGrid(BOT_LOG_SHEET);
  if (grid.length === 0 || grid[0].join("|") !== BOT_LOG_HEADERS.join("|")) {
    await graph(`${sheetRef(BOT_LOG_SHEET)}/range(address='A1:H1')`, {
      method: "PATCH",
      body: { values: [BOT_LOG_HEADERS] },
    });
  }
}

export async function appendLogRows(rows: string[][]): Promise<void> {
  await initBotLogIfEmpty();
  const existing = await readGrid(BOT_LOG_SHEET);
  const start = existing.length + 1;
  const endRow = start + rows.length - 1;
  await graph(`${sheetRef(BOT_LOG_SHEET)}/range(address='A${start}:H${endRow}')`, {
    method: "PATCH",
    body: { values: rows },
  });
}

export async function readLogRows(): Promise<string[][]> {
  await initBotLogIfEmpty();
  const grid = await readGrid(BOT_LOG_SHEET);
  return grid.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
}
