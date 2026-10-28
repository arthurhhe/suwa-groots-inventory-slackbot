// Workbook service: load the sheet, check plans with the guard, commit them through a Graph
// session, and write the audit trail (BotLog) that powers undo.

import { randomUUID } from "node:crypto";
import { LowStockEvent, findLowStock } from "./alerts";
import { CellChange, Plan, evaluatePlan, Verdict, Limits } from "./guard";
import { appendLogRows, applyPlan, readGrid, readLogRows, sheetName, withSession } from "./graph";
import { planUndo, PlanResult } from "./plan";
import { Grid, Layout, resolveLayout, toAddress } from "./sheet";

export interface LoadedWorkbook {
  sheet: string;
  grid: Grid;
  layout: Layout;
}

export type LoadResult = { ok: true; workbook: LoadedWorkbook } | { ok: false; reason: string };

export async function loadWorkbook(): Promise<LoadResult> {
  const sheet = await sheetName();
  const grid = await readGrid(sheet);
  const resolved = resolveLayout(grid[1] ?? []);
  if (!resolved.ok) {
    const why =
      resolved.reason === "missing-threshold"
        ? 'I could not find a "Threshold" column in row 2.'
        : "I found more than one threshold-like column in row 2, so I cannot tell which one to use.";
    return { ok: false, reason: `${why} Please rename the column so there is one clear "Threshold" header.` };
  }
  return { ok: true, workbook: { sheet, grid, layout: resolved.layout } };
}

export function checkPlan(plan: Plan, workbook: LoadedWorkbook, limits: Limits): Verdict {
  return evaluatePlan(plan, { grid: workbook.grid, layout: workbook.layout, limits });
}

export interface CommitInput {
  plan: Plan;
  workbook: LoadedWorkbook;
  requester: string;
  requestText: string;
  batchId?: string;
}

export interface CommitOutput {
  batchId: string;
  after: Grid;
  alerts: LowStockEvent[];
}

// Caller must already have passed the plan through checkPlan (or the requester confirmed it).
export async function commitPlan(input: CommitInput): Promise<CommitOutput> {
  const { plan, workbook, requester, requestText } = input;
  const batchId = input.batchId ?? randomUUID();
  const timestamp = new Date().toISOString();

  await withSession((sessionId) => applyPlan(plan, workbook.sheet, sessionId));
  const after = await readGrid(workbook.sheet);

  const alerts = plan.structural.length === 0 ? findLowStock(workbook.grid, after, workbook.layout, plan.changes) : [];

  const rows = logRows(plan, { batchId, timestamp, requester, requestText });
  await appendLogRows(rows);

  return { batchId, after, alerts };
}

function logRows(plan: Plan, meta: { batchId: string; timestamp: string; requester: string; requestText: string }): string[][] {
  const common = [meta.timestamp, meta.batchId, safeText(meta.requester), safeText(meta.requestText), safeText(plan.summary)];
  const cellRows = plan.changes.map((c: CellChange) => [...common, toAddress(c.row, c.col), c.before, c.after]);
  const structuralRows = plan.structural.map(() => [...common, "", "", ""]);
  return [...cellRows, ...structuralRows];
}

// Stops spreadsheet formula injection through text the requester typed into the log.
function safeText(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

// Builds a plan that reverses the most recent batch recorded in BotLog.
export async function planUndoLastBatch(): Promise<PlanResult> {
  const rows = await readLogRows();
  if (rows.length === 0) return { ok: false, error: "Nothing to undo yet." };
  const lastBatch = rows[rows.length - 1][1];
  const entries = rows.filter((r) => r[1] === lastBatch);
  if (entries.some((r) => r[5] === "")) {
    return { ok: false, error: "The last change included a row or column insert or delete, which the bot cannot undo automatically." };
  }
  return planUndo(entries.map((r) => ({ address: r[5], before: r[6], after: r[7] })));
}
