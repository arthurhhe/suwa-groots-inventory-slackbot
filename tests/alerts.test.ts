import { describe, expect, it } from "vitest";
import { findLowStock } from "../lib/alerts";
import { CellChange } from "../lib/guard";
import { Grid, resolveLayout } from "../lib/sheet";

const headers = ["Item", "Threshold", "West Coast", "East Coast"];
const resolved = resolveLayout(headers);
if (!resolved.ok) throw new Error("layout should resolve");
const layout = resolved.layout;

function sheet(eastCoast: string, westCoast = "50"): Grid {
  return [
    ["low-inventory-slack-ids-to-tag: @dana", "", ""],
    headers,
    ["Bolts", "10", westCoast, eastCoast],
  ];
}

function change(col: number, before: string, after: string): CellChange {
  return { row: 2, col, before, after, via: "set_cells" };
}

describe("findLowStock", () => {
  it("alerts when a region crosses down through the threshold", () => {
    const before = sheet("12");
    const after = sheet("8");
    const events = findLowStock(before, after, layout, [change(3, "12", "8")]);
    expect(events).toEqual([{ item: "Bolts", region: "East Coast", quantity: 8, previous: 12, threshold: 10 }]);
  });

  it("alerts when a cell lands exactly on the threshold", () => {
    const events = findLowStock(sheet("12"), sheet("10"), layout, [change(3, "12", "10")]);
    expect(events).toHaveLength(1);
  });

  it("alerts again when an already-low region decreases further", () => {
    const events = findLowStock(sheet("6"), sheet("4"), layout, [change(3, "6", "4")]);
    expect(events).toHaveLength(1);
  });

  it("does not alert on a pure increase, even if still low", () => {
    expect(findLowStock(sheet("3"), sheet("5"), layout, [change(3, "3", "5")])).toEqual([]);
  });

  it("does not alert when the region stays comfortably above threshold", () => {
    expect(findLowStock(sheet("30"), sheet("25"), layout, [change(3, "30", "25")])).toEqual([]);
  });

  it("ignores changes to other regions even if they are low", () => {
    const before = sheet("30", "12");
    const after = sheet("30", "8");
    expect(findLowStock(before, after, layout, [change(3, "30", "30")])).toEqual([]);
  });

  it("ignores cells that were not part of this update", () => {
    const before = sheet("12", "12");
    const after = sheet("12", "8");
    expect(findLowStock(before, after, layout, [change(2, "12", "8")])).toHaveLength(1);
    expect(findLowStock(before, after, layout, [change(2, "12", "8")])[0].region).toBe("West Coast");
  });
});
