// Pure helpers for the inventory worksheet. A Grid is 0-based [row][col], anchored at A1.
// Layout convention (see README):
//   row 1  -> bot config, "key: value" per cell
//   row 2  -> headers: Item | Threshold | <region> | <region> | ...
//   row 3+ -> one item per row; column A is the item name

export type Grid = string[][];

export interface ConfigEntry {
  key: string;
  value: string;
  col: number;
}

export interface Region {
  name: string;
  col: number;
}

export interface Layout {
  thresholdCol: number;
  regions: Region[];
}

export interface Item {
  row: number;
  name: string;
  threshold: number | null;
  quantities: Record<number, number | null>;
}

export const ITEM_COL = 0;
export const CONFIG_ROW = 0;
export const HEADER_ROW = 1;
export const FIRST_DATA_ROW = 2;

export function colLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function parseAddress(address: string): { row: number; col: number } {
  const match = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(address.trim());
  if (!match) throw new Error(`Invalid cell address: ${address}`);
  let col = 0;
  for (const ch of match[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(match[2]) - 1, col: col - 1 };
}

export function toAddress(row: number, col: number): string {
  return `${colLetter(col)}${row + 1}`;
}

export function cellAt(grid: Grid, row: number, col: number): string {
  return grid[row]?.[col] ?? "";
}

export function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function parseConfig(grid: Grid): Record<string, ConfigEntry> {
  const entries: Record<string, ConfigEntry> = {};
  const row = grid[CONFIG_ROW] ?? [];
  row.forEach((raw, col) => {
    const idx = raw.indexOf(":");
    if (idx === -1) return;
    const key = raw.slice(0, idx).trim().toLowerCase();
    if (!key) return;
    entries[key] = { key, value: raw.slice(idx + 1).trim(), col };
  });
  return entries;
}

export function formatConfigCell(key: string, value: string): string {
  return `${key}: ${value}`;
}

// "@abc, @xyz" -> ["abc", "xyz"]
export function parseRecipients(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/^@/, ""))
    .filter(Boolean);
}

export function headerIndex(grid: Grid, name: string): number {
  const target = name.trim().toLowerCase();
  return (grid[HEADER_ROW] ?? []).findIndex((h) => h.trim().toLowerCase() === target);
}

const THRESHOLD_NAMES = ["threshold", "min", "reorder point", "reorder"];

export type LayoutResult =
  | { ok: true; layout: Layout }
  | { ok: false; reason: "missing-threshold" | "ambiguous-threshold" };

// Deterministic layout from the header row. When the threshold header has an unexpected
// name the caller may ask the model to identify it (see lib/columns.ts) and pass the index back.
export function resolveLayout(headers: string[], thresholdColOverride?: number): LayoutResult {
  const norm = headers.map((h) => h.trim().toLowerCase());
  let thresholdCol = thresholdColOverride ?? -1;
  if (thresholdCol === -1) {
    const exact = norm.findIndex((h, i) => i > ITEM_COL && h === "threshold");
    if (exact !== -1) thresholdCol = exact;
  }
  if (thresholdCol === -1) {
    const hits = norm.reduce<number[]>((acc, h, i) => {
      if (i > ITEM_COL && THRESHOLD_NAMES.includes(h)) acc.push(i);
      return acc;
    }, []);
    if (hits.length === 0) return { ok: false, reason: "missing-threshold" };
    if (hits.length > 1) return { ok: false, reason: "ambiguous-threshold" };
    thresholdCol = hits[0];
  }
  const regions: Region[] = [];
  headers.forEach((h, col) => {
    if (col === ITEM_COL || col === thresholdCol) return;
    const name = h.trim();
    if (name) regions.push({ name, col });
  });
  return { ok: true, layout: { thresholdCol, regions } };
}

export function readItems(grid: Grid, layout: Layout): Item[] {
  const items: Item[] = [];
  for (let row = FIRST_DATA_ROW; row < grid.length; row++) {
    const name = cellAt(grid, row, ITEM_COL).trim();
    if (!name) continue;
    const quantities: Record<number, number | null> = {};
    for (const region of layout.regions) {
      quantities[region.col] = parseNumber(cellAt(grid, row, region.col));
    }
    items.push({
      row,
      name,
      threshold: parseNumber(cellAt(grid, row, layout.thresholdCol)),
      quantities,
    });
  }
  return items;
}

// Compact CSV-style view for the model, with row numbers so it can address cells precisely.
export function formatForModel(grid: Grid): string {
  const width = Math.max(0, ...grid.map((r) => r.length));
  const header = ["row", ...Array.from({ length: width }, (_, c) => colLetter(c))].join(",");
  const lines = grid.map((cells, r) => {
    const fields = [String(r + 1), ...Array.from({ length: width }, (_, c) => csvField(cells[c] ?? ""))];
    return fields.join(",");
  });
  return [header, ...lines].join("\n");
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
