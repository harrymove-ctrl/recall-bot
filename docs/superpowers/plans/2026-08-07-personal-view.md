# Personal View (Self-Service Read-Only User Dashboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an individual Slack user log into a browser as themselves (not as the workspace) and see, read-only, exactly the namespaces they personally participated in and the messages inside them — via a new `/api/me/*` API surface, a new personal session cookie kept fully separate from the admin session, a personal claim-link delivered from `/recall-key`, and a new `/dashboard/me*` frontend surface that reuses `NamespaceDetail.tsx`'s presentation.

**Architecture:** Extract the one piece of logic that must never drift between two authorization surfaces — `recallNamespace()`'s participation check — into a shared `src/db/participation.ts` helper used by both the MCP tool and the new personal API. Add a fully parallel, never-shared session/claim-token pair (`userSession.ts`/`userAuth.ts`/`userClaimTokens.ts`) signed with a **distinct** secret from the admin session's, with a boot-time guard against the two secrets ever matching. Add `/api/me/*` routes in a new `meApi.ts`. Trigger personal-link delivery from the existing `/recall-key` command. Add a new `dashboard-web/src/MePage.tsx` for the list view and thin routing in `App.tsx`; extend `NamespaceDetail.tsx` with optional, backward-compatible props instead of duplicating it.

**Tech Stack:** Existing stack only (Express 5, drizzle-orm, Postgres, `@slack/bolt`, React 19, esbuild, Vitest). No new dependencies.

## Global Constraints

- **Do not touch** `src/dashboard/session.ts`, `src/dashboard/auth.ts`, or `src/dashboard/claimTokens.ts` — the admin session/auth/claim-token path is out of scope, full stop. The new personal equivalents are separate files with separate exports.
- **`USER_SESSION_SECRET` must never equal `DASHBOARD_SESSION_SECRET`.** This is enforced at boot in `src/server.ts` (Task 4), not just documented — see the design doc's Design reference for why a shared secret is a real cross-cookie forgery risk, not a style preference.
- **`findParticipantNamespace` (src/db/participation.ts) is the only place the "does this user have a message in this namespace" check is allowed to live.** Both `recallNamespace()` (MCP) and `GET /api/me/namespaces/:id/messages` call it. Do not write a second, independent version of this check anywhere.
- **Every `/api/me/*` route scopes by both `workspaceId` and `slackUserId`** (from the verified personal session), never by `workspaceId` alone — that's the admin pattern, and using it here would leak cross-user data within a workspace.
- **A resource the caller doesn't have standing to see returns `404`, never `401`/`403`, and is indistinguishable from a resource that doesn't exist at all.** (`401` is reserved for "no valid session at all," matching the existing admin convention.)
- ESM, extensionless imports, matching the rest of the codebase.
- Before committing each task, run `npx tsc --noEmit -p dashboard-web/tsconfig.json` (frontend tasks) and/or `npm test` (backend tasks) as applicable. Run the **full** `npm test` once at the end (Task 7).
- Migrations are always generated via `npm run db:generate`, never hand-written.
- Remember: `DATABASE_URL="postgres://recall:recall@localhost:55432/recall_test" npm test` uses a Postgres instance shared with other concurrent agents in this session — if a run looks like your seeded data vanished mid-test, another agent's suite truncated it; rerun, don't debug it as your own bug.

---

## File Structure

```
recall-bot/
  .env.example                                  # MODIFY — add USER_SESSION_SECRET
  drizzle/
    000X_user_claim_tokens.sql                  # NEW — generated, not hand-written
  src/
    db/
      schema.ts                                 # MODIFY — add userClaimTokens table
      participation.ts                          # NEW — findParticipantNamespace
    mcp/
      recallTool.ts                             # MODIFY — refactor to call findParticipantNamespace
    dashboard/
      userSession.ts                            # NEW — createUserSessionCookie / verifyUserSessionCookie
      userAuth.ts                                # NEW — requireUserSession, USER_SESSION_COOKIE_NAME
      userClaimTokens.ts                         # NEW — issueUserClaimToken / consumeUserClaimToken
      meApi.ts                                   # NEW — createMeApiRouter, /api/me/*
    slack/
      recallKeyCommand.ts                        # MODIFY — issuePersonalLoginLink, DM text, publicBaseUrl param
    server.ts                                    # MODIFY — env var, boot guard, routes, router mount
  dashboard-web/
    src/
      NamespaceDetail.tsx                        # MODIFY — additive optional props only
      MePage.tsx                                 # NEW — MeClaimView, PersonalNamespacesTable, PersonalDashboard, MeNamespaceDetail
      App.tsx                                    # MODIFY — routing branches only
  tests/
    setup.ts                                     # MODIFY — add user_claim_tokens to TRUNCATE
    db/
      participation.test.ts                      # NEW
    dashboard/
      userSession.test.ts                        # NEW
      userAuth.test.ts                            # NEW
      userClaimTokens.test.ts                     # NEW
      sessionIsolation.test.ts                    # NEW
      meApi.test.ts                                # NEW
    slack/
      recallKeyCommand.test.ts                    # MODIFY — add issuePersonalLoginLink cases
    server.wiring.test.ts                          # MODIFY — add boot-guard + new-route cases
```

---

### Task 1: Schema + shared participation helper

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/participation.ts`
- Modify: `src/mcp/recallTool.ts`
- Create: `drizzle/000X_user_claim_tokens.sql` (generated)
- Modify: `tests/setup.ts`
- Create: `tests/db/participation.test.ts`

**Interfaces:**
- Produces: `userClaimTokens` table (drizzle schema export); `findParticipantNamespace(db, workspaceId, slackUserId, namespaceId): Promise<{ id: string } | null>` from `src/db/participation.ts`. Tasks 2 and 3 depend on the table; Task 3 depends on `findParticipantNamespace`.
- Consumes: nothing new.

- [ ] **Step 1: Add the `userClaimTokens` table to `src/db/schema.ts`**

  Add near `workspaceClaimTokens` (keep claim-token tables adjacent):

  ```typescript
  export const userClaimTokens = pgTable(
    "user_claim_tokens",
    {
      id: uuid("id").defaultRandom().primaryKey(),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id, { onDelete: "cascade" }),
      slackUserId: varchar("slack_user_id", { length: 32 }).notNull(),
      tokenHash: text("token_hash").notNull().unique(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      usedAt: timestamp("used_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      index("user_claim_tokens_workspace_id_idx").on(t.workspaceId),
      index("user_claim_tokens_workspace_slack_user_idx").on(t.workspaceId, t.slackUserId),
    ],
  );
  ```

  No `relations()` block — `workspaceClaimTokens` doesn't have one either; stay consistent.

- [ ] **Step 2: Generate the migration**

  ```bash
  npm run db:generate -- --name=user_claim_tokens
  ```

  Expected: a new `drizzle/000X_user_claim_tokens.sql` (next sequential number after `0004_recall_events.sql`) plus an updated `drizzle/meta/_journal.json` and a new `drizzle/meta/000X_snapshot.json`. Read the generated SQL — confirm it's exactly `CREATE TABLE "user_claim_tokens" (...)` plus the FK and two indexes, nothing else touched. Do not hand-edit it.

- [ ] **Step 3: Add `tests/db/participation.test.ts`**

  ```typescript
  import { describe, it, expect } from "vitest";
  import { db } from "../../src/db/client.js";
  import { workspaces, namespaces, messages } from "../../src/db/schema.js";
  import { findParticipantNamespace } from "../../src/db/participation.js";

  async function seedThread() {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" })
      .returning();
    await db.insert(messages).values({ namespaceId: namespace.id, slackUserId: "U1", text: "hi", slackTs: "1.0" });
    return { workspace, namespace };
  }

  describe("findParticipantNamespace", () => {
    it("returns the namespace for an actual participant", async () => {
      const { workspace, namespace } = await seedThread();
      const result = await findParticipantNamespace(db, workspace.id, "U1", namespace.id);
      expect(result).toEqual({ id: namespace.id });
    });

    it("returns null for a user who never posted in the namespace", async () => {
      const { workspace, namespace } = await seedThread();
      expect(await findParticipantNamespace(db, workspace.id, "U-STRANGER", namespace.id)).toBeNull();
    });

    it("returns null for a namespace in a different workspace", async () => {
      const { namespace } = await seedThread();
      const [otherWorkspace] = await db.insert(workspaces).values({ slackTeamId: "T-OTHER", name: "T" }).returning();
      expect(await findParticipantNamespace(db, otherWorkspace.id, "U1", namespace.id)).toBeNull();
    });

    it("returns null for a namespace id that doesn't exist", async () => {
      const { workspace } = await seedThread();
      expect(await findParticipantNamespace(db, workspace.id, "U1", "00000000-0000-0000-0000-000000000000")).toBeNull();
    });
  });
  ```

  This is the exact same case coverage `recallTool.test.ts` already has for `recallNamespace`'s authorization behavior — deliberately, since Step 4 makes them the same code path.

  Create `src/db/participation.ts` (content per the design doc's Components #1) before running this test.

- [ ] **Step 4: Refactor `recallTool.ts` to call `findParticipantNamespace`**

  Replace the inline `namespace`/`participation` lookup at the top of `recallNamespace()` with:

  ```typescript
  const namespace = await findParticipantNamespace(db, delegateUser.workspaceId, delegateUser.slackUserId, namespaceId);
  if (!namespace) return { authorized: false };
  ```

  Add the import: `import { findParticipantNamespace } from "../db/participation.js";`. Nothing else in `recallNamespace()` (the message/file assembly, `RecallResult` shape) changes.

- [ ] **Step 5: Add `user_claim_tokens` to `tests/setup.ts`'s TRUNCATE list**

  ```typescript
  await db.execute(
    sql`TRUNCATE TABLE recall_events, slack_user_profiles, namespace_linear_issues, files, messages, namespaces, users, user_claim_tokens, installations, workspace_claim_tokens, workspaces RESTART IDENTITY CASCADE`,
  );
  ```

  (Position among the other tables doesn't matter — `CASCADE` handles ordering — but keep it near `workspace_claim_tokens` for readability.) Skipping this step means either FK errors in later tasks' tests, or worse, silent cross-test data leakage.

- [ ] **Step 6: Verify — new test passes, existing `recallTool` test still passes unmodified**

  ```bash
  DATABASE_URL="postgres://recall:recall@localhost:55432/recall_test" npx vitest run tests/db/participation.test.ts tests/mcp/recallTool.test.ts
  ```

  Expected: all pass. `tests/mcp/recallTool.test.ts` is not edited in this task — if it fails, the refactor in Step 4 changed behavior and must be fixed, not the test.

- [ ] **Step 7: Commit**

  ```bash
  git add src/db/schema.ts src/db/participation.ts src/mcp/recallTool.ts drizzle/ tests/setup.ts tests/db/participation.test.ts
  git commit -m "feat(dashboard): extract shared participation check, add user_claim_tokens table"
  ```

---

### Task 2: Personal session + claim-token modules

**Files:**
- Create: `src/dashboard/userSession.ts`
- Create: `src/dashboard/userAuth.ts`
- Create: `src/dashboard/userClaimTokens.ts`
- Create: `tests/dashboard/userSession.test.ts`
- Create: `tests/dashboard/userAuth.test.ts`
- Create: `tests/dashboard/userClaimTokens.test.ts`
- Create: `tests/dashboard/sessionIsolation.test.ts`

**Interfaces:**
- Consumes: `parseCookies` from the existing `src/dashboard/session.ts` (read-only import, not a modification); `userClaimTokens` table from Task 1.
- Produces: `createUserSessionCookie`, `verifyUserSessionCookie`, `USER_SESSION_COOKIE_NAME`, `requireUserSession`, `UserSessionRequest`, `issueUserClaimToken`, `consumeUserClaimToken`. Task 3 consumes all of these.

- [ ] **Step 1: Create `src/dashboard/userSession.ts`**

  ```typescript
  import { createHmac, timingSafeEqual } from "node:crypto";

  const ALGO = "sha256";
  const DEFAULT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days — matches the admin session's default

  function sign(payloadB64Url: string, secret: string): string {
    return createHmac(ALGO, secret).update(payloadB64Url).digest("base64url");
  }

  export interface UserSession {
    workspaceId: string;
    slackUserId: string;
  }

  export function createUserSessionCookie(
    workspaceId: string,
    slackUserId: string,
    secret: string,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
  ): string {
    const payload = { workspaceId, slackUserId, exp: Date.now() + maxAgeMs };
    const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = sign(payloadB64, secret);
    return `${payloadB64}.${sig}`;
  }

  export function verifyUserSessionCookie(cookieValue: string | undefined, secret: string): UserSession | null {
    if (!cookieValue) return null;

    const dot = cookieValue.lastIndexOf(".");
    if (dot === -1) return null;

    const payloadB64 = cookieValue.slice(0, dot);
    const sig = cookieValue.slice(dot + 1);

    let sigBuf: Buffer;
    let expectedBuf: Buffer;
    try {
      sigBuf = Buffer.from(sig, "base64url");
      expectedBuf = Buffer.from(sign(payloadB64, secret), "base64url");
    } catch {
      return null;
    }

    // timingSafeEqual THROWS on length mismatch, it does not return false —
    // must guard the length ourselves or a malformed cookie crashes the request.
    // (Same guard as src/dashboard/session.ts, copied deliberately — these two verifiers stay
    // fully independent modules, see docs/superpowers/specs/2026-08-07-personal-view-design.md.)
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    } catch {
      return null;
    }

    if (typeof payload !== "object" || payload === null) return null;
    const { workspaceId, slackUserId, exp } = payload as { workspaceId?: unknown; slackUserId?: unknown; exp?: unknown };
    if (typeof workspaceId !== "string") return null;
    if (typeof slackUserId !== "string") return null;
    if (typeof exp !== "number" || Date.now() > exp) return null;

    return { workspaceId, slackUserId };
  }
  ```

- [ ] **Step 2: Create `src/dashboard/userAuth.ts`**

  ```typescript
  import type { NextFunction, Request, RequestHandler, Response } from "express";
  import { parseCookies } from "./session.js";
  import { verifyUserSessionCookie } from "./userSession.js";

  export const USER_SESSION_COOKIE_NAME = "recall_user_session";

  export interface UserSessionRequest extends Request {
    workspaceId?: string;
    slackUserId?: string;
  }

  export function requireUserSession(secret: string): RequestHandler {
    return (req: UserSessionRequest, res: Response, next: NextFunction) => {
      const cookies = parseCookies(req.headers.cookie);
      const session = verifyUserSessionCookie(cookies[USER_SESSION_COOKIE_NAME], secret);
      if (!session) {
        res.status(401).json({ error: "no_active_session" });
        return;
      }
      req.workspaceId = session.workspaceId;
      req.slackUserId = session.slackUserId;
      next();
    };
  }
  ```

- [ ] **Step 3: Create `src/dashboard/userClaimTokens.ts`**

  ```typescript
  import { createHash, randomBytes } from "node:crypto";
  import { eq, and, isNull, gt } from "drizzle-orm";
  import type { Database } from "../db/client.js";
  import { userClaimTokens } from "../db/schema.js";

  const DEFAULT_EXPIRY_MS = 1000 * 60 * 60 * 24 * 7; // 7 days — matches workspace claim tokens

  function hashToken(plaintext: string): string {
    return createHash("sha256").update(plaintext).digest("hex");
  }

  export async function issueUserClaimToken(
    db: Database,
    workspaceId: string,
    slackUserId: string,
    expiryMs: number = DEFAULT_EXPIRY_MS,
  ): Promise<string> {
    const plaintext = randomBytes(24).toString("hex");
    await db.insert(userClaimTokens).values({
      workspaceId,
      slackUserId,
      tokenHash: hashToken(plaintext),
      expiresAt: new Date(Date.now() + expiryMs),
    });
    return plaintext;
  }

  export async function consumeUserClaimToken(
    db: Database,
    plaintext: string,
  ): Promise<{ workspaceId: string; slackUserId: string } | null> {
    const [row] = await db
      .update(userClaimTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(userClaimTokens.tokenHash, hashToken(plaintext)),
          isNull(userClaimTokens.usedAt),
          gt(userClaimTokens.expiresAt, new Date()),
        ),
      )
      .returning();

    return row ? { workspaceId: row.workspaceId, slackUserId: row.slackUserId } : null;
  }
  ```

- [ ] **Step 4: `tests/dashboard/userSession.test.ts`** — mirror `tests/dashboard/session.test.ts`'s cases exactly, against the new payload shape (round-trip; wrong secret; tampered payload; expired; malformed input doesn't throw), plus one extra: a payload missing `slackUserId` (e.g. hand-construct an admin-shaped cookie with the same signing function) is rejected.

- [ ] **Step 5: `tests/dashboard/userAuth.test.ts`** — mirror `tests/dashboard/auth.test.ts`'s three cases (401 no cookie, 401 garbage cookie, 200 + `req.workspaceId`/`req.slackUserId` attached) against `requireUserSession`/`USER_SESSION_COOKIE_NAME`.

- [ ] **Step 6: `tests/dashboard/userClaimTokens.test.ts`** — mirror `tests/dashboard/claimTokens.test.ts`'s four cases (issue-then-consume-once; unknown token rejected; expired token rejected; only one of two concurrent consumers succeeds) against `issueUserClaimToken`/`consumeUserClaimToken`, additionally asserting the returned `{ workspaceId, slackUserId }` on success.

- [ ] **Step 7: `tests/dashboard/sessionIsolation.test.ts`** (new file — cross-cutting property, doesn't belong in either single-module suite)

  ```typescript
  import { describe, it, expect } from "vitest";
  import { createSessionCookie, verifySessionCookie } from "../../src/dashboard/session.js";
  import { createUserSessionCookie, verifyUserSessionCookie } from "../../src/dashboard/userSession.js";

  describe("admin/personal session cross-cookie isolation", () => {
    it("documents the risk class: with a shared secret, a personal-session cookie also verifies as a valid admin session", () => {
      const SHARED = "shared-secret-if-misconfigured-long-enough";
      const userCookie = createUserSessionCookie("ws-1", "U100", SHARED);
      // The extra slackUserId field is silently ignored by verifySessionCookie — it only ever
      // reads workspaceId/exp. This is exactly why USER_SESSION_SECRET must differ in practice
      // (enforced at boot in src/server.ts) — this test exists to prove the risk is real, not
      // hypothetical, and to catch a regression if that boot guard is ever removed.
      expect(verifySessionCookie(userCookie, SHARED)).toEqual({ workspaceId: "ws-1" });
    });

    it("with distinct secrets, a personal-session cookie is never accepted as an admin session", () => {
      const userCookie = createUserSessionCookie("ws-1", "U100", "user-secret-long-enough");
      expect(verifySessionCookie(userCookie, "admin-secret-long-enough")).toBeNull();
    });

    it("an admin-session cookie is never accepted as a personal session (missing slackUserId), regardless of secret", () => {
      const adminCookie = createSessionCookie("ws-1", "shared-or-not-long-enough");
      expect(verifyUserSessionCookie(adminCookie, "shared-or-not-long-enough")).toBeNull();
    });
  });
  ```

- [ ] **Step 8: Verify**

  ```bash
  DATABASE_URL="postgres://recall:recall@localhost:55432/recall_test" npx vitest run tests/dashboard/userSession.test.ts tests/dashboard/userAuth.test.ts tests/dashboard/userClaimTokens.test.ts tests/dashboard/sessionIsolation.test.ts
  ```

  Expected: all pass (these are pure-function/in-memory tests except `userClaimTokens.test.ts`, which needs the DB from Task 1).

- [ ] **Step 9: Commit**

  ```bash
  git add src/dashboard/userSession.ts src/dashboard/userAuth.ts src/dashboard/userClaimTokens.ts tests/dashboard/userSession.test.ts tests/dashboard/userAuth.test.ts tests/dashboard/userClaimTokens.test.ts tests/dashboard/sessionIsolation.test.ts
  git commit -m "feat(dashboard): add personal session, auth middleware, and claim tokens (separate from admin)"
  ```

---

### Task 3: `/api/me` router

**Files:**
- Create: `src/dashboard/meApi.ts`
- Create: `tests/dashboard/meApi.test.ts`

**Interfaces:**
- Consumes: `findParticipantNamespace` (Task 1); `createUserSessionCookie`, `requireUserSession`, `USER_SESSION_COOKIE_NAME`, `UserSessionRequest`, `consumeUserClaimToken` (Task 2); `linearIssueUrl` (existing, `src/slack/linearLinks.ts`); `resolveDisplayNames` (existing, `src/slack/userProfiles.ts`).
- Produces: `createMeApiRouter(db, userSessionSecret): Router`. Task 4 mounts it.

- [ ] **Step 1: Create `src/dashboard/meApi.ts`**

  Full content per the design doc's Components #6 (all five routes: `POST /claim`, `POST /logout`, `GET /me`, `GET /namespaces`, `GET /namespaces/:id/messages`). Key points to get right while writing it:
  - The local `UUID_RE` constant is a fresh copy, not an import from `api.ts` — leave a one-line comment saying why (input-shape guard, not the authorization boundary, so no drift risk in duplicating a static regex).
  - `GET /namespaces/:id/messages` calls `findParticipantNamespace` and returns `404 { error: "namespace_not_found" }` on `null` — do not add a different status code for "wrong workspace" vs. "right workspace, not a participant." They must be the same response.
  - The message/file/`linearIssues` assembly after the gate mirrors `src/dashboard/api.ts`'s equivalent handler field-for-field (same response shape: `id`, `slackUserId`, `displayName`, `avatarUrl`, `text`, `slackTs`, `createdAt`, `files[]` with `id`/`originalName`/`mimeType`/`status`, plus top-level `linearIssues[]`) so the frontend can consume both through identical rendering code.

- [ ] **Step 2: Write `tests/dashboard/meApi.test.ts`** (supertest-based, mirroring `tests/dashboard/api.test.ts`'s structure)

  ```typescript
  import { describe, it, expect, vi } from "vitest";
  import express from "express";
  import request from "supertest";
  import { eq } from "drizzle-orm";
  import { db } from "../../src/db/client.js";
  import { workspaces, installations, namespaces, messages } from "../../src/db/schema.js";
  import { issueUserClaimToken } from "../../src/dashboard/userClaimTokens.js";
  import { createMeApiRouter } from "../../src/dashboard/meApi.js";

  vi.mock("@slack/web-api", () => ({
    WebClient: vi.fn().mockImplementation(() => ({
      users: { info: vi.fn().mockRejectedValue({ data: { error: "missing_scope" } }) },
    })),
  }));

  const SECRET = "test-secret-at-least-this-long";

  function buildTestApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/me", createMeApiRouter(db, SECRET));
    return app;
  }

  async function seedWorkspace(teamId: string) {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: teamId, name: `Team ${teamId}` }).returning();
    await db.insert(installations).values({ workspaceId: workspace.id, botToken: "xoxb-fake", botUserId: "UBOT" });
    return workspace;
  }

  async function claimSessionCookie(app: express.Express, workspaceId: string, slackUserId: string) {
    const token = await issueUserClaimToken(db, workspaceId, slackUserId);
    const res = await request(app).post("/api/me/claim").send({ token });
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    return (setCookie as unknown as string[])[0].split(";")[0];
  }

  describe("personal (/api/me) API", () => {
    it("POST /claim sets a session cookie for a valid token, and rejects reuse", async () => {
      const app = buildTestApp();
      const workspace = await seedWorkspace("M1");
      const token = await issueUserClaimToken(db, workspace.id, "U1");

      const first = await request(app).post("/api/me/claim").send({ token });
      expect(first.status).toBe(200);
      expect(first.headers["set-cookie"]).toBeDefined();

      const second = await request(app).post("/api/me/claim").send({ token });
      expect(second.status).toBe(400);
    });

    it("rejects every protected route with no cookie", async () => {
      const app = buildTestApp();
      expect((await request(app).get("/api/me/me")).status).toBe(401);
      expect((await request(app).get("/api/me/namespaces")).status).toBe(401);
      expect((await request(app).get(`/api/me/namespaces/${crypto.randomUUID()}/messages`)).status).toBe(401);
    });

    it("GET /namespaces lists only namespaces the session's slackUserId participated in, never another user's or another workspace's", async () => {
      const app = buildTestApp();
      const workspace = await seedWorkspace("M2");
      const otherWorkspace = await seedWorkspace("M2-OTHER");

      const [shared] = await db.insert(namespaces).values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" }).returning();
      const [mineOnly] = await db.insert(namespaces).values({ workspaceId: workspace.id, channelId: "C2", threadTs: "2.0" }).returning();
      const [theirsOnly] = await db.insert(namespaces).values({ workspaceId: workspace.id, channelId: "C3", threadTs: "3.0" }).returning();
      const [otherWorkspaceNs] = await db
        .insert(namespaces)
        .values({ workspaceId: otherWorkspace.id, channelId: "C4", threadTs: "4.0" })
        .returning();

      await db.insert(messages).values([
        { namespaceId: shared.id, slackUserId: "U1", text: "hi", slackTs: "1.0" },
        { namespaceId: shared.id, slackUserId: "U2", text: "hi back", slackTs: "1.1" },
        { namespaceId: mineOnly.id, slackUserId: "U1", text: "solo", slackTs: "2.0" },
        { namespaceId: theirsOnly.id, slackUserId: "U2", text: "not yours", slackTs: "3.0" },
        { namespaceId: otherWorkspaceNs.id, slackUserId: "U1", text: "wrong workspace", slackTs: "4.0" },
      ]);

      const cookie = await claimSessionCookie(app, workspace.id, "U1");
      const res = await request(app).get("/api/me/namespaces").set("Cookie", cookie);
      expect(res.status).toBe(200);
      const ids = res.body.map((n: { id: string }) => n.id).sort();
      expect(ids).toEqual([shared.id, mineOnly.id].sort());
      expect(ids).not.toContain(theirsOnly.id);
      expect(ids).not.toContain(otherWorkspaceNs.id);
    });

    it("GET /namespaces/:id/messages 404s for a namespace in the same workspace the caller never participated in", async () => {
      const app = buildTestApp();
      const workspace = await seedWorkspace("M3");
      const [theirsOnly] = await db.insert(namespaces).values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" }).returning();
      await db.insert(messages).values({ namespaceId: theirsOnly.id, slackUserId: "U2", text: "not yours", slackTs: "1.0" });

      const cookie = await claimSessionCookie(app, workspace.id, "U1");
      const res = await request(app).get(`/api/me/namespaces/${theirsOnly.id}/messages`).set("Cookie", cookie);
      expect(res.status).toBe(404);
    });

    it("GET /namespaces/:id/messages 404s for a namespace in a different workspace", async () => {
      const app = buildTestApp();
      const workspace = await seedWorkspace("M4");
      const otherWorkspace = await seedWorkspace("M4-OTHER");
      const [otherNs] = await db.insert(namespaces).values({ workspaceId: otherWorkspace.id, channelId: "C1", threadTs: "1.0" }).returning();
      await db.insert(messages).values({ namespaceId: otherNs.id, slackUserId: "U1", text: "hi", slackTs: "1.0" });

      const cookie = await claimSessionCookie(app, workspace.id, "U1");
      const res = await request(app).get(`/api/me/namespaces/${otherNs.id}/messages`).set("Cookie", cookie);
      expect(res.status).toBe(404);
    });

    it("GET /namespaces/:id/messages 404s for a malformed id instead of 500ing", async () => {
      const app = buildTestApp();
      const workspace = await seedWorkspace("M5");
      const cookie = await claimSessionCookie(app, workspace.id, "U1");
      const res = await request(app).get("/api/me/namespaces/not-a-uuid/messages").set("Cookie", cookie);
      expect(res.status).toBe(404);
    });

    it("GET /namespaces/:id/messages 200s with the full shape for an actual participant", async () => {
      const app = buildTestApp();
      const workspace = await seedWorkspace("M6");
      const [ns] = await db.insert(namespaces).values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" }).returning();
      await db.insert(messages).values({ namespaceId: ns.id, slackUserId: "U1", text: "hi", slackTs: "1.0" });

      const cookie = await claimSessionCookie(app, workspace.id, "U1");
      const res = await request(app).get(`/api/me/namespaces/${ns.id}/messages`).set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(1);
      expect(res.body.messages[0].text).toBe("hi");
      expect(res.body).toHaveProperty("linearIssues");
    });
  });
  ```

- [ ] **Step 3: Verify**

  ```bash
  DATABASE_URL="postgres://recall:recall@localhost:55432/recall_test" npx vitest run tests/dashboard/meApi.test.ts
  ```

  Expected: all pass. Pay particular attention to the "same workspace, not a participant" and "different workspace" cases both returning `404` — this is the test that would catch a regression of the whole point of this sub-project.

- [ ] **Step 4: Commit**

  ```bash
  git add src/dashboard/meApi.ts tests/dashboard/meApi.test.ts
  git commit -m "feat(dashboard): add /api/me personal read-only namespace API"
  ```

---

### Task 4: Wire `/recall-key` to issue and DM the personal login link; mount everything in `server.ts`

**Files:**
- Modify: `src/slack/recallKeyCommand.ts`
- Modify: `src/server.ts`
- Modify: `.env.example`
- Modify: `tests/slack/recallKeyCommand.test.ts`
- Modify: `tests/server.wiring.test.ts`

**Interfaces:**
- Consumes: `issueUserClaimToken` (Task 2), `createMeApiRouter` (Task 3).
- Produces: `issuePersonalLoginLink` (exported from `recallKeyCommand.ts`, for direct unit testing without mocking Bolt — matching how `issueDelegateKey` is already tested today).

- [ ] **Step 1: Add `issuePersonalLoginLink` and update `registerRecallKeyCommand`'s signature in `src/slack/recallKeyCommand.ts`**

  ```typescript
  import { issueUserClaimToken } from "../dashboard/userClaimTokens.js";

  export async function issuePersonalLoginLink(
    db: Database,
    workspaceId: string,
    slackUserId: string,
    publicBaseUrl: string,
  ): Promise<string> {
    const token = await issueUserClaimToken(db, workspaceId, slackUserId);
    return `${publicBaseUrl}/dashboard/me/claim?token=${token}`;
  }

  export function registerRecallKeyCommand(app: App, db: Database, publicBaseUrl: string): void {
    app.command("/recall-key", async ({ command, ack, client, logger, respond }) => {
      await ack();

      try {
        const workspaceIdRow = await resolveWorkspaceByTeamId(db, command.team_id);
        if (!workspaceIdRow) {
          // unchanged
        }

        const plaintext = await issueDelegateKey(db, workspaceIdRow.id, command.user_id);
        const loginLink = await issuePersonalLoginLink(db, workspaceIdRow.id, command.user_id, publicBaseUrl);

        const dm = await client.conversations.open({ users: command.user_id });
        await client.chat.postMessage({
          channel: dm.channel!.id!,
          text:
            `Here's your recall delegate key. Keep it secret — anyone with this key can recall any thread you've participated in:\n\`${plaintext}\`\n\n` +
            `Run \`/recall-key\` again any time to rotate it (this invalidates the old one).\n\n` +
            `Prefer a browser? View your captured threads here: ${loginLink}\n` +
            `(single-use, expires in 7 days — run /recall-key again any time for a fresh link)`,
        });
      } catch (error) {
        // unchanged
      }
    });
  }
  ```

- [ ] **Step 2: Update `src/server.ts`**

  - Capture `publicBaseUrl` once, before `createSlackReceiver(...)`, and reuse it for both `createSlackReceiver` and `registerRecallKeyCommand`:

    ```typescript
    const publicBaseUrl = requireEnv("PUBLIC_BASE_URL");

    const receiver = createSlackReceiver({ db: database, app, signingSecret: requireEnv("SLACK_SIGNING_SECRET"), clientId: requireEnv("SLACK_CLIENT_ID"), clientSecret: requireEnv("SLACK_CLIENT_SECRET"), stateSecret: requireEnv("SLACK_STATE_SECRET"), publicBaseUrl });
    const slackApp = createSlackApp(receiver);
    registerEventHandlers(slackApp, database);
    registerRecallKeyCommand(slackApp, database, publicBaseUrl);
    ```

  - After `const dashboardSessionSecret = requireEnv("DASHBOARD_SESSION_SECRET");`, add:

    ```typescript
    const userSessionSecret = requireEnv("USER_SESSION_SECRET");
    if (userSessionSecret === dashboardSessionSecret) {
      throw new Error(
        "USER_SESSION_SECRET must not equal DASHBOARD_SESSION_SECRET — a shared secret lets a personal " +
          "session cookie's payload (a superset of the admin cookie's shape) verify as a valid admin " +
          "session too. Generate a second, independent secret (openssl rand -hex 32).",
      );
    }
    ```

  - Add the three new sendFile routes, right after the existing `/dashboard/namespaces/:id` one and before `app.use("/dashboard", express.static(...))`:

    ```typescript
    app.get("/dashboard/me", (_req, res) => {
      res.sendFile("index.html", { root: DASHBOARD_DIST });
    });
    app.get("/dashboard/me/claim", (_req, res) => {
      res.sendFile("index.html", { root: DASHBOARD_DIST });
    });
    app.get("/dashboard/me/namespaces/:id", (_req, res) => {
      res.sendFile("index.html", { root: DASHBOARD_DIST });
    });
    ```

  - Add the import and mount the router, alongside the existing dashboard one:

    ```typescript
    import { createMeApiRouter } from "./dashboard/meApi.js";
    // ...
    app.use("/api/dashboard", createDashboardApiRouter(database, dashboardSessionSecret));
    app.use("/api/me", createMeApiRouter(database, userSessionSecret));
    ```

- [ ] **Step 3: Add `USER_SESSION_SECRET=` to `.env.example`**, next to `DASHBOARD_SESSION_SECRET`. If working from a local `.env` (per this repo's worktree convention), add a real value there too: `openssl rand -hex 32` — and confirm it is **different** from the value already in `DASHBOARD_SESSION_SECRET`.

- [ ] **Step 4: Add to `tests/slack/recallKeyCommand.test.ts`**

  ```typescript
  import { issuePersonalLoginLink } from "../../src/slack/recallKeyCommand.js";
  import { consumeUserClaimToken } from "../../src/dashboard/userClaimTokens.js";

  describe("issuePersonalLoginLink", () => {
    it("returns a claim URL whose token round-trips to the right workspace and user", async () => {
      const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T3", name: "T" }).returning();

      const link = await issuePersonalLoginLink(db, workspace.id, "U300", "https://example.up.railway.app");

      expect(link).toMatch(/^https:\/\/example\.up\.railway\.app\/dashboard\/me\/claim\?token=/);
      const token = new URL(link).searchParams.get("token")!;
      const result = await consumeUserClaimToken(db, token);
      expect(result).toEqual({ workspaceId: workspace.id, slackUserId: "U300" });
    });
  });
  ```

- [ ] **Step 5: Add to `tests/server.wiring.test.ts`**

  ```typescript
  it("refuses to boot when USER_SESSION_SECRET is not configured", () => {
    vi.stubEnv("USER_SESSION_SECRET", "");
    expect(() => buildApp(db)).toThrow("Missing required environment variable: USER_SESSION_SECRET");
  });

  it("refuses to boot when USER_SESSION_SECRET equals DASHBOARD_SESSION_SECRET", () => {
    vi.stubEnv("USER_SESSION_SECRET", process.env.DASHBOARD_SESSION_SECRET ?? "");
    expect(() => buildApp(db)).toThrow(/USER_SESSION_SECRET must not equal DASHBOARD_SESSION_SECRET/);
  });

  it("serves the personal-view SPA shell routes", async () => {
    const app = buildApp(db);
    for (const path of ["/dashboard/me", "/dashboard/me/claim", "/dashboard/me/namespaces/00000000-0000-0000-0000-000000000000"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.text).toContain("bundle.js");
    }
  });

  it("exposes /api/me/me and rejects unauthenticated calls", async () => {
    const app = buildApp(db);
    const res = await request(app).get("/api/me/me");
    expect(res.status).toBe(401);
  });
  ```

  Check the test-environment `.env`/CI setup already sets `DASHBOARD_SESSION_SECRET` and a distinct `USER_SESSION_SECRET` — the second new test above needs `DASHBOARD_SESSION_SECRET` to actually be set for its `vi.stubEnv` to be meaningful; if it's ever blank in the test environment, hardcode a literal matching value on both sides instead of reading `process.env`.

- [ ] **Step 6: Verify**

  ```bash
  DATABASE_URL="postgres://recall:recall@localhost:55432/recall_test" npx vitest run tests/slack/recallKeyCommand.test.ts tests/server.wiring.test.ts
  ```

  Expected: all pass, including the two new boot-guard cases.

- [ ] **Step 7: Commit**

  ```bash
  git add src/slack/recallKeyCommand.ts src/server.ts .env.example tests/slack/recallKeyCommand.test.ts tests/server.wiring.test.ts
  git commit -m "feat(dashboard): issue personal login link from /recall-key, mount /api/me and /dashboard/me routes"
  ```

---

### Task 5: Frontend — extend `NamespaceDetail.tsx` with optional props (no behavior change for the admin caller)

**Files:**
- Modify: `dashboard-web/src/NamespaceDetail.tsx`

**Interfaces:**
- Produces: `NamespaceDetail` gains optional `apiBase`, `backHref`, `unauthorizedMessage` props (all defaulted to today's hardcoded values). Task 6 is the first consumer of the non-default values.
- Consumes: nothing new.

- [ ] **Step 1: Widen the props type and thread `apiBase`/`backHref`/`unauthorizedMessage` through**

  ```tsx
  export function NamespaceDetail({
    namespaceId,
    apiBase = "/api/dashboard",
    backHref = "/dashboard",
    unauthorizedMessage = "No active session — check your Slack DM for the dashboard setup link.",
  }: {
    namespaceId: string;
    apiBase?: string;
    backHref?: string;
    unauthorizedMessage?: string;
  }) {
  ```

  Update the `fetch` call: `` fetch(`${apiBase}/namespaces/${namespaceId}/messages`) `` and its `useEffect` dependency array to `[namespaceId, apiBase]`.

  Replace `if (unauthorized) return <NoSession />;` with `if (unauthorized) return <p>{unauthorizedMessage}</p>;`.

  Replace the hardcoded `<a href="/dashboard">← Back to namespaces</a>` with `<a href={backHref}>← Back to namespaces</a>`.

- [ ] **Step 2: Remove the now-unused `import { NoSession } from "./App";`**

  Confirm nothing else in the file references `NoSession` before removing the import.

- [ ] **Step 3: Confirm `App.tsx`'s existing call site needs zero changes**

  `grep -n "NamespaceDetail namespaceId" dashboard-web/src/App.tsx` — should still read exactly `<NamespaceDetail namespaceId={namespaceMatch[1]} />`, with no new props. If it does, the defaults added in Step 1 are correct; if the admin view's behavior visibly changed, the defaults are wrong.

- [ ] **Step 4: Verify**

  ```bash
  npx tsc --noEmit -p dashboard-web/tsconfig.json
  npm run build:dashboard
  ```

  Expected: zero errors. Manually load `/dashboard/namespaces/:id` for an existing namespace (local dev server) and confirm it is pixel-for-pixel unchanged from before this task.

- [ ] **Step 5: Commit**

  ```bash
  git add dashboard-web/src/NamespaceDetail.tsx
  git commit -m "feat(dashboard): make NamespaceDetail's endpoint, back-link, and unauthorized copy configurable"
  ```

---

### Task 6: Frontend — new `MePage.tsx` and `App.tsx` routing

**Files:**
- Create: `dashboard-web/src/MePage.tsx`
- Modify: `dashboard-web/src/App.tsx`

**Interfaces:**
- Consumes: `NamespaceDetail` (Task 5, non-default props).
- Produces: `MeClaimView`, `PersonalDashboard`, `MeNamespaceDetail` exported from `MePage.tsx`, imported by `App.tsx`.

- [ ] **Step 1: Create `dashboard-web/src/MePage.tsx`**

  ```tsx
  import { useEffect, useState } from "react";
  import { NamespaceDetail } from "./NamespaceDetail";

  interface PersonalNamespaceRow {
    id: string;
    channelId: string;
    threadTs: string;
    label: string | null;
    status: string;
    createdAt: string;
  }

  interface PersonalIdentity {
    slackUserId: string;
    displayName: string | null;
  }

  const PERSONAL_NO_SESSION_MESSAGE = "No active session — run /recall-key in Slack and use the link it DMs you.";

  export function MeClaimView() {
    const [status, setStatus] = useState<"claiming" | "error">("claiming");
    const [message, setMessage] = useState("");

    useEffect(() => {
      const token = new URLSearchParams(window.location.search).get("token");
      if (!token) {
        setStatus("error");
        setMessage("Missing token in the link.");
        return;
      }
      fetch("/api/me/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(typeof body.error === "string" ? body.error : "claim_failed");
          }
          window.location.href = "/dashboard/me";
        })
        .catch((err: unknown) => {
          setStatus("error");
          setMessage(
            err instanceof Error && err.message === "invalid_or_expired_token"
              ? "This link has expired or was already used — run /recall-key in Slack again for a fresh one."
              : "Something went wrong logging you in.",
          );
        });
    }, []);

    if (status === "error") return <p>{message}</p>;
    return <p>Logging you in…</p>;
  }

  function MeNoSession() {
    return <p>{PERSONAL_NO_SESSION_MESSAGE}</p>;
  }

  function PersonalNamespacesTable({ namespaces }: { namespaces: PersonalNamespaceRow[] }) {
    if (namespaces.length === 0) {
      return <p>No captured threads yet — tag @recall-bot on a Slack thread you're part of.</p>;
    }
    return (
      <table>
        <thead>
          <tr>
            <th>Label</th>
            <th>Channel</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {namespaces.map((n) => (
            <tr key={n.id}>
              <td>{n.label ?? n.threadTs}</td>
              <td>{n.channelId}</td>
              <td>{new Date(n.createdAt).toLocaleDateString()}</td>
              <td>
                <a href={`/dashboard/me/namespaces/${n.id}`}>View</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  export function PersonalDashboard() {
    const [identity, setIdentity] = useState<PersonalIdentity | null>(null);
    const [namespaces, setNamespaces] = useState<PersonalNamespaceRow[]>([]);
    const [unauthorized, setUnauthorized] = useState(false);

    useEffect(() => {
      fetch("/api/me/me").then((res) => {
        if (res.status === 401) {
          setUnauthorized(true);
          return;
        }
        res.json().then(setIdentity);
      });
      fetch("/api/me/namespaces")
        .then((res) => (res.ok ? res.json() : []))
        .then(setNamespaces);
    }, []);

    if (unauthorized) return <MeNoSession />;
    if (!identity) return <p>Loading…</p>;

    return (
      <div>
        <h1>Your captured threads</h1>
        <p>Signed in as {identity.displayName ?? identity.slackUserId}</p>
        <PersonalNamespacesTable namespaces={namespaces} />
      </div>
    );
  }

  export function MeNamespaceDetail({ namespaceId }: { namespaceId: string }) {
    return (
      <NamespaceDetail
        namespaceId={namespaceId}
        apiBase="/api/me"
        backHref="/dashboard/me"
        unauthorizedMessage={PERSONAL_NO_SESSION_MESSAGE}
      />
    );
  }
  ```

  Note the fetch path is `/api/me/me` (the router is mounted at `/api/me`, and the identity route inside it is `/me` — matching the existing `/api/dashboard/me` naming shape exactly).

- [ ] **Step 2: Update `dashboard-web/src/App.tsx`'s routing**

  Add the import:

  ```tsx
  import { MeClaimView, PersonalDashboard, MeNamespaceDetail } from "./MePage";
  ```

  Replace the `App()` function's path-branching body with:

  ```tsx
  export function App() {
    const [gridMode, toggleGridMode] = useGridMode();
    const path = window.location.pathname;

    let view: JSX.Element;
    const meNamespaceMatch = path.match(/^\/dashboard\/me\/namespaces\/([0-9a-fA-F-]+)$/);
    if (path === "/dashboard/claim") {
      view = <ClaimView />;
    } else if (path === "/dashboard/me/claim") {
      view = <MeClaimView />;
    } else if (meNamespaceMatch) {
      view = <MeNamespaceDetail namespaceId={meNamespaceMatch[1]} />;
    } else if (path === "/dashboard/me") {
      view = <PersonalDashboard />;
    } else {
      const namespaceMatch = path.match(/^\/dashboard\/namespaces\/([0-9a-fA-F-]+)$/);
      view = namespaceMatch ? <NamespaceDetail namespaceId={namespaceMatch[1]} /> : <Dashboard />;
    }

    return (
      <>
        {gridMode && <div className="grid-overlay" />}
        <button className="grid-toggle" onClick={toggleGridMode}>
          Grid Mode: {gridMode ? "On" : "Off"}
        </button>
        <div className="page">{view}</div>
      </>
    );
  }
  ```

  Do not touch `Dashboard`, `NamespacesTable`, `UsersTable`, `AnalyticsTable`, `useDashboardTab`, `useGridMode`, or any other existing export in this file.

- [ ] **Step 3: Verify**

  ```bash
  npx tsc --noEmit -p dashboard-web/tsconfig.json
  npm run build:dashboard
  ```

  Expected: zero errors.

- [ ] **Step 4: Commit**

  ```bash
  git add dashboard-web/src/MePage.tsx dashboard-web/src/App.tsx
  git commit -m "feat(dashboard): add personal /dashboard/me view (list + claim + thread detail)"
  ```

---

### Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

  ```bash
  DATABASE_URL="postgres://recall:recall@localhost:55432/recall_test" npm test
  ```

  Expected: every test passes, including every existing admin-dashboard and MCP test file **unmodified** by this plan (`tests/dashboard/api.test.ts`, `tests/dashboard/auth.test.ts`, `tests/dashboard/session.test.ts`, `tests/dashboard/claimTokens.test.ts`, `tests/mcp/recallTool.test.ts`, `tests/mcp/server.test.ts`) — this is the regression check that nothing about the admin surface changed.

- [ ] **Step 2: Manual end-to-end check against the local test database**

  Start the server locally (`DATABASE_URL=postgres://recall:recall@localhost:55432/recall_test npm run dev`, with `.env` carrying a real, distinct `USER_SESSION_SECRET`). Seed two Slack users, A and B, in one workspace: a namespace both posted in, a namespace only A posted in, a namespace only B posted in. Since there's no live Slack workspace in local dev, mint the personal claim tokens directly instead of running `/recall-key`:

  ```typescript
  // one-off script, run from inside the repo per this project's node-script gotcha
  import { db } from "./src/db/client.js";
  import { issueUserClaimToken } from "./src/dashboard/userClaimTokens.js";
  console.log(await issueUserClaimToken(db, "<workspace-id>", "U_A"));
  ```

  Visit `/dashboard/me/claim?token=<token>` for A, confirm redirect to `/dashboard/me` and the cookie is set (`recall_user_session`, httpOnly). Confirm:
  - A's `/dashboard/me` lists the shared namespace and A's own, never B's.
  - Repeating for B (a fresh token, fresh browser profile/incognito to avoid cookie collision) shows the shared namespace and B's own, never A's.
  - A manually navigating to `/dashboard/me/namespaces/<B's-solo-namespace-id>` gets "Namespace not found," not a crash or a 401.
  - The thread detail view (`/dashboard/me/namespaces/<shared-id>`) renders identically to the admin's `NamespaceDetail` view for the same namespace (grouped messages, avatar fallbacks, linkified text, file chips) — only the "Back" link target and the endpoint differ.
  - The existing admin `/dashboard` flow (claim, namespace list, user list, analytics, revoke, archive, rename) is completely unaffected.
  - Restarting the server with `USER_SESSION_SECRET` unset, or equal to `DASHBOARD_SESSION_SECRET`, refuses to boot with the expected error message.

- [ ] **Step 3: Self-review the full diff**

  ```bash
  git diff main --stat
  ```

  Read every changed/new file. Confirm: `src/dashboard/session.ts`, `src/dashboard/auth.ts`, `src/dashboard/claimTokens.ts`, and `src/dashboard/api.ts` all show **zero** diff; `recallNamespace`'s exported signature and `RecallResult` type are unchanged; every `/api/me/*` route scopes by both `workspaceId` and `slackUserId`; every "not authorized" path returns `404`, never `401`/`403`, from the data-access routes; the boot-time secret-equality guard is present and tested; `dashboard-web/src/App.tsx`'s pre-existing branches (`Dashboard`, admin `NamespaceDetail` call site, `ClaimView`) are unchanged beyond being nested one `else` deeper.
