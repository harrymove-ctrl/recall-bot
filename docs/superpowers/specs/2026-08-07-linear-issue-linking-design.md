# Linear Issue Linking — Design

**Status:** Draft — ready for review
**Sub-project:** 5 of N (Linear issue linking). Extends sub-project 4 (dashboard tabs, merged to `main`). Detect-and-link only for v1 — no live Linear API integration (see Non-goals / Open items).

## Goal

When a captured thread mentions a Linear issue (a message contains a `linear.app/.../issue/...` permalink), automatically detect it, extract the issue identifier (e.g. `WALM-297`), and store enough to construct a working link back to it. Surface that as a small badge/link on the namespace list row and as a linked-out section on the namespace detail view — so an admin skimming captured threads can see "this thread is about WALM-297" without opening Slack.

A namespace can reference zero, one, or many distinct Linear issues (a thread might mention more than one ticket over its life), so the data model is a namespace ↔ issue join table, not a single column on `namespaces`.

## Non-goals

- **No live Linear API integration.** Only the identifier + a constructed `linear.app` URL are stored; the badge shows the bare identifier (e.g. `WALM-297`), never a live title or status. No new required env var, no request to Linear on the capture or dashboard-render path. This is the explicit default per the brief; see Open items for what an optional, best-effort metadata fetch would look like if ever justified later.
- **No one-off retroactive migration script** that scans every historical message's text on deploy. `backfillThread` already re-scans every message in a thread on each re-tag (see Data flow), so historical namespaces get linked issues automatically the next time someone re-tags them — the same "re-tag to retry" mechanic this codebase already uses for stranded file captures. A namespace that is never re-tagged again simply shows no badges until it is (acceptable for v1; flagged as an open item if it proves insufficient).
- **No inline linkification of the URL inside message bodies.** The namespace detail view keeps rendering `m.text` as plain text (`<p>{m.text}</p>`); linked issues appear as a separate summary section, not as a rewrite of message content. Splitting message text into React nodes around a matched substring is extra complexity this feature doesn't need — the raw URL is still visible (and copyable) in the message text either way.
- **No changes to the MCP `recall` tool's output** (`src/mcp/recallTool.ts`). Linked issues are a dashboard-only surface for v1; a coding agent recalling a namespace via MCP does not see them.
- **No edit/remove UI for a detected link.** Detection is derived data. This bot already drops `message_changed`/`message_deleted` Slack subtypes (see `isCapturableMessageSubtype` in `src/slack/events.ts`), so messages — and by extension the links found in them — are treated as immutable once captured, matching existing behavior.
- **No parsing of file attachments.** Detection scans `messages.text` only; a Linear link inside an attached PDF/image is not extracted.

## Design reference

No new visual language. This adds one new element to the existing dashboard-v2 design system (`theme.css`): a small pill/chip badge for a linked issue, built entirely from tokens already in the palette (`--color-border`, `--color-accent`, `--color-text-muted`, `--space-1`) — no new colors. It borrows its shape from the existing `button` rule (1px `--color-border`, 3px radius) but renders as an `<a>` (accent-colored, underline on hover, matching the existing `a`/`a:hover` rules) since it's a link, not an action. It's the first *external* link this dashboard renders, so it deliberately opens in a new tab (`target="_blank" rel="noopener noreferrer"`) — every other `<a>` in the app today (`View`, "Back to namespaces") is an internal same-tab navigation.

The thing actually being "designed" here is the detection pattern, not a UI. Linear issue permalinks always take the shape:

```
https://linear.app/<workspace-slug>/issue/<TEAM-KEY-NUMBER>/<optional-descriptive-slug>
```

e.g. the real one already captured in production:
`https://linear.app/mysten-labs/issue/WALM-297/memory-read-api-authentication-and-authorization-short-lived-owner`

Linear's own redirect behavior means the trailing descriptive slug is cosmetic: `https://linear.app/mysten-labs/issue/WALM-297` alone redirects to the same issue. So the workspace slug + identifier is all that needs to be stored and reconstructed — the constructed link this feature emits deliberately omits the descriptive suffix.

## Components

1. **Schema** (`src/db/schema.ts`) — new join table `namespace_linear_issues`:

   ```ts
   export const namespaceLinearIssues = pgTable(
     "namespace_linear_issues",
     {
       id: uuid("id").defaultRandom().primaryKey(),
       namespaceId: uuid("namespace_id")
         .notNull()
         .references(() => namespaces.id, { onDelete: "cascade" }),
       workspaceSlug: varchar("workspace_slug", { length: 64 }).notNull(),
       issueIdentifier: varchar("issue_identifier", { length: 32 }).notNull(),
       createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
     },
     (t) => [
       unique("namespace_linear_issues_namespace_identifier_unique").on(t.namespaceId, t.issueIdentifier),
       index("namespace_linear_issues_namespace_id_idx").on(t.namespaceId),
     ],
   );
   ```

   Dedup key is `(namespaceId, issueIdentifier)` — one row per distinct issue *per namespace*, regardless of how many messages or how many times it's mentioned. `workspaceSlug` is stored (not derived) because it's needed to reconstruct a working URL and isn't guaranteed to be the same across every Linear workspace a thread might reference (see Open items). No `messageId` column: v1 doesn't need per-message attribution, only "this namespace mentions this issue" — if inline highlighting or "first mentioned in message X" context is ever wanted, add that column then rather than speculatively now. Add `linearIssues: many(namespaceLinearIssues)` to `namespacesRelations` and a matching `namespaceLinearIssuesRelations`. Run `npm run db:generate` in the implementation phase to produce the migration — not run in this design-only pass.

2. **Detection module** (new file, `src/slack/linearLinks.ts`) — pure extraction + a DB-writing helper, mirroring the shape of `src/slack/files.ts`:

   ```ts
   const LINEAR_ISSUE_URL_RE =
     /linear\.app\/([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)\/issue\/([a-zA-Z][a-zA-Z0-9]{1,9}-\d+)/g;

   export interface LinearIssueRef {
     workspaceSlug: string;
     issueIdentifier: string; // normalized uppercase, e.g. "WALM-297"
   }

   export function extractLinearIssueRefs(text: string): LinearIssueRef[] { ... }
   export function linearIssueUrl(ref: LinearIssueRef): string { ... } // `https://linear.app/${workspaceSlug}/issue/${issueIdentifier}`
   export async function recordLinearIssueLinks(params: {
     db: Database;
     namespaceId: string;
     text: string;
   }): Promise<void> { ... }
   ```

   `LINEAR_ISSUE_URL_RE` matches the substring `linear.app/<slug>/issue/<KEY>-<digits>` anywhere in the text, unanchored — deliberately, because Slack stores link-containing message text with its own bracket markup (`<https://linear.app/...|https://linear.app/...>` or bare `<https://linear.app/...>`), and an unanchored substring match handles both forms plus plain unwrapped URLs without needing to strip Slack's `<...|...>` syntax first. It does *not* match non-issue `linear.app` URLs (e.g. `linear.app/mysten-labs/settings`) because those don't have the `/issue/<KEY>-<digits>` segment. The captured identifier is uppercased before dedup/storage so a hand-typed `walm-297` and Slack's own `WALM-297` collapse to the same row. `recordLinearIssueLinks` loops the extracted refs and `db.insert(namespaceLinearIssues).values(...).onConflictDoNothing({ target: [namespaceLinearIssues.namespaceId, namespaceLinearIssues.issueIdentifier] })` per ref, each wrapped in its own try/catch that logs and continues (one bad ref must never block the others in the same message, or block message/file capture) — same defensive posture as `captureSlackFile`'s per-file error handling and `handleAppMention`'s swallowed confirmation-post failure.

3. **Capture-pipeline wiring** — two call sites, deliberately asymmetric:

   - `handleMessage` (`src/slack/events.ts`, live path): after the existing `messages` insert, alongside the existing `if (messageRow && message.files?.length)` file-capture block, add `if (messageRow) { await recordLinearIssueLinks({ db, namespaceId: namespace.id, text: message.text ?? "" }); }`. Gated on `messageRow` being defined (a genuinely new message) is correct here — a live event only ever represents new content, so there's nothing to retroactively rescan.
   - `backfillThread` (`src/slack/backfill.ts`): call `recordLinearIssueLinks` for **every** `raw` message in the page, whether it was newly inserted or already existed — and critically, positioned *before* the existing `if (rawFiles.length === 0) continue;` early-exit, not nested inside the file-handling branch. Today that early-continue only skips further work when a message has no files, which is fine for file capture but would silently skip link detection for the (common) case of a message with a Linear link and no attachment. Because `recordLinearIssueLinks` is idempotent (`onConflictDoNothing`), calling it unconditionally on every pass — including for messages stored by an earlier backfill, before this feature existed — is what makes re-tagging a thread double as retroactive link-detection for pre-existing captures, at no extra cost.

4. **Dashboard API** (`src/dashboard/api.ts`):
   - `GET /namespaces` — after the existing workspace-scoped `namespaces` query, fetch `namespaceLinearIssues` via `inArray(namespaceLinearIssues.namespaceId, rows.map(r => r.id))` (guarded for an empty array, same pattern the messages endpoint already uses for its `files` sub-query), group by `namespaceId`, and add `linearIssues: { identifier: string; url: string }[]` to each row in the JSON response. Safe by construction: the id list being joined against was itself already filtered to `req.workspaceId!` in the first query, so this second query can't cross a tenant boundary even though it doesn't repeat the `workspaceId` filter directly — identical reasoning to how the existing `files` sub-query trusts `messageIds` derived from an already-scoped `messages` query.
   - `GET /namespaces/:id/messages` — same trust chain: after the existing 404-gated `namespace` lookup (already `eq(namespaces.id, ...) AND eq(namespaces.workspaceId, req.workspaceId!)`), add a query for `namespaceLinearIssues` filtered by that single `namespaceId`. **Response shape changes** from a bare array to `{ messages: [...], linearIssues: [{ identifier, url }] }` — a deliberate breaking change to this endpoint's shape, made safe because its only consumer, `NamespaceDetail.tsx`, is updated in the same change.

5. **Dashboard frontend** (`dashboard-web/src/`):
   - `App.tsx` — `NamespaceRow` gets `linearIssues: { identifier: string; url: string }[]`. `NamespacesTable` gets a new `<th>Linked issues</th>` column; the `<td>` renders one `.issue-badge` `<a>` per entry (empty cell if none — no placeholder text, since most namespaces won't reference a Linear issue).
   - `NamespaceDetail.tsx` — the fetch handler is updated to read `{ messages, linearIssues }` instead of a bare array. When `linearIssues.length > 0`, render a "Linked issues" block (same `.issue-badge` chips) between the "Captured thread" heading and the message list; omitted entirely when empty, matching the list view's no-placeholder treatment.
   - `theme.css` — new `.issue-badge` rule: small pill using `--space-1`, `--color-border`, `--color-accent`, matching the existing `button` shape (1px border, 3px radius) but styled as a link per the Design reference section.

## Data flow

```
Slack message text
  → handleMessage (live) or backfillThread (thread replay/re-tag)
  → recordLinearIssueLinks(text)
      → extractLinearIssueRefs(text)   [pure regex, dedup within the call]
      → INSERT ... ON CONFLICT DO NOTHING into namespace_linear_issues,
        keyed on (namespaceId, issueIdentifier)
  → GET /api/dashboard/namespaces            → NamespacesTable badge column
  → GET /api/dashboard/namespaces/:id/messages → NamespaceDetail "Linked issues" section
```

Two capture entry points exist because they have different rescanning needs: `handleMessage` only ever sees genuinely new messages (rescan-on-conflict would be a no-op), while `backfillThread` is also the mechanism that replays *already-captured* messages whenever a thread is re-tagged — so it's the natural (and only, for v1) retroactive-detection path for threads captured before this feature shipped. `onConflictDoNothing` on the join table's unique constraint is what makes calling `recordLinearIssueLinks` unconditionally on every backfill pass cheap and safe rather than needing a "was this message already scanned" check.

Both read endpoints derive their `namespaceLinearIssues` queries from an already workspace-scoped id (or id set), so neither needs to repeat the `workspaceId` filter directly — see Components §4 for why that's still safe.

## Error handling

- Namespace not found, or not owned by the session's workspace → 404, unchanged (same gate as today; the new `linearIssues` field just rides along inside that already-guarded response).
- A `linear.app` URL that isn't an issue permalink (no `/issue/<KEY>-<digits>` segment) → not matched, not stored. Only true issue links are detected.
- A DB error while recording a link (should only happen on a genuine connectivity/constraint problem, since `namespaceId` is always the current, just-verified namespace) → caught per-ref, logged with the namespace id and the ref that failed, swallowed. Link detection must never fail or roll back message/file capture — the primary capture path already succeeded by the time detection runs.
- Same issue mentioned multiple times (same message, or repeated across the thread) → deduped by the unique constraint; badge/link shown once per namespace.
- Hand-typed lowercase identifier (`walm-297`) vs. Slack's own uppercase link (`WALM-297`) → normalized to uppercase before dedup, so both collapse to one row.

## Testing

- `tests/slack/linearLinks.test.ts` (new) — unit tests for `extractLinearIssueRefs`: Slack's `<url>` and `<url|label>` bracket forms, multiple distinct issues in one message, duplicate-mention dedup within a single call, case normalization, a non-issue `linear.app` URL correctly ignored, and plain text with no link returning `[]`. Plus an integration case for `recordLinearIssueLinks` against the real test DB: inserting the same ref twice is a no-op (unique constraint honored via `onConflictDoNothing`), and two distinct refs produce two rows.
- `tests/slack/events.test.ts` — extend `handleMessage` coverage: a message containing a Linear link produces a `namespace_linear_issues` row scoped to the right namespace; a message without one produces none.
- `tests/slack/backfill.test.ts` — extend `backfillThread` coverage: (a) a thread replay containing a Linear link populates the join table; (b) the retroactive case — insert a `messages` row directly (simulating a message captured before this feature existed), then run `backfillThread` again and assert the link row now exists even though the message itself already existed (`onConflictDoNothing` skip on `messages`, but detection still ran).
- `tests/dashboard/api.test.ts` — extend both endpoints: `GET /namespaces` includes the right `linearIssues` per row; `GET /namespaces/:id/messages` returns the new `{ messages, linearIssues }` shape; and — the security-critical case, matching every other route's test coverage — workspace A's session cannot see workspace B's namespace's linked issues via either endpoint.
- Frontend: no dedicated test suite, matching v1/v2/tabs precedent for this internal admin UI. `tsc --noEmit -p dashboard-web/tsconfig.json` is the build-time check; manual verification that badges render on both the list and detail views and open Linear in a new tab.

## Open items (explicitly deferred, not blocking this sub-project)

- **Optional live Linear metadata fetch.** If a future need justifies showing the real issue title/status instead of just the bare identifier, it must be opt-in (a `LINEAR_API_KEY` env var that's absent by default), best-effort only (wrapped in try/catch, short timeout, cached), and never on the capture or initial dashboard-render path — e.g. a lazy client-side fetch triggered on badge hover, never blocking `recordLinearIssueLinks` or the `GET /namespaces*` responses. Not justified for v1: the brief's default (detect-and-link only) covers the stated need (surface *that* a thread references a ticket) without adding a new external dependency, credential, or failure mode to the capture path.
- **One-off historical backfill script**, if re-tagging existing threads to trigger retroactive detection (per Non-goals) proves impractical for workspaces with many old namespaces.
- **Team-key collisions across two different Linear workspaces** referenced from the same Slack workspace (rare — a thread would need to link issues from two separate Linear orgs with an identical team key) are not specially handled; the dedup key is `(namespaceId, issueIdentifier)` without `workspaceSlug`, so this edge case would silently keep only the first-seen workspace slug for that identifier. Acceptable for v1; would need `workspaceSlug` added to the unique constraint if it ever matters in practice.
- **MCP `recall` tool surfacing linked issues** to a coding agent, if that turns out to be useful context beyond the dashboard.
