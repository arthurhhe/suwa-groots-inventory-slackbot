import { describe, expect, it } from "vitest";
import { colLetter, formatForModel, parseAddress, parseConfig, parseRecipients, readItems, resolveLayout, toAddress } from "../lib/sheet";

const grid = [
  ["low-inventory-slack-ids-to-tag: @dana, @lee", "", ""],
  ["Item", "Threshold", "West Coast", "East Coast"],
  ["Bolts", "10", "50", "3"],
  ["Widgets", "5", "", "7"],
];

describe("addresses", () => {
  it("converts column indexes to letters and back", () => {
    expect(colLetter(0)).toBe("A");
    expect(colLetter(25)).toBe("Z");
    expect(colLetter(26)).toBe("AA");
    expect(parseAddress("AB12")).toEqual({ row: 11, col: 27 });
    expect(toAddress(11, 27)).toBe("AB12");
  });

  it("rejects malformed addresses", () => {
    expect(() => parseAddress("12")).toThrow();
  });
});

describe("config row", () => {
  it("parses key: value cells, keyed by lowercase key", () => {
    const config = parseConfig(grid);
    expect(config["low-inventory-slack-ids-to-tag"].value).toBe("@dana, @lee");
    expect(config["low-inventory-slack-ids-to-tag"].col).toBe(0);
  });

  it("splits recipients on commas and whitespace, stripping @", () => {
    expect(parseRecipients("@abc, @xyz  @qq")).toEqual(["abc", "xyz", "qq"]);
  });
});

describe("layout and items", () => {
  it("finds the threshold column and treats every other header as a region", () => {
    const result = resolveLayout(grid[1]);
    expect(result).toEqual({
      ok: true,
      layout: {
        thresholdCol: 1,
        regions: [
          { name: "West Coast", col: 2 },
          { name: "East Coast", col: 3 },
        ],
      },
    });
  });

  it("accepts an alternate threshold name like Reorder Point", () => {
    const result = resolveLayout(["Item", "Reorder Point", "East"]);
    expect(result.ok && result.layout.thresholdCol).toBe(1);
  });

  it("reports a missing threshold instead of guessing", () => {
    expect(resolveLayout(["Item", "East"])).toEqual({ ok: false, reason: "missing-threshold" });
  });

  it("reads items from row 3 with numeric quantities and blanks as null", () => {
    const result = resolveLayout(grid[1]);
    if (!result.ok) throw new Error("layout should resolve");
    const items = readItems(grid, result.layout);
    expect(items.map((i) => i.name)).toEqual(["Bolts", "Widgets"]);
    expect(items[0]).toMatchObject({ row: 2, threshold: 10, quantities: { 2: 50, 3: 3 } });
    expect(items[1].quantities[2]).toBeNull();
  });
});

describe("model view", () => {
  it("prints row numbers and column letters and quotes commas", () => {
    const view = formatForModel([["a, b", "c"]]);
    expect(view.split("\n")).toEqual(["row,A,B", '1,"a, b",c']);
  });
});
