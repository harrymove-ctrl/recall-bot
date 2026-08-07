# Personal View — Self-Service Read-Only User Dashboard — Design

**Status:** Draft — ready for review
**Sub-project:** 8 of N (personal view). This is the "future per-user mode" explicitly flagged and deferred in sub-project 2's non-goals ("No per-user self-service login — one admin session per workspace, not per Slack user... A future per-user mode, if ever needed, is a separate design") — **not** the Enoki/zkLogin identity work flagged in sub-projects 1 and 2 ("Enoki-based dashboard login"), which is a different, still-unbuilt idea about *how* a user proves identity (wallet signature) rather than *what* they can see once logged in. This design reuses the existing Slack-DM claim-link pattern for delivery, exactly like the admin flow already does, not Enoki. Extends sub-project 7 (memory view redesign, merged to `main`) by reusing `NamespaceDetail.tsx`'s grouped-message presentation, and sub-project 1's `/recall-key` command (core loop, merged) as the delivery trigger. Independent of sub-project 6 (onboarding flow) — that sub-project has **not** merged to `main` as of this writing (no `public/index.html`, no Getting Started panel in `App.tsx`) and, per its own design doc, touches `public/index.html` (new) and the `Dashboard` component in `App.tsx`; this design touches neither.

## Goal

Give an individual Slack user a way to log into a browser **as themselves** — not as the workspace — and see exactly the namespaces (captured Slack threads) they personally participated in, read-only: the list of those namespaces, and the message thread inside each one. Nothing else. The authorization boundary is the same one `recallNamespace()` already enforces for the MCP tool — "does this Slack user have a message row in this namespace" — extracted into a single shared function (`findParticipantNamespace`, Components #1) so the MCP tool and the new personal API can never independently drift on what "you have access" means. Delivery reuses the exact mechanism the admin claim link already uses (a one-time DM'd token exchanged for a signed session cookie, Components #3–#5), triggered from `/recall-key` — already the moment a user says, in effect, "let me interact with my recall data" (Components #6).

## Non-goals

- **No admin actions anywhere in the personal view.** No revoke, no archive, no rename, no visibility into other users' namespaces, no visibility into delegate-key issuance/rotation status (that's an admin-only signal today, surfaced only via `/api/dashboard/users`).
- **No cross-user visibility of any kind**, even within the same workspace. A personal session for Slack user A must never be able to see a namespace only user B participated in, even though both share a `workspaceId`.
- **No changes to the existing admin session/auth code.** `src/dashboard/session.ts`, `src/dashboard/auth.ts` (`createSessionCookie`/`verifySessionCookie`/`requireDashboardSession`/`DASHBOARD_COOKIE_NAME`) are untouched, byte-for-byte. `src/dashboard/claimTokens.ts` and the `workspace_claim_tokens` table are also untouched — a **new**, fully separate table and module are added for personal claim tokens instead of repurposing that one (see Design reference: "Why a new table, not a shared one").
- **No changes to the MCP server's or `recallNamespace()`'s external behavior.** `recallNamespace()`'s signature, inputs, outputs, and authorized/unauthorized semantics are pinned exactly as they are today — the existing `tests/mcp/recallTool.test.ts` suite must pass **unmodified**. Its internals are refactored (Components #1) to call a newly-extracted shared helper, which the non-goals explicitly permit: "sharing its underlying query logic via extraction is fine and encouraged."
- **No Enoki/zkLogin sign-in** — see Sub-project note above. Not what this design is.
- **No rate limiting on personal-link issuance.** `/recall-key` already rotates the delegate key with no rate limit today; the new personal-login-link issuance rides along in the same handler with the same (lack of) limit. Consistent, not a new gap.
- **No "log in by pasting your delegate key into a web form."** Considered and rejected — see Design reference.
- **No DB-backed session revocation / session table** for the new personal session, matching the admin session's own accepted precedent (stateless HMAC cookie, "no sessions table, no revocation beyond secret rotation or cookie expiry" — sub-project 2's design doc, Decisions log).
- **No changes to `src/dashboard/api.ts`.** The busiest, most security-sensitive file in the codebase stays completely untouched by this sub-project (see Design reference: "Why the participation check is shared but the message-shaping code is not").
- **No new UI polish beyond what's asked.** The personal namespace list shows exactly label / channel / created + a View link, per the brief. Status and linked-issue badges are not surfaced in v1 (Open items).

## Design reference

No external visual reference — this reuses `theme.css` and `NamespaceDetail.tsx`'s already-shipped presentation verbatim (sub-project 7). The design work in this sub-project is almost entirely about the *authorization and session architecture*, not visuals, so this section is decisions-and-reasoning rather than a style reference.

**Why a distinct HMAC secret for the personal session, and why a boot-time guard enforcing it.** `verifySessionCookie` (admin, untouched) decodes the payload, then reads only `workspaceId` and `exp` off it — it does **not** reject unknown extra keys. The new personal session's payload is `{ workspaceId, slackUserId, exp }`, a strict superset of the admin payload's shape. If the two cookies were ever signed with the *same* secret, a personal-session cookie value is *also* a validly-signed `{ workspaceId, exp }` payload as far as `verifySessionCookie` is concerned — pasting a DM'd personal-login cookie into the browser as `recall_dashboard_session` (renaming only the cookie, not its value) would grant full workspace-wide admin access. This is a real, mechanical confusable-format risk, not a hypothetical: it exists purely because both verifiers ignore unknown fields and both use the identical `createHmac(...).digest("base64url")` construction over the same base64 payload string. The fix is a distinct secret (`USER_SESSION_SECRET`, independent of `DASHBOARD_SESSION_SECRET`) — the signature check alone then fails regardless of payload-shape overlap. Because nothing in the type system stops a future config from setting the two env vars to the same value by accident, `buildApp` adds an explicit boot-time equality check (Components #8) — the same "catch the misconfiguration at the worst-but-earliest possible place" philosophy the file already uses for `REQUIRED_BUCKET_ENV_VARS`.

**Why `findParticipantNamespace` is extracted and shared, but the message/file/profile response-shaping code is deliberately duplicated instead.** The task brief calls out the participation check specifically as "the single most security-critical convention in this codebase" territory — it is the one piece of logic that, if it drifted between two implementations, would silently become a security bug (one surface allowing access the other correctly denies, or vice versa). It's extracted into `src/db/participation.ts` (mirroring the existing `src/db/workspaces.ts` precedent: a small, dependency-free, directly-unit-testable db-query helper used by multiple subsystems) and called identically by `recallNamespace()` and the new `/api/me/namespaces/:id/messages` route — they are now *literally the same code path*, so they cannot drift. The message/file/Linear-issue/display-name assembly logic that runs *after* that gate, by contrast, is presentation shaping with no security content — scoping already happened. Extracting it into a shared helper would mean touching `src/dashboard/api.ts` (the file this whole codebase treats as its highest-blast-radius surface, per the task brief, and the busiest file across every in-flight parallel sub-project). Duplicating ~25 lines of read-only formatting code there is a deliberate, asymmetric trade: share the thing that must never drift, accept duplication of the thing that safely can (worst case of drift there is a cosmetic bug, not a security one — see Open items for a possible future consolidation).

**Why a new `user_claim_tokens` table instead of adding a nullable `slackUserId` column to `workspace_claim_tokens`.** Considered. Rejected for two reasons: (1) the task brief explicitly frames this as "an equivalent per-user token table" — a new table, not a repurposed one; (2) mixing the two concerns in one table would force `consumeClaimToken`'s (admin, untouched) and a hypothetical unified consumer's `WHERE` clauses to branch on whether `slackUserId IS NULL`, which is exactly the kind of "two things sharing one implementation that could drift" the security-critical-convention framing warns against — better to keep the admin claim flow's table and code path completely untouched and add a structurally independent twin.

**Why "DM a fresh personal login link every time `/recall-key` runs," not "only once."** The task explicitly asks for a decision here. Chosen: every run, matching the delegate-key rotation precedent in the very same handler — `/recall-key` already unconditionally regenerates the delegate key and DMs the new plaintext every single time it's invoked, with no "have they already got one" check. Doing anything different for the personal link (e.g., checking for an existing unexpired unused token before minting a new one) would make the same command handler behave with two different mental models in one message. The cost of the simpler choice — a user who runs `/recall-key` three times in a row now has three outstanding, unconsumed, single-use tokens instead of one — is low: each is single-use (`consumeUserClaimToken`'s atomic `UPDATE ... WHERE used_at IS NULL`, identical pattern to the admin flow's `consumeClaimToken`), each still requires the DM to have actually been delivered to that Slack user, and an unused extra token sitting in the table for up to 7 days is not a privilege escalation — it's the same access the freshest token already grants. This mirrors the existing workspace claim token precedent, which also never invalidates previous unconsumed tokens on a fresh OAuth install.

**Why the delegate key and the personal login link are one DM, not two.** The existing DM already tells the user "here's your secret, keep it safe, run this again to rotate." Appending two more lines (the link plus a one-line expiry/rotation note) keeps everything about "how do I get my data" in the single message a user already expects and reads, rather than adding a second `chat.postMessage` call for no functional reason. Matches the single-message precedent every other DM in this codebase already follows (`receiver.ts`'s install-claim DM, `events.ts`'s capture-confirmation DM).

**Why the plaintext delegate key is never itself accepted as a browser login credential ("log in with your delegate key" form, considered and rejected).** The delegate key is a long-lived bearer secret meant to sit in an MCP client's config file, not to be typed into a web form, sent as a query param (which would land in server access logs / browser history / a `Referer` header on any outbound link from that page), or even sent as a POST body over and over across sessions. The claim-token indirection the admin flow already uses exists for exactly this reason — trade a one-time, short-lived, single-use token for a proper httpOnly session cookie — and the personal flow reuses that same reasoning rather than inventing a second, weaker credential-entry pattern.

**No new CSRF surface.** The two new state-changing routes (`POST /api/me/claim`, `POST /api/me/logout`) are `sameSite: "lax"` cookie-gated exactly like their admin equivalents (`POST /api/dashboard/claim`, `POST /api/dashboard/logout`) already are — `sameSite: "lax"` cookies are not attached to cross-site POSTs, only top-level GET navigations, so this sub-project accepts exactly the same (already-accepted) risk posture as the admin dashboard, not a new one.

## Components

### 1. Shared participation-check helper (`src/db/participation.ts`, new) + `recallTool.ts` refactor (behavior-preserving)

```typescript
// src/db/participation.ts
import { and, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { namespaces, messages } from "./schema.js";

/**
 * The single source of truth for "does this Slack user have standing to see this namespace."
 * A namespace is visible to a user only if (a) it belongs to their workspace and (b) they have
 * at least one message row in it — matching who actually participated in the captured thread,
 * not just anyone in the workspace. Both the MCP recall tool (src/mcp/recallTool.ts) and the
 * personal dashboard API (src/dashboard/meApi.ts) call this exact function so the authorization
 * check can never drift between the two surfaces.
 */
export async function findParticipantNamespace(
  db: Database,
  workspaceId: string,
  slackUserId: string,
  namespaceId: string,
): Promise<{ id: string } | null> {
  const [namespace] = await db
    .select({ id: namespaces.id })
    .from(namespaces)
    .where(and(eq(namespaces.id, namespaceId), eq(namespaces.workspaceId, workspaceId)));
  if (!namespace) return null;

  const [participation] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.namespaceId, namespace.id), eq(messages.slackUserId, slackUserId)));
  if (!participation) return null;

  return namespace;
}
```

`src/mcp/recallTool.ts`'s `recallNamespace()` replaces its inline duplicate of this exact two-query check with a call to the shared helper:

```typescript
export async function recallNamespace(db: Database, delegateUser: DelegateUser, namespaceId: string): Promise<RecallResult> {
  const namespace = await findParticipantNamespace(db, delegateUser.workspaceId, delegateUser.slackUserId, namespaceId);
  if (!namespace) return { authorized: false };

  const rows = await db.query.messages.findMany({
    where: eq(messages.namespaceId, namespace.id),
    orderBy: asc(messages.slackTs),
    with: { files: true },
  });
  // ...rest unchanged (file signed-URL assembly, RecallResult shape)
}
```

`recallNamespace`'s exported signature, inputs, and outputs are identical before and after — this is a pure internal refactor, verified by running the existing `tests/mcp/recallTool.test.ts` unmodified.

### 2. Schema: `user_claim_tokens` table (`src/db/schema.ts`, additive)

```typescript
export const userClaimTokens = pgTable(
  "user_claim_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slackUserId: varchar("slack_user_id", { length: 32 }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("user_claim_tokens_workspace_id_idx").on(t.workspaceId),
    index("user_claim_tokens_workspace_slack_user_idx").on(t.workspaceId, t.slackUserId),
  ],
);
```

Structurally a twin of `workspace_claim_tokens` plus a `slack_user_id` column. Migration generated via `npm run db:generate`, never hand-written.

### 3. `src/dashboard/userSession.ts` (new) — parallel to `session.ts`, not shared with it

`createUserSessionCookie(workspaceId, slackUserId, secret, maxAgeMs?)` / `verifyUserSessionCookie(cookieValue, secret)`, same `createHmac`/`timingSafeEqual` construction as `session.ts`, same defensive length-check-before-`timingSafeEqual` guard (copied deliberately, not imported, so the two verifiers remain fully independent modules — see Design reference). Payload: `{ workspaceId, slackUserId, exp }`. `parseCookies` (pure header parsing, no security branching) is imported from the existing `session.ts` rather than duplicated — it has nothing to do with the admin/personal distinction.

### 4. `src/dashboard/userAuth.ts` (new) — parallel to `auth.ts`, not shared with it

```typescript
export const USER_SESSION_COOKIE_NAME = "recall_user_session";

export interface UserSessionRequest extends Request {
  workspaceId?: string;
  slackUserId?: string;
}

export function requireUserSession(secret: string): RequestHandler {
  return (req: UserSessionRequest, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const session = verifyUserSessionCookie(cookies[USER_SESSION_COOKIE_NAME], secret);
    if (!session) {
      res.status(401).json({ error: "no_active_session" });
      return;
    }
    req.workspaceId = session.workspaceId;
    req.slackUserId = session.slackUserId;
    next();
  };
}
```

### 5. `src/dashboard/userClaimTokens.ts` (new) — parallel to `claimTokens.ts`, not shared with it

`issueUserClaimToken(db, workspaceId, slackUserId, expiryMs?)` and `consumeUserClaimToken(db, plaintext)`, identical shape to `claimTokens.ts`'s functions (random-bytes plaintext, sha256 hash stored, atomic single-use `UPDATE ... WHERE used_at IS NULL AND expires_at > now() RETURNING`), operating against `userClaimTokens` and additionally threading `slackUserId` through both directions.

### 6. `src/dashboard/meApi.ts` (new) — `/api/me/*`, gated by `requireUserSession`, scoped by BOTH `workspaceId` and `slackUserId`

- `POST /claim` — consumes a personal claim token, sets `recall_user_session`. Same response shape/status codes as `POST /api/dashboard/claim` (`400 invalid_or_expired_token` on failure).
- `POST /logout` — clears the cookie.
- `GET /me` — `{ slackUserId, displayName }` for the session's own user (via the existing `resolveDisplayNames`, called with a single-element array). Deliberately does **not** return anything about installation status, delegate-key state, or other admin-only signals.
- `GET /namespaces` — lists namespaces the session's `slackUserId` has at least one message in, scoped by `workspaceId`. The join *is* the authorization boundary (every returned row already satisfies the participation condition by construction) — no separate per-row check is needed, matching how `/api/dashboard/namespaces` scopes its own list with a single `eq(workspaceId)` clause:

  ```typescript
  const participantRows = await db
    .selectDistinct({ namespaceId: messages.namespaceId })
    .from(messages)
    .innerJoin(namespaces, eq(messages.namespaceId, namespaces.id))
    .where(and(eq(namespaces.workspaceId, req.workspaceId!), eq(messages.slackUserId, req.slackUserId!)));

  const namespaceIds = participantRows.map((r) => r.namespaceId);
  const rows = namespaceIds.length > 0
    ? await db.select().from(namespaces).where(inArray(namespaces.id, namespaceIds)).orderBy(desc(namespaces.createdAt))
    : [];

  res.json(rows.map((n) => ({ id: n.id, channelId: n.channelId, threadTs: n.threadTs, label: n.label, status: n.status, createdAt: n.createdAt })));
  ```

  (`status` is returned for forward-compatibility even though v1's frontend table doesn't render it — see Open items.)

- `GET /namespaces/:id/messages` — the security-critical route. Same `UUID_RE` input-shape guard as `api.ts` (duplicated intentionally, see Design reference — this is an input-format guard, not the authorization boundary, so duplicating a static regex carries no drift risk). Then:

  ```typescript
  const namespace = await findParticipantNamespace(db, req.workspaceId!, req.slackUserId!, namespaceId);
  if (!namespace) {
    res.status(404).json({ error: "namespace_not_found" });
    return;
  }
  ```

  A namespace outside the caller's workspace and a namespace inside their workspace they never participated in both resolve to `null` here, and both become the identical `404` — on purpose, per the codebase's core convention: never leak existence, never distinguish "not yours" from "doesn't exist." Everything after the gate (message/file/Linear-issue assembly, `displayName`/`avatarUrl` resolution via `resolveDisplayNames`) mirrors `api.ts`'s equivalent handler field-for-field, so the JSON response shape is identical and the frontend can consume it through the exact same rendering code (Components #9). This portion is a deliberate duplication, not an extraction — see Design reference.

### 7. `src/slack/recallKeyCommand.ts` — new exported helper + DM text update

```typescript
export async function issuePersonalLoginLink(
  db: Database,
  workspaceId: string,
  slackUserId: string,
  publicBaseUrl: string,
): Promise<string> {
  const token = await issueUserClaimToken(db, workspaceId, slackUserId);
  return `${publicBaseUrl}/dashboard/me/claim?token=${token}`;
}
```

`registerRecallKeyCommand` gains a third parameter, `publicBaseUrl: string`. Inside the handler, alongside the existing `issueDelegateKey` call:

```typescript
const plaintext = await issueDelegateKey(db, workspaceIdRow.id, command.user_id);
const loginLink = await issuePersonalLoginLink(db, workspaceIdRow.id, command.user_id, publicBaseUrl);

await client.chat.postMessage({
  channel: dm.channel!.id!,
  text:
    `Here's your recall delegate key. Keep it secret — anyone with this key can recall any thread you've participated in:\n\`${plaintext}\`\n\n` +
    `Run \`/recall-key\` again any time to rotate it (this invalidates the old one).\n\n` +
    `Prefer a browser? View your captured threads here: ${loginLink}\n` +
    `(single-use, expires in 7 days — run /recall-key again any time for a fresh link)`,
});
```

`issueDelegateKey` itself, its tests, and the existing failure-path `catch` block are unchanged — a failure minting or DMing the login link is caught by the same existing `try/catch` that already wraps the whole handler.

### 8. `src/server.ts` wiring

```typescript
const publicBaseUrl = requireEnv("PUBLIC_BASE_URL"); // captured once, reused below
// ...createSlackReceiver({ ..., publicBaseUrl }) as today...
registerRecallKeyCommand(slackApp, database, publicBaseUrl);

// ...

const dashboardSessionSecret = requireEnv("DASHBOARD_SESSION_SECRET");
const userSessionSecret = requireEnv("USER_SESSION_SECRET");
// See Design reference: a shared secret would let a personal-session cookie's payload (a strict
// superset of the admin cookie's shape) verify as a valid admin session too. Catching this at
// boot is cheaper than discovering it as a live privilege-escalation report.
if (userSessionSecret === dashboardSessionSecret) {
  throw new Error(
    "USER_SESSION_SECRET must not equal DASHBOARD_SESSION_SECRET — generate a second, independent secret (openssl rand -hex 32).",
  );
}

// New client-side routes for the personal view — same reasoning as the three existing
// /dashboard* sendFile routes above: registered ahead of express.static so a direct hit (e.g.
// from the Slack DM link) serves the SPA shell instead of a static-file 404.
app.get("/dashboard/me", (_req, res) => res.sendFile("index.html", { root: DASHBOARD_DIST }));
app.get("/dashboard/me/claim", (_req, res) => res.sendFile("index.html", { root: DASHBOARD_DIST }));
app.get("/dashboard/me/namespaces/:id", (_req, res) => res.sendFile("index.html", { root: DASHBOARD_DIST }));

app.use("/dashboard", express.static(DASHBOARD_DIST));
app.use("/api/dashboard", createDashboardApiRouter(database, dashboardSessionSecret));
app.use("/api/me", createMeApiRouter(database, userSessionSecret));
```

New required env var: `USER_SESSION_SECRET` (added to `.env.example`, generated the same way as the others: `openssl rand -hex 32`).

### 9. `dashboard-web/src/NamespaceDetail.tsx` — additive optional props, existing call site unchanged

```tsx
export function NamespaceDetail({
  namespaceId,
  apiBase = "/api/dashboard",
  backHref = "/dashboard",
  unauthorizedMessage = "No active session — check your Slack DM for the dashboard setup link.",
}: {
  namespaceId: string;
  apiBase?: string;
  backHref?: string;
  unauthorizedMessage?: string;
}) {
  // ...
  useEffect(() => {
    fetch(`${apiBase}/namespaces/${namespaceId}/messages`).then(/* unchanged */);
  }, [namespaceId, apiBase]);

  if (unauthorized) return <p>{unauthorizedMessage}</p>; // was: return <NoSession />
  // ...
  <a href={backHref}>← Back to namespaces</a> // was: hardcoded href="/dashboard"
  // ...everything else (grouping, Avatar, linkifyText, FileBadge, DayDivider) is untouched
}
```

`App.tsx`'s existing call site, `<NamespaceDetail namespaceId={namespaceMatch[1]} />`, needs **zero** changes — the defaults reproduce today's exact behavior. This also drops `NamespaceDetail.tsx`'s import of `NoSession` from `App.tsx`, removing a reverse import edge between the two files (App.tsx imports NamespaceDetail; NamespaceDetail previously also imported from App.tsx) as an incidental cleanup. This is the one piece of "reuse/adapt rather than rebuild" the task calls for explicitly, and is the whole reason `NamespaceDetail.tsx` needs to change at all — nothing else in it does.

### 10. `dashboard-web/src/MePage.tsx` (new file) — the personal view's own components, not a modification of `App.tsx`'s `Dashboard`

Colocated small components, matching this codebase's existing convention (no `components/` directory split for page-level pieces):

- `MeClaimView` — reads `?token=` from the URL, `POST`s to `/api/me/claim`, redirects to `/dashboard/me` on success. Structurally identical to `App.tsx`'s existing `ClaimView`, pointed at the personal endpoint and redirect target, with copy that references `/recall-key` (not "reinstall the app") for the expired-link case.
- `PersonalNamespacesTable` — four columns only, per the brief: Label, Channel, Created, a "View" link to `/dashboard/me/namespaces/:id`. No rename input, no Archive button, no linked-issues column. An empty-state message ("No captured threads yet — tag @recall-bot on a Slack thread you're part of.") replaces an empty header-only table.
- `PersonalDashboard` — fetches `GET /api/me` (identity) and `GET /api/me/namespaces` (list) on mount; renders "Signed in as {displayName ?? slackUserId}" and `PersonalNamespacesTable`. On `401` from either, renders the shared `MeNoSession` message.
- `MeNamespaceDetail` — a thin wrapper: `<NamespaceDetail namespaceId={id} apiBase="/api/me" backHref="/dashboard/me" unauthorizedMessage={PERSONAL_NO_SESSION_MESSAGE} />`. This is the entire "adapt NamespaceDetail for the personal surface" step — no rendering logic is rebuilt.

### 11. `dashboard-web/src/App.tsx` — routing branches added, `Dashboard`/`NamespacesTable`/`UsersTable`/`AnalyticsTable` untouched

```tsx
import { MeClaimView, PersonalDashboard, MeNamespaceDetail } from "./MePage";
// ...
export function App() {
  const [gridMode, toggleGridMode] = useGridMode();
  const path = window.location.pathname;

  let view: JSX.Element;
  const meNamespaceMatch = path.match(/^\/dashboard\/me\/namespaces\/([0-9a-fA-F-]+)$/);
  if (path === "/dashboard/claim") {
    view = <ClaimView />;
  } else if (path === "/dashboard/me/claim") {
    view = <MeClaimView />;
  } else if (meNamespaceMatch) {
    view = <MeNamespaceDetail namespaceId={meNamespaceMatch[1]} />;
  } else if (path === "/dashboard/me") {
    view = <PersonalDashboard />;
  } else {
    const namespaceMatch = path.match(/^\/dashboard\/namespaces\/([0-9a-fA-F-]+)$/);
    view = namespaceMatch ? <NamespaceDetail namespaceId={namespaceMatch[1]} /> : <Dashboard />;
  }
  // ...grid-toggle / grid-overlay / <div className="page"> wrapper unchanged, shared by both surfaces
}
```

The final `else` branch is byte-identical to today's code, just nested one level deeper — every existing admin path (`/dashboard`, `/dashboard/claim`, `/dashboard/namespaces/:id`) resolves exactly as it does today.

## Data flow

1. A Slack user runs `/recall-key` in a DM. The handler resolves the workspace, issues (rotates) the delegate key as today, **and** issues a fresh personal claim token (`issuePersonalLoginLink`) — both land in one DM.
2. The user clicks the personal link: `GET {publicBaseUrl}/dashboard/me/claim?token=...`. `server.ts`'s new sendFile route serves the SPA shell; client-side routing renders `MeClaimView`.
3. `MeClaimView` reads the token, `POST /api/me/claim` → `consumeUserClaimToken` atomically marks it used (or 400s if already used/expired) → on success, `res.cookie(recall_user_session, ...)` is set → redirect to `/dashboard/me`.
4. `/dashboard/me` loads → `PersonalDashboard` fetches `GET /api/me` (identity) and `GET /api/me/namespaces` (list, scoped by the join described in Components #6) → renders the table.
5. Clicking "View" navigates to `/dashboard/me/namespaces/:id` → `MeNamespaceDetail` renders `NamespaceDetail` wired to `apiBase="/api/me"` → `GET /api/me/namespaces/:id/messages` → `requireUserSession` validates the cookie → the route calls `findParticipantNamespace(workspaceId, slackUserId, id)` → `404` if the caller never participated (or the namespace belongs to another workspace) → otherwise the same message/file/Linear-issue/display-name assembly `api.ts` does, returned in the identical JSON shape → the exact same grouped-message rendering already shipped in sub-project 7 draws the thread.

No polling, no websockets — one-shot `fetch` on mount at every step, matching every existing dashboard surface in this codebase.

## Error handling

- Missing/invalid/expired `recall_user_session` cookie on any `/api/me/*` route (except `POST /claim`) → `401 { error: "no_active_session" }`, identical shape to the admin equivalent.
- Malformed (non-UUID) `:id` path segment on `/api/me/namespaces/:id/messages` → `404 { error: "namespace_not_found" }` — never `400`, so a malformed id is indistinguishable from a well-formed-but-inaccessible one, matching `api.ts`'s existing `UUID_RE` guard rationale exactly.
- Namespace exists but in a **different workspace** → `404`. Namespace exists in the **caller's own workspace** but they never participated in it → also `404`. These two cases must never be distinguishable from each other or from "the id doesn't exist at all" — this is the core convention this whole design hinges on, and the reason `findParticipantNamespace` is the single, shared gate for all three.
- Expired/already-used/unknown token on `POST /api/me/claim` → `400 { error: "invalid_or_expired_token" }`, identical shape/status to the admin claim flow.
- `USER_SESSION_SECRET` equal to `DASHBOARD_SESSION_SECRET`, or either missing, at boot → the process refuses to start with an explicit error (Components #8), rather than booting into a silently-forgeable configuration.
- A Slack API failure while opening the DM or posting the combined delegate-key/login-link message is caught by the `/recall-key` handler's existing outer `try/catch` — no new failure path, same generic ephemeral error message as today.

## Testing

New/changed test files, `DATABASE_URL="postgres://recall:recall@localhost:55432/recall_test" npm test`:

- `tests/db/participation.test.ts` (new) — `findParticipantNamespace` returns the namespace for an actual participant; returns `null` for a namespace in a different workspace; returns `null` for a user who never posted in that namespace; returns `null` for a namespace id that doesn't exist.
- `tests/mcp/recallTool.test.ts` — **unmodified**, must still pass unchanged after the Components #1 refactor (this is the regression check that the extraction preserved `recallNamespace`'s exact external behavior).
- `tests/dashboard/userSession.test.ts` (new) — round-trips a valid cookie; rejects wrong secret, tampered payload, expired cookie, malformed input without throwing (mirrors `session.test.ts`'s cases against the new payload shape).
- `tests/dashboard/userAuth.test.ts` (new) — mirrors `auth.test.ts`: 401 with no cookie, 401 with a garbage cookie, 200 + `req.workspaceId`/`req.slackUserId` attached for a valid one.
- `tests/dashboard/sessionIsolation.test.ts` (new) — the cross-cutting security property between `session.ts` and `userSession.ts` that doesn't belong in either single-file suite:
  - *Documents the risk class*: with a **shared** secret (deliberately constructed in the test, not read from env), a `createUserSessionCookie(...)` output verifies successfully against `verifySessionCookie(..., sharedSecret)` — proving the extra `slackUserId` field is silently ignored by the admin verifier.
  - *Proves the mitigation*: with **distinct** secrets, `verifySessionCookie(userCookie, adminSecret)` is `null`, and `verifyUserSessionCookie(adminCookie, userSecret)` is `null` (the latter fails on the missing `slackUserId` field alone, independent of the secret).
- `tests/dashboard/userClaimTokens.test.ts` (new) — mirrors `claimTokens.test.ts`: issues a token consumable exactly once; rejects unknown/expired tokens; only one of two concurrent consumers succeeds for the same token.
- `tests/dashboard/meApi.test.ts` (new, supertest-based like `dashboard/api.test.ts`) — `POST /claim` sets a cookie and rejects reuse; all `/api/me/*` routes (except `/claim`) 401 with no cookie; `GET /namespaces` returns only namespaces the session's `slackUserId` has a message in, excluding a namespace in the *same workspace* the user didn't post in and a namespace in a *different workspace* entirely; `GET /namespaces/:id/messages` 200s with the full message/file/`linearIssues` shape for a real participant, and 404s (not 401, not 403) for a non-participant's namespace, a wrong-workspace namespace, and a malformed id.
- `tests/slack/recallKeyCommand.test.ts` — new case for `issuePersonalLoginLink`: returned URL contains `/dashboard/me/claim?token=`, and the token round-trips through `consumeUserClaimToken` to the correct `{ workspaceId, slackUserId }`.
- `tests/server.wiring.test.ts` — new case: `buildApp` throws when `USER_SESSION_SECRET` is unset, and throws when it equals `DASHBOARD_SESSION_SECRET`; `/dashboard/me`, `/dashboard/me/claim`, `/dashboard/me/namespaces/:id` all serve the SPA shell (200, contains `bundle.js`); `/api/me/me` (or equivalent) 401s with no cookie.
- Frontend: no dedicated test suite, matching the v1/v2/dashboard-tabs/memory-view-redesign precedent — `npx tsc --noEmit -p dashboard-web/tsconfig.json` is the build-time check.
- **Required update**: `tests/setup.ts`'s `TRUNCATE` statement must add `user_claim_tokens` to its table list — easy to forget, and without it either FK-constraint errors surface, or (worse) rows silently accumulate across test files and break isolation.

Manual verification: run `/recall-key` twice for two different Slack users (A and B) who have both posted in a shared namespace and one namespace each that only they posted in. Confirm: both DMs contain a working personal link; A's `/dashboard/me` lists exactly the shared namespace plus A's own, never B's; B's `/dashboard/me` lists the shared namespace plus B's own, never A's; A hitting `/dashboard/me/namespaces/<B's-solo-namespace-id>` directly gets "Namespace not found," not an error page or a 401; the admin dashboard (`/dashboard`) is completely unaffected and still shows every namespace to the one admin session.

## Open items (explicitly deferred, not blocking this sub-project)

- `PersonalNamespacesTable` shows only label/channel/created + View, per the brief. `status` (archived vs. active) and linked-issue badges are already returned by `GET /api/me/namespaces` (forward-compatible) but not rendered in v1 — a small follow-up if it turns out to matter.
- The message-shaping duplication between `api.ts`'s and `meApi.ts`'s `/namespaces/:id/messages` handlers (Design reference) could be consolidated into a shared formatter later if it's ever observed to drift in practice; not done now to keep `api.ts` untouched.
- `findParticipantNamespace` currently issues two separate indexed queries (`messages_namespace_id_idx`, `messages_slack_user_id_idx`); a composite `(namespace_id, slack_user_id)` index would let Postgres do this in one index scan instead of two, but per-namespace message volumes are small enough today that this is a non-issue — flagged for later if it ever shows up in query stats.
- Multiple outstanding, unconsumed personal claim tokens per user (Design reference: "DM every time") are never proactively invalidated on reissue. If this ever needs tightening (e.g., compliance requirement to have "only the latest link ever work"), `issuePersonalLoginLink` would need to mark prior unused tokens for that `(workspaceId, slackUserId)` as consumed before minting a new one — not needed today.
- Once sub-project 6 (onboarding flow) lands, its Getting Started panel could mention the personal login link alongside `/recall-key`'s other instructions — not touched here, flagged for that sub-project's own follow-up.
- No "forgot my link" self-service resend outside of running `/recall-key` again in Slack — consistent with there being no other account-recovery mechanism anywhere in this codebase today.
