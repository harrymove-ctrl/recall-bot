# Usage Analytics — Design

**Status:** Approved for planning
**Sub-project:** 5 of N (usage analytics). Extends sub-project 4 (dashboard tabs, merged to `main`). Adds a new backend event log and a third dashboard tab — no changes to the capture pipeline, namespace/user management, or the recall tool's authorization/response behavior.

## Goal

Answer "which threads/agents are actually pulling from memory?" There is currently zero event logging for MCP recall calls — `recallNamespace` (`src/mcp/recallTool.ts`) answers the request and nothing is recorded. Add a best-effort event log of successful recall invocations, and surface it in the dashboard as a new "Analytics" tab: per-namespace recall count and last-recalled-at, sorted by most recently used.

## Non-goals

- No logging of unsuccessful/unauthorized recall attempts — only successful invocations (`result.authorized === true`) are logged. Failed-auth attempts are a separate concern (rate limiting / abuse detection) not in scope here.
- No logging of recalled message content — the event row is call metadata only (namespace, delegate user, timestamp). This is explicitly called out because the whole point of this feature is usage visibility without duplicating the sensitive data `messages` already holds.
- No per-message or per-file granularity — a recall call returns an entire namespace's thread as one unit; one event row per call, not one per message returned.
- No time-series chart, no date-range filtering, no CSV export. The table (namespace, recall count, last recalled) is the whole v1 surface — matching this admin tool's precedent of shipping the plain-table version first (see `2026-08-06-dashboard-v2-redesign-design.md`'s deferred "Analytics/activity charts" item, which this sub-project is finally picking up, in reduced scope).
- No changes to `recallNamespace`'s return shape, the MCP tool's response, or its authorization logic — logging is additive and strictly non-blocking.
- No retention/pruning policy for the new event table. If the table grows unbounded, that's a follow-up, not blocking v1.

## Design reference

No new visual language — reuses the existing dashboard design system (`dashboard-web/src/theme.css`: serif headings, hairline `border-bottom` table rows, `--space-*` tokens, monochrome palette with the one `--color-accent` blue) and the existing `MorphingTabs` chrome from the dashboard-tabs sub-project. The "Analytics" tab is the third `MorphingTabsItem`, exactly the extension point that sub-project's spec called out ("If a third dashboard section is ever added (e.g. future analytics), it becomes a third `MorphingTabsItem` — no structural change needed"). A plain HTML `<table>` is the primary and sufficient visualization, per the task's own steer: no charting library dependency. One optional lightweight enhancement — a small inline SVG horizontal bar per row, scaled to the row with the highest recall count, giving an at-a-glance sense of relative usage — is included below as a nice-to-have, built with plain SVG, no new dependency.

## Components

### 1. Schema — `recall_events` table (`src/db/schema.ts`)

A new `pgTable`, following the exact column/index conventions already used by `messages`/`files`:

```typescript
export const recallEvents = pgTable(
  "recall_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    namespaceId: uuid("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    delegateUserId: uuid("delegate_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("recall_events_namespace_id_idx").on(t.namespaceId),
    index("recall_events_namespace_id_created_at_idx").on(t.namespaceId, t.createdAt),
  ],
);

export const recallEventsRelations = relations(recallEvents, ({ one }) => ({
  namespace: one(namespaces, { fields: [recallEvents.namespaceId], references: [namespaces.id] }),
  delegateUser: one(users, { fields: [recallEvents.delegateUserId], references: [users.id] }),
}));
```

No `workspaceId` column directly on `recall_events` — it's derivable via `namespaceId → namespaces.workspaceId` (the same join-based scoping pattern `GET /namespaces/:id/messages` already uses for `files`), keeping one source of truth for a namespace's workspace rather than a second denormalized copy that could drift. The analytics query (Component 3) joins through `namespaces` to scope by workspace.

Deliberately not logged: message content, recalled text, file references. Only `namespaceId`, `delegateUserId` (the calling delegate user — gives "which agent/user" without a second free-text column), and `createdAt` (the timestamp). `delegateUserId` references `users.id`, not `users.slackUserId` directly, matching how the rest of the schema references users by id elsewhere.

Generate the migration with `npm run db:generate` after adding this table — never hand-write the SQL, per repo convention.

### 2. Recall-event logger (`src/mcp/recallEvents.ts`, new file)

A small, isolated module so the logging concern doesn't get tangled into `recallTool.ts`'s existing authorization logic:

```typescript
export async function logRecallEvent(db: Database, namespaceId: string, delegateUserId: string): Promise<void> {
  await db.insert(recallEvents).values({ namespaceId, delegateUserId });
}
```

Callers are required to catch — see Component 3 for the fire-and-forget wrapper at the call site, which is where the "never block or fail the actual recall response" requirement is actually enforced. Keeping `logRecallEvent` itself a plain throwing function (rather than swallowing errors internally) keeps it unit-testable on its own terms (a test can assert it does throw / write a row) while the call site owns the non-blocking guarantee.

### 3. Instrumentation in the recall tool's success path (`src/mcp/server.ts`)

`recallNamespace`'s return type and `recallTool.ts` are untouched. The logging call is added in `buildRecallServer`'s tool handler in `server.ts`, immediately after `result.authorized` is confirmed `true` and before the response is returned — fire-and-forget, not awaited inline with the response path:

```typescript
const result = await recallNamespace(db, delegateUser, namespaceId);
if (!result.authorized) {
  return { content: [{ type: "text", text: "Not authorized to recall this namespace" }], isError: true };
}

logRecallEvent(db, result.namespaceId, delegateUser.id).catch((err) => {
  console.error("Failed to log recall event:", err);
});

return {
  content: [{ type: "text", text: JSON.stringify({ namespaceId: result.namespaceId, messages: result.messages }) }],
};
```

Not `await`ed — the promise is fired and its rejection handled with a separate `.catch`, so a logging failure (e.g. a transient DB error) can never delay or fail the recall response itself. This is the one place in the codebase where a DB write is intentionally *not* awaited inline; the comment at the call site should say so explicitly, so a future reader doesn't "fix" it into a blocking `await`.

### 4. Analytics API route (`GET /api/dashboard/analytics`, added to `src/dashboard/api.ts`)

Returns, per namespace with at least one recall event, `{ namespaceId, label, channelId, recallCount, lastRecalledAt }`, sorted by `lastRecalledAt` descending (most-recently-used first). Scoped by `req.workspaceId!` exactly like every other route in this file — joins `recall_events` to `namespaces` and filters on `namespaces.workspaceId`, so a namespace belonging to another workspace never appears, full stop (not a 404 case here, since this is a list endpoint with no `:id` param to leak through — the scoping is baked into the `WHERE`, same posture as `GET /namespaces` and `GET /users`).

```typescript
router.get("/analytics", auth, async (req: DashboardRequest, res: Response) => {
  const rows = await db
    .select({
      namespaceId: namespaces.id,
      label: namespaces.label,
      channelId: namespaces.channelId,
      recallCount: count(recallEvents.id),
      lastRecalledAt: max(recallEvents.createdAt),
    })
    .from(recallEvents)
    .innerJoin(namespaces, eq(recallEvents.namespaceId, namespaces.id))
    .where(eq(namespaces.workspaceId, req.workspaceId!))
    .groupBy(namespaces.id, namespaces.label, namespaces.channelId)
    .orderBy(desc(max(recallEvents.createdAt)));

  res.json(rows);
});
```

(`count` and `max` from `drizzle-orm`, added to the existing import line alongside `and`, `desc`, `eq`, `inArray`, `isNotNull`.) Namespaces with zero recall events are simply absent from the result — an empty/never-recalled dashboard renders an empty-state table, not a zero-row-per-namespace list (see Error handling).

### 5. "Analytics" tab (`dashboard-web/src/App.tsx`)

A third `MorphingTabsItem`, added to the existing `tabs` array in `Dashboard`:

```tsx
const tabs: MorphingTabsItem[] = [
  { id: "namespaces", label: "Namespaces", content: <NamespacesTable ... /> },
  { id: "users", label: "Users", content: <UsersTable ... /> },
  { id: "analytics", label: "Analytics", content: <AnalyticsTable analytics={analytics} /> },
];
```

`Dashboard`'s `reload()` gains a third fetch (`/api/dashboard/analytics` → `setAnalytics`), following the exact pattern of the existing `namespaces`/`users` fetches — same `.then((res) => (res.ok ? res.json() : []))` shape, same unauthenticated-tolerant handling.

New `AnalyticsRow` interface alongside the existing `NamespaceRow`/`UserRow`:

```typescript
interface AnalyticsRow {
  namespaceId: string;
  label: string | null;
  channelId: string;
  recallCount: number;
  lastRecalledAt: string;
}
```

New `AnalyticsTable` component, same shape/placement as `NamespacesTable`/`UsersTable` (plain `<table>`, reusing `theme.css`'s existing `th`/`td`/`tr` styling — no new CSS classes needed beyond what's below):

```tsx
function AnalyticsTable({ analytics }: { analytics: AnalyticsRow[] }) {
  const maxCount = Math.max(1, ...analytics.map((a) => a.recallCount));
  if (analytics.length === 0) return <p>No recall activity yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Namespace</th>
          <th>Channel</th>
          <th>Recalls</th>
          <th>Last recalled</th>
        </tr>
      </thead>
      <tbody>
        {analytics.map((a) => (
          <tr key={a.namespaceId}>
            <td>
              <a href={`/dashboard/namespaces/${a.namespaceId}`}>{a.label ?? a.namespaceId}</a>
            </td>
            <td>{a.channelId}</td>
            <td>
              <span className="analytics-bar-wrap">
                <svg className="analytics-bar" width="60" height="10" aria-hidden="true">
                  <rect width="60" height="10" className="analytics-bar-track" />
                  <rect width={(a.recallCount / maxCount) * 60} height="10" className="analytics-bar-fill" />
                </svg>
                {a.recallCount}
              </span>
            </td>
            <td>{new Date(a.lastRecalledAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

The namespace cell links to the existing `NamespaceDetail` view (`/dashboard/namespaces/:id`, from the dashboard-v2 sub-project) — reusing that view rather than building any new detail surface, matching this row's existing precedent in `NamespacesTable`'s "View" link.

The SVG bar is the one "lightweight visual" allowed by the task: two stacked `<rect>`s (a full-width track, a proportional fill), styled via two new `theme.css` rules using existing tokens — no inline hex, no new dependency:

```css
.analytics-bar-wrap {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.analytics-bar-track {
  fill: var(--color-surface);
  stroke: var(--color-border);
}

.analytics-bar-fill {
  fill: var(--color-accent);
}
```

If this is judged not worth the extra markup during implementation, the plain `{a.recallCount}` number alone is an acceptable fallback — the spec doesn't mandate the bar, only permits it.

## Data flow

1. An MCP client calls the `recall` tool → `mountMcpServer`'s handler in `src/mcp/server.ts` → `recallNamespace` (unchanged) authorizes and returns messages.
2. On `result.authorized === true`, `logRecallEvent(db, result.namespaceId, delegateUser.id)` is fired without `await`, inserting one row into `recall_events`. Its promise's rejection is caught and logged separately (`console.error`); it never touches the response path.
3. The tool handler returns the recall response to the MCP client, regardless of whether the log insert has completed, failed, or is still in flight.
4. The dashboard's `Analytics` tab, on mount (via `Dashboard`'s existing `reload()`), calls `GET /api/dashboard/analytics`, which joins `recall_events → namespaces` filtered on `namespaces.workspaceId = req.workspaceId!`, grouped per namespace, sorted by `lastRecalledAt` descending.
5. The response renders as a table; each row links to that namespace's existing detail view.

## Error handling

- **Logging failure never affects the recall response.** This is the central constraint from the task and is enforced structurally, not by convention: `logRecallEvent(...)` is called without `await` in `server.ts`, and its promise carries its own `.catch` that only logs to `console.error`. The MCP response is constructed and returned independently of that promise's outcome. A test should assert this directly (see Testing).
- **Unauthorized/failed recall attempts are not logged at all** — the logging call sits after the `if (!result.authorized) return ...` early return, so it's structurally unreachable on the failure path. No separate guard needed.
- **`GET /api/dashboard/analytics` with no recall history** → `rows` is an empty array (the `INNER JOIN` naturally excludes namespaces with zero events); the dashboard renders "No recall activity yet." — an empty state, not an error, matching the `NamespaceDetail` precedent for a namespace with zero messages.
- **Cross-workspace isolation** — same posture as every other route: the `WHERE namespaces.workspaceId = req.workspaceId!` clause means a namespace from another workspace can never appear in the aggregated result, not even as a row with zero events (it's simply never joined in). No 404 case applies here since there's no `:id` route param to validate against `UUID_RE` — this is a scoped list endpoint like `GET /namespaces` and `GET /users`, not a scoped single-resource lookup like `GET /namespaces/:id/messages`.
- **A namespace deleted between the recall event being logged and the analytics query running** — `onDelete: "cascade"` on `recall_events.namespaceId` means its events are removed along with it; no orphaned rows, no dangling foreign key to handle defensively.
- **A user's delegate key revoked after logging an event** — `recall_events.delegateUserId` still references the (now keyless) `users` row via `onDelete: "cascade"` from `users`; the row itself isn't deleted by key revocation (revocation only nulls `delegateKeyHash`, per `POST /users/:id/revoke-key`), so historical events remain attributable. Not a case that needs special handling.

## Testing

- **`src/mcp/recallEvents.ts` unit test** (`tests/mcp/recallEvents.test.ts`, real Postgres via `tests/setup.ts`, same pattern as `tests/mcp/recallTool.test.ts`): `logRecallEvent` inserts exactly one row with the given `namespaceId`/`delegateUserId` and a `createdAt` close to `Date.now()`.
- **Instrumentation test** (`tests/mcp/server.test.ts`, extending the existing suite): a successful `recall` tool call results in exactly one `recall_events` row; an *unauthorized* `recall` call (wrong namespace, non-participant, or invalid delegate key) results in zero rows — covering the "only the success path is logged" requirement directly against the wired-up server, not just the isolated logger function.
- **Non-blocking guarantee test** (`tests/mcp/server.test.ts`): with the DB insert for `recall_events` mocked/forced to reject (e.g. stub `logRecallEvent`'s underlying `db.insert` to throw), the `recall` tool call still returns its normal successful response (`isError` unset, `content` containing the expected `messages` JSON) — proving a logging failure cannot fail the recall path. Pair with an assertion that the rejection was routed to `console.error` (via `vi.spyOn(console, "error")`), not silently dropped.
- **`GET /api/dashboard/analytics` integration test** (`tests/dashboard/api.test.ts`, extending the existing suite, same `buildTestApp()`/`seedWorkspace()`/`claimSessionCookie()` helpers already used by the file's other route tests):
  - Seed two namespaces in one workspace with different recall-event counts/timestamps; assert the response is sorted by `lastRecalledAt` descending and `recallCount` matches the seeded event count per namespace.
  - A namespace with zero recall events does not appear in the response.
  - **Cross-workspace isolation** (the security-critical case, matching the existing `"a workspace's session cannot read or mutate another workspace's namespace"` test's shape): seed workspace B's namespace with recall events, assert workspace A's session sees an empty/non-including result for `GET /api/dashboard/analytics` — workspace B's activity never leaks into workspace A's view.
- **Frontend**: no dedicated test suite, matching the v1/v2/dashboard-tabs precedent for this internal admin UI — `tsc --noEmit -p dashboard-web/tsconfig.json` is the build-time check. Manual verification: seed recall events locally (via a couple of MCP `recall` calls against a claimed delegate key), confirm the "Analytics" tab renders the expected counts/timestamps and the bar/fallback numbers scale sensibly.

## Open items (explicitly deferred, not blocking this sub-project)

- Retention/pruning policy for `recall_events` if it grows large over time (no TTL or archival job in this sub-project).
- Time-series / trend charting (recalls per day/week) — the flat table only shows current totals and last-used, not usage over time.
- Per-user (not just per-namespace) breakdown in the dashboard — `delegateUserId` is captured in the schema for future use, but the v1 API/UI aggregates by namespace only, matching the task's stated minimum.
- Logging unauthorized/failed recall attempts, for abuse detection or debugging — a distinct concern from usage analytics, deferred to a security-focused follow-up if ever needed.
