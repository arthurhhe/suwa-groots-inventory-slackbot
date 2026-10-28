// Turns structured tool inputs into concrete Plans (cell changes + at most one structural op).
// Nothing here touches the network; lib/guard.ts decides whether a Plan may run.

import { CellChange, Plan } from "./guard";
import { CONFIG_ROW, Grid, ITEM_COL, HEADER_ROW, FIRST_DATA_ROW, cellAt, formatConfigCell, headerIndex, parseAddress, toAddress } from "./sheet";

export type PlanResult = { ok: true; plan: Plan } | { ok: false; error: string };

export function planSetCells(grid: Grid, cells: { address: string; value: string | number }[]): PlanResult {
  const changes: CellChange[] = [];
  for (const { address, value } of cells) {
    let row: number;
    let col: number;
    try {
      ({ row, col } = parseAddress(address));
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    changes.push({ row, col, before: cellAt(grid, row, col), after: String(value), via: "set_cells" });
  }
  return { ok: true, plan: { summary: describe(changes), changes, structural: [] } };
}

export function planAppendRow(grid: Grid, values: Record<string, string | number>): PlanResult {
  const row = grid.length;
  const changes: CellChange[] = [];
  for (const [header, value] of Object.entries(values)) {
    const col = headerIndex(grid, header);
    if (col === -1) return { ok: false, error: `No column named "${header}".` };
    changes.push({ row, col, before: "", after: String(value), via: "append_row" });
  }
  if (changes.length === 0) return { ok: false, error: "No values given for the new row." };
  return { ok: true, plan: { summary: `Add row ${row + 1}`, changes, structural: [] } };
}

export function planRenameColumn(grid: Grid, from: string, to: string): PlanResult {
  const col = headerIndex(grid, from);
  if (col === -1) return { ok: false, error: `No column named "${from}".` };
  const newName = to.trim();
  if (!newName) return { ok: false, error: "New column name cannot be empty." };
  const change: CellChange = { row: HEADER_ROW, col, before: cellAt(grid, HEADER_ROW, col), after: newName, via: "rename_column" };
  return { ok: true, plan: { summary: `Rename column "${from}" to "${newName}"`, changes: [change], structural: [] } };
}

export function planInsertColumn(grid: Grid, name: string, afterHeader?: string): PlanResult {
  const headers = grid[HEADER_ROW] ?? [];
  let index = headers.length;
  if (afterHeader) {
    const after = headerIndex(grid, afterHeader);
    if (after === -1) return { ok: false, error: `No column named "${afterHeader}".` };
    index = after + 1;
  }
  const change: CellChange = { row: HEADER_ROW, col: index, before: "", after: name.trim(), via: "insert_column" };
  return {
    ok: true,
    plan: {
      summary: `Add column "${name}"`,
      changes: [change],
      structural: [{ kind: "insertColumn", index }],
    },
  };
}

export function planDeleteColumn(grid: Grid, header: string): PlanResult {
  const index = headerIndex(grid, header);
  if (index === -1) return { ok: false, error: `No column named "${header}".` };
  return {
    ok: true,
    plan: {
      summary: `Delete column "${header}"`,
      changes: [],
      structural: [{ kind: "deleteColumn", index, name: header }],
    },
  };
}

export function planDeleteRow(grid: Grid, itemName: string): PlanResult {
  const target = itemName.trim().toLowerCase();
  let index = -1;
  for (let row = FIRST_DATA_ROW; row < grid.length; row++) {
    if (cellAt(grid, row, ITEM_COL).trim().toLowerCase() === target) {
      index = row;
      break;
    }
  }
  if (index === -1) return { ok: false, error: `No item named "${itemName}".` };
  return {
    ok: true,
    plan: {
      summary: `Delete item "${itemName}"`,
      changes: [],
      structural: [{ kind: "deleteRow", index, name: itemName }],
    },
  };
}

export function planSetConfig(grid: Grid, key: string, value: string): PlanResult {
  const normalized = key.trim().toLowerCase();
  const row = grid[CONFIG_ROW] ?? [];
  let col = row.findIndex((raw) => raw.includes(":") && raw.slice(0, raw.indexOf(":")).trim().toLowerCase() === normalized);
  if (col === -1) col = row.findIndex((raw) => raw.trim() === "");
  if (col === -1) col = row.length;
  const after = formatConfigCell(normalized, value.trim());
  const change: CellChange = { row: CONFIG_ROW, col, before: cellAt(grid, CONFIG_ROW, col), after, via: "set_config" };
  return { ok: true, plan: { summary: `Set ${normalized} to "${value.trim()}"`, changes: [change], structural: [] } };
}

// Reverse a logged batch. `entries` come from the BotLog sheet, newest batch first.
export function planUndo(entries: { address: string; before: string; after: string }[]): PlanResult {
  if (entries.length === 0) return { ok: false, error: "Nothing to undo." };
  const changes: CellChange[] = entries.map((e) => {
    const { row, col } = parseAddress(e.address);
    return { row, col, before: e.after, after: e.before, via: "undo" as const };
  });
  return { ok: true, plan: { summary: "Undo last change", changes, structural: [] } };
}

function describe(changes: CellChange[]): string {
  return changes.map((c) => `${toAddress(c.row, c.col)}: "${c.before}" -> "${c.after}"`).join("; ");
}
