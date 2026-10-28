// Write safeguards. Every change to the workbook passes through evaluatePlan before it
// reaches Microsoft Graph, no matter what the model asked for. The model has no delete-range
// tool at all; deletions are single structural operations that always require confirmation.

import { CONFIG_ROW, HEADER_ROW, ITEM_COL, Grid, Layout, parseNumber } from "./sheet";

export type WriteVia = "set_cells" | "append_row" | "rename_column" | "set_config" | "insert_column" | "undo";

export interface CellChange {
  row: number;
  col: number;
  before: string;
  after: string;
  via: WriteVia;
}

export type Structural =
  | { kind: "insertColumn"; index: number }
  | { kind: "deleteColumn"; index: number; name: string }
  | { kind: "deleteRow"; index: number; name: string };

export interface Plan {
  summary: string;
  changes: CellChange[];
  structural: Structural[];
}

export interface Limits {
  maxCells: number;
  confirmAboveUnits: number;
  confirmRatio: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxCells: 10,
  confirmAboveUnits: 1000,
  confirmRatio: 10,
};

export type Verdict =
  | { status: "ok" }
  | { status: "confirm"; reasons: string[] }
  | { status: "reject"; reason: string };

export interface GuardContext {
  grid: Grid;
  layout: Layout;
  limits: Limits;
}

export function evaluatePlan(plan: Plan, ctx: GuardContext): Verdict {
  const { grid, layout, limits } = ctx;
  const headerWidth = (grid[HEADER_ROW] ?? []).length;
  const reasons: string[] = [];

  if (plan.changes.length > limits.maxCells) {
    return { status: "reject", reason: `Too many cells in one request (max ${limits.maxCells}).` };
  }
  if (plan.structural.length > 1) {
    return { status: "reject", reason: "Only one row or column can be changed structurally per request." };
  }

  for (const op of plan.structural) {
    if (op.kind === "insertColumn") continue;
    if (op.kind === "deleteColumn" && (op.index === ITEM_COL || op.index === layout.thresholdCol)) {
      return { status: "reject", reason: "The item and threshold columns cannot be deleted." };
    }
    if (op.kind === "deleteRow" && op.index <= HEADER_ROW) {
      return { status: "reject", reason: "The config and header rows cannot be deleted." };
    }
    reasons.push(`Delete ${op.kind === "deleteRow" ? `row for "${op.name}"` : `column "${op.name}"`}`);
  }

  for (const change of plan.changes) {
    if (change.row < 0 || change.col < 0) {
      return { status: "reject", reason: "Invalid cell address." };
    }
    if (/^\s*[=+@]/.test(change.after)) {
      // A leading = (or + / @) makes Excel evaluate the value as a formula.
      return { status: "reject", reason: "Formulas are not allowed in inventory cells." };
    }
    if (change.row > grid.length || change.col > headerWidth) {
      return { status: "reject", reason: "Writes must stay inside the sheet or add one new row or column." };
    }
    if (change.row === CONFIG_ROW && change.via !== "set_config" && change.via !== "undo") {
      return { status: "reject", reason: "Row 1 is bot config. Use the config tool instead." };
    }
    if (change.row === HEADER_ROW && change.via !== "rename_column" && change.via !== "insert_column" && change.via !== "undo") {
      return { status: "reject", reason: "Header names change through the rename or insert column tools." };
    }
    if (change.row === CONFIG_ROW || change.row === HEADER_ROW) continue;

    const after = change.after.trim();
    const before = change.before.trim();

    if (change.via === "set_cells" && change.col === ITEM_COL) {
      if (after === "") return { status: "reject", reason: "Item names cannot be blanked." };
      reasons.push(`Rename item "${before}" to "${after}"`);
      continue;
    }
    if (change.via === "set_cells" && change.col === layout.thresholdCol) {
      reasons.push(`Change threshold from ${before || "blank"} to ${after || "blank"}`);
      continue;
    }
    if (change.col === ITEM_COL || change.col === layout.thresholdCol) continue;

    if (after === "") {
      reasons.push(`Clear a quantity (was ${before || "blank"})`);
      continue;
    }
    const newQty = parseNumber(after);
    if (newQty === null) {
      return { status: "reject", reason: `Quantities must be numbers; "${after}" is not one.` };
    }
    if (newQty < 0) reasons.push(`Result would be negative (${newQty})`);
    const oldQty = parseNumber(before);
    if (oldQty !== null) {
      const delta = Math.abs(newQty - oldQty);
      if (delta > limits.confirmAboveUnits) {
        reasons.push(`Large change of ${delta} units (limit ${limits.confirmAboveUnits})`);
      }
      if (oldQty > 0 && newQty / oldQty > limits.confirmRatio) {
        reasons.push(`Quantity would grow more than ${limits.confirmRatio}x (from ${oldQty} to ${newQty})`);
      }
    }
  }

  return reasons.length > 0 ? { status: "confirm", reasons } : { status: "ok" };
}
