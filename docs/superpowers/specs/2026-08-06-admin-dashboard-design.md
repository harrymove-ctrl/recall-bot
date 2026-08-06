# Admin Dashboard — Design

**Status:** Approved for planning
**Sub-project:** 2 of N (dashboard). Analytics/activity charts are a separate, later sub-project — not designed here. Enoki (Sui/zkLogin) sign-in is a planned future addition, not part of this build.

## Goal

Give each installed workspace a single admin a web UI to see and manage what the core loop currently only exposes through Slack: view/rename/archive captured threads (namespaces), and view/revoke users' delegate keys — replacing "check the database by hand" with a real, if minimal, control panel.

## Non-goals (this sub-project)

- No Enoki/zkLogin sign-in — v1 auth is a one-time claim link + signed session cookie. Enoki is a later addition to the same session concept, not a blocker.
- No per-user self-service login — one admin session per workspace, not per Slack user. (A future per-user mode, if ever needed, is a separate design.)
- No activity/usage charts or analytics — separate sub-project, needs discrete usage events that don't exist yet.
- No ability to issue or view a user's plaintext delegate key from the dashboard — the admin can only revoke; only `/recall-key` in Slack ever shows a plaintext key, by design (matches the core loop's existing security model).
- No multi-admin support, no admin invite/removal flow — one claim link, one admin, full stop for v1.

## Decisions log

| Decision | Choice |
|---|---|
| Dashboard users | One admin per workspace (not per individual Slack user) |
| Identity/login (v1) | No external identity provider. A one-time claim link, DM'd after Slack install, sets a signed session cookie directly |
| Identity/login (future) | Enoki zkLogin (base Enoki, not Enoki Connect — this app doesn't need cross-app wallet portability) as an added sign-in method on top of the same session concept, once an app is registered on Enoki's Developer Portal |
| Session strategy | Stateless signed httpOnly cookie (`{ workspaceId }`, HMAC'd with `DASHBOARD_SESSION_SECRET`) — no sessions table, no revocation beyond secret rotation or cookie expiry. Considered and rejected: DB-backed sessions table (real revocation, but a table + cleanup job this v1 doesn't need) |
| Hosting | Same Express service as the Slack bot/MCP server — no new Railway service |
| Frontend | Small React app, bundled with esbuild (no build-less vanilla JS, no separate framework-managed app), served as static output from the existing service |
| MVP actions | View & revoke delegate keys; view & rename namespaces; archive a namespace; view read-only workspace/installation info |
| Namespace naming | New nullable `namespaces.label` column — a namespace's UUID is not human-readable today |

## Architecture

```
Slack OAuth install completes
      │
      ▼
installer success hook — generates claim token, DMs
"https://.../dashboard/claim?token=..." to the installer
      │
      ▼
┌─────────────────────────────────────────────┐
│           recall-bot (Express, existing)      │
│  ┌───────────┐ ┌────────┐ ┌────────────────┐ │
│  │  /slack   │ │  /mcp  │ │   /dashboard    │ │
│  │  routes   │ │ route  │ │  (static React) │ │
│  └───────────┘ └────────┘ └────────────────┘ │
│                              ┌────────────────┐│
│                              │ /api/dashboard  ││
│                              │  routes         ││
│                              └────────────────┘│
└───────────────────┬───────────────────────────┘
                     │
                Postgres DB
        (workspaces, namespaces, users,
         + new workspace_claim_tokens,
         + new namespaces.label)
```

Considered and rejected: a separate Next.js app / separate Railway service for the dashboard — more moving parts (two deploys, two domains or a proxy) for a v1 admin panel with four actions; revisit only if the dashboard's own complexity outgrows what fits comfortably in the existing service.

## Components

1. **`workspace_claim_tokens` table** — `id`, `workspaceId` (FK), `tokenHash`, `expiresAt`, `usedAt` (nullable). Raw token is only ever in the DM link; only its hash is stored (same pattern as delegate keys).
2. **`namespaces.label`** migration — nullable `text` column, no default.
3. **Claim-token issuance** — wired into the Slack receiver's `installerOptions.callbackOptions.success` hook (has the bot token needed to DM the installer), not into `installationStore.storeInstallation` (which has no Slack client access and shouldn't need one).
4. **Session cookie helpers** (`src/dashboard/session.ts`) — `createSessionCookie(workspaceId)`, `verifySessionCookie(cookieValue)`, using Node's built-in `crypto.createHmac` — no new dependency needed for this.
5. **Session middleware** (`src/dashboard/auth.ts`) — reads the cookie, verifies it, attaches `req.workspaceId`; used on every `/api/dashboard/*` route except `/api/dashboard/claim`.
6. **Dashboard API** (`src/dashboard/api.ts`), mounted at `/api/dashboard`:
   - `POST /claim` — body `{ token }`, no auth required. Looks up `tokenHash`, checks `expiresAt`/`usedAt`, marks used, sets cookie.
   - `GET /me` — returns workspace name, `slackTeamId`, install date.
   - `GET /namespaces` — list for the session's workspace: `id`, `channelId`, `threadTs`, `label`, `status`, `createdAt`, message count.
   - `PATCH /namespaces/:id` — body `{ label?, status? }`; `status` only ever settable to `"archived"` from the dashboard (namespaces become `"active"` only through the bot's own capture flow).
   - `GET /users` — workspace users with a non-null `delegateKeyHash`: `slackUserId`, key-issued/rotated timestamp (`updatedAt`).
   - `POST /users/:id/revoke-key` — sets `delegateKeyHash` to `null`. Idempotent.
   - `POST /logout` — clears the cookie.
7. **React frontend** (`dashboard-web/`, new directory, esbuild-bundled to `dist/dashboard/`) — one page, three sections (workspace info, namespaces table with inline rename/archive, users table with revoke), served statically by Express at `/dashboard/*`.

## Data flow

1. **Claim** — admin opens the DM'd link → frontend's claim page calls `POST /api/dashboard/claim` with the token from the URL → server hashes it, matches against `workspace_claim_tokens`, rejects if expired/already used, else marks `usedAt` and responds with `Set-Cookie` → frontend redirects to `/dashboard`.
2. **Every dashboard view/action** — browser sends the cookie automatically → session middleware verifies the HMAC signature, extracts `workspaceId`, rejects (401) if missing/invalid/tampered → route handlers scope every query by that `workspaceId`, so cross-workspace access is structurally impossible, not just policy.
3. **Rename/archive/revoke** — each is a single `UPDATE ... WHERE id = $1 AND workspace_id = $2` (namespaces) or `... WHERE id = $1 AND workspace_id = $2` (users) — the `workspaceId` predicate is what makes cross-tenant writes impossible even if a client sent someone else's row id.

## Error handling

- Claim token expired or already used → `POST /claim` returns 400 with a specific reason; claim page shows "This link has expired or was already used — reinstall the app or contact support" (no automatic re-issuance in v1).
- Missing/invalid/tampered session cookie on a protected route → 401; frontend shows "No active session — check your Slack DM for the dashboard setup link."
- `PATCH /namespaces/:id` for a namespace not owned by the session's workspace → 404, not 403 (don't confirm the id exists at all, same "don't leak existence" principle as the MCP recall tool).
- `POST /users/:id/revoke-key` for a user with no active key, or not owned by the workspace → 404/no-op, never an error the admin needs to react to.
- Rename to an empty string → stored as `NULL` (clears the label), not rejected.

## Testing

- Real-Postgres integration tests (same `tests/setup.ts` pattern as the core loop) for: claim-token issuance and consumption (including expired/reused rejection), session cookie creation/verification (valid, tampered, expired), and every `/api/dashboard/*` route — especially the cross-workspace isolation case (workspace A's session cannot read or mutate workspace B's namespaces/users).
- No dedicated frontend test suite for v1 — deliberate scope cut for a small internal admin UI; a `tsc --noEmit` pass over the React code is the only build-time check.

## Open items (explicitly deferred, not blocking this sub-project)

- Enoki zkLogin sign-in (needs an app registered on Enoki's Developer Portal — not done yet).
- Real session revocation (would need DB-backed sessions instead of stateless cookies).
- Multi-admin per workspace / admin invite-and-remove flow.
- Activity/usage analytics charts (separate sub-project; needs discrete event logging that doesn't exist yet).
- Claim-link re-issuance if the original DM'd link expires unused (v1 has no self-serve recovery path).
