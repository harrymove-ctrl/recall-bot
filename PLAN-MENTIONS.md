# User-scoped namespaces: mentions not just authored messages

## Context

Currently `/api/me/namespaces` returns only namespaces where the current user **authored a message** (`messages.slackUserId = req.slackUserId`). The intended behavior is: a user sees any thread where they **participated** — meaning they either authored a message OR were `@mentioned` in any message in that thread.

`extractMentionedUserIds()` already exists in `src/slack/mentions.ts` (regex-based, parses `<@U123>` syntax), but it's not wired into the capture pipeline and there's no storage for it.

## Changes

### 1. DB schema — new table `message_mentions`

**`src/db/schema.ts`** — add after the `messages` table definition:

```ts
export const messageMentions = pgTable("message_mentions", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageId: uuid("message_id").notNull().references(() => messages.id, ...),
  slackUserId: varchar("slack_user_id", { length: 32 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("message_mentions_message_user_unique").on(t.messageId, t.slackUserId),
  index("message_mentions_user_idx").on(t.slackUserId),
])
```

**Drizzle migration** (`drizzle/0008_mention_tables.sql`):
- Create `message_mentions` table
- Backfill existing messages: run `extractMentionedUserIds(text)` on each existing message row and insert into `message_mentions`

### 2. Capture pipeline — store mentions

**`src/slack/backfill.ts`** — in the per-message processing block (around line 132, after message insert succeeds):

```ts
// After: if (messageRow) { ... }
if (messageRow && message.text) {
  const mentionedIds = extractMentionedUserIds(message.text);
  for (const uid of mentionedIds) {
    await db.insert(messageMentions).values({
      messageId: messageRow.id,
      slackUserId: uid,
    }).onConflictDoNothing();
  }
}
```

**`src/slack/events.ts`** — in `handleMessage()` (after message insert, same pattern):
```ts
if (messageRow && message.text) {
  const mentionedIds = extractMentionedUserIds(message.text);
  for (const uid of mentionedIds) {
    await db.insert(messageMentions).values({ messageId: messageRow.id, slackUserId: uid })
      .onConflictDoNothing();
  }
}
```

**`src/slack/events.ts`** — import `extractMentionedUserIds` and `messageMentions`:
```ts
import { extractMentionedUserIds } from "./mentions.js";
import { messageMentions } from "../db/schema.js";
```

### 3. `findParticipantNamespace` — check mentions

**`src/db/participation.ts`** — update the function to also check `messageMentions`:

```ts
// Existing: user authored a message in the namespace
const authored = await db.select({ id: messages.id })
  .from(messages)
  .where(and(eq(messages.namespaceId, namespace.id), eq(messages.slackUserId, slackUserId)))
  .limit(1);

// NEW: user was mentioned in any message in the namespace
const mentioned = await db.select({ id: messageMentions.id })
  .from(messageMentions)
  .innerJoin(messages, eq(messageMentions.messageId, messages.id))
  .where(and(eq(messages.namespaceId, namespace.id), eq(messageMentions.slackUserId, slackUserId)))
  .limit(1);

return authored.length > 0 || mentioned.length > 0 ? namespace : null;
```

Import `messageMentions` from schema.

### 4. `listDelegateNamespaces` (MCP) — same mention check

**`src/mcp/recallTool.ts`** — in `listDelegateNamespaces()`, update the DISTINCT query to also join through `messageMentions`:

```ts
// Find namespace IDs where user authored OR was mentioned
const participantRows = await db
  .selectDistinct({ namespaceId: messages.namespaceId })
  .from(messages)
  .innerJoin(namespaces, eq(messages.namespaceId, namespaces.id))
  .where(and(eq(namespaces.workspaceId, delegateUser.workspaceId), eq(messages.slackUserId, delegateUser.slackUserId)))
  .union(
    db.selectDistinct({ namespaceId: messages.namespaceId })
      .from(messageMentions)
      .innerJoin(messages, eq(messageMentions.messageId, messages.id))
      .innerJoin(namespaces, eq(messages.namespaceId, namespaces.id))
      .where(and(eq(namespaces.workspaceId, delegateUser.workspaceId), eq(messageMentions.slackUserId, delegateUser.slackUserId)))
  );
```

Import `messageMentions`.

### 5. API `/api/me/namespaces` — no code change needed

The existing join-based query (line 71-75 in meApi.ts) already uses `findParticipantNamespace` indirectly via the namespace fetch — once `findParticipantNamespace` is updated in step 3, the API automatically returns the correct set.

### 6. Dashboard — no UI change needed

The dashboard already shows the user's namespaces correctly once the API returns the right data.

## Files to modify

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add `messageMentions` table |
| `drizzle/0008_mention_tables.sql` | Create table + backfill existing messages |
| `src/db/schema.ts` | Add `messageMentions` export |
| `src/db/participation.ts` | Update `findParticipantNamespace` to check mentions |
| `src/mcp/recallTool.ts` | Update `listDelegateNamespaces` UNION query |
| `src/slack/backfill.ts` | Store mentions after message insert |
| `src/slack/events.ts` | Store mentions after message insert |
| `src/db/participation.ts` | Import `messageMentions` |
| `src/mcp/recallTool.ts` | Import `messageMentions` |
| `tests/db/participation.test.ts` | Add tests for mention-based visibility |

## Verification
1. `npm run build` ✅
2. `npx vitest run` ✅
3. Railway deploys ✅
4. Tag `@userB` in a thread where only `@userA` posted → `@userB` sees the namespace in `/dashboard/me` ✅
5. User who was neither author nor mentioned → does NOT see the namespace ✅
