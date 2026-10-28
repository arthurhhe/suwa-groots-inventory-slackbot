// Deterministic low-inventory check. Runs in code, never in the model.
// Fires for a region cell when it is at or below the item's threshold AND this update either
// crossed the threshold (was above, now at/below) or decreased while already at/below.
// Pure increases and unchanged cells never alert.

import { CellChange } from "./guard";
import { Grid, Layout, readItems } from "./sheet";

export interface LowStockEvent {
  item: string;
  region: string;
  quantity: number;
  previous: number | null;
  threshold: number;
}

export function findLowStock(before: Grid, after: Grid, layout: Layout, changes: CellChange[]): LowStockEvent[] {
  const oldItems = new Map(readItems(before, layout).map((i) => [i.row, i]));
  const newItems = readItems(after, layout);
  const newByRow = new Map(newItems.map((i) => [i.row, i]));
  const events: LowStockEvent[] = [];
  const seen = new Set<string>();

  for (const change of changes) {
    const item = newByRow.get(change.row);
    const region = layout.regions.find((r) => r.col === change.col);
    if (!item || !region || item.threshold === null) continue;
    const key = `${item.row}:${region.col}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const quantity = item.quantities[region.col];
    if (quantity === null || quantity === undefined) continue;
    const previous = oldItems.get(change.row)?.quantities[region.col] ?? null;
    const threshold = item.threshold;
    if (quantity > threshold) continue;

    const crossed = previous !== null && previous > threshold;
    const decreasedWhileLow = previous !== null && previous <= threshold && quantity < previous;
    if (crossed || decreasedWhileLow) {
      events.push({ item: item.name, region: region.name, quantity, previous, threshold });
    }
  }
  return events;
}
