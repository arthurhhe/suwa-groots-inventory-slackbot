import { readFileSync } from "node:fs";
import path from "node:path";
import Mustache from "mustache";
import { LowStockEvent } from "./alerts";

export const ALERT_TEMPLATE_PATH = path.join(process.cwd(), "templates", "low-inventory-alert.md");

export interface AlertView {
  item: string;
  regions: { region: string; quantity: number; previous: number | null; threshold: number }[];
  threshold: number;
  requester: string;
  requestText: string;
  mentions: string;
  unresolvedMentions: string;
}

// Slack mrkdwn only needs &, <, > escaped. Text from the sheet and from users is escaped here,
// so the template can use raw {{{ }}} output and keep Slack mentions like <@U123> intact.
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildAlertView(events: LowStockEvent[], ctx: { requester: string; requestText: string; mentions: string; unresolved: string[] }): AlertView {
  const first = events[0];
  return {
    item: escapeMrkdwn(first.item),
    regions: events.map((e) => ({
      region: escapeMrkdwn(e.region),
      quantity: e.quantity,
      previous: e.previous,
      threshold: e.threshold,
    })),
    threshold: first.threshold,
    requester: escapeMrkdwn(ctx.requester),
    requestText: escapeMrkdwn(ctx.requestText),
    mentions: ctx.mentions,
    unresolvedMentions: ctx.unresolved.length > 0 ? `Could not find Slack users: ${ctx.unresolved.map(escapeMrkdwn).join(", ")}` : "",
  };
}

// Templates are plain Mustache, so adopters can edit wording in templates/ without touching code.
export function renderAlert(view: AlertView, templateSource = readFileSync(ALERT_TEMPLATE_PATH, "utf8")): string {
  return Mustache.render(templateSource, view).replace(/\n{3,}/g, "\n\n").trim();
}
