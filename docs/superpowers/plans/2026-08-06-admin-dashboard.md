# Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each workspace's admin a web dashboard (served from the existing recall-bot Express service) to view/rename/archive captured namespaces and view/revoke users' delegate keys, reached via a one-time claim link DM'd after Slack install.

**Architecture:** No new service. The existing Express app gains a signed-cookie session layer, a JSON API under `/api/dashboard/*`, and a small React app (bundled with esbuild, no framework/router dependency) served as static files at `/dashboard`. A Slack OAuth install-success hook issues a one-time claim token and DMs the installer a link; opening it sets the session cookie. No external identity provider in this build — Enoki is a planned future addition, not part of it.

**Tech Stack:** Node's built-in `crypto` for signed session cookies (zero new runtime dependency for that piece), `@slack/web-api` (explicit dependency, was only transitive before) for the post-install DM, React 19.2.8 + esbuild 0.28.1 for the frontend, Express 5 (existing) for the API, Drizzle ORM (existing) for the two schema additions.

## Global Constraints

- ESM throughout, matching the existing project: relative imports use `.js` extensions in backend code (NodeNext resolution). The **frontend** (`dashboard-web/`) is a separate TypeScript project with its own `tsconfig.json` using `"moduleResolution": "Bundler"` — imports there are extensionless, matching how esbuild resolves them.
- No new runtime dependency for session cookies — Node `crypto` only, no `cookie-parser`/`express-session`/`iron-session`.
- `react` and `react-dom` must stay on the exact same version (`react-dom`'s peer dependency pins it).
- Every DB-touching module takes `Database` as a parameter, per the existing project convention — no module-level DB singleton imports outside `server.ts`.
- Before committing any task, run `npx tsc --noEmit -p tsconfig.json` (backend) — a prior task in this project shipped a broken import that only a real type-check caught, `npm test` alone is not sufficient evidence.

---

## File Structure

```
recall-bot/
  dashboard-web/                  # NEW — frontend source, separate TS project
    tsconfig.json
    src/
      index.html
      main.tsx
      App.tsx
  build-dashboard.mjs             # NEW — esbuild production build script (project root)
  src/
    dashboard/                    # NEW — backend dashboard logic
      session.ts                   # signed-cookie create/verify, cookie header parsing
      claimTokens.ts                # issue/consume one-time claim tokens
      auth.ts                       # Express middleware requiring a valid session
      api.ts                         # /api/dashboard/* route handlers
    db/
      schema.ts                    # MODIFY — add workspaceClaimTokens table, namespaces.label column
    slack/
      receiver.ts                  # MODIFY — add installerOptions.callbackOptions success/failure hook
    server.ts                      # MODIFY — mount dashboard static files + API, new required env vars
  tests/
    dashboard/
      session.test.ts
      claimTokens.test.ts
      api.test.ts
```

---

### Task 1: Schema additions (claim tokens table, namespace label column)

**Files:**
- Modify: `src/db/schema.ts`
- Test: `tests/db/schema.test.ts` (existing file — add one test)

**Interfaces:**
- Consumes: existing `workspaces`, `namespaces` tables and their exports from `src/db/schema.ts`.
- Produces: `workspaceClaimTokens` table export (`id`, `workspaceId`, `tokenHash`, `expiresAt`, `usedAt`, `createdAt`), and `namespaces.label` (nullable text column, no new export — same `namespaces` table object gains a field). Task 2 (`claimTokens.ts`) and Task 5 (`api.ts`) both import `workspaceClaimTokens`; Task 5 reads/writes `namespaces.label`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/schema.test.ts — add this test to the existing describe block
import { workspaceClaimTokens } from "../../src/db/schema.js";

// ...inside the existing describe("schema", ...) block, add:
it("enforces a unique tokenHash on workspace_claim_tokens and allows a nullable namespace label", async () => {
  const [workspace] = await db
    .insert(workspaces)
    .values({ slackTeamId: "T-CLAIM", name: "Test Workspace" })
    .returning();

  await db.insert(workspaceClaimTokens).values({
    workspaceId: workspace.id,
    tokenHash: "abc123",
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  });

  await expect(
    db.insert(workspaceClaimTokens).values({
      workspaceId: workspace.id,
      tokenHash: "abc123",
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    }),
  ).rejects.toThrow();

  const [namespace] = await db
    .insert(namespaces)
    .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.1", label: null })
    .returning();
  expect(namespace.label).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/db/schema.test.ts`
Expected: FAIL — `workspaceClaimTokens` is not exported, and/or `namespaces` insert rejects an unknown `label` field.

- [ ] **Step 3: Add the schema additions**

```typescript
// src/db/schema.ts — add these imports to the existing import block from "drizzle-orm/pg-core"
// (merge into the existing `import { pgTable, pgEnum, uuid, text, varchar, timestamp, unique, index } from "drizzle-orm/pg-core";`
//  — no new symbols needed beyond what's already imported there)

// Add this table definition anywhere after `workspaces` is defined (it references workspaces.id):
export const workspaceClaimTokens = pgTable(
  "workspace_claim_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workspace_claim_tokens_workspace_id_idx").on(t.workspaceId)],
);
```

Then modify the existing `namespaces` table definition to add one field (insert `label` into the column object, e.g. right after `threadTs`):

```typescript
// src/db/schema.ts — inside the existing `namespaces = pgTable("namespaces", { ... }, ...)` call,
// add this line to the columns object (order doesn't matter, but grouping near threadTs reads well):
    label: text("label"),
```

- [ ] **Step 4: Generate and apply the migration against the test DB**

Run:
```bash
DATABASE_URL=postgres://recall:recall@localhost:55432/recall_test npx drizzle-kit generate --name=dashboard_claim_tokens_and_namespace_label
DATABASE_URL=postgres://recall:recall@localhost:55432/recall_test npx drizzle-kit migrate
```
Expected: a new `./drizzle/000X_*.sql` file is created; migrate reports it applied with no errors. (The test suite's `tests/setup.ts` also runs `migrate()` automatically in `beforeAll`, so once this migration file is committed, `npm test` picks it up on its own — this manual run here is just to generate the file and confirm it applies cleanly.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/db/schema.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts tests/db/schema.test.ts drizzle/
git commit -m "feat(db): add workspace_claim_tokens table and namespaces.label column"
```

---

### Task 2: Session cookie module

**Files:**
- Create: `src/dashboard/session.ts`
- Test: `tests/dashboard/session.test.ts`

**Interfaces:**
- Consumes: nothing (pure logic, Node `crypto` only, no DB).
- Produces: `createSessionCookie(workspaceId: string, secret: string, maxAgeMs?: number): string`, `verifySessionCookie(cookieValue: string | undefined, secret: string): { workspaceId: string } | null`, `parseCookies(cookieHeader: string | undefined): Record<string, string>`. Task 4 (`auth.ts`) and Task 5 (`api.ts`) both import all three.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/dashboard/session.test.ts
import { describe, it, expect } from "vitest";
import { createSessionCookie, verifySessionCookie, parseCookies } from "../../src/dashboard/session.js";

const SECRET = "test-secret-at-least-this-long";

describe("createSessionCookie / verifySessionCookie", () => {
  it("round-trips a valid cookie", () => {
    const cookie = createSessionCookie("ws-123", SECRET);
    const result = verifySessionCookie(cookie, SECRET);
    expect(result).toEqual({ workspaceId: "ws-123" });
  });

  it("rejects a cookie signed with a different secret", () => {
    const cookie = createSessionCookie("ws-123", SECRET);
    expect(verifySessionCookie(cookie, "wrong-secret-also-long-enough")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const cookie = createSessionCookie("ws-123", SECRET);
    const [payload, sig] = cookie.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ workspaceId: "ws-999", exp: Date.now() + 100000 }), "utf8").toString(
      "base64url",
    );
    expect(verifySessionCookie(`${tamperedPayload}.${sig}`, SECRET)).toBeNull();
    expect(payload).toBeDefined();
  });

  it("rejects an expired cookie", () => {
    const cookie = createSessionCookie("ws-123", SECRET, -1000);
    expect(verifySessionCookie(cookie, SECRET)).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    expect(verifySessionCookie(undefined, SECRET)).toBeNull();
    expect(verifySessionCookie("", SECRET)).toBeNull();
    expect(verifySessionCookie("not-a-valid-cookie-at-all", SECRET)).toBeNull();
    expect(verifySessionCookie("a.b", SECRET)).toBeNull();
    expect(() => verifySessionCookie("short.sig", SECRET)).not.toThrow();
  });
});

describe("parseCookies", () => {
  it("parses a standard Cookie header", () => {
    expect(parseCookies("a=1; b=2; c=hello%20world")).toEqual({ a: "1", b: "2", c: "hello world" });
  });

  it("returns an empty object for undefined or empty header", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/dashboard/session.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write src/dashboard/session.ts**

```typescript
// src/dashboard/session.ts
import { createHmac, timingSafeEqual } from "node:crypto";

const ALGO = "sha256";
const DEFAULT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function sign(payloadB64Url: string, secret: string): string {
  return createHmac(ALGO, secret).update(payloadB64Url).digest("base64url");
}

export function createSessionCookie(workspaceId: string, secret: string, maxAgeMs = DEFAULT_MAX_AGE_MS): string {
  const payload = { workspaceId, exp: Date.now() + maxAgeMs };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = sign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

export function verifySessionCookie(cookieValue: string | undefined, secret: string): { workspaceId: string } | null {
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
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof payload !== "object" || payload === null) return null;
  const { workspaceId, exp } = payload as { workspaceId?: unknown; exp?: unknown };
  if (typeof workspaceId !== "string") return null;
  if (typeof exp !== "number" || Date.now() > exp) return null;

  return { workspaceId };
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/dashboard/session.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/session.ts tests/dashboard/session.test.ts
git commit -m "feat(dashboard): add zero-dependency signed session cookie helpers"
```

---

### Task 3: Claim token module

**Files:**
- Create: `src/dashboard/claimTokens.ts`
- Test: `tests/dashboard/claimTokens.test.ts`

**Interfaces:**
- Consumes: `Database` type; `workspaceClaimTokens` table (Task 1).
- Produces: `issueClaimToken(db: Database, workspaceId: string): Promise<string>` (returns the plaintext token, storing only its hash), `consumeClaimToken(db: Database, plaintext: string): Promise<{ workspaceId: string } | null>`. Task 7 (Slack receiver hook) calls `issueClaimToken`; Task 5 (`api.ts`) calls `consumeClaimToken`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/dashboard/claimTokens.test.ts
import { describe, it, expect } from "vitest";
import { db } from "../../src/db/client.js";
import { workspaces } from "../../src/db/schema.js";
import { issueClaimToken, consumeClaimToken } from "../../src/dashboard/claimTokens.js";

describe("issueClaimToken / consumeClaimToken", () => {
  it("issues a token that can be consumed exactly once", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();

    const plaintext = await issueClaimToken(db, workspace.id);
    expect(typeof plaintext).toBe("string");
    expect(plaintext.length).toBeGreaterThan(20);

    const first = await consumeClaimToken(db, plaintext);
    expect(first).toEqual({ workspaceId: workspace.id });

    const second = await consumeClaimToken(db, plaintext);
    expect(second).toBeNull();
  });

  it("rejects an unknown token", async () => {
    const result = await consumeClaimToken(db, "this-token-was-never-issued");
    expect(result).toBeNull();
  });

  it("rejects an expired token", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2", name: "T" }).returning();
    const plaintext = await issueClaimToken(db, workspace.id, -1000);
    const result = await consumeClaimToken(db, plaintext);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/dashboard/claimTokens.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write src/dashboard/claimTokens.ts**

```typescript
// src/dashboard/claimTokens.ts
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { workspaceClaimTokens } from "../db/schema.js";

const DEFAULT_EXPIRY_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export async function issueClaimToken(
  db: Database,
  workspaceId: string,
  expiryMs: number = DEFAULT_EXPIRY_MS,
): Promise<string> {
  const plaintext = randomBytes(24).toString("hex");
  await db.insert(workspaceClaimTokens).values({
    workspaceId,
    tokenHash: hashToken(plaintext),
    expiresAt: new Date(Date.now() + expiryMs),
  });
  return plaintext;
}

export async function consumeClaimToken(db: Database, plaintext: string): Promise<{ workspaceId: string } | null> {
  const [row] = await db
    .select()
    .from(workspaceClaimTokens)
    .where(eq(workspaceClaimTokens.tokenHash, hashToken(plaintext)));

  if (!row) return null;
  if (row.usedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;

  await db.update(workspaceClaimTokens).set({ usedAt: new Date() }).where(eq(workspaceClaimTokens.id, row.id));

  return { workspaceId: row.workspaceId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/dashboard/claimTokens.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/claimTokens.ts tests/dashboard/claimTokens.test.ts
git commit -m "feat(dashboard): add one-time claim token issuance and consumption"
```

---

### Task 4: Dashboard session middleware

**Files:**
- Create: `src/dashboard/auth.ts`
- Test: `tests/dashboard/auth.test.ts`

**Interfaces:**
- Consumes: `parseCookies`, `verifySessionCookie` (Task 2).
- Produces: `DASHBOARD_COOKIE_NAME: string` (constant), `interface DashboardRequest extends Request { workspaceId?: string }`, `requireDashboardSession(secret: string): RequestHandler`. Task 5 (`api.ts`) imports all three — **this is the canonical definition of `DashboardRequest`, not redefined elsewhere.**

- [ ] **Step 1: Write the failing test**

```typescript
// tests/dashboard/auth.test.ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createSessionCookie } from "../../src/dashboard/session.js";
import { requireDashboardSession, DASHBOARD_COOKIE_NAME, type DashboardRequest } from "../../src/dashboard/auth.js";

const SECRET = "test-secret-at-least-this-long";

function buildTestApp() {
  const app = express();
  app.get("/protected", requireDashboardSession(SECRET), (req: DashboardRequest, res) => {
    res.json({ workspaceId: req.workspaceId });
  });
  return app;
}

describe("requireDashboardSession", () => {
  it("returns 401 when no cookie is present", async () => {
    const res = await request(buildTestApp()).get("/protected");
    expect(res.status).toBe(401);
  });

  it("returns 401 for an invalid cookie", async () => {
    const res = await request(buildTestApp()).get("/protected").set("Cookie", `${DASHBOARD_COOKIE_NAME}=garbage`);
    expect(res.status).toBe(401);
  });

  it("attaches workspaceId and calls next for a valid cookie", async () => {
    const cookie = createSessionCookie("ws-abc", SECRET);
    const res = await request(buildTestApp()).get("/protected").set("Cookie", `${DASHBOARD_COOKIE_NAME}=${cookie}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ workspaceId: "ws-abc" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/dashboard/auth.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write src/dashboard/auth.ts**

```typescript
// src/dashboard/auth.ts
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { parseCookies, verifySessionCookie } from "./session.js";

export const DASHBOARD_COOKIE_NAME = "recall_dashboard_session";

export interface DashboardRequest extends Request {
  workspaceId?: string;
}

export function requireDashboardSession(secret: string): RequestHandler {
  return (req: DashboardRequest, res: Response, next: NextFunction) => {
    const cookies = parseCookies(req.headers.cookie);
    const session = verifySessionCookie(cookies[DASHBOARD_COOKIE_NAME], secret);
    if (!session) {
      res.status(401).json({ error: "no_active_session" });
      return;
    }
    req.workspaceId = session.workspaceId;
    next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/dashboard/auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/auth.ts tests/dashboard/auth.test.ts
git commit -m "feat(dashboard): add session-cookie auth middleware"
```

---

### Task 5: Dashboard API router

**Files:**
- Create: `src/dashboard/api.ts`
- Test: `tests/dashboard/api.test.ts`

**Interfaces:**
- Consumes: `Database` type; `workspaces`, `installations`, `namespaces`, `users` tables (existing schema + Task 1's additions); `issueClaimToken`/`consumeClaimToken` (Task 3); `createSessionCookie` (Task 2); `DASHBOARD_COOKIE_NAME`, `requireDashboardSession`, `DashboardRequest` (Task 4).
- Produces: `createDashboardApiRouter(db: Database, sessionSecret: string): Router` (an Express `Router`, mountable at any path). Task 8 (composition root) mounts this at `/api/dashboard`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/dashboard/api.test.ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { workspaces, installations, namespaces, users } from "../../src/db/schema.js";
import { issueClaimToken } from "../../src/dashboard/claimTokens.js";
import { hashDelegateKey } from "../../src/keys/delegateKeys.js";
import { createDashboardApiRouter } from "../../src/dashboard/api.js";

const SECRET = "test-secret-at-least-this-long";

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/dashboard", createDashboardApiRouter(db, SECRET));
  return app;
}

async function seedWorkspace(teamId: string) {
  const [workspace] = await db.insert(workspaces).values({ slackTeamId: teamId, name: `Team ${teamId}` }).returning();
  await db.insert(installations).values({ workspaceId: workspace.id, botToken: "xoxb-fake", botUserId: "UBOT" });
  return workspace;
}

async function claimSessionCookie(app: express.Express, workspaceId: string) {
  const token = await issueClaimToken(db, workspaceId);
  const res = await request(app).post("/api/dashboard/claim").send({ token });
  const setCookie = res.headers["set-cookie"];
  expect(setCookie).toBeDefined();
  return (setCookie as unknown as string[])[0].split(";")[0];
}

describe("dashboard API", () => {
  it("POST /claim sets a session cookie for a valid token, and rejects reuse", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("T1");
    const token = await issueClaimToken(db, workspace.id);

    const first = await request(app).post("/api/dashboard/claim").send({ token });
    expect(first.status).toBe(200);
    expect(first.headers["set-cookie"]).toBeDefined();

    const second = await request(app).post("/api/dashboard/claim").send({ token });
    expect(second.status).toBe(400);
  });

  it("rejects protected routes with no cookie", async () => {
    const app = buildTestApp();
    const res = await request(app).get("/api/dashboard/me");
    expect(res.status).toBe(401);
  });

  it("GET /me returns workspace info for the session", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("T2");
    const cookie = await claimSessionCookie(app, workspace.id);

    const res = await request(app).get("/api/dashboard/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.slackTeamId).toBe("T2");
    expect(res.body.revoked).toBe(false);
  });

  it("GET/PATCH /namespaces supports rename and archive, scoped to the session's workspace", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("T3");
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.1" })
      .returning();
    const cookie = await claimSessionCookie(app, workspace.id);

    const list = await request(app).get("/api/dashboard/namespaces").set("Cookie", cookie);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].label).toBeNull();

    const renamed = await request(app)
      .patch(`/api/dashboard/namespaces/${namespace.id}`)
      .set("Cookie", cookie)
      .send({ label: "Launch planning" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.label).toBe("Launch planning");

    const archived = await request(app)
      .patch(`/api/dashboard/namespaces/${namespace.id}`)
      .set("Cookie", cookie)
      .send({ status: "archived" });
    expect(archived.body.status).toBe("archived");

    const cleared = await request(app)
      .patch(`/api/dashboard/namespaces/${namespace.id}`)
      .set("Cookie", cookie)
      .send({ label: "" });
    expect(cleared.body.label).toBeNull();
  });

  it("a workspace's session cannot read or mutate another workspace's namespace", async () => {
    const app = buildTestApp();
    const workspaceA = await seedWorkspace("T4A");
    const workspaceB = await seedWorkspace("T4B");
    const [namespaceB] = await db
      .insert(namespaces)
      .values({ workspaceId: workspaceB.id, channelId: "C1", threadTs: "1.1" })
      .returning();
    const cookieA = await claimSessionCookie(app, workspaceA.id);

    const list = await request(app).get("/api/dashboard/namespaces").set("Cookie", cookieA);
    expect(list.body).toHaveLength(0);

    const patch = await request(app)
      .patch(`/api/dashboard/namespaces/${namespaceB.id}`)
      .set("Cookie", cookieA)
      .send({ label: "should not work" });
    expect(patch.status).toBe(404);

    const [stillUnlabeled] = await db.select().from(namespaces).where(eq(namespaces.id, namespaceB.id));
    expect(stillUnlabeled.label).toBeNull();
  });

  it("GET /users lists only users with an active key, and revoke-key is idempotent", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("T5");
    const [userWithKey] = await db
      .insert(users)
      .values({ workspaceId: workspace.id, slackUserId: "U1", delegateKeyHash: hashDelegateKey("rk_test") })
      .returning();
    await db.insert(users).values({ workspaceId: workspace.id, slackUserId: "U2", delegateKeyHash: null });
    const cookie = await claimSessionCookie(app, workspace.id);

    const list = await request(app).get("/api/dashboard/users").set("Cookie", cookie);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].slackUserId).toBe("U1");

    const revoke = await request(app).post(`/api/dashboard/users/${userWithKey.id}/revoke-key`).set("Cookie", cookie);
    expect(revoke.status).toBe(200);
    expect(revoke.body.revoked).toBe(true);

    const revokeAgain = await request(app).post(`/api/dashboard/users/${userWithKey.id}/revoke-key`).set("Cookie", cookie);
    expect(revokeAgain.status).toBe(200);
    expect(revokeAgain.body.revoked).toBe(false);

    const afterList = await request(app).get("/api/dashboard/users").set("Cookie", cookie);
    expect(afterList.body).toHaveLength(0);
  });

  it("a workspace's session cannot revoke another workspace's user key", async () => {
    const app = buildTestApp();
    const workspaceA = await seedWorkspace("T5A");
    const workspaceB = await seedWorkspace("T5B");
    const [userB] = await db
      .insert(users)
      .values({ workspaceId: workspaceB.id, slackUserId: "U1", delegateKeyHash: hashDelegateKey("rk_other") })
      .returning();
    const cookieA = await claimSessionCookie(app, workspaceA.id);

    const revoke = await request(app).post(`/api/dashboard/users/${userB.id}/revoke-key`).set("Cookie", cookieA);
    expect(revoke.status).toBe(200);
    expect(revoke.body.revoked).toBe(false);

    const [stillHasKey] = await db.select().from(users).where(eq(users.id, userB.id));
    expect(stillHasKey.delegateKeyHash).not.toBeNull();
  });

  it("POST /logout clears the cookie", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("T6");
    const cookie = await claimSessionCookie(app, workspace.id);

    const res = await request(app).post("/api/dashboard/logout").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"][0]).toMatch(/recall_dashboard_session=;/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/dashboard/api.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write src/dashboard/api.ts**

```typescript
// src/dashboard/api.ts
import { Router } from "express";
import type { Response } from "express";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { installations, namespaces, users, workspaces } from "../db/schema.js";
import { consumeClaimToken } from "./claimTokens.js";
import { createSessionCookie } from "./session.js";
import { DASHBOARD_COOKIE_NAME, requireDashboardSession, type DashboardRequest } from "./auth.js";

const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export function createDashboardApiRouter(db: Database, sessionSecret: string): Router {
  const router = Router();
  const auth = requireDashboardSession(sessionSecret);

  router.post("/claim", async (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : undefined;
    if (!token) {
      res.status(400).json({ error: "missing_token" });
      return;
    }

    const result = await consumeClaimToken(db, token);
    if (!result) {
      res.status(400).json({ error: "invalid_or_expired_token" });
      return;
    }

    res.cookie(DASHBOARD_COOKIE_NAME, createSessionCookie(result.workspaceId, sessionSecret, SESSION_MAX_AGE_MS), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_MS,
      path: "/",
    });
    res.status(200).json({ ok: true });
  });

  router.post("/logout", auth, (_req, res: Response) => {
    res.clearCookie(DASHBOARD_COOKIE_NAME, { path: "/" });
    res.status(200).json({ ok: true });
  });

  router.get("/me", auth, async (req: DashboardRequest, res: Response) => {
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, req.workspaceId!));
    if (!workspace) {
      res.status(404).json({ error: "workspace_not_found" });
      return;
    }
    const [installation] = await db.select().from(installations).where(eq(installations.workspaceId, workspace.id));
    res.json({
      name: workspace.name,
      slackTeamId: workspace.slackTeamId,
      installedAt: installation?.createdAt ?? null,
      revoked: Boolean(installation?.revokedAt),
    });
  });

  router.get("/namespaces", auth, async (req: DashboardRequest, res: Response) => {
    const rows = await db
      .select()
      .from(namespaces)
      .where(eq(namespaces.workspaceId, req.workspaceId!))
      .orderBy(desc(namespaces.createdAt));
    res.json(
      rows.map((n) => ({
        id: n.id,
        channelId: n.channelId,
        threadTs: n.threadTs,
        label: n.label,
        status: n.status,
        createdAt: n.createdAt,
      })),
    );
  });

  router.patch("/namespaces/:id", auth, async (req: DashboardRequest, res: Response) => {
    const { label, status } = (req.body ?? {}) as { label?: unknown; status?: unknown };
    if (status !== undefined && status !== "archived") {
      res.status(400).json({ error: "invalid_status" });
      return;
    }

    const update: { label?: string | null; status?: "archived"; updatedAt: Date } = { updatedAt: new Date() };
    if (label !== undefined) update.label = typeof label === "string" && label.length > 0 ? label : null;
    if (status === "archived") update.status = "archived";

    const [row] = await db
      .update(namespaces)
      .set(update)
      .where(and(eq(namespaces.id, req.params.id), eq(namespaces.workspaceId, req.workspaceId!)))
      .returning();

    if (!row) {
      res.status(404).json({ error: "namespace_not_found" });
      return;
    }
    res.json({ id: row.id, label: row.label, status: row.status });
  });

  router.get("/users", auth, async (req: DashboardRequest, res: Response) => {
    const rows = await db
      .select()
      .from(users)
      .where(and(eq(users.workspaceId, req.workspaceId!), isNotNull(users.delegateKeyHash)));
    res.json(rows.map((u) => ({ id: u.id, slackUserId: u.slackUserId, keyIssuedOrRotatedAt: u.updatedAt })));
  });

  router.post("/users/:id/revoke-key", auth, async (req: DashboardRequest, res: Response) => {
    const [row] = await db
      .update(users)
      .set({ delegateKeyHash: null, updatedAt: new Date() })
      .where(and(eq(users.id, req.params.id), eq(users.workspaceId, req.workspaceId!)))
      .returning();
    res.json({ ok: true, revoked: Boolean(row) });
  });

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/dashboard/api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/api.ts tests/dashboard/api.test.ts
git commit -m "feat(dashboard): add /api/dashboard REST routes (claim, me, namespaces, users)"
```

---

### Task 6: React frontend (esbuild)

**Files:**
- Create: `dashboard-web/tsconfig.json`
- Create: `dashboard-web/src/index.html`
- Create: `dashboard-web/src/main.tsx`
- Create: `dashboard-web/src/App.tsx`
- Create: `build-dashboard.mjs`
- Modify: `package.json` (new dependencies/devDependencies, `build` script)

**Interfaces:**
- Consumes: the JSON shapes returned by Task 5's API (`/api/dashboard/me`, `/namespaces`, `/users`) — matched by field name in the fetch calls below.
- Produces: `dist/dashboard/index.html` + `dist/dashboard/bundle.js` (build output, not source symbols — Task 8 serves this directory as static files).

- [ ] **Step 1: Install the new dependencies**

```bash
npm install react@19.2.8 react-dom@19.2.8 @slack/web-api@8.0.0
npm install -D esbuild@0.28.1 @types/react@19.2.18 @types/react-dom@19.2.4
```

- [ ] **Step 2: Write dashboard-web/tsconfig.json**

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["react", "react-dom"],
    "strict": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write dashboard-web/src/index.html**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>recall-bot dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script src="./bundle.js"></script>
  </body>
</html>
```

- [ ] **Step 4: Write dashboard-web/src/main.tsx**

```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";

const container = document.getElementById("root")!;
createRoot(container).render(<App />);
```

- [ ] **Step 5: Write dashboard-web/src/App.tsx**

```tsx
import { useEffect, useState } from "react";

interface WorkspaceInfo {
  name: string;
  slackTeamId: string;
  installedAt: string | null;
  revoked: boolean;
}

interface NamespaceRow {
  id: string;
  channelId: string;
  threadTs: string;
  label: string | null;
  status: string;
  createdAt: string;
}

interface UserRow {
  id: string;
  slackUserId: string;
  keyIssuedOrRotatedAt: string;
}

function ClaimView() {
  const [status, setStatus] = useState<"claiming" | "error">("claiming");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setStatus("error");
      setMessage("Missing token in the link.");
      return;
    }
    fetch("/api/dashboard/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(typeof body.error === "string" ? body.error : "claim_failed");
        }
        window.location.href = "/dashboard";
      })
      .catch((err: unknown) => {
        setStatus("error");
        setMessage(
          err instanceof Error && err.message === "invalid_or_expired_token"
            ? "This link has expired or was already used — reinstall the app or contact support."
            : "Something went wrong claiming this workspace.",
        );
      });
  }, []);

  if (status === "error") return <p>{message}</p>;
  return <p>Setting up your dashboard…</p>;
}

function NoSession() {
  return <p>No active session — check your Slack DM for the dashboard setup link.</p>;
}

function Dashboard() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [namespaces, setNamespaces] = useState<NamespaceRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [unauthorized, setUnauthorized] = useState(false);

  const reload = () => {
    fetch("/api/dashboard/me").then((res) => {
      if (res.status === 401) {
        setUnauthorized(true);
        return;
      }
      res.json().then(setWorkspace);
    });
    fetch("/api/dashboard/namespaces")
      .then((res) => (res.ok ? res.json() : []))
      .then(setNamespaces);
    fetch("/api/dashboard/users")
      .then((res) => (res.ok ? res.json() : []))
      .then(setUsers);
  };

  useEffect(reload, []);

  if (unauthorized) return <NoSession />;
  if (!workspace) return <p>Loading…</p>;

  const renameNamespace = async (id: string, label: string) => {
    await fetch(`/api/dashboard/namespaces/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    reload();
  };

  const archiveNamespace = async (id: string) => {
    await fetch(`/api/dashboard/namespaces/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
    reload();
  };

  const revokeKey = async (id: string) => {
    await fetch(`/api/dashboard/users/${id}/revoke-key`, { method: "POST" });
    reload();
  };

  return (
    <div>
      <h1>{workspace.name}</h1>
      <p>
        Slack team {workspace.slackTeamId} — installed{" "}
        {workspace.installedAt ? new Date(workspace.installedAt).toLocaleDateString() : "unknown"}
        {workspace.revoked ? " — REVOKED" : ""}
      </p>

      <h2>Namespaces</h2>
      <table>
        <thead>
          <tr>
            <th>Label</th>
            <th>Channel</th>
            <th>Status</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {namespaces.map((n) => (
            <tr key={n.id}>
              <td>
                <input defaultValue={n.label ?? ""} placeholder={n.threadTs} onBlur={(e) => renameNamespace(n.id, e.currentTarget.value)} />
              </td>
              <td>{n.channelId}</td>
              <td>{n.status}</td>
              <td>{new Date(n.createdAt).toLocaleDateString()}</td>
              <td>{n.status !== "archived" && <button onClick={() => archiveNamespace(n.id)}>Archive</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Users with an active delegate key</h2>
      <table>
        <thead>
          <tr>
            <th>Slack user</th>
            <th>Key issued/rotated</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.slackUserId}</td>
              <td>{new Date(u.keyIssuedOrRotatedAt).toLocaleDateString()}</td>
              <td>
                <button onClick={() => revokeKey(u.id)}>Revoke</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function App() {
  if (window.location.pathname === "/dashboard/claim") {
    return <ClaimView />;
  }
  return <Dashboard />;
}
```

- [ ] **Step 6: Write build-dashboard.mjs**

```javascript
// build-dashboard.mjs — project root. Always parsed as ESM regardless of package.json "type".
import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const outdir = "dist/dashboard";
mkdirSync(outdir, { recursive: true });

await esbuild.build({
  entryPoints: ["dashboard-web/src/main.tsx"],
  bundle: true,
  outfile: `${outdir}/bundle.js`,
  platform: "browser",
  format: "iife",
  target: ["es2022"],
  jsx: "automatic",
  sourcemap: true,
  minify: true,
  logLevel: "info",
});

cpSync("dashboard-web/src/index.html", `${outdir}/index.html`);
```

- [ ] **Step 7: Update package.json's build script and add a dedicated one**

```jsonc
// package.json — modify the existing "scripts" block:
// change:  "build": "tsc -p tsconfig.json",
// to:
"build": "tsc -p tsconfig.json && node build-dashboard.mjs",
"build:dashboard": "node build-dashboard.mjs",
```

- [ ] **Step 8: Run the build and verify output + type-check**

Run:
```bash
npm run build:dashboard
ls dist/dashboard/bundle.js dist/dashboard/index.html
npx tsc --noEmit -p dashboard-web/tsconfig.json
```
Expected: both files exist; the frontend type-check passes with zero errors. (esbuild itself does not type-check — this `tsc --noEmit` pass is the only type safety net for the frontend, per the spec's deliberate no-frontend-test-suite scope cut.)

- [ ] **Step 9: Commit**

```bash
git add dashboard-web/ build-dashboard.mjs package.json package-lock.json
git commit -m "feat(dashboard): add React frontend bundled with esbuild"
```

---

### Task 7: Wire claim-token issuance into the Slack OAuth install-success hook

**Files:**
- Modify: `src/slack/receiver.ts`
- Test: `tests/slack/receiver.test.ts` (existing file — add tests)

**Interfaces:**
- Consumes: `issueClaimToken` (Task 3); `Database` type; `workspaces` table.
- Produces: `createSlackReceiver`'s params gain one new required field: `publicBaseUrl: string`. No other exported symbol changes — `createSlackApp` is untouched. Task 8 (composition root) passes the new `publicBaseUrl` argument.

**Context you need that isn't in the brief text alone:** Bolt's `installerOptions.callbackOptions.successAsync` runs *after* `installationStore.storeInstallation` has already persisted the `workspaces`/`installations` rows — so looking up the `workspaces` row by `slackTeamId` inside this hook is safe. Providing `success`/`successAsync` **fully replaces** Bolt's default "Thank you!" page — you must call `res.redirect(...)` (or otherwise complete the response) in every code path, including error paths, or the HTTP request hangs. With `ExpressReceiver` (which this project uses), `res` really is an Express `Response` at runtime despite being typed narrowly as `http.ServerResponse` in Bolt's own types — casting is not needed in JS, but if TypeScript complains, the existing project pattern is to trust the runtime shape (see how `context.botToken as string` is already used elsewhere in this codebase).

- [ ] **Step 1: Write the failing test**

Add this test to the existing `describe("createSlackReceiver", ...)` block in `tests/slack/receiver.test.ts` (no new imports needed — `express`, `db`, and `createSlackReceiver` are already imported at the top of this file):

```typescript
  it("accepts a publicBaseUrl param and still builds without throwing", async () => {
    const app = express();
    expect(() =>
      createSlackReceiver({
        db,
        app,
        signingSecret: "test-signing-secret",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        stateSecret: "test-state-secret-test-state-secret",
        publicBaseUrl: "https://example.test",
      }),
    ).not.toThrow();
  });
```

(The OAuth success/failure callback itself — the part that actually issues a token and sends a Slack DM — cannot be meaningfully unit-tested without a live Slack OAuth exchange, matching this project's existing precedent for Task 5's OAuth callback. It's verified manually against a real Slack app, same as the rest of the install flow.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/slack/receiver.test.ts`
Expected: FAIL — `createSlackReceiver` throws or rejects the unknown `publicBaseUrl` param (TypeScript error at minimum; adjust the test run to `npx tsc --noEmit -p tsconfig.json` first if the failure is a compile error rather than a runtime one).

- [ ] **Step 3: Modify src/slack/receiver.ts**

```typescript
// src/slack/receiver.ts — full replacement content
import type { Express } from "express";
import { App, ExpressReceiver } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { workspaces } from "../db/schema.js";
import { createPostgresInstallationStore } from "./installationStore.js";
import { issueClaimToken } from "../dashboard/claimTokens.js";

export interface SlackReceiverParams {
  db: Database;
  app: Express;
  signingSecret: string;
  clientId: string;
  clientSecret: string;
  stateSecret: string;
  publicBaseUrl: string;
}

const SCOPES = [
  "app_mentions:read",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "chat:write",
  "im:write",
  "files:read",
  "commands",
];

async function sendClaimLinkDm(db: Database, publicBaseUrl: string, teamId: string, botToken: string, installerUserId: string) {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.slackTeamId, teamId));
  if (!workspace) return;

  const token = await issueClaimToken(db, workspace.id);
  const client = new WebClient(botToken);
  const dm = await client.conversations.open({ users: installerUserId });
  await client.chat.postMessage({
    channel: dm.channel!.id!,
    text: `Set up your dashboard: ${publicBaseUrl}/dashboard/claim?token=${token}`,
  });
}

export function createSlackReceiver(params: SlackReceiverParams): ExpressReceiver {
  const { db, app, signingSecret, clientId, clientSecret, stateSecret, publicBaseUrl } = params;

  return new ExpressReceiver({
    signingSecret,
    clientId,
    clientSecret,
    stateSecret,
    scopes: SCOPES,
    installationStore: createPostgresInstallationStore(db),
    installerOptions: {
      directInstall: true,
      callbackOptions: {
        successAsync: async (installation, _options, _req, res) => {
          try {
            if (!installation.isEnterpriseInstall && installation.team?.id && installation.bot?.token) {
              await sendClaimLinkDm(db, publicBaseUrl, installation.team.id, installation.bot.token, installation.user.id);
            }
          } catch (error) {
            console.error("Failed to send dashboard claim link DM:", error);
          }
          (res as import("express").Response).redirect("/dashboard");
        },
        failureAsync: async (error, _options, _req, res) => {
          console.error("Slack OAuth install failed:", error);
          (res as import("express").Response).redirect("/dashboard");
        },
      },
    },
    app,
  });
}

export function createSlackApp(receiver: ExpressReceiver): App {
  return new App({ receiver });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npm test -- tests/slack/receiver.test.ts
```
Expected: zero type errors; PASS.

- [ ] **Step 5: Commit**

```bash
git add src/slack/receiver.ts tests/slack/receiver.test.ts
git commit -m "feat(dashboard): DM a dashboard claim link after Slack install completes"
```

---

### Task 8: Wire everything into the composition root

**Files:**
- Modify: `src/server.ts`
- Modify: `.env.example`
- Test: `tests/server.wiring.test.ts` (existing file — add tests)

**Interfaces:**
- Consumes: everything produced by Tasks 1–7.
- Produces: `buildApp(database: Database): Express` gains dashboard routes; no signature change.

**Context you need that isn't in the brief text alone:** `express.json()` is already mounted globally in `server.ts` (added in the core-loop plan, positioned after the Slack receiver mounts its own raw-body-verified routes, before `mountMcpServer`). Mount the dashboard static files and API router anywhere after that `express.json()` line — order relative to `mountMcpServer` doesn't matter since the path prefixes (`/dashboard`, `/api/dashboard`, `/mcp`) don't overlap.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server.wiring.test.ts — add these tests to the existing describe block
  it("serves the dashboard static bundle and claim page", async () => {
    const app = buildApp(db);
    const indexRes = await request(app).get("/dashboard");
    expect(indexRes.status).toBe(200);
    expect(indexRes.text).toContain("bundle.js");

    const claimRes = await request(app).get("/dashboard/claim");
    expect(claimRes.status).toBe(200);
    expect(claimRes.text).toContain("bundle.js");
  });

  it("exposes /api/dashboard/me and rejects unauthenticated calls", async () => {
    const app = buildApp(db);
    const res = await request(app).get("/api/dashboard/me");
    expect(res.status).toBe(401);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server.wiring.test.ts`
Expected: FAIL — `/dashboard` and `/api/dashboard/me` are 404, and the dashboard bundle doesn't exist yet in `dist/` for the test run.

Before implementing, run the dashboard build so the static files exist for this test to serve (this mirrors how `npm run build` will work in production — the test run needs the same artifact):
```bash
npm run build:dashboard
```

- [ ] **Step 3: Modify src/server.ts**

```typescript
// src/server.ts — add these imports alongside the existing ones:
import { createDashboardApiRouter } from "./dashboard/api.js";

// Add this constant near the top of the file, alongside MIGRATIONS_FOLDER:
const DASHBOARD_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/dashboard");
```

Then, inside `buildApp()`, update the `createSlackReceiver` call to pass the new `publicBaseUrl` param, and add the dashboard mounting after the existing `express.json()` line:

```typescript
// src/server.ts — inside buildApp(), modify the existing createSlackReceiver call to add:
  const receiver = createSlackReceiver({
    db: database,
    app,
    signingSecret: requireEnv("SLACK_SIGNING_SECRET"),
    clientId: requireEnv("SLACK_CLIENT_ID"),
    clientSecret: requireEnv("SLACK_CLIENT_SECRET"),
    stateSecret: requireEnv("SLACK_STATE_SECRET"),
    publicBaseUrl: requireEnv("PUBLIC_BASE_URL"),
  });

// ...further down, after the existing `app.use(express.json());` line and before mountMcpServer(app, database), add:
  const dashboardSessionSecret = requireEnv("DASHBOARD_SESSION_SECRET");
  app.use("/dashboard", express.static(DASHBOARD_DIST));
  app.get("/dashboard/claim", (_req, res) => {
    res.sendFile(path.join(DASHBOARD_DIST, "index.html"));
  });
  app.use("/api/dashboard", createDashboardApiRouter(database, dashboardSessionSecret));
```

- [ ] **Step 4: Update .env.example**

```bash
# .env.example — add these two lines
DASHBOARD_SESSION_SECRET=
PUBLIC_BASE_URL=https://your-railway-domain.up.railway.app
```

- [ ] **Step 5: Set the new env vars for the test run and run the full suite**

Add to `vitest.config.ts`'s existing `test.env` block:
```typescript
      DASHBOARD_SESSION_SECRET: "test-dashboard-session-secret",
      PUBLIC_BASE_URL: "https://recall-bot.test",
```

Run: `npm test`
Expected: every test file in the project passes, including the two new assertions in `tests/server.wiring.test.ts`.

- [ ] **Step 6: Run a final full verification**

```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p dashboard-web/tsconfig.json
npm run build
npm test
```
Expected: all four commands succeed with zero errors/failures.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts .env.example vitest.config.ts tests/server.wiring.test.ts
git commit -m "feat(dashboard): wire dashboard static files and API into the composition root"
```

---

## Deployment note (not a task — for whoever runs Task-13-style deployment later)

This sub-project needs two new Railway variables set before deploying: `DASHBOARD_SESSION_SECRET` (generate with `openssl rand -hex 32`, same pattern as `SLACK_STATE_SECRET`) and `PUBLIC_BASE_URL` (the existing Railway domain, e.g. `https://recall-bot-production-105d.up.railway.app` — already known from the core-loop deployment, no new domain needed). No new Slack app manifest changes are required — the OAuth redirect URL and scopes are unchanged; only the post-install *behavior* (the DM) is new.
