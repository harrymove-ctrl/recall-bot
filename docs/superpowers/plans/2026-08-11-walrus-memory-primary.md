# Walrus Memory primary storage rework

## Goal

Recall Bot should treat Walrus Memory as the primary memory store. Postgres remains the fast index/cache for auth scoping, namespace lookup, search, and UI rendering, but every captured Slack message should be backed by a Walrus blob ID.

## Target flow

1. A Slack user signs in to `/dashboard/me`.
2. The user generates or retrieves a personal delegate key.
3. The user tags `@recall-bot` in a Slack thread.
4. Recall Bot captures the thread into a namespace.
5. Each message is serialized as canonical memory JSON and stored to Walrus.
6. Postgres stores the namespace/message metadata plus the Walrus blob ID and storage status.
7. The user's coding agent connects to `/mcp` with the delegate key.
8. The agent can list/recall only namespaces where that Slack user participated.
9. Recall responses include message content, file refs, and Walrus blob proof metadata.
10. Future plan/checklist generation tools consume recalled Walrus-backed memories.

## Data model checklist

- Add `messages.walrus_blob_id`.
- Add `messages.walrus_storage_status`.
- Add `messages.walrus_stored_at`.
- Later: add file-level Walrus fields if attachments become Walrus-backed too.
- Later: add digest/object/epoch fields if the Walrus publisher returns them.

## Capture checklist

- Create namespace as today.
- Insert Slack messages as today.
- Publish each new message to Walrus.
- Update the message row with `walrus_blob_id`, `walrus_storage_status`, and `walrus_stored_at`.
- If Walrus is not configured, leave the row `pending`, not silently “stored”.
- If Walrus publish fails, mark the row `failed` while preserving Postgres cache text.
- Add a backfill job for old rows with no blob ID.

## Dashboard checklist

- Show each message's Walrus status.
- Show each message's Walrus blob ID when available.
- Make blob IDs copyable.
- Show namespace-level counts: messages, files, Walrus-stored messages.
- Warn when a message is only cached in Postgres.

## MCP checklist

- Keep delegate-key scoping per Slack user.
- `recall(namespaceId)` returns content plus `walrusBlobId` and `walrusStorageStatus`.
- Add `list_namespaces()` for user-scoped namespace discovery.
- Add `memory_plan(namespaceId)` after recall is Walrus-backed.
- Add `memory_checklist(namespaceId)` after recall is Walrus-backed.
- Optional: add `verify_blob(messageId)` to fetch/verify the Walrus blob.

## First PR-sized patch

- Introduce Walrus message metadata columns.
- Add a configurable Walrus publisher adapter.
- Publish newly captured Slack messages through that adapter.
- Expose Walrus status/blob ID in dashboard and MCP recall responses.
- Keep existing S3 bucket attachment behavior unchanged.
