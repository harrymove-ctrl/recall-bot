# Slack Display-Name Resolution — Design

**Status:** Approved for planning
**Sub-project:** 5 of N (dashboard v2). Extends sub-project 3 (dashboard v2 grid redesign + namespace detail — introduced the message-author rendering this touches) and sub-project 4 (dashboard tabs navigation — introduced the Users table this also touches), independent of whether sub-project 4 has merged yet.

**Prerequisite — read this before anything else:** the currently-installed bot token (`installations.botToken`) does **not** have the `users:read` scope, so every `users.info` call this design adds will fail with a Slack `missing_scope` error against every real workspace today. Granting that scope requires **reinstalling the Slack app** — updating the scope list in api.slack.com and having each workspace re-authorize. That reinstall is a **human-owned, separate action**. It is explicitly out of scope for this sub-project: the code below does not perform it, does not request it, does not block on it, and does not assume it has happened. Everything here is designed so that:

1. **It is safe to ship today, before any reinstall** — with the scope missing, the dashboard behaves exactly as it does now (raw Slack IDs everywhere), with no new error states, no broken pages, no extra user-visible latency beyond one cheap failed lookup per cold cache entry.
2. **It starts working automatically, with no further deploy,** once a human completes the reinstall — the next resolution attempt after the scope lands succeeds and gets cached.

## Goal

Show real Slack display names (and a small avatar) instead of raw Slack user IDs (e.g. `U0ALD7Q3JAW`) in the two places the dashboard currently renders them: namespace detail message authors (`NamespaceDetail.tsx`) and the Users list (`UsersTable` in `App.tsx`). Resolve via `users.info`, cache results in Postgres so the dashboard doesn't call Slack on every page load, and degrade to today's raw-ID behavior whenever resolution isn't possible — whether because the scope is missing (the case today) or for any other reason (deleted user, rate limit, network error).

## Non-goals

- **Performing the Slack app reinstall or touching OAuth scopes/config in api.slack.com** — human-owned, handled separately, not triggered or waited on by this code.
- **Resolving `<@U…>` mentions inside message body text** — only the author field of each message row and the Users list row are resolved. Mentions embedded in captured text stay as raw Slack markup, same as today.
- **Bulk pre-warming the cache** (e.g. a `users.list` sweep at reinstall time, or a cron backfill) — resolution is purely lazy, triggered by an actual dashboard read. If nobody opens the dashboard, nothing gets pre-fetched.
- **A manual "refresh now" affordance** for an admin to force-bust a cached failure immediately after a reinstall — the staleness policy below already self-heals within 24 hours with no user action; a manual override is a reasonable future addition, not required here.
- **Any change to the capture pipeline, the MCP recall tool, or Slack bot event handling** — this is a dashboard-read-path-only change, same boundary every prior dashboard sub-project has kept.
- **Resolving names for Slack bot users or deleted/deactivated users** — `users.info` still returns a value for these in most cases, but no special-casing is added for them; they're just another `displayName` (possibly a bot's name) or another failure to fall back from, whichever `users.info` returns.

## Design reference

No new visual language — this reuses `theme.css`'s existing tokens exactly as sub-projects 3 and 4 did. One small addition: an `.avatar` class (a `--space-4` (24px) circle, `object-fit: cover`, `border: 1px solid var(--color-border)`) for the small profile image shown next to a resolved name, placed inline before the name text in both the message-meta line and the Users table's "Slack user" cell. When there's no avatar URL (unresolved, or Slack simply didn't send one), no placeholder/broken-image box is rendered — just the text, exactly like today.

## Components

1. **Cache table** (`src/db/schema.ts`) — `slackUserProfiles` (`slack_user_profiles`): `id` (uuid pk), `workspaceId` (uuid, references `workspaces`, cascade delete), `slackUserId` (varchar(32)), `displayName` (text, nullable), `avatarUrl` (text, nullable), `resolvedAt` (timestamptz, not null — the moment of the *last attempt*, success or failure), `createdAt`/`updatedAt`. Unique on `(workspaceId, slackUserId)`, indexed on `workspaceId`. This is a standalone table rather than new columns on `users`, because `users` only holds rows for people who've issued a delegate key (`isNotNull(users.delegateKeyHash)` gates the existing `/users` list) — message authors in a captured thread are a broader, overlapping-but-different population that may never have a `users` row at all. `displayName`/`avatarUrl` are nullable on purpose: a null row with a fresh `resolvedAt` *is* a cached result — it means "we tried and got nothing usable," and is what makes the staleness policy below double as both a cache TTL and a retry backoff, with no extra status column needed. Generated via `npm run db:generate`, never hand-written, per repo convention.

2. **Resolution module** (`src/slack/userProfiles.ts`) — exports `resolveDisplayNames(db, workspaceId, slackUserIds: string[]): Promise<Map<string, { displayName: string | null; avatarUrl: string | null }>>`. Looks up the workspace's `installations` row itself (so API route call sites don't need to plumb a bot token through); if there's no installation row or it's `revokedAt`-set, returns nulls for every id immediately with zero Slack calls and zero cache writes — a revoked install can never succeed, so there's nothing worth remembering. Otherwise, for each requested id: a fresh cache row (see staleness policy below) is returned as-is; anything missing or stale triggers a `users.info` call via `new WebClient(botToken)` (matching the existing `WebClient` usage in `receiver.ts`). On success, upserts `{ displayName, avatarUrl, resolvedAt: now }`. On failure, see Error handling.

3. **Route changes** (`src/dashboard/api.ts`) — `GET /namespaces/:id/messages` and `GET /users` each gain one step: after loading their rows, collect the distinct `slackUserId`s present, call `resolveDisplayNames(db, req.workspaceId!, ids)`, and attach `displayName`/`avatarUrl` (both nullable) to each returned object alongside the `slackUserId` that's already there. `slackUserId` is never removed from the payload — it's the fallback value the frontend renders when `displayName` is null, and remains available for anything else that might key off it later. This is an additive, backward-compatible response shape change; workspace scoping is inherited for free since `resolveDisplayNames` is called with the same `req.workspaceId!` every other route uses, and the cache table itself is keyed by `workspaceId`, so one workspace's cached name for a raw Slack ID string can never be read back for a different workspace's session even in the (Slack-guarantees-won't-happen) case of two workspaces sharing a literal ID string.

4. **Frontend rendering** (`dashboard-web/src/NamespaceDetail.tsx`, `dashboard-web/src/App.tsx`) — `MessageRow` and `UserRow` gain `displayName: string | null` and `avatarUrl: string | null`. Both call sites render `(avatarUrl && <img class="avatar" src={avatarUrl} onError={hide-self} />)` followed by `displayName ?? slackUserId` — i.e. today's exact output whenever resolution hasn't produced a name. The `onError` handler (setting the image's own `display: none` on load failure) covers the case where a cached `avatarUrl` from Slack's CDN has since expired or rotated; it fails visually invisible rather than as a broken-image icon.

## Data flow

`resolveDisplayNames` processes the requested ids sequentially (typical volume is a handful of distinct posters per thread or per Users list, not worth a concurrency pool):

- **Cache hit, not stale** → use it, no network call.
- **Cache miss or stale** → call `users.info`. On success, read `display_name || real_name || name` from the response's `user.profile`/`user` fields (first non-empty wins) and `user.profile.image_48` for the avatar, upsert the cache row, return the value.
- **Auth-class failure** (`missing_scope`, `invalid_auth`, `account_inactive`, `token_revoked`, `not_authed` — anything meaning "this token fundamentally can't call this method," which is exactly what `missing_scope` is until the reinstall happens) → this failure is workspace-wide, not per-user: the *first* one encountered in a batch short-circuits every remaining id in that same batch straight to a negative-cache write (`displayName: null, avatarUrl: null, resolvedAt: now`) **without** calling Slack for each of them. A cold cache against a still-missing scope costs exactly one wasted Slack call per dashboard page load, not one per unique author.
- **Per-id failure** (`user_not_found`, `users_not_found`, a `ratelimited` response that survives the SDK's built-in retry, a network/timeout error) → negative-cache just that one id and continue processing the rest of the batch normally.

**Staleness policy:**

| Cache state | Retry after | Why |
|---|---|---|
| Successful resolution (`displayName` set) | 30 days | Display names and avatars change rarely; this keeps steady-state `users.info` volume near zero. |
| Failed resolution (`displayName` null) | 24 hours | Cheap enough to re-check daily, and it means the dashboard self-heals within at most a day of a human completing the reinstall, with no manual trigger and no deploy. |

## Error handling

- No installation row, or `installations.revokedAt` set → skip resolution entirely, raw ID shown, no cache writes (see Components #2).
- `missing_scope` and the other auth-class errors above → caught specifically (matching `@slack/web-api`'s `WebAPIPlatformError`, `error.data.error`), batch-short-circuited, negative-cached with the 24h retry window, logged once per batch at a level distinct from unexpected errors (e.g. `console.warn` with the literal Slack error code) so a human skimming logs can tell "still waiting on the reinstall" apart from a real bug.
- Any other error from the Slack call (including ones not enumerated above — a defensive catch-all, not just the listed codes) → negative-cached the same way, logged at the same "expected, degraded" level. **`resolveDisplayNames` never throws** — a total Slack outage degrades every row to raw IDs, it never turns into a 500 on `/namespaces/:id/messages` or `/users`.
- Frontend: a null `displayName` renders the raw `slackUserId` exactly as before (no error text, no "unresolved" badge — an unresolved name isn't an error state to a dashboard viewer, it's just today's normal). A stale/broken `avatarUrl` fails silently via `onError` (Components #4).
- Cross-tenant: every cache read/write goes through `resolveDisplayNames(db, req.workspaceId!, ...)`, and the table's unique constraint is `(workspaceId, slackUserId)` — same "scope everything by the session's workspace" rule as every other route in this file. A resource not owned by the session's workspace still 404s upstream of this code entirely (the namespace/user lookups that gate these routes are unchanged); this only adds read-side enrichment on top of already-scoped rows, never a new lookup surface of its own.

## Testing

- **`tests/slack/userProfiles.test.ts`** (new, real Postgres via `tests/setup.ts`, `@slack/web-api`'s `WebClient` mocked with `vi.mock`): cache hit skips the network call; a fresh success upserts `displayName`/`avatarUrl`/`resolvedAt` and is returned; a `missing_scope` error on the first id in a multi-id batch short-circuits the rest to negative cache without additional mocked calls (assert the mock's call count); a per-id error (`user_not_found`) negative-caches only that id and still resolves the others in the same batch; a negative-cached row past the 24h staleness window retries and can succeed; a positive-cached row past the 30-day window retries.
- **`tests/dashboard/api.test.ts`** (extend existing file): `GET /namespaces/:id/messages` and `GET /users` responses include `displayName`/`avatarUrl` keys (null when the mocked Slack client is made to fail, matching today's `botToken: "xoxb-fake"` seed data — this is effectively the "scope missing" path exercised end-to-end); cross-workspace isolation extended to confirm workspace A's session never sees a cached name/avatar seeded against workspace B's identical raw Slack ID.
- `tsc --noEmit -p dashboard-web/tsconfig.json` for the frontend type changes, matching prior sub-projects' precedent (no dedicated frontend test suite for this internal admin UI).
- Full `npm test` must stay green.

## Open items (explicitly deferred, not blocking this sub-project)

- **The Slack app reinstall itself** (granting `users:read`) — required for any of this to show real names in production; human-owned, tracked separately, not this sub-project's deliverable.
- A manual "force refresh" control in the dashboard to bypass the 24h negative-cache window right after a reinstall.
- Resolving `<@U…>` mentions inside message body text, not just author fields.
- Bulk pre-warming via `users.list` instead of purely lazy, on-read resolution.
- If a single cold-cache page load ever needs to resolve an unusually large number of distinct posters (not expected — see sub-project 3's "namespace is a single bounded Slack thread" non-goal), the current sequential-per-id approach has no concurrency cap; revisit only if that ever becomes real.
