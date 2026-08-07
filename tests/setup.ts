import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../src/db/client.js";

// Resolved from this file rather than process.cwd() so the suite does not depend on the
// directory it was invoked from.
const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

beforeAll(async () => {
  // Bring the throwaway test database up to the current schema. Doing it here — rather than in a
  // separate npm script someone has to remember to run — is what makes
  // `npm ci && npm run test:db:up && npm test` work from a clean checkout. drizzle records which
  // migrations it has already applied, so every run after the first is a no-op.
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
});

afterEach(async () => {
  await db.execute(
    sql`TRUNCATE TABLE recall_events, slack_user_profiles, namespace_linear_issues, files, messages, namespaces, users, installations, workspace_claim_tokens, workspaces RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await pool.end();
});
