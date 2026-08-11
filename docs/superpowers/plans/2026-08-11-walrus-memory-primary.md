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

- [x] Add `messages.walrus_blob_id`.
- [x] Add `messages.walrus_storage_status`.
- [x] Add `messages.walrus_stored_at`.
- [x] Add message-level proof metadata: blob object ID, tx digest, end epoch.
- [x] Add file-level Walrus fields for attachments.
- [x] Add file-level proof metadata: blob object ID, tx digest, end epoch.

## Capture checklist

- [x] Create namespace as today.
- [x] Insert Slack messages as today.
- [x] Publish each new message to Walrus through the HTTP publisher API.
- [x] Update the message row with `walrus_blob_id`, `walrus_storage_status`, and `walrus_stored_at`.
- [x] Preserve publisher proof metadata when returned by Walrus.
- [x] If Walrus is not configured, leave the row `pending`, not silently “stored”.
- [x] If Walrus publish fails, mark the row `failed` while preserving Postgres cache text.
- [x] Publish Slack attachment bytes to Walrus while keeping existing S3 signed-download behavior.
- [x] Add a backfill job for old message rows with no blob ID.
- [x] Add a backfill job for old stored file rows with no blob ID.

## Dashboard checklist

- [x] Show each message's Walrus status.
- [x] Show each message's Walrus blob ID when available.
- [x] Show file-level Walrus status/blob ID for attachments.
- [x] Make blob IDs copyable.
- [x] Show namespace-level counts: messages, files, Walrus-stored messages.
- [x] Warn when a message is only cached in Postgres by showing `pending`/`failed` and “No blob ID yet”.

## MCP checklist

- [x] Keep delegate-key scoping per Slack user.
- [x] `recall(namespaceId)` returns content plus `walrusBlobId` and `walrusStorageStatus`.
- [x] `recall(namespaceId)` uses Walrus blob content when `WALRUS_AGGREGATOR_URL` is configured and the blob is readable; Postgres is the fallback cache.
- [x] Add `list_namespaces()` for user-scoped namespace discovery.
- [x] Add `memory_plan(namespaceId)`.
- [x] Add `memory_checklist(namespaceId)`.
- [x] Add `verify_blob(namespaceId, messageId)` to fetch/verify the Walrus blob.

## Production configuration

- `WALRUS_PUBLISHER_URL`: base publisher endpoint. The app calls `PUT {WALRUS_PUBLISHER_URL}/v1/blobs`.
- `WALRUS_AGGREGATOR_URL`: base aggregator endpoint. The app calls `GET {WALRUS_AGGREGATOR_URL}/v1/blobs/{blobId}` for verification and Walrus-primary recall.
- Optional: `WALRUS_EPOCHS`, `WALRUS_PERMANENT`, `WALRUS_DELETABLE`, `WALRUS_SEND_OBJECT_TO`.

Without `WALRUS_PUBLISHER_URL`, new captures remain `pending`. Without `WALRUS_AGGREGATOR_URL`, recall still returns cached Postgres text plus blob proof metadata, but it cannot verify/read the blob at recall time.

## First PR-sized patch

- Introduce Walrus message metadata columns.
- Add a configurable Walrus publisher adapter.
- Publish newly captured Slack messages through that adapter.
- Expose Walrus status/blob ID in dashboard and MCP recall responses.
- Keep existing S3 bucket attachment behavior unchanged.
