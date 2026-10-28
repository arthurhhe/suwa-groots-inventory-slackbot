import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, Plan, evaluatePlan } from "../lib/guard";
import { planAppendRow, planDeleteColumn, planDeleteRow, planInsertColumn, planRenameColumn, planSetCells, planSetConfig, planUndo } from "../lib/plan";
import { Grid, resolveLayout } from "../lib/sheet";

const grid: Grid = [
  ["low-inventory-slack-ids-to-tag: @dana", "", ""],
  ["Item", "Threshold", "West Coast", "East Coast"],
  ["Bolts", "10", "50", "3"],
  ["Widgets", "5", "20", "7"],
];
const resolved = resolveLayout(grid[1]);
if (!resolved.ok) throw new Error("layout should resolve");
const ctx = { grid, layout: resolved.layout, limits: DEFAULT_LIMITS };

function ok(result: ReturnType<typeof planSetCells>): Plan {
  if (!result.ok) throw new Error(result.error);
  return result.plan;
}

describe("evaluatePlan: writes", () => {
  it("allows a normal region update with no confirmation", () => {
    const plan = ok(planSetCells(grid, [{ address: "D3", value: 2 }]));
    expect(evaluatePlan(plan, ctx)).toEqual({ status: "ok" });
  });

  it("rejects more cells than the per-request maximum", () => {
    const cells = Array.from({ length: 11 }, (_, i) => ({ address: `C${i + 3}`, value: 1 }));
    expect(evaluatePlan(ok(planSetCells(grid, cells)), ctx).status).toBe("reject");
  });

  it("rejects writes to row 1 or the header row outside their dedicated tools", () => {
    expect(evaluatePlan(ok(planSetCells(grid, [{ address: "B1", value: "x" }])), ctx).status).toBe("reject");
    expect(evaluatePlan(ok(planSetCells(grid, [{ address: "C2", value: "Midwest" }])), ctx).status).toBe("reject");
  });

  it("rejects blanking an item name but confirms renaming one", () => {
    expect(evaluatePlan(ok(planSetCells(grid, [{ address: "A3", value: "" }])), ctx).status).toBe("reject");
    expect(evaluatePlan(ok(planSetCells(grid, [{ address: "A3", value: "Bolt" }])), ctx).status).toBe("confirm");
  });

  it("requires confirmation for a negative result and rejects non-numeric quantities", () => {
    expect(evaluatePlan(ok(planSetCells(grid, [{ address: "D3", value: -1 }])), ctx).status).toBe("confirm");
    expect(evaluatePlan(ok(planSetCells(grid, [{ address: "D3", value: "lots" }])), ctx).status).toBe("reject");
  });

  it("requires confirmation for a very large change or a jump over the ratio limit", () => {
    expect(evaluatePlan(ok(planSetCells(grid, [{ address: "C3", value: 5000 }])), ctx).status).toBe("confirm");
    expect(evaluatePlan(ok(planSetCells(grid, [{ address: "D4", value: 200 }])), ctx).status).toBe("confirm");
  });

  it("requires confirmation to change the threshold", () => {
    expect(evaluatePlan(ok(planSetCells(grid, [{ address: "B3", value: 12 }])), ctx).status).toBe("confirm");
  });

  it("rejects values that Excel would evaluate as formulas", () => {
    expect(evaluatePlan(ok(planSetCells(grid, [{ address: "D3", value: "=HYPERLINK(\"x\")" }])), ctx).status).toBe("reject");
  });

  it("rejects writes far outside the used area", () => {
    expect(evaluatePlan(ok(planSetCells(grid, [{ address: "Z99", value: 1 }])), ctx).status).toBe("reject");
  });
});

describe("evaluatePlan: structural changes", () => {
  it("allows one new row and one new column", () => {
    const row = ok(planAppendRow(grid, { Item: "Nuts", Threshold: 4, "West Coast": 9, "East Coast": 1 }));
    expect(evaluatePlan(row, ctx).status).toBe("ok");
    expect(evaluatePlan(ok(planInsertColumn(grid, "Midwest")), ctx).status).toBe("ok");
  });

  it("always confirms a single row or column deletion", () => {
    expect(evaluatePlan(ok(planDeleteRow(grid, "Bolts")), ctx).status).toBe("confirm");
    expect(evaluatePlan(ok(planDeleteColumn(grid, "East Coast")), ctx).status).toBe("confirm");
  });

  it("never deletes the item or threshold columns", () => {
    expect(evaluatePlan(ok(planDeleteColumn(grid, "Item")), ctx).status).toBe("reject");
    expect(evaluatePlan(ok(planDeleteColumn(grid, "Threshold")), ctx).status).toBe("reject");
  });

  it("rejects more than one structural change in a single request", () => {
    const plan: Plan = {
      summary: "two deletes",
      changes: [],
      structural: [
        { kind: "deleteRow", index: 2, name: "Bolts" },
        { kind: "deleteRow", index: 3, name: "Widgets" },
      ],
    };
    expect(evaluatePlan(plan, ctx).status).toBe("reject");
  });
});

describe("planning helpers", () => {
  it("renames a column through the header row only", () => {
    const plan = ok(planRenameColumn(grid, "East Coast", "Northeast"));
    expect(plan.changes[0]).toMatchObject({ row: 1, col: 3, before: "East Coast", after: "Northeast" });
    expect(evaluatePlan(plan, ctx).status).toBe("ok");
  });

  it("sets a config entry on row 1 and keeps the key:value format", () => {
    const plan = ok(planSetConfig(grid, "low-inventory-slack-ids-to-tag", "@lee"));
    expect(plan.changes[0]).toMatchObject({ row: 0, col: 0, after: "low-inventory-slack-ids-to-tag: @lee" });
    expect(evaluatePlan(plan, ctx).status).toBe("ok");
  });

  it("builds an undo that restores the logged before-values", () => {
    const plan = ok(planUndo([{ address: "D3", before: "3", after: "2" }]));
    expect(plan.changes[0]).toMatchObject({ row: 2, col: 3, before: "2", after: "3", via: "undo" });
  });
});
