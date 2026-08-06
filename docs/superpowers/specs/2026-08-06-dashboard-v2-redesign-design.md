# Dashboard v2 — Grid-Mode Redesign & Namespace Detail — Design

**Status:** Approved for planning
**Sub-project:** 3 of N (dashboard v2). Extends sub-project 2 (admin dashboard MVP, merged to `main`). Analytics/activity charts and the Slack/Notion/Linear/GitHub sync initiative are separate, later sub-projects — not designed here.

## Goal

Redesign the dashboard's visual language, and add a namespace detail view so an admin can actually read what the bot captured for a thread — not just manage its metadata (rename/archive/revoke).

## Non-goals

- No file download from the dashboard — list attached files by name and type only, no download link. Needs signed URLs or a proxy route; deferred.
- No pagination of namespace messages — a namespace is a single bounded Slack thread, not an unbounded feed.
- No Slack display-name resolution — messages show the raw `slackUserId`, matching the existing Users list's precedent (already shows raw IDs, not resolved names).
- No changes to the capture pipeline, the MCP recall tool, or Slack bot behavior — this is a dashboard-only change, reading data that already exists.

## Design reference

Visual cues taken from `bidyut.cc` (a portfolio site the project owner pointed to): a serif display font for headings against clean sans-serif body text, generous whitespace, 1px hairline dividers instead of boxed/shadowed cards, a mostly-monochrome palette with one small accent color, and — the specific mechanic that gave "grid mode" its name — a toggle that overlays faint dotted lines marking the page's layout grid, default on, state persisted client-side.

## Components

1. **Design system** (`dashboard-web/src/theme.css` or equivalent) — CSS custom properties for color tokens (background, surface, text-primary, text-muted, border, accent), a spacing scale, and a type scale (serif for headings, sans for body). Replaces the current plain, unstyled HTML elements. Applied consistently across the claim page, the dashboard list view, and the new namespace detail view — one shared system, not three separate treatments.
2. **Grid Mode toggle** — a boolean UI control (top-right, matching the reference) that shows/hides a dotted overlay marking the layout grid. Persisted in `localStorage` so it survives a reload; defaults to on.
3. **Namespace detail endpoint** (`GET /api/dashboard/namespaces/:id/messages`, added to `src/dashboard/api.ts`) — returns the namespace's captured messages in order (`slackUserId`, `text`, `slackTs`, `createdAt`) plus any files attached to each message (`originalName`, `mimeType`), scoped to the session's `workspaceId` exactly like every existing route: a namespace that isn't found or isn't owned by the session's workspace returns 404, never 403, never a silent cross-tenant leak.
4. **Namespace detail view** (`dashboard-web/src/NamespaceDetail.tsx` or equivalent) — a new client-side view reached by clicking a namespace's row in the list. No router library, matching the existing claim-page precedent: `App.tsx` already branches on `window.location.pathname`; this adds one more branch for a path shaped like `/dashboard/namespaces/:id`, extracting the id from the pathname. Renders the ordered message thread and a link back to the list.

## Data flow

`GET /namespaces/:id/messages` joins `messages` to `namespaces` on `namespace_id`, filtering on `namespaces.id = $1 AND namespaces.workspace_id = $2` (the same "scope every query by the session's workspace" pattern as every other route), ordered by `messages.slack_ts`. Slack timestamps are stored as `varchar` in the form `"1733500000.000100"` — all current and foreseeable values share the same digit count, so a plain string sort produces the correct chronological order without a numeric cast. A second query (or a join) attaches each message's files by `files.message_id`.

## Error handling

- Namespace not found, or not owned by the session's workspace → 404, same as `PATCH /namespaces/:id`.
- A namespace with zero captured messages (shouldn't happen — backfill always captures at least the tagged message — but handled defensively) → an empty-state message in the detail view, not an error.

## Testing

- Integration test for the new endpoint (real Postgres, same `tests/setup.ts` pattern as every other dashboard test): correct ordering, files attached correctly, and — the security-critical case — cross-workspace isolation (workspace A's session cannot fetch workspace B's namespace messages).
- The visual redesign itself has no dedicated test suite, matching the v1 precedent for this internal admin UI — `tsc --noEmit` over the React code is the only build-time check.

## Open items (explicitly deferred, not blocking this sub-project)

- File download from the dashboard.
- Slack display-name resolution (would need a `users:read` scope addition and either a live lookup or a cached mapping).
- Pagination, if a workspace ever produces an unusually large thread.
