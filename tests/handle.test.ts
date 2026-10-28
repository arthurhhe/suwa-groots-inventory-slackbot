import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared mutable state for the fake workbook and the scripted model.
const state = vi.hoisted(() => ({
  grid: [] as string[][],
  posted: [] as { channel: string; text: string; threadTs?: string }[],
  reactions: [] as string[],
  saved: [] as unknown[],
  logged: [] as string[],
  script: [] as unknown[],
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = {
      create: async () => {
        const next = state.script.shift();
        if (!next) throw new Error("model called more times than scripted");
        return next;
      },
    };
  },
}));

vi.mock("../lib/graph", () => ({
  sheetName: async () => "Inventory",
  readGrid: async () => state.grid.map((r) => [...r]),
  withSession: async (fn: (id: string) => Promise<unknown>) => fn("session-1"),
  applyPlan: async (plan: { changes: { row: number; col: number; after: string }[] }) => {
    for (const c of plan.changes) {
      state.grid[c.row] ??= [];
      state.grid[c.row][c.col] = c.after;
    }
  },
  appendLogRows: async (rows: string[][]) => {
    state.logged.push(...rows.map((r) => r.join("|")));
  },
  readLogRows: async () => [],
  initBotLogIfEmpty: async () => undefined,
}));

vi.mock("../lib/slack", () => ({
  postMessage: async (channel: string, text: string, threadTs?: string) => {
    state.posted.push({ channel, text, threadTs });
  },
  addReaction: async (_channel: string, _ts: string, name: string) => {
    state.reactions.push(name);
  },
  requesterName: async () => "Maria Lopez",
  workspaceUsers: async () => [{ id: "U_DANA", name: "dana", displayName: "Dana", realName: "Dana Rivera" }],
}));

vi.mock("../lib/store", () => ({
  loadThread: async () => null,
  saveThread: async (_key: string, value: unknown) => {
    state.saved.push(value);
  },
  threadKey: (channel: string, ts: string) => `thread:${channel}:${ts}`,
  withWorkbookLock: async <T,>(fn: () => Promise<T>) => fn(),
}));

import { handleMessage } from "../lib/handle";

function toolUse(id: string, name: string, input: unknown) {
  return { stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] };
}
function finalText(text: string) {
  return { stop_reason: "end_turn", content: [{ type: "text", text }] };
}

beforeEach(() => {
  state.grid = [
    ["low-inventory-slack-ids-to-tag: @dana", "", ""],
    ["Item", "Threshold", "West Coast", "East Coast"],
    ["Bolts", "10", "50", "12"],
  ];
  state.posted = [];
  state.reactions = [];
  state.saved = [];
  state.logged = [];
  state.script = [];
  process.env.SLACK_CHANNEL_ID = "C_INVENTORY";
});

describe("handleMessage", () => {
  it("acknowledges, applies the update in a new message, reacts, and posts a low-stock alert", async () => {
    state.script = [
      toolUse("t1", "read_sheet", {}),
      toolUse("t2", "set_cells", { cells: [{ address: "D3", value: 7 }] }),
      finalText("Bolts / East Coast: 12 -> 7"),
    ];

    await handleMessage({ channel: "C_INVENTORY", user: "U_REQ", text: "used 5 bolts in east coast", ts: "100.1" });

    expect(state.grid[2][3]).toBe("7");

    const [ack, completion, alert] = state.posted;
    expect(ack.threadTs).toBe("100.1");
    expect(ack.text).toContain("Maria Lopez");
    expect(ack.text).toContain("> used 5 bolts in east coast");
    expect(ack.text).toContain("Working on it");

    expect(completion.threadTs).toBe("100.1");
    expect(completion.text).toBe("Bolts / East Coast: 12 -> 7");

    expect(alert.channel).toBe("C_INVENTORY");
    expect(alert.threadTs).toBeUndefined();
    expect(alert.text).toContain("Low inventory: Bolts");
    expect(alert.text).toContain("East Coast");
    expect(alert.text).toContain("<@U_DANA>");

    expect(state.reactions).toEqual(["white_check_mark"]);
    expect(state.logged.length).toBe(1);
  });

  it("refuses a change the guard rejects and leaves the sheet untouched", async () => {
    state.script = [
      toolUse("t1", "set_cells", { cells: [{ address: "D3", value: "=HYPERLINK(\"x\")" }] }),
      finalText("I could not apply that."),
    ];
    await handleMessage({ channel: "C_INVENTORY", user: "U_REQ", text: "set east coast to a formula", ts: "300.1" });
    expect(state.grid[2][3]).toBe("12");
    expect(state.logged).toEqual([]);
    expect(state.reactions).toEqual([]);
  });

  it("holds a risky change until the requester confirms in the thread", async () => {
    state.script = [
      toolUse("t1", "delete_row", { item: "Bolts" }),
      finalText("Deleting Bolts needs your confirmation. Reply confirm to proceed."),
    ];
    await handleMessage({ channel: "C_INVENTORY", user: "U_REQ", text: "remove bolts", ts: "400.1" });
    expect(state.grid.length).toBe(3);
    const saved = state.saved[state.saved.length - 1] as { pendingPlan?: { structural: unknown[] } };
    expect(saved.pendingPlan?.structural.length).toBe(1);
  });
});
