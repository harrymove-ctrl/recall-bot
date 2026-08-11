import { db, pool } from "../db/client.js";
import { backfillWalrusMessages } from "../storage/walrusBackfill.js";

function parseLimit(): number {
  const raw = process.env.WALRUS_BACKFILL_LIMIT ?? process.argv[2] ?? "100";
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid WALRUS_BACKFILL_LIMIT: ${raw}`);
  }
  return value;
}

try {
  const result = await backfillWalrusMessages({ db, limit: parseLimit() });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
