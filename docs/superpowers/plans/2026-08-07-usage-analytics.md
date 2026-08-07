# Usage Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Branch:** `usage-analytics`, based on the tip of `slack-display-name-resolution` (the **third and last** branch in the stack: `linear-issue-linking` → `slack-display-name-resolution` → `usage-analytics`). This means, before starting:

- `App.tsx`'s `Dashboard` component already has a two-item `tabs: MorphingTabsItem[]` array (`namespaces`, `users`) and a `reload()` with two fetches; this plan appends a third tab and a third fetch, it does not restructure the existing two.
- `NamespacesTable` already has a "Linked issues" column and `UsersTable` already renders resolved avatars/names; this plan does not touch either table.
- `src/dashboard/api.ts`'s `drizzle-orm` import line is `import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";` and its schema import line includes `namespaceLinearIssues`; this plan extends both, alphabetically, with `count`/`max` and `recallEvents`.

**Goal:** Answer "which threads/agents are actually pulling from memory?" — log successful MCP `recall` calls to a new event table, and surface per-namespace recall count + last-recalled-at as a third "Analytics" dashboard tab.

**Architecture:** A new `recall_events` table (scoped to a workspace only indirectly, via `namespaceId → namespaces.workspaceId`) is written to, fire-and-forget, from the MCP tool handler's success path — never from `recallNamespace` itself, which stays untouched. A new `GET /api/dashboard/analytics` route aggregates it per namespace. A third `MorphingTabsItem` renders it as a plain table with an optional inline-SVG usage bar.

**Tech Stack:** Existing stack only (`drizzle-orm`'s `count`/`max` aggregates, already available; React 19; Vitest). No new dependencies.

## Global Constraints

- **Logging a recall event must never affect the recall response.** `logRecallEvent(...)` is called without `await` in `src/mcp/server.ts`, with its own `.catch`. This is the one place in the codebase where a DB write is intentionally not awaited inline — the comment at the call site must say so explicitly.
- `recallNamespace` (`src/mcp/recallTool.ts`) and its return shape are **untouched** by this plan.
- Only successful, authorized recalls are logged — the logging call sits structurally after the `if (!result.authorized) return ...` early return, so the failure path can never reach it.
- `GET /analytics` scopes by `namespaces.workspaceId = req.workspaceId!` in the join's `WHERE` clause (a list endpoint, no `:id` param, so no 404 case — same posture as `GET /namespaces` and `GET /users`).
- Before committing each task, run `npx tsc --noEmit -p dashboard-web/tsconfig.json` (frontend tasks) and `npm test` (backend tasks).
- Generate the migration with `npm run db:generate -- --name=recall_events` — never hand-write migration SQL.

---

## File Structure

```
recall-bot/
  src/
    db/
      schema.ts                          # MODIFY — add recallEvents table + relations
    mcp/
      recallEvents.ts                    # NEW — logRecallEvent
      server.ts                          # MODIFY — fire-and-forget logging on the success path
    dashboard/
      api.ts                             # MODIFY — GET /analytics
  drizzle/
    0004_recall_events.sql               # NEW — generated, not hand-written
  dashboard-web/
    src/
      App.tsx                            # MODIFY — AnalyticsRow/AnalyticsTable, third tab, third fetch
      theme.css                          # MODIFY — .analytics-bar-*
  tests/
    mcp/
      recallEvents.test.ts               # NEW
      server.test.ts                     # MODIFY — instrumentation + non-blocking guarantee tests
    dashboard/
      api.test.ts                        # MODIFY — GET /analytics coverage
    setup.ts                             # MODIFY — add recall_events to the TRUNCATE list
```

---

### Task 1: Schema — `recall_events` table

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `tests/setup.ts`
- Generate: `drizzle/0004_recall_events.sql`

**Interfaces:**
- Produces: `recallEvents` table, `recallEventsRelations`. Consumed by Task 2 (`logRecallEvent`) and Task 4 (`GET /analytics`).

- [ ] **Step 1: Add the table**

All needed imports (`pgTable`, `uuid`, `timestamp`, `index`) are already imported. Add after `slackUserProfilesRelations` (the last block from `slack-display-name-resolution`):

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

No `workspaceId` column directly on `recall_events` — it's derivable via `namespaceId → namespaces.workspaceId`, keeping one source of truth rather than a denormalized copy that could drift. Deliberately not logged: message content, recalled text, file references — only `namespaceId`, `delegateUserId`, `createdAt`.

- [ ] **Step 2: Generate the migration**

```bash
npm run db:generate -- --name=recall_events
```

Expected: `drizzle/0004_recall_events.sql` created. Read it to confirm it's just the new table + its two indexes.

- [ ] **Step 3: Add the new table to the test-suite TRUNCATE list**

```typescript
await db.execute(
  sql`TRUNCATE TABLE recall_events, slack_user_profiles, namespace_linear_issues, files, messages, namespaces, users, installations, workspace_claim_tokens, workspaces RESTART IDENTITY CASCADE`,
);
```

- [ ] **Step 4: Verify and commit**

```bash
npm test
```

```bash
git add src/db/schema.ts tests/setup.ts drizzle/
git commit -m "feat(db): add recall_events table"
```

---

### Task 2: Recall-event logger (`src/mcp/recallEvents.ts`)

**Files:**
- Create: `src/mcp/recallEvents.ts`
- Create: `tests/mcp/recallEvents.test.ts`

**Interfaces:**
- Consumes: `recallEvents` (Task 1).
- Produces: `logRecallEvent(db, namespaceId, delegateUserId): Promise<void>` — a plain throwing function, kept unit-testable on its own terms. Consumed by Task 3, which owns the non-blocking guarantee at the call site.

- [ ] **Step 1: Write the module**

```typescript
// src/mcp/recallEvents.ts
import type { Database } from "../db/client.js";
import { recallEvents } from "../db/schema.js";

/**
 * Deliberately a plain throwing function, not a swallow-errors-internally one — the "never block
 * or fail the recall response" guarantee is enforced at the call site in server.ts (fire-and-
 * forget with its own .catch), not here. Keeping this function honest about failures is what
 * makes it independently unit-testable.
 */
export async function logRecallEvent(db: Database, namespaceId: string, delegateUserId: string): Promise<void> {
  await db.insert(recallEvents).values({ namespaceId, delegateUserId });
}
```

- [ ] **Step 2: Unit test**

```typescript
// tests/mcp/recallEvents.test.ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, users, recallEvents } from "../../src/db/schema.js";
import { logRecallEvent } from "../../src/mcp/recallEvents.js";

describe("logRecallEvent", () => {
  it("inserts exactly one row with the given namespaceId/delegateUserId and a fresh createdAt", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" })
      .returning();
    const [user] = await db.insert(users).values({ workspaceId: workspace.id, slackUserId: "U1" }).returning();

    const before = Date.now();
    await logRecallEvent(db, namespace.id, user.id);
    const after = Date.now();

    const rows = await db.select().from(recallEvents).where(eq(recallEvents.namespaceId, namespace.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].delegateUserId).toBe(user.id);
    expect(rows[0].createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(rows[0].createdAt.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  it("rejects when given a namespaceId that doesn't exist (FK violation) — callers must expect this to throw", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2", name: "T" }).returning();
    const [user] = await db.insert(users).values({ workspaceId: workspace.id, slackUserId: "U2" }).returning();

    await expect(logRecallEvent(db, "00000000-0000-0000-0000-000000000000", user.id)).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Verify and commit**

```bash
npm test
```

```bash
git add src/mcp/recallEvents.ts tests/mcp/recallEvents.test.ts
git commit -m "feat(mcp): add recall-event logger"
```

---

### Task 3: Instrumentation in the recall tool's success path

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `tests/mcp/server.test.ts`

**Interfaces:**
- Consumes: `logRecallEvent` (Task 2).
- `recallTool.ts` is **not modified** by this task.

- [ ] **Step 1: Wire the fire-and-forget call into `server.ts`**

Add the import:

```typescript
import { logRecallEvent } from "./recallEvents.js";
```

In the tool handler, immediately after `result.authorized` is confirmed `true` and before the response is constructed:

```typescript
const result = await recallNamespace(db, delegateUser, namespaceId);
if (!result.authorized) {
  return { content: [{ type: "text", text: "Not authorized to recall this namespace" }], isError: true };
}

// Fire-and-forget: this is the one place in the codebase where a DB write is intentionally NOT
// awaited inline. A logging failure (e.g. a transient DB error) must never delay or fail the
// recall response — do not "fix" this into a blocking `await`.
logRecallEvent(db, result.namespaceId, delegateUser.id).catch((err) => {
  console.error("Failed to log recall event:", err);
});

return {
  content: [
    {
      type: "text",
      text: JSON.stringify({ namespaceId: result.namespaceId, messages: result.messages }),
    },
  ],
};
```

- [ ] **Step 2: Add instrumentation coverage to `tests/mcp/server.test.ts`**

Add imports at the top: `recallEvents` to the schema import line, `vi` (already imported).

```typescript
it("logs exactly one recall_events row on a successful call", async () => {
  const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T20", name: "T" }).returning();
  const [namespace] = await db
    .insert(namespaces)
    .values({ workspaceId: workspace.id, channelId: "C20", threadTs: "20.0" })
    .returning();
  await db.insert(messages).values({ namespaceId: namespace.id, slackUserId: "U1", text: "hi", slackTs: "20.0" });
  const { plaintext, hash } = generateDelegateKey();
  await db.insert(users).values({ workspaceId: workspace.id, slackUserId: "U1", delegateKeyHash: hash });

  const { httpServer, url } = await startTestServer();
  try {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${plaintext}` } },
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);

    await client.callTool({ name: "recall", arguments: { namespaceId: namespace.id } });
    // logRecallEvent is fire-and-forget; give its promise a tick to land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rows = await db.select().from(recallEvents).where(eq(recallEvents.namespaceId, namespace.id));
    expect(rows).toHaveLength(1);
  } finally {
    httpServer.close();
  }
});

it("does not log an event for an unauthorized recall call", async () => {
  const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T21", name: "T" }).returning();
  const [namespace] = await db
    .insert(namespaces)
    .values({ workspaceId: workspace.id, channelId: "C21", threadTs: "21.0" })
    .returning();
  await db.insert(messages).values({ namespaceId: namespace.id, slackUserId: "U-OTHER", text: "hi", slackTs: "21.0" });
  const { plaintext, hash } = generateDelegateKey();
  await db.insert(users).values({ workspaceId: workspace.id, slackUserId: "U-ME", delegateKeyHash: hash });

  const { httpServer, url } = await startTestServer();
  try {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${plaintext}` } },
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);

    const result = await client.callTool({ name: "recall", arguments: { namespaceId: namespace.id } });
    expect(result.isError).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rows = await db.select().from(recallEvents).where(eq(recallEvents.namespaceId, namespace.id));
    expect(rows).toHaveLength(0);
  } finally {
    httpServer.close();
  }
});
```

- [ ] **Step 3: Add the non-blocking guarantee test**

This needs `logRecallEvent` to reject while the rest of the handler keeps running normally. Wrap the import in `vi.mock` with `importOriginal` so every *other* test in the file keeps the real (DB-writing) implementation, and only this test overrides it:

At the top of the file, alongside the other imports:

```typescript
import { logRecallEvent } from "../../src/mcp/recallEvents.js";

vi.mock("../../src/mcp/recallEvents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mcp/recallEvents.js")>();
  return { ...actual, logRecallEvent: vi.fn(actual.logRecallEvent) };
});
```

Then the test:

```typescript
it("still returns the recall response, and logs to console.error, when logging the event fails", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(logRecallEvent).mockRejectedValueOnce(new Error("db unavailable"));

  const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T22", name: "T" }).returning();
  const [namespace] = await db
    .insert(namespaces)
    .values({ workspaceId: workspace.id, channelId: "C22", threadTs: "22.0" })
    .returning();
  await db.insert(messages).values({ namespaceId: namespace.id, slackUserId: "U1", text: "hi", slackTs: "22.0" });
  const { plaintext, hash } = generateDelegateKey();
  await db.insert(users).values({ workspaceId: workspace.id, slackUserId: "U1", delegateKeyHash: hash });

  const { httpServer, url } = await startTestServer();
  try {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${plaintext}` } },
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);

    const result = await client.callTool({ name: "recall", arguments: { namespaceId: namespace.id } });
    expect(result.isError).toBeUndefined();
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
    expect(JSON.parse(text).messages).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(consoleError).toHaveBeenCalledWith("Failed to log recall event:", expect.any(Error));
  } finally {
    httpServer.close();
    consoleError.mockRestore();
  }
});
```

- [ ] **Step 4: Verify and commit**

```bash
npm test
```

```bash
git add src/mcp/server.ts tests/mcp/server.test.ts
git commit -m "feat(mcp): log successful recall calls without blocking the response"
```

---

### Task 4: Dashboard API — `GET /analytics`

**Files:**
- Modify: `src/dashboard/api.ts`
- Modify: `tests/dashboard/api.test.ts`

**Interfaces:**
- Consumes: `recallEvents` (Task 1).
- Produces: `GET /api/dashboard/analytics` → `{ namespaceId, label, channelId, recallCount, lastRecalledAt }[]`, sorted by `lastRecalledAt` descending. Consumed by Task 5.

- [ ] **Step 1: Update imports**

Extend the existing `drizzle-orm` import line (alphabetical order preserved):

```typescript
import { and, count, desc, eq, inArray, isNotNull, max } from "drizzle-orm";
```

Extend the existing schema import line:

```typescript
import { installations, namespaces, users, workspaces, messages, files, namespaceLinearIssues, recallEvents } from "../db/schema.js";
```

- [ ] **Step 2: Add the route**

Add after the existing `POST /users/:id/revoke-key` route, before `return router;`:

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

Namespaces with zero recall events are simply absent (the `INNER JOIN` naturally excludes them) — no `:id` param, so no 404 case; a namespace belonging to another workspace never appears, full stop.

- [ ] **Step 3: Add coverage to `tests/dashboard/api.test.ts`**

```typescript
it("GET /analytics returns per-namespace recall counts sorted by most-recently-used", async () => {
  const app = buildTestApp();
  const workspace = await seedWorkspace("T13");
  const [namespaceA] = await db
    .insert(namespaces)
    .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.1", label: "Old thread" })
    .returning();
  const [namespaceB] = await db
    .insert(namespaces)
    .values({ workspaceId: workspace.id, channelId: "C2", threadTs: "2.1", label: "Recent thread" })
    .returning();
  const [user] = await db.insert(users).values({ workspaceId: workspace.id, slackUserId: "U1" }).returning();

  await db.insert(recallEvents).values([
    { namespaceId: namespaceA.id, delegateUserId: user.id, createdAt: new Date("2026-01-01T00:00:00Z") },
    { namespaceId: namespaceB.id, delegateUserId: user.id, createdAt: new Date("2026-01-02T00:00:00Z") },
    { namespaceId: namespaceB.id, delegateUserId: user.id, createdAt: new Date("2026-01-03T00:00:00Z") },
  ]);
  const cookie = await claimSessionCookie(app, workspace.id);

  const res = await request(app).get("/api/dashboard/analytics").set("Cookie", cookie);
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(2);
  expect(res.body[0].namespaceId).toBe(namespaceB.id);
  expect(res.body[0].recallCount).toBe(2);
  expect(res.body[1].namespaceId).toBe(namespaceA.id);
  expect(res.body[1].recallCount).toBe(1);
});

it("GET /analytics omits a namespace with zero recall events", async () => {
  const app = buildTestApp();
  const workspace = await seedWorkspace("T14");
  await db.insert(namespaces).values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.1" });
  const cookie = await claimSessionCookie(app, workspace.id);

  const res = await request(app).get("/api/dashboard/analytics").set("Cookie", cookie);
  expect(res.body).toEqual([]);
});

it("a workspace's session cannot see another workspace's recall activity", async () => {
  const app = buildTestApp();
  const workspaceA = await seedWorkspace("T15A");
  const workspaceB = await seedWorkspace("T15B");
  const [namespaceB] = await db
    .insert(namespaces)
    .values({ workspaceId: workspaceB.id, channelId: "C1", threadTs: "1.1" })
    .returning();
  const [userB] = await db.insert(users).values({ workspaceId: workspaceB.id, slackUserId: "U1" }).returning();
  await db.insert(recallEvents).values({ namespaceId: namespaceB.id, delegateUserId: userB.id });
  const cookieA = await claimSessionCookie(app, workspaceA.id);

  const res = await request(app).get("/api/dashboard/analytics").set("Cookie", cookieA);
  expect(res.body).toEqual([]);
});
```

Add `recallEvents` to the schema import line at the top of the test file.

- [ ] **Step 4: Verify and commit**

```bash
npm test
```

```bash
git add src/dashboard/api.ts tests/dashboard/api.test.ts
git commit -m "feat(dashboard): add GET /analytics recall-usage endpoint"
```

---

### Task 5: "Analytics" dashboard tab

**Files:**
- Modify: `dashboard-web/src/App.tsx`
- Modify: `dashboard-web/src/theme.css`

**Interfaces:**
- Consumes: `GET /api/dashboard/analytics` (Task 4).

- [ ] **Step 1: `theme.css` — bar styling**

Append:

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

- [ ] **Step 2: `App.tsx` — `AnalyticsRow` interface and `AnalyticsTable` component**

Add alongside the existing `NamespaceRow`/`UserRow` interfaces:

```tsx
interface AnalyticsRow {
  namespaceId: string;
  label: string | null;
  channelId: string;
  recallCount: number;
  lastRecalledAt: string;
}
```

Add alongside the existing `NamespacesTable`/`UsersTable` components:

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

The namespace cell reuses the existing `NamespaceDetail` view (`/dashboard/namespaces/:id`) rather than a new detail surface.

- [ ] **Step 3: Wire the third tab and fetch into `Dashboard`**

Add `analytics` state and a third `reload()` fetch:

```tsx
const [analytics, setAnalytics] = useState<AnalyticsRow[]>([]);

const reload = () => {
  // ... existing /me, /namespaces, /users fetches unchanged ...
  fetch("/api/dashboard/analytics")
    .then((res) => (res.ok ? res.json() : []))
    .then(setAnalytics);
};
```

Add the third item to the `tabs` array:

```tsx
const tabs: MorphingTabsItem[] = [
  {
    id: "namespaces",
    label: "Namespaces",
    content: <NamespacesTable namespaces={namespaces} onRename={renameNamespace} onArchive={archiveNamespace} />,
  },
  { id: "users", label: "Users", content: <UsersTable users={users} onRevoke={revokeKey} /> },
  { id: "analytics", label: "Analytics", content: <AnalyticsTable analytics={analytics} /> },
];
```

No other change to the `MorphingTabs` element itself — same `value`/`onValueChange`/`ariaLabel`/`classNames` props as today.

- [ ] **Step 4: Verify types and build**

```bash
npx tsc --noEmit -p dashboard-web/tsconfig.json
npm run build:dashboard
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard-web/src/App.tsx dashboard-web/src/theme.css
git commit -m "feat(dashboard): add Analytics tab showing per-namespace recall usage"
```

---

### Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full backend test suite**

```bash
npm test
```

Expected: all tests pass, including `recallEvents.test.ts`, the extended `server.test.ts`, and the extended `api.test.ts` coverage.

- [ ] **Step 2: Manual end-to-end check against the local test database**

Seed a workspace, claim a delegate key, make a couple of MCP `recall` calls against it (real or via a small script hitting `/mcp` with the delegate key), then confirm: the "Analytics" tab renders the expected namespace(s) with correct recall counts, the bar scales sensibly relative to the highest count, and "Last recalled" reflects the most recent call. Confirm a namespace never recalled does not appear, and the empty state ("No recall activity yet.") renders correctly for a fresh workspace.

- [ ] **Step 3: Self-review the full diff**

```bash
git diff slack-display-name-resolution --stat
```

Read every changed/new file. Confirm: `logRecallEvent` is never `await`ed inline at its call site in `server.ts`; the non-blocking guarantee test actually forces a rejection and asserts the response is still successful; `recallNamespace`/`recallTool.ts` are byte-for-byte untouched; `GET /analytics`'s cross-workspace isolation is covered.

- [ ] **Step 4: Full three-feature stack sanity check**

Since this is the last branch in the stack, do a final combined check before handing off:

```bash
git log --oneline main..HEAD
```

Confirm the log shows, in order, all of `linear-issue-linking`'s commits, then `slack-display-name-resolution`'s, then `usage-analytics`'s — the stack is linear with no unexpected merge commits. Then run `npm test` and `npm run build:dashboard` one final time from this branch tip as the combined-feature regression check.
