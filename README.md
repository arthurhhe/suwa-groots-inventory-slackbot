# Inventory Slack Bot

A Slack bot for one channel. People post updates in plain language ("used 5 bolts in east coast"), a Claude agent applies them to an inventory workbook in OneDrive or SharePoint, and the bot posts a low-stock alert in the same channel when a region falls to or below the item's threshold. The alert tags the people listed in the workbook.

Anyone can clone this repo, run `npm run setup`, and stand up their own bot with their own accounts.

## How it works

```
Slack message ──► /api/slack/events (verify signature, dedupe)
                    │
                    ├─ ack in thread: "<name> requested: … ⏳ Working on it…"
                    ├─ Claude agent (tool use) ──► guard ──► Microsoft Graph (one workbook)
                    ├─ completion message in thread (new message, never an edit)
                    └─ low-stock alert in channel (from templates/low-inventory-alert.md)
```

- The bot never edits or deletes a Slack message it has sent. Every step is a new message, so the thread is a complete record.
- The model can only request changes through narrow tools. Every change goes through deterministic checks in `lib/guard.ts` before it reaches Microsoft Graph. Those checks are code, not prompts.
- Alerts are computed in code (`lib/alerts.ts`), not by the model.
- The app is scoped to **one** workbook via Microsoft's `Files.SelectedOperations.Selected` permission. Other files in the tenant are refused.

## Workbook layout

| | A | B | C… |
|---|---|---|---|
| **1** | `low-inventory-slack-ids-to-tag: @dana, @lee` | (more config cells later) | |
| **2** | Item | Threshold | West Coast · East Coast · Southwest · … |
| **3+** | Bolts | 10 | 50 · 12 · 30 |

- Row 1 is bot configuration, one `key: value` per cell.
- Row 2 holds headers. Region columns can be added, renamed, or removed by asking the bot in plain language.
- Column B must be the threshold. The bot finds it by the header `Threshold` (or `Min` / `Reorder` / `Reorder Point`). If it can't find exactly one, it says so in Slack instead of guessing.
- Quantities must be numbers. Text is not allowed in region cells. Formulas (values starting with `=`) are refused.

Run `npm run make-template` to generate a starter `inventory-template.xlsx`.

## Accounts and permissions you need

| # | Account | What you need from it | Where | Cost |
|---|---|---|---|---|
| 1 | **Slack** (paid workspace) | Permission to install apps. A channel for inventory. | Slack admin / api.slack.com/apps | Existing |
| 2 | **Slack app** | Named `stuffbot`, icon `clippy.jpg` (upload under Display Information; must be at least 512x512). Bot token (`xoxb-…`) and signing secret. Scopes: `chat:write`, `channels:history`, `reactions:write`, `users:read`. Event: `message.channels`. | Create from `slack-manifest.yaml` | Free |
| 3 | **Anthropic** | API key with prepaid credit. The Claude API is separate from Claude.ai subscriptions. | console.anthropic.com | ~$5 prepaid, then usage (cents/month at this volume) |
| 4 | **Microsoft 365 tenant** | One admin, once, to consent and grant the app access to the one workbook. | Tenant admin | Existing |
| 5 | **Entra app registration** | Tenant ID, client ID, client secret. Application permission **only** `Files.SelectedOperations.Selected`. | entra.microsoft.com → App registrations | Free |
| 6 | **Workbook** | The `.xlsx` in OneDrive for Business or a SharePoint library. Its sharing link. | Your OneDrive/SharePoint | Existing |
| 7 | **Vercel** | Account and project. Hobby is free. | vercel.com | Free (see the caveat below) |
| 8 | **Upstash Redis** | REST URL and token. Used for event dedupe, thread state, and a workbook lock. | Vercel Marketplace → Storage | Free tier |

### Permissions the app holds

- Microsoft Graph, application permission `Files.SelectedOperations.Selected`, granted only on the workbook's item.
- Slack bot scopes listed above.
- No other Microsoft permissions. In particular, no `Files.ReadWrite.All`, no `Sites.*`, and no user sign-in.

The admin's sign-in during setup uses Microsoft Graph Command Line Tools to create the single-file grant. That token is used for one call and discarded. Your tenant may restrict third-party sign-ins, in which case an admin can perform the grant in Graph Explorer or PowerShell. The setup script prints the exact request in that case.

## Setup

```bash
git clone <this repo> && cd inventory-slack-bot
npm install
npm run setup
```

`npm run setup` walks you through:

1. A checklist of every account above, with the permissions and where to get each one.
2. Prompts for each value. Values are written to `.env.local`, which is gitignored.
3. Live checks: Slack, Anthropic, Redis, and an app sign-in to Microsoft.
4. The admin consent link. An admin approves the app once.
5. A link to the workbook. An admin signs in once and the script grants write access to that one file.
6. Checks that the app can read the workbook, that the layout is valid, and optionally that an unrelated file is refused.
7. An optional push of the variables to Vercel production (needs the Vercel CLI and `vercel login`).

Then:

1. Deploy: `npx vercel --prod`, or import the repo in the Vercel dashboard. Set the environment variables from `.env.local` if you did not push them.
2. In the Slack app's **Event Subscriptions**, set the request URL to `https://<your-deployment>/api/slack/events`. Slack verifies it. Save.
3. Invite the bot to the channel: `/invite @stuffbot`.
4. Put the recipients in cell A1, e.g. `low-inventory-slack-ids-to-tag: @dana, @lee`.

Re-check at any time with `npm run doctor`.

## Safeguards

These are enforced in code, not only in the prompt:

- **No delete-range tool.** Deleting a row or column is a single structural action that always asks for confirmation, and only one per request.
- **Per-request limits:** at most 10 cells per request (`MAX_CELLS_PER_REQUEST`), and one new row or column.
- **Protected cells:** row 1 changes only through the config tool. Header changes only through the rename and insert tools. Item names cannot be blanked. The item and threshold columns cannot be deleted.
- **Confirmation required** for: negative results, changes over 1000 units (`CONFIRM_CHANGE_ABOVE_UNITS`), quantities more than 10× their previous value (`CONFIRM_CHANGE_RATIO`), clearing a value, changing a threshold, and any row or column deletion. Only the original requester can confirm, by replying `confirm` in the thread. Confirmations expire after an hour.
- **Formula injection blocked.** Values starting with `=`, `+`, or `@` are refused.
- **Audit and undo.** Every change is written to a `BotLog` sheet in the same workbook (timestamp, requester, request, cell, before, after). "Undo last" reverses the most recent batch. Structural changes cannot be undone automatically; use OneDrive version history for those.
- **One writer at a time.** A Redis lock serializes workbook updates across concurrent messages.

## Operating notes

- **Vercel Hobby** is free and intended for personal, non-commercial use. Using it for an organization's internal tool may not fit Vercel's terms. Check their [Hobby plan terms](https://vercel.com/docs/plans/hobby) for your situation. Nothing in the code is Hobby-specific, so moving to Pro is a plan change.
- Functions run up to 60 seconds (`vercel.json`). Slack's acknowledgement is immediate. Work continues in `after()`.
- Excel Online co-authoring works. Updates appear in an open workbook.
- The Graph call path is `/drives/{drive}/items/{item}/workbook/…`. The first deployment should be checked with `npm run doctor`, since workbook endpoints under this scope are the one assumption setup verifies live.

## Development

```bash
npm test          # unit tests for layout, guard, plans, alerts, templates, signatures
npm run typecheck
npm run dev       # local Next.js server; expose it with a tunnel to test Slack
```

Project layout:

```
app/api/slack/events/route.ts   Slack entry point: signature check, dedupe, after()
lib/handle.ts                   message flow: ack, lock, agent or confirm, completion, alerts
lib/agent.ts                    Claude tool-use loop and tool definitions
lib/guard.ts                    deterministic write safeguards
lib/plan.ts                     tool input → concrete cell changes
lib/alerts.ts                   low-stock rule (crossing or decreasing while low)
lib/sheet.ts                    grid helpers, row 1 config, layout resolution
lib/graph.ts                    Microsoft Graph client, scoped to one workbook
lib/workbook.ts                 load, commit, BotLog, undo
lib/store.ts                    Redis: dedupe, thread state, lock
lib/slack.ts                    Slack Web API helpers (create-only messages)
lib/mentions.ts                 handle → Slack user ID
templates/low-inventory-alert.md  alert wording (edit freely)
scripts/setup.ts                interactive setup and one-time scoped grant
scripts/doctor.ts               re-runs live checks
scripts/make-template.ts        starter workbook
```

## Changing the alert message

Edit `templates/low-inventory-alert.md`. It is Slack mrkdwn with Mustache placeholders. The available variables are `item`, `regions` (each with `region`, `quantity`, `previous`, `threshold`), `threshold`, `requester`, `requestText`, `mentions`, and `unresolvedMentions`. Use triple braces `{{{ }}}` so Slack mentions such as `<@U123>` are not escaped.
