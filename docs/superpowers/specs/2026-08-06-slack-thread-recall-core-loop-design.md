# Slack Thread Recall — Core Loop Design

**Status:** Approved for planning
**Sub-project:** 1 of N (core loop). Dashboard, analytics, and Enoki-based dashboard login are separate, later sub-projects — not designed here.

## Goal

When someone @-tags the bot in a Slack thread, capture that thread (history + ongoing replies, text + files) into a namespaced memory store. Coding agents (Codex, Claude, etc.) recall that memory over MCP, authenticated with a personal delegate key tied to the Slack user who requests it.

## Non-goals (this sub-project)

- No web dashboard (key issuance is a Slack slash command for v1).
- No analytics/activity charts.
- No semantic search — recall returns the raw ordered message dump for a namespace.
- No Enoki/Sui wallet integration (that's dashboard-login scope, later).
- No cross-namespace search or merging threads into one namespace (namespaces are strictly 1:1 with threads for now; renaming/grouping is a dashboard-era feature).

## Decisions log (from design discussion)

| Decision | Choice |
|---|---|
| Audience | Multi-tenant product — any Slack workspace can install |
| Trigger semantics | Tagging the bot = permission granted to capture the thread |
| Capture behavior | Backfill full thread history on first tag, AND keep live-capturing new replies after |
| Capture scope | Text + files/images (downloaded and re-hosted, not just linked) |
| Namespace model | Auto-created per thread (workspace+channel+thread_ts), renaming/grouping deferred to dashboard |
| Recall shape | Raw ordered message dump by namespace/thread ID, no ranking/search |
| MCP auth | Per-user delegate key |
| Access scope | A user's key can recall namespaces from threads they participated in (auto-derived from Slack thread membership) |
| Key issuance (v1) | Slack slash command `/recall-key` DMs the user their key |
| Infra | Railway, new project — Postgres + Railway bucket |
| Topology | Single service, HTTP Slack webhook (Events API) + HTTP MCP endpoint (Approach A of 3 considered) |

## Architecture

```
Slack Workspace(s)
      │  events, slash cmds, OAuth install
      ▼
┌─────────────────────────────┐
│   Railway service             │
│  ┌─────────┐   ┌──────────┐  │
│  │ /slack  │   │  /mcp    │  │
│  │ routes  │   │  routes  │  │
│  └────┬────┘   └────┬─────┘  │
│       └──────┬───────┘       │
│         shared services      │
│   (ingest, recall, keys)     │
└───────┬───────────────┬─────┘
        │               │
   Postgres DB      Bucket (files)
                         ▲
                         │
              Agents (Codex, Claude, …)
              call /mcp with delegate key
```

Considered and rejected: splitting into separate `slack-ingestion` + `mcp-recall` services (cleaner isolation, but unjustified ops overhead for an unproven v1 — revisit if load demands it); Slack Socket Mode instead of the HTTP webhook (faster to prototype, but not a good fit for a production multi-tenant app running on a PaaS with rolling deploys).

## Components

1. **Slack App (multi-tenant, OAuth)** — public app; each workspace installs via "Add to Slack," we store that workspace's bot token in `installations`.
2. **Event ingestion** (`/slack/events`) — receives `app_mention` and `message` events, verifies Slack's request signature, enqueues work.
3. **Backfill worker** — first tag in a thread → `conversations.replies` pulls full history + files → creates the `namespaces` row, `messages` rows, `files` rows. Marks the namespace `active`.
4. **Live capture** — for threads with an active namespace, new `message` (thread reply) events are appended as `messages` rows. No matching namespace → event dropped.
5. **Delegate key service** (`/recall-key` slash command) — issues/rotates a personal API key per Slack user; key is hashed at rest, shown once via DM.
6. **MCP recall server** (`/mcp`) — exposes one tool, `recall(namespace_or_thread_id)`; checks the caller's key against namespace participation, returns the message dump + file references, or 403.
7. **Data model** — `workspaces`, `installations` (bot tokens), `users` (slack_user_id ↔ hashed delegate key), `namespaces` (one per thread), `messages`, `files`.

## Data flow

1. **Install** — admin clicks "Add to Slack" → OAuth callback → `installations` row (workspace_id, bot_token, team info).
2. **Tag** — `@RecallBot` in a thread → Slack sends `app_mention` → webhook verifies signature → enqueue backfill job for `(workspace_id, channel_id, thread_ts)`.
3. **Backfill** — worker calls `conversations.replies`, paginates full history, downloads files via the bot token → uploads to the Railway bucket, creates `namespaces` + `messages` + `files` rows, marks it `active`.
4. **Live capture** — every subsequent `message` (thread reply) event is checked against `namespaces`; if there's an active namespace for that `thread_ts`, append a new `messages` row.
5. **Key issuance** — `/recall-key` → upsert `users` row (slack_user_id ↔ generated key, hashed at rest) → bot DMs the plaintext key once (regenerate = rotate).
6. **Recall** — agent calls MCP `recall(namespace_or_thread_id)` with `Authorization: Bearer <key>` → hash-lookup the user → check they have a `messages` row in that namespace (participation) → return the ordered dump + signed file URLs, or 403.

## Error handling

- Bad Slack signature → 401, log, drop.
- Slack retries (timeout/non-200) → dedupe via event_id / unique constraint on `(workspace_id, channel_id, thread_ts, slack_message_ts)`.
- `conversations.replies` rate-limited → backoff-retry queue; backfill tracks progress so it resumes instead of restarting.
- File download fails → message still stored, file row marked `failed`, retried separately; recall degrades gracefully (text always returned, file status flagged).
- Missing/invalid delegate key → 401 with a message an agent can surface ("run /recall-key in Slack").
- Authenticated but not a participant → 403, don't leak that the namespace exists.
- `app_uninstalled` → mark installation `revoked`, stop processing that workspace's events, keep historical data (deletion-on-request policy is a real open question, flagged below, not a v1 blocker).

## Testing

- **Unit**: signature verification, upsert idempotency, key hashing, recall authorization — pure logic, no network.
- **Local loop**: `npm run dev` + a tunnel (ngrok/Cloudflare Tunnel) for a public HTTPS URL, pointed at a dedicated dev Slack workspace's Event Subscriptions/slash command. Local Postgres via Docker.
- **MCP in isolation**: hit `/mcp` directly with a test delegate key (curl or an MCP inspector), independent of Slack.
- **Integration**: Postgres test container + recorded/replayed Slack API fixtures for the full ingest→recall pipeline, no live Slack needed.

## Open items (explicitly deferred, not blocking this sub-project)

- Data retention / deletion policy on uninstall (GDPR-ish question).
- Dashboard: namespace renaming/grouping, delegate-key management UI, Enoki-based login.
- Analytics/activity charts.
- Landing page rebrand (MemWal heatmap page → this product's marketing page) — page already exists and is deployed; copy/branding pass is separate work.
- Whether the two Sui/Enoki test credentials provided during this discussion apply to dashboard-era Enoki testing — held for that future sub-project, not used here.
