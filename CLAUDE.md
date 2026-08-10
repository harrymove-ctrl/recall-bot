# CLAUDE.md

recall-bot is a Slack bot + MCP server that captures Slack thread replies and
exposes them via an admin dashboard. Core components:

- **bot** (`src/server.ts`) — Slack app using `@slack/bolt`; receives events,
  stores thread snapshots to SQLite via Drizzle ORM, proxies file uploads to S3.
- **dashboard** (`dashboard-web/`) — Next.js (App Router) admin UI; reads the
  same SQLite via API routes proxied through the bot's `/api/dashboard/*`.
- **mcp** (`src/mcp.ts`) — MCP server using `@modelcontextprotocol/sdk`; exposes
  the same namespace/message/file primitives to Claude Code.

## Layout

| Directory | Role |
|-----------|------|
| `src/` | Bot server (Slack app, MCP server, storage, S3 proxy) |
| `dashboard-web/` | Next.js dashboard frontend (runs as static export from `out/`) |
| `lib/` | Shared utilities |
| `components/` | Shared UI components |
| `app/` | Shared App Router pages |
| `tests/` | Vitest tests (bot logic, dashboard API routes) |
| `docs/rules/` | Loaded-on-demand rules (see below) |

## Invariants

- SQLite is the single source of truth; dashboard reads through bot's API only.
- Dashboard is static-export Next.js served from the bot's `out/` directory.
- Slack `client_id` / `client_secret` come from environment; never hardcode.
- MCP server exposes only the namespace/message/file schema; no Slack API
  token leaves `src/`.

## Build & test

```sh
npm run build   # tsc + dashboard static export
npm run test    # vitest (pretest runs build:dashboard automatically)
```

## Rules

Detailed standards live in `docs/rules/common/{topic}.md`, loaded only when the
matching task comes up:

| Doing this? | Read |
|---|---|
| Naming anything | `docs/rules/common/naming.md` |
| Writing a doc comment | `docs/rules/common/doc-comments.md` |
| Writing tests | `docs/rules/common/testing.md` |
| Committing or opening a PR | `docs/rules/common/git-workflow.md` |
| Adding or changing a CLI command | `docs/rules/common/cli-surfaces.md` |
| Long-running or background work | `docs/rules/common/agent-conduct.md` |

Additional project rules: `docs/rules/common/nextjs-agent.md` (legacy Next.js
agent block preserved for reference — superseded by thin-instructions
doctrine).

## Documentation

Start at `docs/README.md` for how the rest of the documentation tree is
organized and when to read each part of it.

## Scratch

Agent scratch and temporary files go under `.local/tmp/`, never a system
temp directory or an ad-hoc `tmp/`.
