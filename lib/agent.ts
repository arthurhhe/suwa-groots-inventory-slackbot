// Claude tool-use loop. The model can only ask for changes through the tools below. Each tool
// builds a Plan, the guard decides, and commitPlan applies it. The model never writes to Graph.

import Anthropic from "@anthropic-ai/sdk";
import { LowStockEvent } from "./alerts";
import { Limits, Plan } from "./guard";
import { MODEL } from "./config";
import {
  planAppendRow,
  planDeleteColumn,
  planDeleteRow,
  planInsertColumn,
  planRenameColumn,
  planSetCells,
  planSetConfig,
  PlanResult,
} from "./plan";
import { formatForModel, resolveLayout } from "./sheet";
import { LoadedWorkbook, checkPlan, commitPlan, planUndoLastBatch } from "./workbook";

export interface Session {
  workbook: LoadedWorkbook;
  requester: string;
  requestText: string;
  limits: Limits;
  alerts: LowStockEvent[];
  applied: string[];
  pendingPlan?: Plan;
}

const MAX_ITERATIONS = 8;

const SYSTEM_PROMPT = `You manage an inventory workbook for a team, through Slack.

Sheet layout:
- Row 1 is bot config, one "key: value" per cell. Do not write to it except with set_config.
- Row 2 holds headers: Item | Threshold | <region> | <region> | ...
- Row 3 onward: one item per row. Column A is the item name. Column B is the threshold. Each region column holds on-hand quantity.

Rules:
- Always call read_sheet before changing anything, so you know the current row numbers and headers.
- Every quantity change must name a region. If the message does not name one, or the region does not match a header, ask which region. Do not guess and do not write.
- Never guess quantities or item names. If the item is unclear, ask which item.
- Adding or removing regions, renaming headers, and changing config are legitimate requests. Use the matching tool.
- Tools may refuse a change or ask for confirmation. Do not try to work around a refusal. Report it plainly.
- When you are finished, reply with one short message for the requester: what changed (for example "Bolts / East Coast: 13 -> 8"), or what you need from them. No preamble.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "read_sheet",
    description: "Return the current worksheet as CSV with row numbers and column letters.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "set_cells",
    description: "Set specific cells by address, for example quantities in a region column. Use row numbers from read_sheet.",
    input_schema: {
      type: "object",
      properties: {
        cells: {
          type: "array",
          items: {
            type: "object",
            properties: { address: { type: "string", description: 'A1-style address, e.g. "D5"' }, value: { type: ["string", "number"] } },
            required: ["address", "value"],
          },
        },
      },
      required: ["cells"],
    },
  },
  {
    name: "append_row",
    description: "Add a new item row. Keys are header names from row 2 (Item, Threshold, region names).",
    input_schema: {
      type: "object",
      properties: { values: { type: "object", additionalProperties: { type: ["string", "number"] } } },
      required: ["values"],
    },
  },
  {
    name: "rename_column",
    description: "Rename a header in row 2.",
    input_schema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    },
  },
  {
    name: "insert_column",
    description: "Add a new region column. Optionally place it after an existing header.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, after_column: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "delete_column",
    description: "Delete one column by header name. Always needs the requester's confirmation.",
    input_schema: { type: "object", properties: { header: { type: "string" } }, required: ["header"] },
  },
  {
    name: "delete_row",
    description: "Delete one item row by item name. Always needs the requester's confirmation.",
    input_schema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
  },
  {
    name: "set_config",
    description: 'Set a row 1 config value, e.g. key "low-inventory-slack-ids-to-tag" with value "@dana, @lee".',
    input_schema: {
      type: "object",
      properties: { key: { type: "string" }, value: { type: "string" } },
      required: ["key", "value"],
    },
  },
  {
    name: "undo_last",
    description: "Reverse the most recent change made by the bot, using the BotLog sheet.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export async function runAgent(session: Session, messages: Anthropic.MessageParam[]): Promise<string> {
  const client = new Anthropic();
  let text = "";
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });
    text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (response.stop_reason !== "tool_use") break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const output = await runTool(block.name, block.input as Record<string, unknown>, session);
      results.push({ type: "tool_result", tool_use_id: block.id, content: output.content, is_error: output.isError });
    }
    messages.push({ role: "user", content: results });
  }
  return text || "I could not finish that request. Nothing else was changed.";
}

async function runTool(name: string, input: Record<string, unknown>, session: Session): Promise<{ content: string; isError?: boolean }> {
  try {
    switch (name) {
      case "read_sheet":
        return { content: formatForModel(session.workbook.grid) };
      case "set_cells":
        return execute(planSetCells(session.workbook.grid, input.cells as { address: string; value: string | number }[]), session);
      case "append_row":
        return execute(planAppendRow(session.workbook.grid, input.values as Record<string, string | number>), session);
      case "rename_column":
        return execute(planRenameColumn(session.workbook.grid, String(input.from), String(input.to)), session);
      case "insert_column":
        return execute(planInsertColumn(session.workbook.grid, String(input.name), input.after_column ? String(input.after_column) : undefined), session);
      case "delete_column":
        return execute(planDeleteColumn(session.workbook.grid, String(input.header)), session);
      case "delete_row":
        return execute(planDeleteRow(session.workbook.grid, String(input.item)), session);
      case "set_config":
        return execute(planSetConfig(session.workbook.grid, String(input.key), String(input.value)), session);
      case "undo_last": {
        const planned = await planUndoLastBatch();
        return execute(planned, session);
      }
      default:
        return { content: `Unknown tool ${name}`, isError: true };
    }
  } catch (err) {
    return { content: `Tool failed: ${(err as Error).message}`, isError: true };
  }
}

async function execute(planned: PlanResult, session: Session): Promise<{ content: string; isError?: boolean }> {
  if (!planned.ok) return { content: planned.error, isError: true };
  const verdict = checkPlan(planned.plan, session.workbook, session.limits);
  if (verdict.status === "reject") return { content: `Refused: ${verdict.reason}`, isError: true };
  if (verdict.status === "confirm") {
    session.pendingPlan = planned.plan;
    return {
      content: `Not applied. This needs the requester's confirmation: ${verdict.reasons.join("; ")}. Tell them to reply "confirm" to proceed.`,
    };
  }
  return { content: await apply(planned.plan, session) };
}

// Applies an already-approved plan and refreshes the in-memory workbook for later tool calls.
export async function apply(plan: Plan, session: Session): Promise<string> {
  const out = await commitPlan({
    plan,
    workbook: session.workbook,
    requester: session.requester,
    requestText: session.requestText,
  });
  session.alerts.push(...out.alerts);
  session.applied.push(plan.summary);
  const relayout = resolveLayout(out.after[1] ?? []);
  session.workbook = {
    ...session.workbook,
    grid: out.after,
    layout: relayout.ok ? relayout.layout : session.workbook.layout,
  };
  return `Applied: ${plan.summary}`;
}

// Applies a plan the requester has explicitly confirmed. Re-checks against the current sheet first.
export async function applyConfirmed(plan: Plan, session: Session): Promise<string> {
  const verdict = checkPlan(plan, session.workbook, session.limits);
  if (verdict.status === "reject") return `Refused: ${verdict.reason}`;
  return apply(plan, session);
}
