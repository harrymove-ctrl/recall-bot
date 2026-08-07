# Linear Issue Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Branch:** `linear-issue-linking`, based on `main` (== the merged `dashboard-tabs` tip — `App.tsx` already renders `MorphingTabs` with "Namespaces"/"Users" tabs, `NamespaceDetail.tsx` already exists). This is the **first** branch in a three-feature stack (`linear-issue-linking` → `slack-display-name-resolution` → `usage-analytics`); the other two are built on top of this one's tip once it's done, so keep its diff exactly what's described here — no speculative extras a later branch would have to route around.

**Goal:** Detect Linear issue permalinks (`linear.app/<slug>/issue/<KEY>-<n>`) in captured Slack messages, store them in a new join table, and surface them as badges on the namespace list and namespace detail views.

**Architecture:** A pure-regex extraction module writes to a new `namespace_linear_issues` table via two call sites in the existing capture pipeline (live messages and thread backfill/re-tag). Two dashboard API routes gain a `linearIssues` field — one additively, one via a breaking (but fully-owned) response-shape change from a bare array to `{ messages, linearIssues }`. Two frontend files render the new badges.

**Tech Stack:** Existing stack only (Express 5, drizzle-orm, React 19, Vitest). No new dependencies.

## Global Constraints

- `recordLinearIssueLinks` must never throw out of its own call sites — link detection is best-effort and must never block or fail message/file capture. Each ref insert is wrapped in its own try/catch.
- `GET /namespaces/:id/messages`'s response shape changes from a bare array to `{ messages: [...], linearIssues: [...] }`. This is a deliberate breaking change — its only consumers (`NamespaceDetail.tsx` and its test coverage) are updated in the same task.
- Every new/changed dashboard route stays scoped by `req.workspaceId!`, following the existing pattern exactly (see `src/dashboard/api.ts`'s current routes).
- Before committing each task, run `npx tsc --noEmit -p dashboard-web/tsconfig.json` (for frontend tasks) and `npm test` (for backend tasks). Run the full `npm test` once at the end regardless.
- Generate the migration with `npm run db:generate -- --name=namespace_linear_issues` — never hand-write migration SQL, per repo convention.

---

## File Structure

```
recall-bot/
  src/
    db/
      schema.ts                          # MODIFY — add namespaceLinearIssues table + relations
    slack/
      linearLinks.ts                     # NEW — extraction + DB-writing helper
      events.ts                          # MODIFY — wire recordLinearIssueLinks into handleMessage
      backfill.ts                        # MODIFY — wire recordLinearIssueLinks into backfillThread
    dashboard/
      api.ts                             # MODIFY — GET /namespaces, GET /namespaces/:id/messages
  drizzle/
    0002_namespace_linear_issues.sql     # NEW — generated, not hand-written
  dashboard-web/
    src/
      App.tsx                            # MODIFY — NamespaceRow/NamespacesTable badge column
      NamespaceDetail.tsx                # MODIFY — fetch shape + "Linked issues" section
      theme.css                          # MODIFY — .issue-badge, .linked-issues
  tests/
    slack/
      linearLinks.test.ts                # NEW
      events.test.ts                     # MODIFY — extend handleMessage coverage
      backfill.test.ts                   # MODIFY — extend backfillThread coverage
    dashboard/
      api.test.ts                        # MODIFY — update existing assertions + new coverage
    setup.ts                             # MODIFY — add namespace_linear_issues to the TRUNCATE list
```

---

### Task 1: Schema — `namespace_linear_issues` table

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `tests/setup.ts`
- Generate: `drizzle/0002_namespace_linear_issues.sql` (and `drizzle/meta/0002_snapshot.json`, `_journal.json` update)

**Interfaces:**
- Produces: `namespaceLinearIssues` table, `namespaceLinearIssuesRelations`, extended `namespacesRelations`. Consumed by Task 2 (`recordLinearIssueLinks`) and Task 4 (dashboard routes).

- [ ] **Step 1: Add the table**

All needed imports (`pgTable`, `uuid`, `varchar`, `timestamp`, `unique`, `index`) are already imported at the top of `schema.ts` — no import changes needed. Add after the `files` table definition:

```typescript
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

- [ ] **Step 2: Add relations**

Extend the existing `namespacesRelations` (do not replace it — add the one new key):

```typescript
export const namespacesRelations = relations(namespaces, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [namespaces.workspaceId], references: [workspaces.id] }),
  messages: many(messages),
  linearIssues: many(namespaceLinearIssues),
}));
```

Add a new relation block after `filesRelations`:

```typescript
export const namespaceLinearIssuesRelations = relations(namespaceLinearIssues, ({ one }) => ({
  namespace: one(namespaces, { fields: [namespaceLinearIssues.namespaceId], references: [namespaces.id] }),
}));
```

- [ ] **Step 3: Generate the migration**

```bash
npm run db:generate -- --name=namespace_linear_issues
```

Expected: `drizzle/0002_namespace_linear_issues.sql` created, `drizzle/meta/_journal.json` gets a new entry, `drizzle/meta/0002_snapshot.json` created. Read the generated SQL to confirm it's just a `CREATE TABLE` + two constraints/indexes — nothing unexpected.

- [ ] **Step 4: Add the new table to the test-suite TRUNCATE list**

In `tests/setup.ts`, the `afterEach` hook's `TRUNCATE` statement is an explicit, exhaustive list (not relying on `CASCADE` alone for documentation purposes, even though cascade would cover it functionally). Add the new table:

```typescript
await db.execute(
  sql`TRUNCATE TABLE namespace_linear_issues, files, messages, namespaces, users, installations, workspace_claim_tokens, workspaces RESTART IDENTITY CASCADE`,
);
```

- [ ] **Step 5: Verify and commit**

```bash
npm test
```

Expected: all existing tests still pass (schema-only change, nothing references the new table yet).

```bash
git add src/db/schema.ts tests/setup.ts drizzle/
git commit -m "feat(db): add namespace_linear_issues table"
```

---

### Task 2: Detection module (`src/slack/linearLinks.ts`)

**Files:**
- Create: `src/slack/linearLinks.ts`
- Create: `tests/slack/linearLinks.test.ts`

**Interfaces:**
- Consumes: `namespaceLinearIssues` (Task 1), `Database` from `../db/client.js`.
- Produces: `LinearIssueRef`, `extractLinearIssueRefs`, `linearIssueUrl`, `recordLinearIssueLinks` — consumed by Task 3 (capture pipeline) and Task 4 (dashboard routes, for `linearIssueUrl` only).

- [ ] **Step 1: Write the module**

```typescript
// src/slack/linearLinks.ts
import type { Database } from "../db/client.js";
import { namespaceLinearIssues } from "../db/schema.js";

// Matches `linear.app/<slug>/issue/<KEY>-<digits>` anywhere in the text, unanchored — this
// handles Slack's own <url> and <url|label> bracket markup, and plain unwrapped URLs, without
// needing to strip Slack's <...|...> syntax first. Deliberately does NOT match non-issue
// linear.app URLs (e.g. linear.app/mysten-labs/settings) since those lack the /issue/<KEY>-<n>
// segment.
const LINEAR_ISSUE_URL_RE =
  /linear\.app\/([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)\/issue\/([a-zA-Z][a-zA-Z0-9]{1,9}-\d+)/g;

export interface LinearIssueRef {
  workspaceSlug: string;
  issueIdentifier: string; // normalized uppercase, e.g. "WALM-297"
}

/**
 * Pure extraction, deduped within the call. Dedup key is issueIdentifier alone (matching the
 * namespace_linear_issues unique constraint, which is (namespaceId, issueIdentifier) without
 * workspaceSlug) — first-seen workspaceSlug for a given identifier wins.
 */
export function extractLinearIssueRefs(text: string): LinearIssueRef[] {
  const refs = new Map<string, LinearIssueRef>();
  for (const match of text.matchAll(LINEAR_ISSUE_URL_RE)) {
    const [, workspaceSlug, rawIdentifier] = match;
    const issueIdentifier = rawIdentifier.toUpperCase();
    if (!refs.has(issueIdentifier)) {
      refs.set(issueIdentifier, { workspaceSlug, issueIdentifier });
    }
  }
  return [...refs.values()];
}

export function linearIssueUrl(ref: LinearIssueRef): string {
  return `https://linear.app/${ref.workspaceSlug}/issue/${ref.issueIdentifier}`;
}

/**
 * Best-effort: each ref is inserted independently, and a failure on one must never block the
 * others or bubble up to the caller (capture must never fail because of link detection). Mirrors
 * captureSlackFile's per-item defensive posture in ./files.ts.
 */
export async function recordLinearIssueLinks(params: {
  db: Database;
  namespaceId: string;
  text: string;
}): Promise<void> {
  const { db, namespaceId, text } = params;
  const refs = extractLinearIssueRefs(text);

  for (const ref of refs) {
    try {
      await db
        .insert(namespaceLinearIssues)
        .values({ namespaceId, workspaceSlug: ref.workspaceSlug, issueIdentifier: ref.issueIdentifier })
        .onConflictDoNothing({
          target: [namespaceLinearIssues.namespaceId, namespaceLinearIssues.issueIdentifier],
        });
    } catch (error) {
      console.error(
        `recordLinearIssueLinks: failed to record ${ref.issueIdentifier} for namespace ${namespaceId}:`,
        error,
      );
    }
  }
}
```

- [ ] **Step 2: Unit + integration tests**

```typescript
// tests/slack/linearLinks.test.ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, namespaceLinearIssues } from "../../src/db/schema.js";
import { extractLinearIssueRefs, linearIssueUrl, recordLinearIssueLinks } from "../../src/slack/linearLinks.js";

describe("extractLinearIssueRefs", () => {
  it("matches Slack's bare <url> bracket form", () => {
    const refs = extractLinearIssueRefs("see <https://linear.app/mysten-labs/issue/WALM-297>");
    expect(refs).toEqual([{ workspaceSlug: "mysten-labs", issueIdentifier: "WALM-297" }]);
  });

  it("matches Slack's <url|label> bracket form", () => {
    const refs = extractLinearIssueRefs(
      "see <https://linear.app/mysten-labs/issue/WALM-297/memory-read-api|WALM-297: Memory read API>",
    );
    expect(refs).toEqual([{ workspaceSlug: "mysten-labs", issueIdentifier: "WALM-297" }]);
  });

  it("returns multiple distinct issues from one message", () => {
    const refs = extractLinearIssueRefs(
      "blocked by <https://linear.app/mysten-labs/issue/WALM-1> and <https://linear.app/mysten-labs/issue/WALM-2>",
    );
    expect(refs.map((r) => r.issueIdentifier)).toEqual(["WALM-1", "WALM-2"]);
  });

  it("dedups a repeated mention within one call", () => {
    const refs = extractLinearIssueRefs(
      "<https://linear.app/mysten-labs/issue/WALM-297> ... also <https://linear.app/mysten-labs/issue/WALM-297>",
    );
    expect(refs).toHaveLength(1);
  });

  it("normalizes a hand-typed lowercase identifier to uppercase", () => {
    const refs = extractLinearIssueRefs("https://linear.app/mysten-labs/issue/walm-297");
    expect(refs[0].issueIdentifier).toBe("WALM-297");
  });

  it("ignores a non-issue linear.app URL", () => {
    expect(extractLinearIssueRefs("https://linear.app/mysten-labs/settings")).toEqual([]);
  });

  it("returns [] for plain text with no link", () => {
    expect(extractLinearIssueRefs("just talking about the launch")).toEqual([]);
  });
});

describe("linearIssueUrl", () => {
  it("reconstructs the bare-identifier URL, dropping any descriptive slug", () => {
    expect(linearIssueUrl({ workspaceSlug: "mysten-labs", issueIdentifier: "WALM-297" })).toBe(
      "https://linear.app/mysten-labs/issue/WALM-297",
    );
  });
});

describe("recordLinearIssueLinks", () => {
  it("inserts one row per distinct ref, and a repeat call is a no-op", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" })
      .returning();

    await recordLinearIssueLinks({
      db,
      namespaceId: namespace.id,
      text: "<https://linear.app/mysten-labs/issue/WALM-1>",
    });
    await recordLinearIssueLinks({
      db,
      namespaceId: namespace.id,
      text: "<https://linear.app/mysten-labs/issue/WALM-1>",
    });

    const rows = await db.select().from(namespaceLinearIssues).where(eq(namespaceLinearIssues.namespaceId, namespace.id));
    expect(rows).toHaveLength(1);
  });

  it("inserts two rows for two distinct refs", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "2.0" })
      .returning();

    await recordLinearIssueLinks({
      db,
      namespaceId: namespace.id,
      text: "<https://linear.app/mysten-labs/issue/WALM-1> and <https://linear.app/mysten-labs/issue/WALM-2>",
    });

    const rows = await db.select().from(namespaceLinearIssues).where(eq(namespaceLinearIssues.namespaceId, namespace.id));
    expect(rows).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Verify and commit**

```bash
npm test
```

```bash
git add src/slack/linearLinks.ts tests/slack/linearLinks.test.ts
git commit -m "feat(slack): add Linear issue link detection module"
```

---

### Task 3: Capture-pipeline wiring

**Files:**
- Modify: `src/slack/events.ts`
- Modify: `src/slack/backfill.ts`
- Modify: `tests/slack/events.test.ts`
- Modify: `tests/slack/backfill.test.ts`

**Interfaces:**
- Consumes: `recordLinearIssueLinks` from `./linearLinks.js` (Task 2).

- [ ] **Step 1: Wire into `handleMessage` (`src/slack/events.ts`)**

Add the import:

```typescript
import { recordLinearIssueLinks } from "./linearLinks.js";
```

In `handleMessage`, after the existing `messageRow` insert, alongside the existing file-capture block:

```typescript
if (messageRow && message.files?.length) {
  for (const file of message.files) {
    await captureSlackFile({ db, file, botToken, messageId: messageRow.id });
  }
}

if (messageRow) {
  await recordLinearIssueLinks({ db, namespaceId: namespace.id, text: message.text ?? "" });
}
```

Gated on `messageRow` because a live event only ever represents genuinely new content — nothing to retroactively rescan here.

- [ ] **Step 2: Wire into `backfillThread` (`src/slack/backfill.ts`)**

Add the import:

```typescript
import { recordLinearIssueLinks } from "./linearLinks.js";
```

Inside the `for (const raw of page.messages ?? [])` loop, call `recordLinearIssueLinks` for **every** raw message — newly inserted or already existing — and position it **before** the `if (rawFiles.length === 0) continue;` early-exit (that early-continue is correct for file capture but would wrongly skip link detection for a message with a Linear link and no attachment):

```typescript
for (const raw of page.messages ?? []) {
  if (!raw.ts || !raw.user) continue;

  const [messageRow] = await db
    .insert(messages)
    .values({
      namespaceId: namespace.id,
      slackUserId: raw.user,
      text: raw.text ?? "",
      slackTs: raw.ts,
    })
    .onConflictDoNothing({ target: [messages.namespaceId, messages.slackTs] })
    .returning();

  // Runs unconditionally — for newly inserted AND already-existing messages — so re-tagging a
  // thread doubles as retroactive link detection for namespaces captured before this feature
  // existed. onConflictDoNothing on the join table makes this cheap and idempotent.
  await recordLinearIssueLinks({ db, namespaceId: namespace.id, text: raw.text ?? "" });

  // onConflictDoNothing returns [] on a skipped row
  const rawFiles = (raw as { files?: SlackFileObject[] }).files ?? [];
  if (rawFiles.length === 0) continue;

  // ... rest unchanged (file capture / retryUnresolvedFiles)
}
```

- [ ] **Step 3: Extend `tests/slack/events.test.ts`**

Add to the `describe("handleMessage", ...)` block:

```typescript
it("records a Linear issue link found in a captured reply", async () => {
  const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2b", name: "T" }).returning();
  const [namespace] = await db
    .insert(namespaces)
    .values({ workspaceId: workspace.id, channelId: "C2b", threadTs: "2.100" })
    .returning();

  await handleMessage({
    db,
    botToken: "xoxb-token",
    workspaceId: workspace.id,
    message: {
      channel: "C2b",
      ts: "2.101",
      thread_ts: "2.100",
      user: "U1",
      text: "blocked by <https://linear.app/mysten-labs/issue/WALM-297>",
    } as any,
  });

  const rows = await db.select().from(namespaceLinearIssues).where(eq(namespaceLinearIssues.namespaceId, namespace.id));
  expect(rows).toHaveLength(1);
  expect(rows[0].issueIdentifier).toBe("WALM-297");
});

it("records nothing for a message with no Linear link", async () => {
  const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2c", name: "T" }).returning();
  const [namespace] = await db
    .insert(namespaces)
    .values({ workspaceId: workspace.id, channelId: "C2c", threadTs: "2.200" })
    .returning();

  await handleMessage({
    db,
    botToken: "xoxb-token",
    workspaceId: workspace.id,
    message: { channel: "C2c", ts: "2.201", thread_ts: "2.200", user: "U1", text: "no link here" } as any,
  });

  const rows = await db.select().from(namespaceLinearIssues).where(eq(namespaceLinearIssues.namespaceId, namespace.id));
  expect(rows).toHaveLength(0);
});
```

Add imports: `namespaceLinearIssues` to the schema import line.

- [ ] **Step 4: Extend `tests/slack/backfill.test.ts`**

Add two cases (read the existing file first to match its exact `fakeWebClient`/param helper shapes):

```typescript
it("populates the join table from a Linear link found during a thread replay", async () => {
  const [workspace] = await db.insert(workspaces).values({ slackTeamId: "TL1", name: "T" }).returning();
  const client = fakeWebClient([
    { messages: [{ ts: "30.000", user: "U1", text: "see <https://linear.app/mysten-labs/issue/WALM-9>" }] },
  ]);

  const { namespaceId } = await backfillThread({
    db,
    client,
    workspaceId: workspace.id,
    channelId: "C30",
    threadTs: "30.000",
    botToken: "xoxb-token",
  });

  const rows = await db.select().from(namespaceLinearIssues).where(eq(namespaceLinearIssues.namespaceId, namespaceId));
  expect(rows).toHaveLength(1);
  expect(rows[0].issueIdentifier).toBe("WALM-9");
});

it("retroactively detects a Linear link in a message captured before this feature existed", async () => {
  const [workspace] = await db.insert(workspaces).values({ slackTeamId: "TL2", name: "T" }).returning();
  const [namespace] = await db
    .insert(namespaces)
    .values({ workspaceId: workspace.id, channelId: "C31", threadTs: "31.000" })
    .returning();
  // Simulates a message stored by an earlier backfill, before Linear link detection shipped.
  await db.insert(messages).values({
    namespaceId: namespace.id,
    slackUserId: "U1",
    text: "see <https://linear.app/mysten-labs/issue/WALM-10>",
    slackTs: "31.000",
  });

  const client = fakeWebClient([
    { messages: [{ ts: "31.000", user: "U1", text: "see <https://linear.app/mysten-labs/issue/WALM-10>" }] },
  ]);

  await backfillThread({ db, client, workspaceId: workspace.id, channelId: "C31", threadTs: "31.000", botToken: "xoxb-token" });

  const rows = await db.select().from(namespaceLinearIssues).where(eq(namespaceLinearIssues.namespaceId, namespace.id));
  expect(rows).toHaveLength(1);
  expect(rows[0].issueIdentifier).toBe("WALM-10");
});
```

Add `namespaceLinearIssues` to the schema import line.

- [ ] **Step 5: Verify and commit**

```bash
npm test
```

```bash
git add src/slack/events.ts src/slack/backfill.ts tests/slack/events.test.ts tests/slack/backfill.test.ts
git commit -m "feat(slack): detect Linear issue links on capture and re-tag/backfill"
```

---

### Task 4: Dashboard API — `GET /namespaces` and `GET /namespaces/:id/messages`

**Files:**
- Modify: `src/dashboard/api.ts`
- Modify: `tests/dashboard/api.test.ts`

**Interfaces:**
- Consumes: `namespaceLinearIssues`, `linearIssueUrl` (Task 1 & 2).
- Produces: `GET /namespaces` rows gain `linearIssues: { identifier, url }[]`. `GET /namespaces/:id/messages` response shape changes from a bare array to `{ messages: [...], linearIssues: [...] }` — **breaking change**, consumed by Task 5.

- [ ] **Step 1: Update imports**

```typescript
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { installations, namespaces, users, workspaces, messages, files, namespaceLinearIssues } from "../db/schema.js";
import { linearIssueUrl } from "../slack/linearLinks.js";
```

- [ ] **Step 2: `GET /namespaces` gains `linearIssues`**

```typescript
router.get("/namespaces", auth, async (req: DashboardRequest, res: Response) => {
  const rows = await db
    .select()
    .from(namespaces)
    .where(eq(namespaces.workspaceId, req.workspaceId!))
    .orderBy(desc(namespaces.createdAt));

  const namespaceIds = rows.map((n) => n.id);
  const issueRows =
    namespaceIds.length > 0
      ? await db.select().from(namespaceLinearIssues).where(inArray(namespaceLinearIssues.namespaceId, namespaceIds))
      : [];
  const issuesByNamespaceId = new Map<string, { identifier: string; url: string }[]>();
  for (const issue of issueRows) {
    const list = issuesByNamespaceId.get(issue.namespaceId) ?? [];
    list.push({ identifier: issue.issueIdentifier, url: linearIssueUrl(issue) });
    issuesByNamespaceId.set(issue.namespaceId, list);
  }

  res.json(
    rows.map((n) => ({
      id: n.id,
      channelId: n.channelId,
      threadTs: n.threadTs,
      label: n.label,
      status: n.status,
      createdAt: n.createdAt,
      linearIssues: issuesByNamespaceId.get(n.id) ?? [],
    })),
  );
});
```

Safe by construction: `namespaceIds` was already derived from a `workspaceId`-scoped query, so this second query can't cross a tenant boundary — same reasoning as the existing `files` sub-query in `GET /namespaces/:id/messages`.

- [ ] **Step 3: `GET /namespaces/:id/messages` response shape change**

```typescript
router.get("/namespaces/:id/messages", auth, async (req: DashboardRequest, res: Response) => {
  const namespaceId = String(req.params.id);
  if (!UUID_RE.test(namespaceId)) {
    res.status(404).json({ error: "namespace_not_found" });
    return;
  }

  const [namespace] = await db
    .select()
    .from(namespaces)
    .where(and(eq(namespaces.id, namespaceId), eq(namespaces.workspaceId, req.workspaceId!)));
  if (!namespace) {
    res.status(404).json({ error: "namespace_not_found" });
    return;
  }

  const messageRows = await db.select().from(messages).where(eq(messages.namespaceId, namespaceId)).orderBy(messages.slackTs);

  const messageIds = messageRows.map((m) => m.id);
  const fileRows = messageIds.length > 0 ? await db.select().from(files).where(inArray(files.messageId, messageIds)) : [];
  const filesByMessageId = new Map<string, typeof fileRows>();
  for (const f of fileRows) {
    const list = filesByMessageId.get(f.messageId) ?? [];
    list.push(f);
    filesByMessageId.set(f.messageId, list);
  }

  const issueRows = await db.select().from(namespaceLinearIssues).where(eq(namespaceLinearIssues.namespaceId, namespaceId));
  const linearIssues = issueRows.map((issue) => ({ identifier: issue.issueIdentifier, url: linearIssueUrl(issue) }));

  res.json({
    messages: messageRows.map((m) => ({
      id: m.id,
      slackUserId: m.slackUserId,
      text: m.text,
      slackTs: m.slackTs,
      createdAt: m.createdAt,
      files: (filesByMessageId.get(m.id) ?? []).map((f) => ({
        id: f.id,
        originalName: f.originalName,
        mimeType: f.mimeType,
        status: f.status,
      })),
    })),
    linearIssues,
  });
});
```

- [ ] **Step 4: Update the existing test that assumes the old bare-array shape**

In `tests/dashboard/api.test.ts`, the test `"GET /namespaces/:id/messages returns the captured thread in order, with attached files"` currently reads `res.body` directly as the message array. Update to:

```typescript
expect(res.status).toBe(200);
expect(res.body.messages).toHaveLength(2);
expect(res.body.messages[0].text).toBe("first");
expect(res.body.messages[0].files).toHaveLength(1);
expect(res.body.messages[0].files[0].originalName).toBe("diagram.png");
expect(res.body.messages[1].text).toBe("second");
expect(res.body.messages[1].files).toHaveLength(0);
expect(res.body.linearIssues).toEqual([]);
```

The 404 test (`"GET /namespaces/:id/messages returns 404 for a namespace owned by another workspace"`) needs no change — it only asserts `res.status`.

- [ ] **Step 5: New coverage for linked-issue behavior**

Add to `tests/dashboard/api.test.ts`:

```typescript
it("GET /namespaces includes linked Linear issues, deduped, per namespace", async () => {
  const app = buildTestApp();
  const workspace = await seedWorkspace("T9");
  const [namespace] = await db
    .insert(namespaces)
    .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.1" })
    .returning();
  await db.insert(namespaceLinearIssues).values({
    namespaceId: namespace.id,
    workspaceSlug: "mysten-labs",
    issueIdentifier: "WALM-297",
  });
  const cookie = await claimSessionCookie(app, workspace.id);

  const res = await request(app).get("/api/dashboard/namespaces").set("Cookie", cookie);
  expect(res.body[0].linearIssues).toEqual([
    { identifier: "WALM-297", url: "https://linear.app/mysten-labs/issue/WALM-297" },
  ]);
});

it("GET /namespaces/:id/messages includes linked Linear issues in the new response shape", async () => {
  const app = buildTestApp();
  const workspace = await seedWorkspace("T10");
  const [namespace] = await db
    .insert(namespaces)
    .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.1" })
    .returning();
  await db.insert(namespaceLinearIssues).values({
    namespaceId: namespace.id,
    workspaceSlug: "mysten-labs",
    issueIdentifier: "WALM-42",
  });
  const cookie = await claimSessionCookie(app, workspace.id);

  const res = await request(app).get(`/api/dashboard/namespaces/${namespace.id}/messages`).set("Cookie", cookie);
  expect(res.body.linearIssues).toEqual([
    { identifier: "WALM-42", url: "https://linear.app/mysten-labs/issue/WALM-42" },
  ]);
});

it("a workspace's session cannot see another workspace's linked Linear issues via either endpoint", async () => {
  const app = buildTestApp();
  const workspaceA = await seedWorkspace("T11A");
  const workspaceB = await seedWorkspace("T11B");
  const [namespaceB] = await db
    .insert(namespaces)
    .values({ workspaceId: workspaceB.id, channelId: "C1", threadTs: "1.1" })
    .returning();
  await db.insert(namespaceLinearIssues).values({
    namespaceId: namespaceB.id,
    workspaceSlug: "mysten-labs",
    issueIdentifier: "WALM-99",
  });
  const cookieA = await claimSessionCookie(app, workspaceA.id);

  const list = await request(app).get("/api/dashboard/namespaces").set("Cookie", cookieA);
  expect(list.body).toHaveLength(0);

  const messagesRes = await request(app)
    .get(`/api/dashboard/namespaces/${namespaceB.id}/messages`)
    .set("Cookie", cookieA);
  expect(messagesRes.status).toBe(404);
});
```

Add `namespaceLinearIssues` to the existing schema import line at the top of the test file.

- [ ] **Step 6: Verify and commit**

```bash
npm test
```

```bash
git add src/dashboard/api.ts tests/dashboard/api.test.ts
git commit -m "feat(dashboard): surface linked Linear issues on namespaces routes"
```

---

### Task 5: Dashboard frontend — badges

**Files:**
- Modify: `dashboard-web/src/App.tsx`
- Modify: `dashboard-web/src/NamespaceDetail.tsx`
- Modify: `dashboard-web/src/theme.css`

**Interfaces:**
- Consumes: the `linearIssues` field and the new `{ messages, linearIssues }` response shape from Task 4.

- [ ] **Step 1: `theme.css` — badge styling**

Append:

```css
.issue-badge {
  display: inline-block;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  padding: 2px 8px;
  margin: 0 var(--space-1) var(--space-1) 0;
  font-size: 12px;
  color: var(--color-accent);
}

.issue-badge:hover {
  text-decoration: underline;
}

.linked-issues {
  margin-bottom: var(--space-3);
}
```

- [ ] **Step 2: `App.tsx` — `NamespaceRow` + `NamespacesTable` badge column**

```tsx
interface LinearIssueRef {
  identifier: string;
  url: string;
}

interface NamespaceRow {
  id: string;
  channelId: string;
  threadTs: string;
  label: string | null;
  status: string;
  createdAt: string;
  linearIssues: LinearIssueRef[];
}
```

In `NamespacesTable`, add a `<th>Linked issues</th>` after `<th>Created</th>`, and the matching `<td>` (empty cell if none — no placeholder text):

```tsx
<thead>
  <tr>
    <th>Label</th>
    <th>Channel</th>
    <th>Status</th>
    <th>Created</th>
    <th>Linked issues</th>
    <th></th>
    <th></th>
  </tr>
</thead>
<tbody>
  {namespaces.map((n) => (
    <tr key={n.id}>
      <td>...</td>
      <td>{n.channelId}</td>
      <td>{n.status}</td>
      <td>{new Date(n.createdAt).toLocaleDateString()}</td>
      <td>
        {n.linearIssues.map((issue) => (
          <a key={issue.identifier} className="issue-badge" href={issue.url} target="_blank" rel="noopener noreferrer">
            {issue.identifier}
          </a>
        ))}
      </td>
      <td><a href={`/dashboard/namespaces/${n.id}`}>View</a></td>
      <td>{n.status !== "archived" && <button onClick={() => onArchive(n.id)}>Archive</button>}</td>
    </tr>
  ))}
</tbody>
```

- [ ] **Step 3: `NamespaceDetail.tsx` — fetch shape + "Linked issues" section**

```tsx
interface LinearIssueRef {
  identifier: string;
  url: string;
}

interface NamespaceMessagesResponse {
  messages: MessageRow[];
  linearIssues: LinearIssueRef[];
}

export function NamespaceDetail({ namespaceId }: { namespaceId: string }) {
  const [messages, setMessages] = useState<MessageRow[] | null>(null);
  const [linearIssues, setLinearIssues] = useState<LinearIssueRef[]>([]);
  const [unauthorized, setUnauthorized] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetch(`/api/dashboard/namespaces/${namespaceId}/messages`).then(async (res) => {
      if (res.status === 401) {
        setUnauthorized(true);
        return;
      }
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      const body: NamespaceMessagesResponse = await res.json();
      setMessages(body.messages);
      setLinearIssues(body.linearIssues);
    });
  }, [namespaceId]);

  if (unauthorized) return <NoSession />;
  if (notFound) return <p>Namespace not found.</p>;
  if (!messages) return <p>Loading…</p>;

  return (
    <div>
      <p>
        <a href="/dashboard">← Back to namespaces</a>
      </p>
      <h1>Captured thread</h1>
      {linearIssues.length > 0 && (
        <div className="linked-issues">
          {linearIssues.map((issue) => (
            <a key={issue.identifier} className="issue-badge" href={issue.url} target="_blank" rel="noopener noreferrer">
              {issue.identifier}
            </a>
          ))}
        </div>
      )}
      {messages.length === 0 && <p>No messages captured yet.</p>}
      {messages.map((m) => (
        /* unchanged */
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Verify types and build**

```bash
npx tsc --noEmit -p dashboard-web/tsconfig.json
npm run build:dashboard
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard-web/src/App.tsx dashboard-web/src/NamespaceDetail.tsx dashboard-web/src/theme.css
git commit -m "feat(dashboard): render linked Linear issue badges"
```

---

### Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full backend test suite**

```bash
npm test
```

Expected: all tests pass, including the new `linearLinks`, `events`, `backfill`, and `api` coverage.

- [ ] **Step 2: Manual end-to-end check against the local test database**

Start the server locally, tag a thread whose message text contains a real-shaped Linear permalink (e.g. `https://linear.app/mysten-labs/issue/WALM-297/some-slug`), and confirm: the namespace list shows a `WALM-297` badge that opens Linear in a new tab; the namespace detail view shows the same badge in a "Linked issues" block above the message list; re-tagging an older thread (captured before this feature) retroactively adds the badge.

- [ ] **Step 3: Self-review the full diff**

```bash
git diff main --stat
```

Read every changed/new file. Confirm: `namespace_linear_issues` dedup key matches the spec; `recordLinearIssueLinks` never throws out of its call sites; the `GET /namespaces/:id/messages` shape change is fully reflected in both the frontend consumer and its test; cross-workspace isolation is covered for both changed routes.
