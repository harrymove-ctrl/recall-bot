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
