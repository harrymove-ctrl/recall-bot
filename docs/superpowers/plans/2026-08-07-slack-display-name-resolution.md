# Slack Display-Name Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Branch:** `slack-display-name-resolution`, based on the tip of `linear-issue-linking` (the **second** branch in the three-feature stack: `linear-issue-linking` → `slack-display-name-resolution` → `usage-analytics`). This means, before starting:

- `GET /namespaces/:id/messages` already returns `{ messages: [...], linearIssues: [...] }`, **not** a bare array (from `linear-issue-linking`'s Task 4). Every step below that touches this route or `NamespaceDetail.tsx`'s fetch handler builds on that shape — it does not reintroduce a bare array.
- `NamespaceDetail.tsx` already renders a "Linked issues" block and imports `MessageRow`/`LinearIssueRef` types; this plan only adds fields to the existing `MessageRow` interface and one line to its rendering, it does not touch the linked-issues section.
- `src/dashboard/api.ts` already imports `namespaceLinearIssues` and `linearIssueUrl`; this plan adds one more import line, it does not restructure the existing ones.

**Goal:** Resolve raw Slack IDs (`U0ALD7Q3JAW`) to real display names + avatars in the namespace detail message list and the Users list, cached in Postgres, degrading silently to today's raw-ID behavior whenever resolution isn't possible (which is guaranteed on day one, since the installed bot token lacks `users:read` until a human reinstalls the Slack app — see the spec's prerequisite note).

**Architecture:** A standalone cache table (`slack_user_profiles`, keyed by `(workspaceId, slackUserId)`) plus a resolution module that looks up the workspace's own `installations` row for the bot token, calls `users.info` per requested id with a staleness-aware cache (30-day TTL on success, 24h on failure), and never throws. Two dashboard routes call it and attach `displayName`/`avatarUrl` to their existing response objects. Two frontend files render an optional `<img class="avatar">` before the existing raw-ID text.

**Tech Stack:** Existing stack only (`@slack/web-api`'s `WebClient`, already a dependency; drizzle-orm; React 19; Vitest). No new dependencies.

## Global Constraints

- `resolveDisplayNames` must **never throw** — every Slack failure (auth-class or per-id) degrades to a negative cache write and a `console.warn`/`console.error`, never an exception that could turn into a 500 on `/namespaces/:id/messages` or `/users`.
- No installation row, or a `revokedAt`-set one, short-circuits to nulls for every requested id with **zero** Slack calls and zero cache writes.
- An auth-class Slack error (`missing_scope`, `invalid_auth`, `account_inactive`, `token_revoked`, `not_authed`) on the *first* id in a batch short-circuits every remaining id in that batch to a negative-cache write without calling Slack again — this is what keeps a cold cache against a still-missing scope to one wasted call per page load, not one per author.
- Every cache read/write goes through `resolveDisplayNames(db, req.workspaceId!, ...)` — the table's unique constraint is `(workspaceId, slackUserId)`, same "scope everything by the session's workspace" rule as every other route.
- Before committing each task, run `npx tsc --noEmit -p dashboard-web/tsconfig.json` (frontend tasks) and `npm test` (backend tasks).
- Generate the migration with `npm run db:generate -- --name=slack_user_profiles` — never hand-write migration SQL.

---

## File Structure

```
recall-bot/
  src/
    db/
      schema.ts                          # MODIFY — add slackUserProfiles table + relations
    slack/
      userProfiles.ts                    # NEW — resolveDisplayNames
    dashboard/
      api.ts                             # MODIFY — GET /namespaces/:id/messages, GET /users
  drizzle/
    0003_slack_user_profiles.sql         # NEW — generated, not hand-written
  dashboard-web/
    src/
      App.tsx                            # MODIFY — UserRow/UsersTable avatar+name
      NamespaceDetail.tsx                # MODIFY — MessageRow avatar+name
      theme.css                          # MODIFY — .avatar
  tests/
    slack/
      userProfiles.test.ts               # NEW
    dashboard/
      api.test.ts                        # MODIFY — mock @slack/web-api, extend coverage
    setup.ts                             # MODIFY — add slack_user_profiles to the TRUNCATE list
```

---

### Task 1: Schema — `slack_user_profiles` cache table

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `tests/setup.ts`
- Generate: `drizzle/0003_slack_user_profiles.sql`

**Interfaces:**
- Produces: `slackUserProfiles` table, `slackUserProfilesRelations`. Consumed by Task 2 (`resolveDisplayNames`).

- [ ] **Step 1: Add the table**

All needed imports (`pgTable`, `uuid`, `text`, `varchar`, `timestamp`, `unique`, `index`) are already imported. Add after `namespaceLinearIssuesRelations` (the last block from `linear-issue-linking`):

```typescript
export const slackUserProfiles = pgTable(
  "slack_user_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slackUserId: varchar("slack_user_id", { length: 32 }).notNull(),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    // The moment of the *last attempt*, success or failure. A null displayName with a fresh
    // resolvedAt IS a cached result — "we tried and got nothing usable" — which is what makes the
    // staleness policy double as both a cache TTL and a retry backoff with no extra status column.
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("slack_user_profiles_workspace_slack_user_unique").on(t.workspaceId, t.slackUserId),
    index("slack_user_profiles_workspace_id_idx").on(t.workspaceId),
  ],
);

export const slackUserProfilesRelations = relations(slackUserProfiles, ({ one }) => ({
  workspace: one(workspaces, { fields: [slackUserProfiles.workspaceId], references: [workspaces.id] }),
}));
```

This is a standalone table, not new columns on `users` — `users` only holds rows for people who've issued a delegate key, while message authors are a broader, overlapping-but-different population.

- [ ] **Step 2: Generate the migration**

```bash
npm run db:generate -- --name=slack_user_profiles
```

Expected: `drizzle/0003_slack_user_profiles.sql` created. Read it to confirm it's just the new table.

- [ ] **Step 3: Add the new table to the test-suite TRUNCATE list**

```typescript
await db.execute(
  sql`TRUNCATE TABLE slack_user_profiles, namespace_linear_issues, files, messages, namespaces, users, installations, workspace_claim_tokens, workspaces RESTART IDENTITY CASCADE`,
);
```

- [ ] **Step 4: Verify and commit**

```bash
npm test
```

```bash
git add src/db/schema.ts tests/setup.ts drizzle/
git commit -m "feat(db): add slack_user_profiles cache table"
```

---

### Task 2: Resolution module (`src/slack/userProfiles.ts`)

**Files:**
- Create: `src/slack/userProfiles.ts`
- Create: `tests/slack/userProfiles.test.ts`

**Interfaces:**
- Consumes: `slackUserProfiles`, `installations` (Task 1), `WebClient` from `@slack/web-api` (already a dependency, same usage pattern as `src/slack/receiver.ts`).
- Produces: `resolveDisplayNames(db, workspaceId, slackUserIds): Promise<Map<string, { displayName: string | null; avatarUrl: string | null }>>` — consumed by Task 3.

- [ ] **Step 1: Write the module**

```typescript
// src/slack/userProfiles.ts
import { and, eq, inArray } from "drizzle-orm";
import { WebClient } from "@slack/web-api";
import type { Database } from "../db/client.js";
import { installations, slackUserProfiles } from "../db/schema.js";

export interface ResolvedProfile {
  displayName: string | null;
  avatarUrl: string | null;
}

const POSITIVE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days — names/avatars change rarely
const NEGATIVE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours — cheap to recheck, self-heals within a day of a reinstall

// "This token fundamentally can't call this method" — workspace-wide, not per-user. missing_scope
// is exactly what today's installed token hits until a human completes the Slack app reinstall.
const AUTH_CLASS_ERROR_CODES = new Set([
  "missing_scope",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "not_authed",
]);

function isStale(row: { displayName: string | null; resolvedAt: Date }): boolean {
  const ttl = row.displayName ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
  return Date.now() - row.resolvedAt.getTime() > ttl;
}

function slackErrorCode(error: unknown): string | undefined {
  return (error as { data?: { error?: string } })?.data?.error;
}

async function upsertProfile(
  db: Database,
  workspaceId: string,
  slackUserId: string,
  displayName: string | null,
  avatarUrl: string | null,
): Promise<ResolvedProfile> {
  const now = new Date();
  await db
    .insert(slackUserProfiles)
    .values({ workspaceId, slackUserId, displayName, avatarUrl, resolvedAt: now })
    .onConflictDoUpdate({
      target: [slackUserProfiles.workspaceId, slackUserProfiles.slackUserId],
      set: { displayName, avatarUrl, resolvedAt: now, updatedAt: now },
    });
  return { displayName, avatarUrl };
}

/**
 * Never throws. A total Slack outage or a still-missing users:read scope degrades every
 * requested id to { displayName: null, avatarUrl: null } — callers render the raw slackUserId
 * they already have, exactly like today.
 */
export async function resolveDisplayNames(
  db: Database,
  workspaceId: string,
  slackUserIds: string[],
): Promise<Map<string, ResolvedProfile>> {
  const result = new Map<string, ResolvedProfile>();
  const uniqueIds = [...new Set(slackUserIds)];
  if (uniqueIds.length === 0) return result;

  const [installation] = await db.select().from(installations).where(eq(installations.workspaceId, workspaceId));
  if (!installation || installation.revokedAt) {
    // A revoked (or nonexistent) install can never succeed — nothing worth remembering.
    for (const id of uniqueIds) result.set(id, { displayName: null, avatarUrl: null });
    return result;
  }

  const cacheRows = await db
    .select()
    .from(slackUserProfiles)
    .where(and(eq(slackUserProfiles.workspaceId, workspaceId), inArray(slackUserProfiles.slackUserId, uniqueIds)));
  const cacheByUserId = new Map(cacheRows.map((r) => [r.slackUserId, r]));

  const client = new WebClient(installation.botToken);
  let authClassFailureHit = false;

  for (const slackUserId of uniqueIds) {
    const cached = cacheByUserId.get(slackUserId);
    if (cached && !isStale(cached)) {
      result.set(slackUserId, { displayName: cached.displayName, avatarUrl: cached.avatarUrl });
      continue;
    }

    if (authClassFailureHit) {
      result.set(slackUserId, await upsertProfile(db, workspaceId, slackUserId, null, null));
      continue;
    }

    try {
      const apiResult = await client.users.info({ user: slackUserId });
      const profile = apiResult.user?.profile;
      const displayName = profile?.display_name || apiResult.user?.real_name || apiResult.user?.name || null;
      const avatarUrl = profile?.image_48 ?? null;
      result.set(slackUserId, await upsertProfile(db, workspaceId, slackUserId, displayName, avatarUrl));
    } catch (error) {
      const code = slackErrorCode(error);
      if (code && AUTH_CLASS_ERROR_CODES.has(code)) {
        authClassFailureHit = true;
        console.warn(
          `resolveDisplayNames: auth-class Slack error "${code}" for workspace ${workspaceId} — ` +
            `likely still waiting on the users:read reinstall; short-circuiting remaining lookups in this batch`,
        );
      } else {
        console.warn(`resolveDisplayNames: failed to resolve ${slackUserId} in workspace ${workspaceId}:`, error);
      }
      result.set(slackUserId, await upsertProfile(db, workspaceId, slackUserId, null, null));
    }
  }

  return result;
}
```

- [ ] **Step 2: Unit + integration tests**

```typescript
// tests/slack/userProfiles.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { workspaces, installations, slackUserProfiles } from "../../src/db/schema.js";
import { resolveDisplayNames } from "../../src/slack/userProfiles.js";

const usersInfoMock = vi.fn();

vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(() => ({ users: { info: usersInfoMock } })),
}));

beforeEach(() => {
  usersInfoMock.mockReset();
});

async function seedInstalledWorkspace(teamId: string) {
  const [workspace] = await db.insert(workspaces).values({ slackTeamId: teamId, name: teamId }).returning();
  await db.insert(installations).values({ workspaceId: workspace.id, botToken: "xoxb-fake", botUserId: "UBOT" });
  return workspace;
}

describe("resolveDisplayNames", () => {
  it("skips the network call on a fresh cache hit", async () => {
    const workspace = await seedInstalledWorkspace("T1");
    await db.insert(slackUserProfiles).values({
      workspaceId: workspace.id,
      slackUserId: "U1",
      displayName: "Ada",
      avatarUrl: "https://example.com/a.png",
      resolvedAt: new Date(),
    });

    const result = await resolveDisplayNames(db, workspace.id, ["U1"]);
    expect(result.get("U1")).toEqual({ displayName: "Ada", avatarUrl: "https://example.com/a.png" });
    expect(usersInfoMock).not.toHaveBeenCalled();
  });

  it("resolves and upserts a fresh id", async () => {
    const workspace = await seedInstalledWorkspace("T2");
    usersInfoMock.mockResolvedValue({
      user: { real_name: "Grace", profile: { display_name: "", image_48: "https://example.com/g.png" } },
    });

    const result = await resolveDisplayNames(db, workspace.id, ["U2"]);
    expect(result.get("U2")).toEqual({ displayName: "Grace", avatarUrl: "https://example.com/g.png" });

    const [row] = await db
      .select()
      .from(slackUserProfiles)
      .where(and(eq(slackUserProfiles.workspaceId, workspace.id), eq(slackUserProfiles.slackUserId, "U2")));
    expect(row.displayName).toBe("Grace");
  });

  it("short-circuits the rest of a batch on the first auth-class error, without extra Slack calls", async () => {
    const workspace = await seedInstalledWorkspace("T3");
    usersInfoMock.mockRejectedValue({ data: { error: "missing_scope" } });

    const result = await resolveDisplayNames(db, workspace.id, ["U3", "U4", "U5"]);
    expect([...result.values()]).toEqual([
      { displayName: null, avatarUrl: null },
      { displayName: null, avatarUrl: null },
      { displayName: null, avatarUrl: null },
    ]);
    expect(usersInfoMock).toHaveBeenCalledTimes(1);
  });

  it("negative-caches only the failing id on a per-id error, and still resolves the rest", async () => {
    const workspace = await seedInstalledWorkspace("T4");
    usersInfoMock.mockImplementation(async ({ user }: { user: string }) => {
      if (user === "U6") throw { data: { error: "user_not_found" } };
      return { user: { real_name: "Resolved", profile: {} } };
    });

    const result = await resolveDisplayNames(db, workspace.id, ["U6", "U7"]);
    expect(result.get("U6")).toEqual({ displayName: null, avatarUrl: null });
    expect(result.get("U7")?.displayName).toBe("Resolved");
    expect(usersInfoMock).toHaveBeenCalledTimes(2);
  });

  it("retries a negative-cached row past the 24h window", async () => {
    const workspace = await seedInstalledWorkspace("T5");
    await db.insert(slackUserProfiles).values({
      workspaceId: workspace.id,
      slackUserId: "U8",
      displayName: null,
      avatarUrl: null,
      resolvedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    usersInfoMock.mockResolvedValue({ user: { real_name: "Now Resolved", profile: {} } });

    const result = await resolveDisplayNames(db, workspace.id, ["U8"]);
    expect(result.get("U8")?.displayName).toBe("Now Resolved");
    expect(usersInfoMock).toHaveBeenCalledTimes(1);
  });

  it("retries a positive-cached row past the 30-day window", async () => {
    const workspace = await seedInstalledWorkspace("T6");
    await db.insert(slackUserProfiles).values({
      workspaceId: workspace.id,
      slackUserId: "U9",
      displayName: "Stale Name",
      avatarUrl: null,
      resolvedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });
    usersInfoMock.mockResolvedValue({ user: { real_name: "Fresh Name", profile: {} } });

    const result = await resolveDisplayNames(db, workspace.id, ["U9"]);
    expect(result.get("U9")?.displayName).toBe("Fresh Name");
  });

  it("returns nulls with zero Slack calls when there is no installation row", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T7", name: "T7" }).returning();
    const result = await resolveDisplayNames(db, workspace.id, ["U10"]);
    expect(result.get("U10")).toEqual({ displayName: null, avatarUrl: null });
    expect(usersInfoMock).not.toHaveBeenCalled();
  });

  it("returns nulls with zero Slack calls when the installation is revoked", async () => {
    const workspace = await seedInstalledWorkspace("T8");
    await db.update(installations).set({ revokedAt: new Date() }).where(eq(installations.workspaceId, workspace.id));

    const result = await resolveDisplayNames(db, workspace.id, ["U11"]);
    expect(result.get("U11")).toEqual({ displayName: null, avatarUrl: null });
    expect(usersInfoMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Verify and commit**

```bash
npm test
```

```bash
git add src/slack/userProfiles.ts tests/slack/userProfiles.test.ts
git commit -m "feat(slack): add Slack display-name/avatar resolution with a Postgres cache"
```

---

### Task 3: Dashboard API — `GET /namespaces/:id/messages` and `GET /users`

**Files:**
- Modify: `src/dashboard/api.ts`
- Modify: `tests/dashboard/api.test.ts`

**Interfaces:**
- Consumes: `resolveDisplayNames` (Task 2).
- Produces: each message object in `GET /namespaces/:id/messages`'s `messages` array, and each row of `GET /users`, gains `displayName: string | null` and `avatarUrl: string | null`. Consumed by Task 4.

- [ ] **Step 1: Add the import**

```typescript
import { resolveDisplayNames } from "../slack/userProfiles.js";
```

- [ ] **Step 2: `GET /namespaces/:id/messages` — attach profiles to each message**

The route already returns `{ messages: [...], linearIssues: [...] }` (from `linear-issue-linking`). Add profile resolution after `messageRows` is loaded, and merge into the existing per-message mapping:

```typescript
const messageRows = await db.select().from(messages).where(eq(messages.namespaceId, namespaceId)).orderBy(messages.slackTs);

const slackUserIds = [...new Set(messageRows.map((m) => m.slackUserId))];
const profiles = await resolveDisplayNames(db, req.workspaceId!, slackUserIds);

// ... existing fileRows / filesByMessageId / issueRows / linearIssues unchanged ...

res.json({
  messages: messageRows.map((m) => {
    const profile = profiles.get(m.slackUserId);
    return {
      id: m.id,
      slackUserId: m.slackUserId,
      displayName: profile?.displayName ?? null,
      avatarUrl: profile?.avatarUrl ?? null,
      text: m.text,
      slackTs: m.slackTs,
      createdAt: m.createdAt,
      files: (filesByMessageId.get(m.id) ?? []).map((f) => ({
        id: f.id,
        originalName: f.originalName,
        mimeType: f.mimeType,
        status: f.status,
      })),
    };
  }),
  linearIssues,
});
```

- [ ] **Step 3: `GET /users` — attach profiles to each row**

```typescript
router.get("/users", auth, async (req: DashboardRequest, res: Response) => {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.workspaceId, req.workspaceId!), isNotNull(users.delegateKeyHash)));

  const slackUserIds = rows.map((u) => u.slackUserId);
  const profiles = await resolveDisplayNames(db, req.workspaceId!, slackUserIds);

  res.json(
    rows.map((u) => {
      const profile = profiles.get(u.slackUserId);
      return {
        id: u.id,
        slackUserId: u.slackUserId,
        displayName: profile?.displayName ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
        keyIssuedOrRotatedAt: u.updatedAt,
      };
    }),
  );
});
```

Workspace scoping is inherited for free — `resolveDisplayNames` is called with the same `req.workspaceId!` every other route uses, and the cache table itself is keyed by `workspaceId`.

- [ ] **Step 4: Mock `@slack/web-api` in `tests/dashboard/api.test.ts` and extend coverage**

Add near the top of the file (after the existing imports):

```typescript
import { vi } from "vitest"; // add `vi` to the existing `{ describe, it, expect }` import from "vitest"

vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    users: { info: vi.fn().mockRejectedValue({ data: { error: "missing_scope" } }) },
  })),
}));
```

This matches today's real-world state: `seedWorkspace`'s `botToken: "xoxb-fake"` seed data plus a `missing_scope`-rejecting mock exercises exactly the "scope missing" path end-to-end, without making a real network call.

Extend the existing `"GET /namespaces/:id/messages returns the captured thread..."` test:

```typescript
expect(res.body.messages[0].displayName).toBeNull();
expect(res.body.messages[0].avatarUrl).toBeNull();
```

Extend the existing `"GET /users lists only users with an active key..."` test:

```typescript
expect(list.body[0].displayName).toBeNull();
expect(list.body[0].avatarUrl).toBeNull();
```

Add a new cross-workspace isolation test:

```typescript
it("a workspace's session never sees a cached name/avatar seeded against another workspace's identical Slack user id", async () => {
  const app = buildTestApp();
  const workspaceA = await seedWorkspace("T12A");
  const workspaceB = await seedWorkspace("T12B");
  const [namespaceA] = await db
    .insert(namespaces)
    .values({ workspaceId: workspaceA.id, channelId: "C1", threadTs: "1.1" })
    .returning();
  await db.insert(messages).values({ namespaceId: namespaceA.id, slackUserId: "U1", text: "hi", slackTs: "1.1" });
  await db.insert(slackUserProfiles).values({
    workspaceId: workspaceB.id,
    slackUserId: "U1",
    displayName: "Bob From Workspace B",
    avatarUrl: "https://example.com/bob.png",
    resolvedAt: new Date(),
  });
  const cookieA = await claimSessionCookie(app, workspaceA.id);

  const res = await request(app).get(`/api/dashboard/namespaces/${namespaceA.id}/messages`).set("Cookie", cookieA);
  expect(res.body.messages[0].displayName).toBeNull();
});
```

Add `slackUserProfiles` to the schema import line at the top of the test file.

- [ ] **Step 5: Verify and commit**

```bash
npm test
```

```bash
git add src/dashboard/api.ts tests/dashboard/api.test.ts
git commit -m "feat(dashboard): resolve Slack display names/avatars on namespaces and users routes"
```

---

### Task 4: Dashboard frontend — avatar + name rendering

**Files:**
- Modify: `dashboard-web/src/App.tsx`
- Modify: `dashboard-web/src/NamespaceDetail.tsx`
- Modify: `dashboard-web/src/theme.css`

**Interfaces:**
- Consumes: `displayName`/`avatarUrl` fields from Task 3.

- [ ] **Step 1: `theme.css` — `.avatar`**

Append:

```css
.avatar {
  width: var(--space-4);
  height: var(--space-4);
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid var(--color-border);
  vertical-align: middle;
  margin-right: var(--space-1);
}
```

- [ ] **Step 2: `App.tsx` — `UserRow` + `UsersTable`**

```tsx
interface UserRow {
  id: string;
  slackUserId: string;
  displayName: string | null;
  avatarUrl: string | null;
  keyIssuedOrRotatedAt: string;
}
```

In `UsersTable`, replace the `<td>{u.slackUserId}</td>` cell:

```tsx
<td>
  {u.avatarUrl && (
    <img
      className="avatar"
      src={u.avatarUrl}
      alt=""
      onError={(e) => {
        e.currentTarget.style.display = "none";
      }}
    />
  )}
  {u.displayName ?? u.slackUserId}
</td>
```

- [ ] **Step 3: `NamespaceDetail.tsx` — `MessageRow` + message-meta line**

```tsx
interface MessageRow {
  id: string;
  slackUserId: string;
  displayName: string | null;
  avatarUrl: string | null;
  text: string;
  slackTs: string;
  createdAt: string;
  files: MessageFile[];
}
```

Replace the `message-meta` paragraph:

```tsx
<p className="message-meta">
  {m.avatarUrl && (
    <img
      className="avatar"
      src={m.avatarUrl}
      alt=""
      onError={(e) => {
        e.currentTarget.style.display = "none";
      }}
    />
  )}
  {m.displayName ?? m.slackUserId} — {new Date(m.createdAt).toLocaleString()}
</p>
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
git commit -m "feat(dashboard): render resolved Slack display names and avatars"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full backend test suite**

```bash
npm test
```

Expected: all tests pass, including `userProfiles.test.ts` and the extended `api.test.ts` coverage.

- [ ] **Step 2: Manual end-to-end check against the local test database**

With the local seed data's `botToken: "xoxb-fake"` (no real `users:read` scope), confirm the dashboard behaves exactly as before this feature: raw Slack IDs render in both the namespace detail message list and the Users list, no console errors, no broken-image icons. This is the expected, correct behavior *before* a human reinstalls the Slack app — do not chase "real names aren't showing" as a bug in this local environment.

- [ ] **Step 3: Self-review the full diff**

```bash
git diff linear-issue-linking --stat
```

Read every changed/new file. Confirm: `resolveDisplayNames` never throws under any tested failure mode; the auth-class short-circuit behavior is exercised and asserted (call-count assertion, not just return value); cross-tenant isolation is covered for the new cache table; no change to the capture pipeline, the MCP recall tool, or Slack OAuth scopes.
