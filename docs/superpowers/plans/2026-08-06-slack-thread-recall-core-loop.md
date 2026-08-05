# Slack Thread Recall — Core Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the core loop of a multi-tenant Slack bot that captures @-tagged threads (backfill + live) into Postgres, with an MCP server exposing a `recall` tool authenticated by a per-user delegate key.

**Architecture:** One Node/TypeScript service on Railway. Express hosts two route groups: Slack's OAuth/Events/slash-command routes (via `@slack/bolt`'s `ExpressReceiver`, mounted on our own Express app) and a `/mcp` route (MCP Streamable HTTP, stateless, hand-rolled bearer-token auth ahead of the transport). Postgres (via Drizzle ORM) is the single source of truth for installs, users, namespaces, messages, and file metadata; a Railway bucket (S3-compatible) holds file bytes.

**Tech Stack:** Node ≥20, TypeScript (ESM/NodeNext), Express 5, `@slack/bolt` 5.0.0, `@modelcontextprotocol/sdk` 1.30.0, Drizzle ORM 0.45.2 + drizzle-kit 0.31.10 on Postgres, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` 3.1103.0, `vitest` + `supertest` for tests, deployed on Railway.

## Global Constraints

- Node.js ≥20 (required by `@slack/bolt@5.0.0`).
- ESM throughout: `package.json` has `"type": "module"`; `tsconfig.json` uses `"module": "NodeNext"` / `"moduleResolution": "NodeNext"`; all relative imports use explicit `.js` extensions (required for NodeNext ESM resolution of TS files).
- No secrets committed. `.env` files stay out of git (see `.gitignore` in Task 1). Real Slack/DB/bucket credentials only ever go in `.env` locally or Railway's variable store — never in code or in this plan.
- Drizzle migrations are generated locally (`drizzle-kit generate`) and committed to git under `./drizzle`; `drizzle-kit push` is never used against a real environment (prototyping only, per Drizzle's own guidance — it has no migration history).
- Every DB-touching module takes its `Database` instance as a parameter (dependency injection) rather than importing a module-level singleton directly, so tests can pass a test-DB-backed instance.
- Delegate keys are never logged or stored in plaintext — only their SHA-256 hash is persisted (see Task 3).

---

## File Structure

```
recall-bot/
  package.json
  tsconfig.json
  .gitignore
  .env.example
  vitest.config.ts
  drizzle.config.ts
  docker-compose.test.yml
  drizzle/                        # generated migrations (Task 2+)
  src/
    server.ts                     # composition root: builds Express app, mounts everything, listens
    db/
      schema.ts                   # Drizzle table + relation definitions
      client.ts                   # db/pool instances, Database type
    keys/
      delegateKeys.ts              # generate/hash delegate keys
    slack/
      installationStore.ts         # Postgres-backed Bolt InstallationStore
      receiver.ts                   # ExpressReceiver + App construction
      files.ts                      # download a Slack file, hand off to bucket storage
      backfill.ts                   # conversations.replies pagination -> namespace + messages + files
      events.ts                     # app_mention / message event handlers
      recallKeyCommand.ts           # /recall-key slash command
    storage/
      bucket.ts                     # S3Client wrapper: putFile, getSignedDownloadUrl
    mcp/
      auth.ts                       # bearer delegate-key auth middleware
      recallTool.ts                  # recall query + authorization logic
      server.ts                      # McpServer + tool registration + /mcp route mounting
  tests/
    setup.ts                        # migrates + truncates the test DB around each test
    app.smoke.test.ts
    keys/delegateKeys.test.ts
    slack/installationStore.test.ts
    slack/backfill.test.ts
    slack/events.test.ts
    slack/recallKeyCommand.test.ts
    slack/receiver.test.ts
    storage/bucket.test.ts
    mcp/auth.test.ts
    mcp/recallTool.test.ts
    mcp/server.test.ts
```

---

## Reconciling this plan with the spec's error-handling section

Three of the spec's error-handling requirements are satisfied differently than their literal wording suggests, once actual library behavior (confirmed by research, not assumed) is factored in. Noting the reasoning here so it doesn't read as a silent gap during implementation or review:

- **"Bad Slack signature → 401, log, drop."** Not custom code anywhere in this plan. `@slack/bolt`'s `ExpressReceiver` verifies the raw-body HMAC signature itself before any of our handlers run (`signatureVerification: true` is its default) — confirmed against the Bolt v5 source in Task 5's research. We rely on that rather than re-implementing it.
- **"Authenticated but not a participant → 403."** Implemented in Task 11 as an MCP-level `isError: true` tool result, not an HTTP 403. Per the MCP SDK research: the auth *middleware* (Task 10) runs before the JSON-RPC body — including the `namespaceId` argument — is parsed, so it can only ever assert "is this delegate key valid at all" (→ real 401 there). Whether the key's owner participated in *this specific namespace* is only knowable once the tool handler runs, and the SDK's own guidance is that per-call authorization decisions like that belong in the tool result (`isError: true`), not a transport-level status code. The net effect for a caller is the same — no data without authorization — just signaled a layer deeper than the spec's shorthand implied.
- **"`app_uninstalled` → mark installation revoked, stop processing that workspace's events."** No explicit event handler for `app_uninstalled` exists in this plan. Bolt calls `InstallationStore.deleteInstallation` automatically on `app_uninstalled`/`tokens_revoked` (confirmed in Task 4's research), and Task 4's `deleteInstallation` sets `installations.revokedAt`. Separately, Task 4's `fetchInstallation` throws for a revoked installation, which makes Bolt's own authorization step fail for that team — so event handlers never dispatch for a revoked workspace. Both halves of the requirement fall out of Task 4's implementation without needing a dedicated Task 13-style event handler.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `vitest.config.ts`
- Create: `src/server.ts`
- Test: `tests/app.smoke.test.ts`

**Interfaces:**
- Produces: `buildApp(): Express` from `src/server.ts` — a bare Express app with `GET /healthz`. Every later task that mounts routes does so by modifying this same file/function.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "recall-bot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "test:db:up": "docker compose -f docker-compose.test.yml up -d",
    "test:db:down": "docker compose -f docker-compose.test.yml down"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.1103.0",
    "@aws-sdk/s3-request-presigner": "^3.1103.0",
    "@modelcontextprotocol/sdk": "^1.30.0",
    "@slack/bolt": "^5.0.0",
    "dotenv": "^16.4.5",
    "drizzle-orm": "^0.45.2",
    "express": "^5.2.1",
    "pg": "^8.22.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^20.14.0",
    "@types/pg": "^8.11.0",
    "@types/supertest": "^6.0.0",
    "drizzle-kit": "^0.31.10",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: installs cleanly, creates `package-lock.json`.

- [ ] **Step 3: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Write .gitignore**

```
node_modules/
dist/
.env
.env.local
*.log
```

- [ ] **Step 5: Write .env.example**

```
DATABASE_URL=postgres://user:password@localhost:5432/recall_bot
PORT=3000

SLACK_SIGNING_SECRET=
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_STATE_SECRET=

BUCKET=
ACCESS_KEY_ID=
SECRET_ACCESS_KEY=
REGION=auto
ENDPOINT=https://storage.railway.app
```

- [ ] **Step 6: Write vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 30000,
  },
});
```

- [ ] **Step 7: Write the failing smoke test**

```typescript
// tests/app.smoke.test.ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildApp } from "../src/server.js";

describe("buildApp", () => {
  it("responds to GET /healthz with 200 and ok:true", async () => {
    const app = buildApp();
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npm test -- tests/app.smoke.test.ts`
Expected: FAIL — `src/server.ts` does not exist / `buildApp` is not exported.

- [ ] **Step 9: Write src/server.ts**

```typescript
// src/server.ts
import express from "express";
import type { Express } from "express";

export function buildApp(): Express {
  const app = express();

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  return app;
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const app = buildApp();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`recall-bot listening on port ${port}`);
  });
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npm test -- tests/app.smoke.test.ts`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore .env.example vitest.config.ts src/server.ts tests/app.smoke.test.ts
git commit -m "chore: scaffold recall-bot project with health check"
```

---

### Task 2: Database schema + migrations

**Files:**
- Create: `drizzle.config.ts`
- Create: `docker-compose.test.yml`
- Create: `src/db/schema.ts`
- Create: `src/db/client.ts`
- Modify: `vitest.config.ts` (add `setupFiles`)
- Create: `tests/setup.ts`
- Test: `tests/db/schema.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 beyond the project scaffold.
- Produces:
  - `src/db/schema.ts` exports tables `workspaces`, `installations`, `users`, `namespaces`, `messages`, `files`, enums `namespaceStatusEnum`, `fileStatusEnum`, and relation objects `workspacesRelations`, `installationsRelations`, `usersRelations`, `namespacesRelations`, `messagesRelations`, `filesRelations`.
  - `src/db/client.ts` exports `pool: Pool`, `db: NodePgDatabase<typeof schema>`, and `type Database = typeof db`. **Every later task imports the `Database` type from here.**

- [ ] **Step 1: Write docker-compose.test.yml**

```yaml
services:
  postgres-test:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: recall
      POSTGRES_PASSWORD: recall
      POSTGRES_DB: recall_test
    ports:
      - "55432:5432"
```

- [ ] **Step 2: Start the test database**

Run: `npm run test:db:up`
Expected: `docker compose` reports the `postgres-test` container running.

- [ ] **Step 3: Write src/db/schema.ts**

```typescript
// src/db/schema.ts
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const namespaceStatusEnum = pgEnum("namespace_status", ["active", "archived"]);
export const fileStatusEnum = pgEnum("file_status", ["pending", "stored", "failed"]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  slackTeamId: varchar("slack_team_id", { length: 32 }).notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const installations = pgTable("installations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" })
    .unique(),
  botToken: text("bot_token").notNull(),
  botUserId: varchar("bot_user_id", { length: 32 }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slackUserId: varchar("slack_user_id", { length: 32 }).notNull(),
    delegateKeyHash: text("delegate_key_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("users_workspace_slack_user_unique").on(t.workspaceId, t.slackUserId),
    index("users_delegate_key_hash_idx").on(t.delegateKeyHash),
  ],
);

export const namespaces = pgTable(
  "namespaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: varchar("channel_id", { length: 32 }).notNull(),
    threadTs: varchar("thread_ts", { length: 32 }).notNull(),
    status: namespaceStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("namespaces_workspace_channel_thread_unique").on(t.workspaceId, t.channelId, t.threadTs),
    index("namespaces_workspace_id_idx").on(t.workspaceId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    namespaceId: uuid("namespace_id")
      .notNull()
      .references(() => namespaces.id, { onDelete: "cascade" }),
    slackUserId: varchar("slack_user_id", { length: 32 }).notNull(),
    text: text("text").notNull(),
    slackTs: varchar("slack_ts", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("messages_namespace_slack_ts_unique").on(t.namespaceId, t.slackTs),
    index("messages_namespace_id_idx").on(t.namespaceId),
    index("messages_slack_user_id_idx").on(t.slackUserId),
  ],
);

export const files = pgTable(
  "files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    bucketKey: text("bucket_key"),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type").notNull(),
    status: fileStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("files_message_id_idx").on(t.messageId)],
);

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  installation: one(installations, {
    fields: [workspaces.id],
    references: [installations.workspaceId],
  }),
  users: many(users),
  namespaces: many(namespaces),
}));

export const installationsRelations = relations(installations, ({ one }) => ({
  workspace: one(workspaces, { fields: [installations.workspaceId], references: [workspaces.id] }),
}));

export const usersRelations = relations(users, ({ one }) => ({
  workspace: one(workspaces, { fields: [users.workspaceId], references: [workspaces.id] }),
}));

export const namespacesRelations = relations(namespaces, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [namespaces.workspaceId], references: [workspaces.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  namespace: one(namespaces, { fields: [messages.namespaceId], references: [namespaces.id] }),
  files: many(files),
}));

export const filesRelations = relations(files, ({ one }) => ({
  message: one(messages, { fields: [files.messageId], references: [messages.id] }),
}));
```

- [ ] **Step 4: Write drizzle.config.ts**

```typescript
// drizzle.config.ts
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

- [ ] **Step 5: Write src/db/client.ts**

```typescript
// src/db/client.ts
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle({ client: pool, schema });
export type Database = typeof db;
```

- [ ] **Step 6: Generate and apply the initial migration against the test DB**

Run:
```bash
DATABASE_URL=postgres://recall:recall@localhost:55432/recall_test npx drizzle-kit generate --name=init
DATABASE_URL=postgres://recall:recall@localhost:55432/recall_test npx drizzle-kit migrate
```
Expected: `./drizzle/0000_init.sql` (plus `./drizzle/meta/`) is created; `migrate` reports the migration applied with no errors.

- [ ] **Step 7: Write tests/setup.ts**

```typescript
// tests/setup.ts
import { beforeAll, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";

beforeAll(async () => {
  // migrations are applied by `npm run test:db:migrate` before the suite runs (see Step 6);
  // this just verifies connectivity.
  await db.execute(sql`SELECT 1`);
});

afterEach(async () => {
  await db.execute(
    sql`TRUNCATE TABLE files, messages, namespaces, users, installations, workspaces RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await pool.end();
});
```

- [ ] **Step 8: Wire setup file + test env into vitest.config.ts**

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 30000,
    setupFiles: ["./tests/setup.ts"],
    env: {
      DATABASE_URL: "postgres://recall:recall@localhost:55432/recall_test",
    },
  },
});
```

- [ ] **Step 9: Write the failing schema test**

```typescript
// tests/db/schema.test.ts
import { describe, it, expect } from "vitest";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces } from "../../src/db/schema.js";

describe("schema", () => {
  it("enforces the namespaces workspace+channel+thread unique constraint", async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({ slackTeamId: "T123", name: "Test Workspace" })
      .returning();

    await db.insert(namespaces).values({
      workspaceId: workspace.id,
      channelId: "C1",
      threadTs: "111.222",
    });

    await expect(
      db.insert(namespaces).values({
        workspaceId: workspace.id,
        channelId: "C1",
        threadTs: "111.222",
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 10: Run test to verify it fails (DB not migrated in the test env yet)**

Run:
```bash
DATABASE_URL=postgres://recall:recall@localhost:55432/recall_test npx drizzle-kit migrate
npm test -- tests/db/schema.test.ts
```
Expected: after running `drizzle-kit migrate` against the test DB, this should already PASS — if it fails with a connection error, confirm `npm run test:db:up` succeeded first.

- [ ] **Step 11: Confirm the test passes**

Run: `npm test -- tests/db/schema.test.ts`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add drizzle.config.ts docker-compose.test.yml src/db/schema.ts src/db/client.ts vitest.config.ts tests/setup.ts tests/db/schema.test.ts drizzle/
git commit -m "feat: add Postgres schema (workspaces, installations, users, namespaces, messages, files) and migrations"
```

---

### Task 3: Delegate key generation and hashing

**Files:**
- Create: `src/keys/delegateKeys.ts`
- Test: `tests/keys/delegateKeys.test.ts`

**Interfaces:**
- Consumes: nothing (pure logic, no DB).
- Produces: `generateDelegateKey(): { plaintext: string; hash: string }`, `hashDelegateKey(plaintext: string): string`. Every later task that issues or verifies a key uses these two functions — no other module computes a key hash independently.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/keys/delegateKeys.test.ts
import { describe, it, expect } from "vitest";
import { generateDelegateKey, hashDelegateKey } from "../../src/keys/delegateKeys.js";

describe("delegateKeys", () => {
  it("generates a key prefixed with rk_ and a matching hash", () => {
    const { plaintext, hash } = generateDelegateKey();
    expect(plaintext).toMatch(/^rk_[a-f0-9]{48}$/);
    expect(hash).toBe(hashDelegateKey(plaintext));
  });

  it("produces different plaintext keys on each call", () => {
    const a = generateDelegateKey();
    const b = generateDelegateKey();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });

  it("hashes deterministically for the same plaintext", () => {
    const { plaintext } = generateDelegateKey();
    expect(hashDelegateKey(plaintext)).toBe(hashDelegateKey(plaintext));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/keys/delegateKeys.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write src/keys/delegateKeys.ts**

```typescript
// src/keys/delegateKeys.ts
import { randomBytes, createHash } from "node:crypto";

const KEY_PREFIX = "rk_";
const KEY_BYTES = 24; // -> 48 hex characters

export function generateDelegateKey(): { plaintext: string; hash: string } {
  const plaintext = `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString("hex")}`;
  return { plaintext, hash: hashDelegateKey(plaintext) };
}

export function hashDelegateKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/keys/delegateKeys.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/keys/delegateKeys.ts tests/keys/delegateKeys.test.ts
git commit -m "feat: add delegate key generation and hashing"
```

---

### Task 4: Postgres-backed Slack InstallationStore

**Files:**
- Create: `src/slack/installationStore.ts`
- Test: `tests/slack/installationStore.test.ts`

**Interfaces:**
- Consumes: `Database` type from `src/db/client.ts` (Task 2); `workspaces`, `installations` tables from `src/db/schema.ts` (Task 2).
- Produces: `createPostgresInstallationStore(db: Database): InstallationStore` (the `InstallationStore` type re-exported from `@slack/bolt`). Task 5 (Slack receiver) passes this directly as `ExpressReceiverOptions.installationStore`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/slack/installationStore.test.ts
import { describe, it, expect } from "vitest";
import type { Installation } from "@slack/bolt";
import { db } from "../../src/db/client.js";
import { workspaces, installations } from "../../src/db/schema.js";
import { createPostgresInstallationStore } from "../../src/slack/installationStore.js";
import { eq } from "drizzle-orm";

function fakeInstallation(teamId: string): Installation<"v2", false> {
  return {
    team: { id: teamId, name: "Test Team" },
    enterprise: undefined,
    user: { token: undefined, scopes: undefined, id: "U1" },
    bot: {
      token: "xoxb-fake-token",
      scopes: ["chat:write"],
      id: "B1",
      userId: "UBOT1",
    },
    tokenType: "bot",
    isEnterpriseInstall: false,
    appId: "A1",
    authVersion: "v2",
  };
}

describe("createPostgresInstallationStore", () => {
  it("stores and fetches an installation by team id", async () => {
    const store = createPostgresInstallationStore(db);
    const installation = fakeInstallation("T100");

    await store.storeInstallation(installation);

    const fetched = await store.fetchInstallation({
      teamId: "T100",
      enterpriseId: undefined,
      isEnterpriseInstall: false,
    });

    expect(fetched.team?.id).toBe("T100");
    expect(fetched.bot?.token).toBe("xoxb-fake-token");

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.slackTeamId, "T100"));
    expect(workspace).toBeDefined();
    const [installationRow] = await db
      .select()
      .from(installations)
      .where(eq(installations.workspaceId, workspace.id));
    expect(installationRow.botToken).toBe("xoxb-fake-token");
  });

  it("updates an existing installation on re-install (same team id)", async () => {
    const store = createPostgresInstallationStore(db);
    await store.storeInstallation(fakeInstallation("T200"));

    const reinstalled = fakeInstallation("T200");
    reinstalled.bot!.token = "xoxb-rotated-token";
    await store.storeInstallation(reinstalled);

    const fetched = await store.fetchInstallation({
      teamId: "T200",
      enterpriseId: undefined,
      isEnterpriseInstall: false,
    });
    expect(fetched.bot?.token).toBe("xoxb-rotated-token");
  });

  it("throws when fetching an unknown team id", async () => {
    const store = createPostgresInstallationStore(db);
    await expect(
      store.fetchInstallation({ teamId: "T-UNKNOWN", enterpriseId: undefined, isEnterpriseInstall: false }),
    ).rejects.toThrow();
  });

  it("deletes an installation", async () => {
    const store = createPostgresInstallationStore(db);
    await store.storeInstallation(fakeInstallation("T300"));

    await store.deleteInstallation!({ teamId: "T300", enterpriseId: undefined, isEnterpriseInstall: false });

    await expect(
      store.fetchInstallation({ teamId: "T300", enterpriseId: undefined, isEnterpriseInstall: false }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/slack/installationStore.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write src/slack/installationStore.ts**

```typescript
// src/slack/installationStore.ts
import { eq } from "drizzle-orm";
import type { Installation, InstallationQuery, InstallationStore } from "@slack/bolt";
import type { Database } from "../db/client.js";
import { workspaces, installations } from "../db/schema.js";

export function createPostgresInstallationStore(db: Database): InstallationStore {
  return {
    async storeInstallation<AuthVersion extends "v1" | "v2">(
      installation: Installation<AuthVersion, boolean>,
    ): Promise<void> {
      if (installation.isEnterpriseInstall) {
        throw new Error("Enterprise Grid (org-wide) installs are not supported yet");
      }
      const teamId = installation.team?.id;
      const bot = installation.bot;
      if (!teamId || !bot) {
        throw new Error("Failed saving installation: missing team id or bot token");
      }

      const [workspace] = await db
        .insert(workspaces)
        .values({ slackTeamId: teamId, name: installation.team?.name ?? teamId })
        .onConflictDoUpdate({
          target: workspaces.slackTeamId,
          set: { name: installation.team?.name ?? teamId, updatedAt: new Date() },
        })
        .returning();

      await db
        .insert(installations)
        .values({
          workspaceId: workspace.id,
          botToken: bot.token,
          botUserId: bot.userId,
        })
        .onConflictDoUpdate({
          target: installations.workspaceId,
          set: { botToken: bot.token, botUserId: bot.userId, revokedAt: null, updatedAt: new Date() },
        });
    },

    async fetchInstallation(query: InstallationQuery<boolean>): Promise<Installation<"v1" | "v2", boolean>> {
      if (query.isEnterpriseInstall || !query.teamId) {
        throw new Error("Enterprise Grid (org-wide) installs are not supported yet");
      }

      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.slackTeamId, query.teamId));
      if (!workspace) {
        throw new Error(`No installation found for team ${query.teamId}`);
      }
      const [installationRow] = await db
        .select()
        .from(installations)
        .where(eq(installations.workspaceId, workspace.id));
      if (!installationRow || installationRow.revokedAt) {
        throw new Error(`No active installation found for team ${query.teamId}`);
      }

      return {
        team: { id: workspace.slackTeamId, name: workspace.name },
        enterprise: undefined,
        user: { token: undefined, scopes: undefined, id: "" },
        bot: {
          token: installationRow.botToken,
          scopes: [],
          id: "",
          userId: installationRow.botUserId,
        },
        tokenType: "bot",
        isEnterpriseInstall: false,
        authVersion: "v2",
      };
    },

    async deleteInstallation(query: InstallationQuery<boolean>): Promise<void> {
      if (query.isEnterpriseInstall || !query.teamId) return;
      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.slackTeamId, query.teamId));
      if (!workspace) return;
      await db
        .update(installations)
        .set({ revokedAt: new Date() })
        .where(eq(installations.workspaceId, workspace.id));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/slack/installationStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/slack/installationStore.ts tests/slack/installationStore.test.ts
git commit -m "feat: add Postgres-backed Slack InstallationStore"
```

---

### Task 5: Slack App / OAuth receiver

**Manual prerequisite (do this once, in Slack's own dashboard, before writing any code in this task):**

1. Go to https://api.slack.com/apps → "Create New App" → "From scratch".
2. Under **OAuth & Permissions**, add these **Bot Token Scopes**: `app_mentions:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `chat:write`, `im:write`, `files:read`, `commands`.
3. Under **OAuth & Permissions → Redirect URLs**, add `https://<your-dev-tunnel-or-railway-domain>/slack/oauth_redirect` (Bolt's default `installerOptions.redirectUriPath`).
4. Under **Event Subscriptions**, enable events, set the Request URL to `https://<your-dev-tunnel-or-railway-domain>/slack/events`, and subscribe to bot events: `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`.
5. Under **Slash Commands**, create `/recall-key` with the same Request URL.
6. Under **Basic Information**, copy the **Client ID**, **Client Secret**, and **Signing Secret** into your local `.env` (`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`). Generate a random 32+ char string for `SLACK_STATE_SECRET` yourself (e.g. `openssl rand -hex 32`) — Slack doesn't provide this one.

**Files:**
- Create: `src/slack/receiver.ts`
- Test: `tests/slack/receiver.test.ts`

**Interfaces:**
- Consumes: `createPostgresInstallationStore` (Task 4), `Database` type (Task 2).
- Produces: `createSlackReceiver(params: { db: Database; app: Express }): ExpressReceiver`, `createSlackApp(receiver: ExpressReceiver): App`. Task 8 (events) and Task 9 (slash command) both take the `App` this produces and call `.event()`/`.message()`/`.command()` on it. Task 12 calls `createSlackReceiver`/`createSlackApp` from the composition root.

- [ ] **Step 1: Write the failing test**

This test only exercises the **install-initiation** redirect (no live Slack API call is involved in that step — it just builds a redirect URL to `slack.com` with a signed state). The OAuth callback (`/slack/oauth_redirect`, which *does* call Slack's API) and live event delivery are verified manually against the real Slack app in Task 13's deployment checklist — they can't be meaningfully unit-tested without a live Slack API double that would test the mock more than the code.

```typescript
// tests/slack/receiver.test.ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { db } from "../../src/db/client.js";
import { createSlackReceiver, createSlackApp } from "../../src/slack/receiver.js";

describe("createSlackReceiver", () => {
  it("redirects GET /slack/install to Slack's authorize URL", async () => {
    const app = express();
    const receiver = createSlackReceiver({
      db,
      app,
      signingSecret: "test-signing-secret",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      stateSecret: "test-state-secret-test-state-secret",
    });
    createSlackApp(receiver);

    const res = await request(app).get("/slack/install");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://slack.com/oauth/v2/authorize");
    expect(res.headers.location).toContain("client_id=test-client-id");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/slack/receiver.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write src/slack/receiver.ts**

```typescript
// src/slack/receiver.ts
import type { Express } from "express";
import { App, ExpressReceiver } from "@slack/bolt";
import type { Database } from "../db/client.js";
import { createPostgresInstallationStore } from "./installationStore.js";

export interface SlackReceiverParams {
  db: Database;
  app: Express;
  signingSecret: string;
  clientId: string;
  clientSecret: string;
  stateSecret: string;
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

export function createSlackReceiver(params: SlackReceiverParams): ExpressReceiver {
  const { db, app, signingSecret, clientId, clientSecret, stateSecret } = params;

  return new ExpressReceiver({
    signingSecret,
    clientId,
    clientSecret,
    stateSecret,
    scopes: SCOPES,
    installationStore: createPostgresInstallationStore(db),
    installerOptions: {
      directInstall: true,
    },
    app,
  });
}

export function createSlackApp(receiver: ExpressReceiver): App {
  return new App({ receiver });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/slack/receiver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/slack/receiver.ts tests/slack/receiver.test.ts
git commit -m "feat: add Slack OAuth receiver mounted on the shared Express app"
```

---

### Task 6: File capture (bucket storage + Slack file download)

**Files:**
- Create: `src/storage/bucket.ts`
- Create: `src/slack/files.ts`
- Test: `tests/storage/bucket.test.ts`
- Test: `tests/slack/files.test.ts`

**Interfaces:**
- Consumes: `Database` type, `files`/`messages` tables (Task 2).
- Produces: `putFile(key: string, body: Buffer, contentType: string): Promise<string>`, `getSignedDownloadUrl(key: string, expiresInSeconds?: number): Promise<string>` from `bucket.ts`; `downloadSlackFile(url: string, botToken: string): Promise<Buffer>` and `captureSlackFile(params: { db: Database; file: SlackFileObject; botToken: string; messageId: string }): Promise<void>` from `files.ts`. Task 7 (backfill) and Task 8 (events) both call `captureSlackFile` for every file on a message; `mcp/recallTool.ts` (Task 11) calls `getSignedDownloadUrl` directly.

- [ ] **Step 1: Write the failing bucket test**

The bucket client reads its config from env vars (`BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `REGION`, `ENDPOINT`) — this test uses `aws-sdk-client-mock` to avoid making real S3 calls.

Run: `npm install -D aws-sdk-client-mock`

```typescript
// tests/storage/bucket.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { putFile, getSignedDownloadUrl } from "../../src/storage/bucket.js";

const s3Mock = mockClient(S3Client);

beforeEach(() => {
  s3Mock.reset();
});

describe("bucket", () => {
  it("uploads a file with putFile and returns the key", async () => {
    s3Mock.on(PutObjectCommand).resolves({});

    const key = await putFile("threads/abc/report.txt", Buffer.from("hello"), "text/plain");

    expect(key).toBe("threads/abc/report.txt");
    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.Key).toBe("threads/abc/report.txt");
    expect(calls[0].args[0].input.ContentType).toBe("text/plain");
  });

  it("returns a signed URL string for a stored key", async () => {
    const url = await getSignedDownloadUrl("threads/abc/report.txt", 60);
    expect(url).toContain("threads/abc/report.txt");
    expect(typeof url).toBe("string");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/storage/bucket.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write src/storage/bucket.ts**

```typescript
// src/storage/bucket.ts
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({
  region: process.env.REGION || "auto",
  endpoint: process.env.ENDPOINT,
  credentials: {
    accessKeyId: process.env.ACCESS_KEY_ID || "",
    secretAccessKey: process.env.SECRET_ACCESS_KEY || "",
  },
  forcePathStyle: process.env.AWS_S3_URL_STYLE === "path",
});

function bucketName(): string {
  const bucket = process.env.BUCKET;
  if (!bucket) throw new Error("BUCKET environment variable is not set");
  return bucket;
}

export async function putFile(key: string, body: Buffer, contentType: string): Promise<string> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return key;
}

export async function getSignedDownloadUrl(key: string, expiresInSeconds = 3600): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucketName(), Key: key });
  return getSignedUrl(s3, command, { expiresIn: expiresInSeconds });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/storage/bucket.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing Slack file capture test**

```typescript
// tests/slack/files.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, messages, files } from "../../src/db/schema.js";
import { downloadSlackFile, captureSlackFile } from "../../src/slack/files.js";
import { eq } from "drizzle-orm";

const s3Mock = mockClient(S3Client);

beforeEach(() => {
  s3Mock.reset();
  s3Mock.on(PutObjectCommand).resolves({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedMessage() {
  const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();
  const [namespace] = await db
    .insert(namespaces)
    .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.1" })
    .returning();
  const [message] = await db
    .insert(messages)
    .values({ namespaceId: namespace.id, slackUserId: "U1", text: "hi", slackTs: "1.2" })
    .returning();
  return message;
}

describe("downloadSlackFile", () => {
  it("fetches the file with a bearer token and returns a Buffer", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode("file-bytes").buffer,
    });
    vi.stubGlobal("fetch", fetchMock);

    const buf = await downloadSlackFile("https://files.slack.com/f1", "xoxb-token");

    expect(buf.toString()).toBe("file-bytes");
    expect(fetchMock).toHaveBeenCalledWith("https://files.slack.com/f1", {
      headers: { Authorization: "Bearer xoxb-token" },
    });
  });

  it("throws when the download response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" }));
    await expect(downloadSlackFile("https://files.slack.com/f1", "xoxb-token")).rejects.toThrow(/403/);
  });
});

describe("captureSlackFile", () => {
  it("downloads, uploads to the bucket, and marks the file row stored", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode("bytes").buffer }),
    );
    const message = await seedMessage();

    await captureSlackFile({
      db,
      messageId: message.id,
      botToken: "xoxb-token",
      file: {
        id: "F1",
        name: "report.txt",
        mimetype: "text/plain",
        url_private: "https://files.slack.com/f1",
      },
    });

    const [fileRow] = await db.select().from(files).where(eq(files.messageId, message.id));
    expect(fileRow.status).toBe("stored");
    expect(fileRow.originalName).toBe("report.txt");
    expect(fileRow.bucketKey).toContain(message.id);
  });

  it("marks the file row failed when the download throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Server Error" }));
    const message = await seedMessage();

    await captureSlackFile({
      db,
      messageId: message.id,
      botToken: "xoxb-token",
      file: {
        id: "F2",
        name: "broken.txt",
        mimetype: "text/plain",
        url_private: "https://files.slack.com/f2",
      },
    });

    const [fileRow] = await db.select().from(files).where(eq(files.messageId, message.id));
    expect(fileRow.status).toBe("failed");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- tests/slack/files.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 7: Write src/slack/files.ts**

```typescript
// src/slack/files.ts
import type { Database } from "../db/client.js";
import { files } from "../db/schema.js";
import { putFile } from "../storage/bucket.js";

export interface SlackFileObject {
  id: string;
  name: string;
  mimetype: string;
  url_private: string;
}

export async function downloadSlackFile(url: string, botToken: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!res.ok) {
    throw new Error(`Slack file download failed: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export interface CaptureSlackFileParams {
  db: Database;
  file: SlackFileObject;
  botToken: string;
  messageId: string;
}

export async function captureSlackFile(params: CaptureSlackFileParams): Promise<void> {
  const { db, file, botToken, messageId } = params;

  const [fileRow] = await db
    .insert(files)
    .values({
      messageId,
      originalName: file.name,
      mimeType: file.mimetype,
      status: "pending",
    })
    .returning();

  try {
    const bytes = await downloadSlackFile(file.url_private, botToken);
    const bucketKey = `messages/${messageId}/${file.id}-${file.name}`;
    await putFile(bucketKey, bytes, file.mimetype);
    await db.update(files).set({ bucketKey, status: "stored" }).where(eqId(fileRow.id));
  } catch {
    await db.update(files).set({ status: "failed" }).where(eqId(fileRow.id));
  }
}

// local helper to avoid importing `eq` + `files` twice for this one narrow use
function eqId(id: string) {
  const { eq } = require("drizzle-orm") as typeof import("drizzle-orm");
  return eq(files.id, id);
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test -- tests/slack/files.test.ts`
Expected: PASS. If the `require(...)` inline helper trips up the ESM build (`require` is not defined in a NodeNext ESM module), replace it with a normal top-level `import { eq } from "drizzle-orm"` and call `eq(files.id, fileRow.id)` directly — do that now rather than shipping the workaround:

```typescript
// src/slack/files.ts (revised top of file)
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { files } from "../db/schema.js";
import { putFile } from "../storage/bucket.js";

// ...(SlackFileObject, downloadSlackFile unchanged)...

export async function captureSlackFile(params: CaptureSlackFileParams): Promise<void> {
  const { db, file, botToken, messageId } = params;

  const [fileRow] = await db
    .insert(files)
    .values({ messageId, originalName: file.name, mimeType: file.mimetype, status: "pending" })
    .returning();

  try {
    const bytes = await downloadSlackFile(file.url_private, botToken);
    const bucketKey = `messages/${messageId}/${file.id}-${file.name}`;
    await putFile(bucketKey, bytes, file.mimetype);
    await db.update(files).set({ bucketKey, status: "stored" }).where(eq(files.id, fileRow.id));
  } catch {
    await db.update(files).set({ status: "failed" }).where(eq(files.id, fileRow.id));
  }
}
```

Run: `npm test -- tests/slack/files.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/storage/bucket.ts src/slack/files.ts tests/storage/bucket.test.ts tests/slack/files.test.ts package.json package-lock.json
git commit -m "feat: add bucket storage wrapper and Slack file capture"
```

---

### Task 7: Backfill worker

**Files:**
- Create: `src/slack/backfill.ts`
- Test: `tests/slack/backfill.test.ts`

**Interfaces:**
- Consumes: `Database` type; `workspaces`, `namespaces`, `messages` tables (Task 2); `captureSlackFile` (Task 6).
- Produces: `backfillThread(params: { db: Database; client: WebClient; workspaceId: string; channelId: string; threadTs: string; botToken: string; retryDelayMs?: number }): Promise<{ namespaceId: string }>`. `retryDelayMs` is test-only (defaults to 500ms in production, overridden to 1ms in tests so retry tests stay fast). Task 8 (events) calls this on the first `app_mention` in a thread, using the production default.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/slack/backfill.test.ts
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, messages } from "../../src/db/schema.js";
import { backfillThread } from "../../src/slack/backfill.js";

function fakeWebClient(pages: Array<{ messages: any[]; nextCursor?: string }>) {
  let call = 0;
  return {
    conversations: {
      replies: vi.fn().mockImplementation(async () => {
        const page = pages[call];
        call += 1;
        return {
          messages: page.messages,
          response_metadata: page.nextCursor ? { next_cursor: page.nextCursor } : {},
        };
      }),
    },
  } as any;
}

describe("backfillThread", () => {
  it("creates a namespace and stores every message across pages", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();

    const client = fakeWebClient([
      {
        messages: [
          { ts: "1.000", user: "U1", text: "root message" },
          { ts: "1.001", user: "U2", text: "first reply" },
        ],
        nextCursor: "cursor-2",
      },
      {
        messages: [{ ts: "1.002", user: "U1", text: "second reply" }],
      },
    ]);

    const { namespaceId } = await backfillThread({
      db,
      client,
      workspaceId: workspace.id,
      channelId: "C1",
      threadTs: "1.000",
      botToken: "xoxb-token",
    });

    const [namespace] = await db.select().from(namespaces).where(eq(namespaces.id, namespaceId));
    expect(namespace.channelId).toBe("C1");
    expect(namespace.threadTs).toBe("1.000");
    expect(namespace.status).toBe("active");

    const rows = await db.select().from(messages).where(eq(messages.namespaceId, namespaceId));
    expect(rows).toHaveLength(3);
    expect(client.conversations.replies).toHaveBeenCalledTimes(2);
    expect(client.conversations.replies).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ channel: "C1", ts: "1.000", cursor: undefined }),
    );
    expect(client.conversations.replies).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ channel: "C1", ts: "1.000", cursor: "cursor-2" }),
    );
  });

  it("is idempotent when run twice for the same thread", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2", name: "T" }).returning();
    const client = fakeWebClient([{ messages: [{ ts: "2.000", user: "U1", text: "hi" }] }]);

    const first = await backfillThread({
      db,
      client,
      workspaceId: workspace.id,
      channelId: "C2",
      threadTs: "2.000",
      botToken: "xoxb-token",
    });

    const client2 = fakeWebClient([{ messages: [{ ts: "2.000", user: "U1", text: "hi" }] }]);
    const second = await backfillThread({
      db,
      client: client2,
      workspaceId: workspace.id,
      channelId: "C2",
      threadTs: "2.000",
      botToken: "xoxb-token",
    });

    expect(second.namespaceId).toBe(first.namespaceId);
    const rows = await db.select().from(messages).where(eq(messages.namespaceId, first.namespaceId));
    expect(rows).toHaveLength(1);
  });

  it("retries a transient conversations.replies failure and still completes", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T3", name: "T" }).returning();
    let call = 0;
    const client = {
      conversations: {
        replies: vi.fn().mockImplementation(async () => {
          call += 1;
          if (call === 1) throw new Error("rate_limited");
          return { messages: [{ ts: "3.000", user: "U1", text: "hi" }], response_metadata: {} };
        }),
      },
    } as any;

    const { namespaceId } = await backfillThread({
      db,
      client,
      workspaceId: workspace.id,
      channelId: "C3",
      threadTs: "3.000",
      botToken: "xoxb-token",
      retryDelayMs: 1, // keep the test fast; production default is defined in backfill.ts
    });

    const rows = await db.select().from(messages).where(eq(messages.namespaceId, namespaceId));
    expect(rows).toHaveLength(1);
    expect(client.conversations.replies).toHaveBeenCalledTimes(2);
  });

  it("gives up after the max retry attempts but keeps whatever was already inserted", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T4", name: "T" }).returning();
    const client = {
      conversations: {
        replies: vi.fn().mockImplementation(async () => {
          throw new Error("rate_limited");
        }),
      },
    } as any;

    await expect(
      backfillThread({
        db,
        client,
        workspaceId: workspace.id,
        channelId: "C4",
        threadTs: "4.000",
        botToken: "xoxb-token",
        retryDelayMs: 1,
      }),
    ).rejects.toThrow("rate_limited");

    // the namespace row itself is still created (inserted before any Slack API call),
    // so a later re-invocation of backfillThread for the same thread resumes into it
    // via onConflictDoNothing rather than duplicating it.
    const [namespace] = await db
      .select()
      .from(namespaces)
      .where(and(eq(namespaces.workspaceId, workspace.id), eq(namespaces.channelId, "C4"), eq(namespaces.threadTs, "4.000")));
    expect(namespace).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/slack/backfill.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write src/slack/backfill.ts**

```typescript
// src/slack/backfill.ts
import { and, eq } from "drizzle-orm";
import type { WebClient } from "@slack/bolt";
import type { Database } from "../db/client.js";
import { namespaces, messages } from "../db/schema.js";
import { captureSlackFile, type SlackFileObject } from "./files.js";

export interface BackfillThreadParams {
  db: Database;
  client: WebClient;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  botToken: string;
  /** overridable only for tests — production keeps the exported default */
  retryDelayMs?: number;
}

const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_RETRY_ATTEMPTS = 5;

// Slack rate-limits (and occasionally 5xxs) conversations.replies. Retrying with
// backoff here is what makes backfill resilient to that without losing progress:
// messages are upserted per-page as we go, so even if retries are exhausted partway
// through pagination, everything fetched so far stays committed. A later re-invocation
// (e.g. Slack redelivering the app_mention event) restarts pagination from page 1, but
// onConflictDoNothing makes that a no-op for anything already stored — cheap to redo,
// not lossy.
async function withRetry<T>(fn: () => Promise<T>, retryDelayMs: number): Promise<T> {
  let attempt = 0;
  let delay = retryDelayMs;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt >= MAX_RETRY_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

export async function backfillThread(params: BackfillThreadParams): Promise<{ namespaceId: string }> {
  const { db, client, workspaceId, channelId, threadTs, botToken, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = params;

  await db
    .insert(namespaces)
    .values({ workspaceId, channelId, threadTs })
    .onConflictDoNothing({
      target: [namespaces.workspaceId, namespaces.channelId, namespaces.threadTs],
    });

  const [namespace] = await db
    .select()
    .from(namespaces)
    .where(
      and(eq(namespaces.workspaceId, workspaceId), eq(namespaces.channelId, channelId), eq(namespaces.threadTs, threadTs)),
    );

  let cursor: string | undefined;
  do {
    const page = await withRetry(
      () =>
        client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          cursor,
          limit: 200,
        }),
      retryDelayMs,
    );

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

      // onConflictDoNothing returns [] on a skipped row; only capture files for newly-inserted messages
      const rawFiles = (raw as { files?: SlackFileObject[] }).files ?? [];
      if (messageRow && rawFiles.length > 0) {
        for (const file of rawFiles) {
          await captureSlackFile({ db, file, botToken, messageId: messageRow.id });
        }
      }
    }

    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return { namespaceId: namespace.id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/slack/backfill.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/slack/backfill.ts tests/slack/backfill.test.ts
git commit -m "feat: add thread backfill worker with pagination and idempotent upserts"
```

---

### Task 8: Slack event handlers (tag trigger + live capture)

**Files:**
- Create: `src/slack/events.ts`
- Test: `tests/slack/events.test.ts`

**Interfaces:**
- Consumes: `backfillThread` (Task 7); `Database` type; `namespaces`, `messages` tables (Task 2); `captureSlackFile` (Task 6).
- Produces: `registerEventHandlers(app: App, db: Database): void`. Task 12 calls this once on the `App` built in Task 5.

- [ ] **Step 1: Write the failing test**

This tests the two handler functions directly (not through a live Bolt dispatch, which would require standing up the whole receiver) — Bolt listener args are plain objects, so the handlers are testable as ordinary async functions.

```typescript
// tests/slack/events.test.ts
import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, messages } from "../../src/db/schema.js";
import { handleAppMention, handleMessage } from "../../src/slack/events.js";

function fakeClient(replies: any[] = []) {
  return {
    conversations: {
      replies: vi.fn().mockResolvedValue({ messages: replies, response_metadata: {} }),
    },
  } as any;
}

describe("handleAppMention", () => {
  it("backfills the thread and marks the namespace active", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();
    const client = fakeClient([{ ts: "1.000", user: "U1", text: "root" }]);

    await handleAppMention({
      db,
      client,
      botToken: "xoxb-token",
      event: { channel: "C1", ts: "1.000", thread_ts: undefined, user: "U9", text: "<@BOT> help" } as any,
      workspaceId: workspace.id,
    });

    const [namespace] = await db
      .select()
      .from(namespaces)
      .where(and(eq(namespaces.workspaceId, workspace.id), eq(namespaces.channelId, "C1"), eq(namespaces.threadTs, "1.000")));
    expect(namespace).toBeDefined();
    expect(namespace.status).toBe("active");
  });
});

describe("handleMessage", () => {
  it("appends a reply to an existing active namespace", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C2", threadTs: "2.000" })
      .returning();

    await handleMessage({
      db,
      botToken: "xoxb-token",
      workspaceId: workspace.id,
      message: { channel: "C2", ts: "2.001", thread_ts: "2.000", user: "U1", text: "a reply" } as any,
    });

    const rows = await db.select().from(messages).where(eq(messages.namespaceId, namespace.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("a reply");
  });

  it("drops a message whose thread has no active namespace", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T3", name: "T" }).returning();

    await handleMessage({
      db,
      botToken: "xoxb-token",
      workspaceId: workspace.id,
      message: { channel: "C3", ts: "3.001", thread_ts: "3.000", user: "U1", text: "ignored" } as any,
    });

    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(0);
  });

  it("ignores a top-level message that is not a thread reply", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T4", name: "T" }).returning();

    await handleMessage({
      db,
      botToken: "xoxb-token",
      workspaceId: workspace.id,
      message: { channel: "C4", ts: "4.001", thread_ts: undefined, user: "U1", text: "not a reply" } as any,
    });

    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/slack/events.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write src/slack/events.ts**

```typescript
// src/slack/events.ts
import { and, eq } from "drizzle-orm";
import type { App, WebClient } from "@slack/bolt";
import type { Database } from "../db/client.js";
import { namespaces, messages } from "../db/schema.js";
import { backfillThread } from "./backfill.js";
import { captureSlackFile, type SlackFileObject } from "./files.js";

interface AppMentionLikeEvent {
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  text: string;
}

export async function handleAppMention(params: {
  db: Database;
  client: WebClient;
  botToken: string;
  workspaceId: string;
  event: AppMentionLikeEvent;
}): Promise<void> {
  const { db, client, botToken, workspaceId, event } = params;
  const threadTs = event.thread_ts ?? event.ts;

  await backfillThread({
    db,
    client,
    workspaceId,
    channelId: event.channel,
    threadTs,
    botToken,
  });

  await db
    .update(namespaces)
    .set({ status: "active", updatedAt: new Date() })
    .where(and(eq(namespaces.workspaceId, workspaceId), eq(namespaces.channelId, event.channel), eq(namespaces.threadTs, threadTs)));
}

interface MessageLikeEvent {
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  files?: SlackFileObject[];
}

export async function handleMessage(params: {
  db: Database;
  botToken: string;
  workspaceId: string;
  message: MessageLikeEvent;
}): Promise<void> {
  const { db, botToken, workspaceId, message } = params;

  if (!message.thread_ts || !message.user) return; // not a thread reply, or a subtype we don't track

  const [namespace] = await db
    .select()
    .from(namespaces)
    .where(
      and(
        eq(namespaces.workspaceId, workspaceId),
        eq(namespaces.channelId, message.channel),
        eq(namespaces.threadTs, message.thread_ts),
        eq(namespaces.status, "active"),
      ),
    );
  if (!namespace) return; // not a thread we're watching

  const [messageRow] = await db
    .insert(messages)
    .values({
      namespaceId: namespace.id,
      slackUserId: message.user,
      text: message.text ?? "",
      slackTs: message.ts,
    })
    .onConflictDoNothing({ target: [messages.namespaceId, messages.slackTs] })
    .returning();

  if (messageRow && message.files?.length) {
    for (const file of message.files) {
      await captureSlackFile({ db, file, botToken, messageId: messageRow.id });
    }
  }
}

export function registerEventHandlers(app: App, db: Database): void {
  app.event("app_mention", async ({ event, client, context }) => {
    const workspaceId = context.workspaceId as string | undefined;
    if (!workspaceId) return; // set by the composition root's authorize step, see Task 12
    await handleAppMention({
      db,
      client,
      botToken: context.botToken as string,
      workspaceId,
      event,
    });
  });

  app.message(async ({ message, context }) => {
    const workspaceId = context.workspaceId as string | undefined;
    if (!workspaceId || message.subtype !== undefined) return;
    await handleMessage({
      db,
      botToken: context.botToken as string,
      workspaceId,
      message: message as unknown as MessageLikeEvent,
    });
  });
}
```

**Note carried into Task 12:** `context.workspaceId` is not a value Bolt populates for you automatically — Task 12's composition root must set it via a custom `authorize`-adjacent step or by looking up `context.teamId` (which Bolt *does* populate from the installation) against `workspaces.slackTeamId` inside these handlers instead. Simplify `registerEventHandlers` at that point to resolve the workspace from `context.teamId` rather than assuming `context.workspaceId` exists — flagged here explicitly rather than silently guessed at.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/slack/events.test.ts`
Expected: PASS (the two exported handlers `handleAppMention`/`handleMessage` are tested directly, independent of the `context.workspaceId` wiring question above, which only affects `registerEventHandlers`'s own body).

- [ ] **Step 5: Commit**

```bash
git add src/slack/events.ts tests/slack/events.test.ts
git commit -m "feat: add app_mention and message event handlers for backfill and live capture"
```

---

### Task 9: `/recall-key` slash command

**Files:**
- Create: `src/slack/recallKeyCommand.ts`
- Test: `tests/slack/recallKeyCommand.test.ts`

**Interfaces:**
- Consumes: `generateDelegateKey` (Task 3); `Database` type; `workspaces`, `users` tables (Task 2).
- Produces: `issueDelegateKey(db: Database, workspaceId: string, slackUserId: string): Promise<string>` (returns the plaintext key, storing only its hash), `registerRecallKeyCommand(app: App, db: Database): void`. Task 12 calls `registerRecallKeyCommand` once.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/slack/recallKeyCommand.test.ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { workspaces, users } from "../../src/db/schema.js";
import { issueDelegateKey } from "../../src/slack/recallKeyCommand.js";
import { hashDelegateKey } from "../../src/keys/delegateKeys.js";

describe("issueDelegateKey", () => {
  it("creates a user row with a hashed key and returns the plaintext once", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();

    const plaintext = await issueDelegateKey(db, workspace.id, "U100");

    expect(plaintext).toMatch(/^rk_/);
    const [user] = await db.select().from(users).where(eq(users.slackUserId, "U100"));
    expect(user.delegateKeyHash).toBe(hashDelegateKey(plaintext));
  });

  it("rotates the key (and hash) when called again for the same user", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2", name: "T" }).returning();

    const first = await issueDelegateKey(db, workspace.id, "U200");
    const second = await issueDelegateKey(db, workspace.id, "U200");

    expect(second).not.toBe(first);
    const rows = await db.select().from(users).where(eq(users.slackUserId, "U200"));
    expect(rows).toHaveLength(1);
    expect(rows[0].delegateKeyHash).toBe(hashDelegateKey(second));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/slack/recallKeyCommand.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write src/slack/recallKeyCommand.ts**

```typescript
// src/slack/recallKeyCommand.ts
import { eq, and } from "drizzle-orm";
import type { App } from "@slack/bolt";
import type { Database } from "../db/client.js";
import { users } from "../db/schema.js";
import { generateDelegateKey } from "../keys/delegateKeys.js";

export async function issueDelegateKey(db: Database, workspaceId: string, slackUserId: string): Promise<string> {
  const { plaintext, hash } = generateDelegateKey();

  await db
    .insert(users)
    .values({ workspaceId, slackUserId, delegateKeyHash: hash })
    .onConflictDoUpdate({
      target: [users.workspaceId, users.slackUserId],
      set: { delegateKeyHash: hash, updatedAt: new Date() },
    });

  return plaintext;
}

export function registerRecallKeyCommand(app: App, db: Database): void {
  app.command("/recall-key", async ({ command, ack, client, logger }) => {
    await ack();

    try {
      const workspaceIdRow = await db.query.workspaces.findFirst({
        where: (w, { eq: eqCol }) => eqCol(w.slackTeamId, command.team_id),
      });
      if (!workspaceIdRow) {
        logger.error(`No workspace found for team ${command.team_id}`);
        return;
      }

      const plaintext = await issueDelegateKey(db, workspaceIdRow.id, command.user_id);

      const dm = await client.conversations.open({ users: command.user_id });
      await client.chat.postMessage({
        channel: dm.channel!.id!,
        text: `Here's your recall delegate key. Keep it secret — anyone with this key can recall any thread you've participated in:\n\`${plaintext}\`\n\nRun \`/recall-key\` again any time to rotate it (this invalidates the old one).`,
      });
    } catch (error) {
      logger.error(error);
    }
  });
}
```

Note: `db.query.workspaces.findFirst` relies on Drizzle's relational query API being available on `db`, which requires `db = drizzle({ client, schema })` to have received the full `schema` module (including relation exports) — already the case in `src/db/client.ts` from Task 2.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/slack/recallKeyCommand.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/slack/recallKeyCommand.ts tests/slack/recallKeyCommand.test.ts
git commit -m "feat: add /recall-key slash command for self-serve delegate key issuance"
```

---

### Task 10: MCP bearer-token auth middleware

**Files:**
- Create: `src/mcp/auth.ts`
- Test: `tests/mcp/auth.test.ts`

**Interfaces:**
- Consumes: `hashDelegateKey` (Task 3); `Database` type; `users` table (Task 2).
- Produces: `requireDelegateKey(db: Database): RequestHandler`, `interface AuthedRequest extends Request { delegateUser?: DelegateUser }`, `interface DelegateUser { id: string; workspaceId: string; slackUserId: string }`. Task 11 (recall tool + MCP route) imports `AuthedRequest` and `DelegateUser` from here — **this is the canonical definition of `DelegateUser`, not redefined elsewhere.**

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp/auth.test.ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { db } from "../../src/db/client.js";
import { workspaces, users } from "../../src/db/schema.js";
import { requireDelegateKey, type AuthedRequest } from "../../src/mcp/auth.js";
import { hashDelegateKey } from "../../src/keys/delegateKeys.js";

function buildTestApp() {
  const app = express();
  app.get("/protected", requireDelegateKey(db), (req: AuthedRequest, res) => {
    res.json({ delegateUser: req.delegateUser });
  });
  return app;
}

describe("requireDelegateKey", () => {
  it("returns 401 when no Authorization header is present", async () => {
    const res = await request(buildTestApp()).get("/protected");
    expect(res.status).toBe(401);
  });

  it("returns 401 for a well-formed but unknown key", async () => {
    const res = await request(buildTestApp()).get("/protected").set("Authorization", "Bearer rk_doesnotexist");
    expect(res.status).toBe(401);
  });

  it("attaches delegateUser and calls next for a valid key", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();
    const plaintext = "rk_testkey1234567890";
    const [user] = await db
      .insert(users)
      .values({ workspaceId: workspace.id, slackUserId: "U1", delegateKeyHash: hashDelegateKey(plaintext) })
      .returning();

    const res = await request(buildTestApp()).get("/protected").set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(200);
    expect(res.body.delegateUser).toEqual({ id: user.id, workspaceId: workspace.id, slackUserId: "U1" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/mcp/auth.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write src/mcp/auth.ts**

```typescript
// src/mcp/auth.ts
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { users } from "../db/schema.js";
import { hashDelegateKey } from "../keys/delegateKeys.js";

export interface DelegateUser {
  id: string;
  workspaceId: string;
  slackUserId: string;
}

export interface AuthedRequest extends Request {
  delegateUser?: DelegateUser;
}

export function requireDelegateKey(db: Database): RequestHandler {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing_bearer_token" });
      return;
    }

    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      res.status(401).json({ error: "missing_bearer_token" });
      return;
    }

    const hash = hashDelegateKey(token);
    const [user] = await db.select().from(users).where(eq(users.delegateKeyHash, hash));
    if (!user) {
      res.status(401).json({ error: "invalid_delegate_key" });
      return;
    }

    req.delegateUser = { id: user.id, workspaceId: user.workspaceId, slackUserId: user.slackUserId };
    next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/mcp/auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/auth.ts tests/mcp/auth.test.ts
git commit -m "feat: add MCP bearer delegate-key auth middleware"
```

---

### Task 11: MCP `recall` tool + Streamable HTTP server

**Files:**
- Create: `src/mcp/recallTool.ts`
- Create: `src/mcp/server.ts`
- Test: `tests/mcp/recallTool.test.ts`
- Test: `tests/mcp/server.test.ts`

**Interfaces:**
- Consumes: `DelegateUser`, `AuthedRequest`, `requireDelegateKey` (Task 10); `getSignedDownloadUrl` (Task 6); `Database` type; `namespaces`, `messages`, `files` tables (Task 2).
- Produces: `recallNamespace(db: Database, delegateUser: DelegateUser, namespaceId: string): Promise<RecallResult>` from `recallTool.ts`; `mountMcpServer(app: Express, db: Database): void` from `server.ts`. Task 12 calls `mountMcpServer` once on the shared app.

- [ ] **Step 1: Write the failing recallTool test**

```typescript
// tests/mcp/recallTool.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client } from "@aws-sdk/client-s3";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, messages, files } from "../../src/db/schema.js";
import { recallNamespace } from "../../src/mcp/recallTool.js";

const s3Mock = mockClient(S3Client);
beforeEach(() => s3Mock.reset());
afterEach(() => vi.unstubAllGlobals());

async function seedThread() {
  const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();
  const [namespace] = await db
    .insert(namespaces)
    .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" })
    .returning();
  const [msg1] = await db
    .insert(messages)
    .values({ namespaceId: namespace.id, slackUserId: "U1", text: "first", slackTs: "1.0" })
    .returning();
  const [msg2] = await db
    .insert(messages)
    .values({ namespaceId: namespace.id, slackUserId: "U2", text: "second", slackTs: "1.1" })
    .returning();
  await db.insert(files).values({
    messageId: msg1.id,
    bucketKey: `messages/${msg1.id}/f1-report.txt`,
    originalName: "report.txt",
    mimeType: "text/plain",
    status: "stored",
  });
  return { workspace, namespace, msg1, msg2 };
}

describe("recallNamespace", () => {
  it("returns messages in order with signed file URLs for a participant", async () => {
    const { workspace, namespace } = await seedThread();

    const result = await recallNamespace(
      db,
      { id: "does-not-matter", workspaceId: workspace.id, slackUserId: "U1" },
      namespace.id,
    );

    expect(result.authorized).toBe(true);
    if (!result.authorized) throw new Error("expected authorized result");
    expect(result.messages.map((m) => m.text)).toEqual(["first", "second"]);
    expect(result.messages[0].files).toHaveLength(1);
    expect(typeof result.messages[0].files[0].url).toBe("string");
  });

  it("is unauthorized for a user who never participated in the thread", async () => {
    const { workspace, namespace } = await seedThread();

    const result = await recallNamespace(
      db,
      { id: "x", workspaceId: workspace.id, slackUserId: "U-STRANGER" },
      namespace.id,
    );

    expect(result.authorized).toBe(false);
  });

  it("is unauthorized for a namespace in a different workspace", async () => {
    const { namespace } = await seedThread();
    const [otherWorkspace] = await db.insert(workspaces).values({ slackTeamId: "T-OTHER", name: "T" }).returning();

    const result = await recallNamespace(
      db,
      { id: "x", workspaceId: otherWorkspace.id, slackUserId: "U1" },
      namespace.id,
    );

    expect(result.authorized).toBe(false);
  });

  it("is unauthorized for a namespace id that doesn't exist", async () => {
    const { workspace } = await seedThread();
    const result = await recallNamespace(
      db,
      { id: "x", workspaceId: workspace.id, slackUserId: "U1" },
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result.authorized).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/mcp/recallTool.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write src/mcp/recallTool.ts**

```typescript
// src/mcp/recallTool.ts
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { namespaces, messages } from "../db/schema.js";
import { getSignedDownloadUrl } from "../storage/bucket.js";
import type { DelegateUser } from "./auth.js";

export interface RecallFile {
  originalName: string;
  url: string | null;
  status: string;
}

export interface RecallMessage {
  slackUserId: string;
  text: string;
  slackTs: string;
  files: RecallFile[];
}

export type RecallResult =
  | { authorized: true; namespaceId: string; messages: RecallMessage[] }
  | { authorized: false };

export async function recallNamespace(
  db: Database,
  delegateUser: DelegateUser,
  namespaceId: string,
): Promise<RecallResult> {
  const [namespace] = await db
    .select()
    .from(namespaces)
    .where(and(eq(namespaces.id, namespaceId), eq(namespaces.workspaceId, delegateUser.workspaceId)));
  if (!namespace) return { authorized: false };

  const [participation] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.namespaceId, namespace.id), eq(messages.slackUserId, delegateUser.slackUserId)));
  if (!participation) return { authorized: false };

  const rows = await db.query.messages.findMany({
    where: eq(messages.namespaceId, namespace.id),
    orderBy: asc(messages.slackTs),
    with: { files: true },
  });

  const result: RecallMessage[] = [];
  for (const row of rows) {
    const fileRefs: RecallFile[] = [];
    for (const file of row.files) {
      const url = file.status === "stored" && file.bucketKey ? await getSignedDownloadUrl(file.bucketKey) : null;
      fileRefs.push({ originalName: file.originalName, url, status: file.status });
    }
    result.push({ slackUserId: row.slackUserId, text: row.text, slackTs: row.slackTs, files: fileRefs });
  }

  return { authorized: true, namespaceId: namespace.id, messages: result };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/mcp/recallTool.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing MCP server test**

This test drives `/mcp` over real HTTP (via `supertest`) with a real `@modelcontextprotocol/sdk` client, exercising `initialize` then `tools/call` — the same path a real coding agent takes.

Run: `npm install -D @modelcontextprotocol/sdk` (already a runtime dependency from Task 1; this just confirms the client-side classes are importable from the same package for the test.)

```typescript
// tests/mcp/server.test.ts
import { describe, it, expect } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, messages } from "../../src/db/schema.js";
import { mountMcpServer } from "../../src/mcp/server.js";
import { generateDelegateKey } from "../../src/keys/delegateKeys.js";
import { eq } from "drizzle-orm";
import { users } from "../../src/db/schema.js";

async function startTestServer() {
  const app = express();
  app.use(express.json());
  mountMcpServer(app, db);
  const httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;
  return { httpServer, url: `http://127.0.0.1:${port}/mcp` };
}

describe("mountMcpServer", () => {
  it("rejects a call to the recall tool with no Authorization header", async () => {
    const { httpServer, url } = await startTestServer();
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url));
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await expect(client.connect(transport)).rejects.toThrow();
    } finally {
      httpServer.close();
    }
  });

  it("returns the thread's messages for an authorized delegate key", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" })
      .returning();
    await db.insert(messages).values({ namespaceId: namespace.id, slackUserId: "U1", text: "hello", slackTs: "1.0" });

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
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      const parsed = JSON.parse(text);

      expect(parsed.namespaceId).toBe(namespace.id);
      expect(parsed.messages).toEqual([
        { slackUserId: "U1", text: "hello", slackTs: "1.0", files: [] },
      ]);
    } finally {
      httpServer.close();
    }
  });

  it("returns isError for a namespace the caller didn't participate in", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C2", threadTs: "2.0" })
      .returning();
    await db.insert(messages).values({ namespaceId: namespace.id, slackUserId: "U-OTHER", text: "hi", slackTs: "2.0" });

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
    } finally {
      httpServer.close();
    }
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- tests/mcp/server.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 7: Write src/mcp/server.ts**

```typescript
// src/mcp/server.ts
import type { Express, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { requireDelegateKey, type AuthedRequest, type DelegateUser } from "./auth.js";
import { recallNamespace } from "./recallTool.js";

function buildRecallServer(db: Database, delegateUser: DelegateUser | undefined): McpServer {
  const server = new McpServer({ name: "recall-mcp-server", version: "1.0.0" });

  server.registerTool(
    "recall",
    {
      title: "Recall thread",
      description: "Fetches ordered messages and file references for a namespace captured from a Slack thread",
      inputSchema: {
        namespaceId: z.string().uuid().describe("Namespace ID returned when the bot captured the thread"),
      },
    },
    async ({ namespaceId }): Promise<CallToolResult> => {
      if (!delegateUser) {
        return { content: [{ type: "text", text: "Unauthorized" }], isError: true };
      }

      const result = await recallNamespace(db, delegateUser, namespaceId);
      if (!result.authorized) {
        return { content: [{ type: "text", text: "Not authorized to recall this namespace" }], isError: true };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ namespaceId: result.namespaceId, messages: result.messages }),
          },
        ],
      };
    },
  );

  return server;
}

const METHOD_NOT_ALLOWED_BODY = JSON.stringify({
  jsonrpc: "2.0",
  error: { code: -32000, message: "Method not allowed." },
  id: null,
});

export function mountMcpServer(app: Express, db: Database): void {
  const auth = requireDelegateKey(db);

  app.post("/mcp", auth, async (req: AuthedRequest, res: Response) => {
    const server = buildRecallServer(db, req.delegateUser);
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  app.get("/mcp", auth, (_req: Request, res: Response) => {
    res.writeHead(405).end(METHOD_NOT_ALLOWED_BODY);
  });

  app.delete("/mcp", auth, (_req: Request, res: Response) => {
    res.writeHead(405).end(METHOD_NOT_ALLOWED_BODY);
  });
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test -- tests/mcp/server.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/mcp/recallTool.ts src/mcp/server.ts tests/mcp/recallTool.test.ts tests/mcp/server.test.ts
git commit -m "feat: add MCP recall tool and Streamable HTTP server route"
```

---

### Task 12: Wire everything into the composition root

**Files:**
- Modify: `src/server.ts`
- Modify: `src/slack/events.ts` (fix the `context.workspaceId` gap flagged in Task 8)
- Modify: `.env.example` (no new keys — confirms it already covers everything `server.ts` reads)
- Test: `tests/server.wiring.test.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 2–11.
- Produces: `buildApp(db: Database): Express` (signature changes from Task 1's no-arg version — this is the last place that signature changes).

- [ ] **Step 1: Fix the `context.workspaceId` gap in src/slack/events.ts**

Bolt populates `context.teamId` from the installation, not `context.workspaceId` (that was this plan's own placeholder name, not a real Bolt field — flagged explicitly in Task 8 rather than left silently wrong). Resolve the workspace row from `context.teamId` inside the handlers instead:

```typescript
// src/slack/events.ts — replace registerEventHandlers's body
export function registerEventHandlers(app: App, db: Database): void {
  app.event("app_mention", async ({ event, client, context }) => {
    const teamId = context.teamId as string | undefined;
    if (!teamId) return;
    const workspace = await db.query.workspaces.findFirst({
      where: (w, { eq: eqCol }) => eqCol(w.slackTeamId, teamId),
    });
    if (!workspace) return;

    await handleAppMention({
      db,
      client,
      botToken: context.botToken as string,
      workspaceId: workspace.id,
      event,
    });
  });

  app.message(async ({ message, context }) => {
    const teamId = context.teamId as string | undefined;
    if (!teamId || message.subtype !== undefined) return;
    const workspace = await db.query.workspaces.findFirst({
      where: (w, { eq: eqCol }) => eqCol(w.slackTeamId, teamId),
    });
    if (!workspace) return;

    await handleMessage({
      db,
      botToken: context.botToken as string,
      workspaceId: workspace.id,
      message: message as unknown as MessageLikeEvent,
    });
  });
}
```

(Leave `handleAppMention`/`handleMessage` themselves untouched — Task 8's tests for those two functions still pass unchanged, since this only touches `registerEventHandlers`'s wiring.)

- [ ] **Step 2: Write the failing wiring test**

```typescript
// tests/server.wiring.test.ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { db } from "../src/db/client.js";
import { buildApp } from "../src/server.js";

describe("buildApp (wired)", () => {
  it("still serves /healthz", async () => {
    const app = buildApp(db);
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
  });

  it("exposes /mcp and rejects unauthenticated calls", async () => {
    const app = buildApp(db);
    const res = await request(app).post("/mcp").send({});
    expect(res.status).toBe(401);
  });

  it("exposes /slack/install", async () => {
    const app = buildApp(db);
    const res = await request(app).get("/slack/install");
    expect(res.status).toBe(302);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- tests/server.wiring.test.ts`
Expected: FAIL — `buildApp` still takes zero arguments.

- [ ] **Step 4: Rewrite src/server.ts**

```typescript
// src/server.ts
import "dotenv/config";
import express from "express";
import type { Express } from "express";
import type { Database } from "./db/client.js";
import { db } from "./db/client.js";
import { createSlackReceiver, createSlackApp } from "./slack/receiver.js";
import { registerEventHandlers } from "./slack/events.js";
import { registerRecallKeyCommand } from "./slack/recallKeyCommand.js";
import { mountMcpServer } from "./mcp/server.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function buildApp(database: Database): Express {
  const app = express();

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const receiver = createSlackReceiver({
    db: database,
    app,
    signingSecret: requireEnv("SLACK_SIGNING_SECRET"),
    clientId: requireEnv("SLACK_CLIENT_ID"),
    clientSecret: requireEnv("SLACK_CLIENT_SECRET"),
    stateSecret: requireEnv("SLACK_STATE_SECRET"),
  });
  const slackApp = createSlackApp(receiver);
  registerEventHandlers(slackApp, database);
  registerRecallKeyCommand(slackApp, database);

  app.use(express.json());
  mountMcpServer(app, database);

  return app;
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const app = buildApp(db);
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`recall-bot listening on port ${port}`);
  });
}
```

**Note on body-parser ordering (flagged by the Task 5 research, applied here):** `express.json()` is registered *after* `createSlackReceiver`/`ExpressReceiver` mounts its own routes, so Slack's raw-body signature verification isn't broken by a global JSON parser running first. It's registered *before* `mountMcpServer`, since the MCP route needs a parsed `req.body` for `transport.handleRequest(req, res, req.body)`.

- [ ] **Step 5: Update tests/app.smoke.test.ts and Task 1's own assumptions**

`tests/app.smoke.test.ts` from Task 1 calls `buildApp()` with no arguments, which no longer compiles. Update it:

```typescript
// tests/app.smoke.test.ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { db } from "../src/db/client.js";
import { buildApp } from "../src/server.js";

describe("buildApp", () => {
  it("responds to GET /healthz with 200 and ok:true", async () => {
    const app = buildApp(db);
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
```

- [ ] **Step 6: Set the env vars the test run needs and run both test files**

The wiring tests need `SLACK_SIGNING_SECRET`/`SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`/`SLACK_STATE_SECRET` set (any non-empty test values — no live Slack call happens for `/healthz`, `/mcp`, or `GET /slack/install`). Add them to `vitest.config.ts`'s `test.env` block alongside `DATABASE_URL`:

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 30000,
    setupFiles: ["./tests/setup.ts"],
    env: {
      DATABASE_URL: "postgres://recall:recall@localhost:55432/recall_test",
      SLACK_SIGNING_SECRET: "test-signing-secret",
      SLACK_CLIENT_ID: "test-client-id",
      SLACK_CLIENT_SECRET: "test-client-secret",
      SLACK_STATE_SECRET: "test-state-secret-test-state-secret",
    },
  },
});
```

Run: `npm test`
Expected: every test file in the project (Tasks 1–12) PASSes.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/slack/events.ts vitest.config.ts tests/app.smoke.test.ts tests/server.wiring.test.ts
git commit -m "feat: wire Slack receiver, event handlers, slash command, and MCP server into the composition root"
```

---

### Task 13: Deploy to Railway and verify against a real Slack workspace

This task is operational, not TDD — its deliverable is a live, verified deployment.

**Files:** none (infrastructure/deployment only).

- [ ] **Step 1: Create the Railway project (personal workspace) and provision Postgres + a bucket**

```bash
cd recall-bot
railway init --name recall-bot --workspace "harrymove-ctrl's Projects" --json
railway add --database postgres --json
railway add --service bucket --json   # or: create via the dashboard's "Bucket" resource type if the CLI doesn't expose it directly — confirm with `railway add --help` first
```

If `railway add` doesn't support buckets directly in your CLI version, create the bucket from the Railway dashboard (Project → New → Bucket) instead — functionally identical, just not scriptable.

- [ ] **Step 2: Wire service env vars via reference variables**

In the `recall-bot` service's Variables tab (or `railway variables set`), set:
```
DATABASE_URL=${{ Postgres.DATABASE_URL }}
BUCKET=${{ Bucket.BUCKET }}
ACCESS_KEY_ID=${{ Bucket.ACCESS_KEY_ID }}
SECRET_ACCESS_KEY=${{ Bucket.SECRET_ACCESS_KEY }}
REGION=${{ Bucket.REGION }}
ENDPOINT=${{ Bucket.ENDPOINT }}
```
Plus the Slack values from Task 5's manual setup — `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_STATE_SECRET` — entered directly (not references, these are your own secrets).

- [ ] **Step 3: Generate a public domain before finishing Slack's OAuth setup (the redirect/event URLs need it)**

```bash
railway domain --json
```
Copy the resulting `https://<name>.up.railway.app` domain. Go back to the Slack app dashboard (Task 5) and update the Redirect URL and Event Subscriptions/Slash Command Request URLs to use this real domain instead of a placeholder.

- [ ] **Step 4: Run the initial migration against the production database**

```bash
DATABASE_URL="$(railway variables get DATABASE_URL --service recall-bot)" npx drizzle-kit migrate
```

- [ ] **Step 5: Deploy**

```bash
railway up --detach --json -m "Initial deploy: recall-bot core loop"
```

- [ ] **Step 6: Verify the deployment is healthy**

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" https://<your-domain>.up.railway.app/healthz
```
Expected: `HTTP 200`.

- [ ] **Step 7: Manual end-to-end verification against the real dev Slack workspace**

1. Install the app into your dev workspace via `https://<your-domain>.up.railway.app/slack/install`.
2. In a channel the bot is in, start a thread and reply a few times, then `@mention` the bot in one reply.
3. Confirm (via `railway logs` or a direct DB query) that a `namespaces` row and several `messages` rows were created for that thread.
4. Post one more reply in the same thread *without* mentioning the bot again — confirm it's captured too (live capture working, not just backfill).
5. Run `/recall-key` in Slack — confirm you receive a DM with a key matching `^rk_[a-f0-9]{48}$`.
6. From a terminal, call the MCP server directly with that key and the namespace's UUID (from step 3) to confirm the full path works end-to-end:

```bash
curl -s https://<your-domain>.up.railway.app/mcp \
  -H "Authorization: Bearer <the rk_... key from step 5>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"recall","arguments":{"namespaceId":"<uuid from step 3>"}}}'
```
Expected: a JSON-RPC response whose result contains the thread's messages.

- [ ] **Step 8: Commit the Railway-specific state (if any config files were added) and record the deployment**

```bash
git status   # confirm nothing sensitive (.env) is staged
git add -A
git commit -m "chore: note Railway deployment configuration" --allow-empty
```
