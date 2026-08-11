import { db, pool } from "../db/client.js";
import { backfillWalrusFiles, backfillWalrusMessages } from "../storage/walrusBackfill.js";

function parseLimit(): number {
  const raw = process.env.WALRUS_BACKFILL_LIMIT ?? process.argv[2] ?? "100";
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid WALRUS_BACKFILL_LIMIT: ${raw}`);
  }
  return value;
}

try {
  const limit = parseLimit();
  const messages = await backfillWalrusMessages({ db, limit });
  const files = await backfillWalrusFiles({ db, limit });
  console.log(JSON.stringify({ messages, files }, null, 2));
} finally {
  await pool.end();
}
