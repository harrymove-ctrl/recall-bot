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
