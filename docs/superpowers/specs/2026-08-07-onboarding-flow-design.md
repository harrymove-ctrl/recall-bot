# Onboarding Flow — Install Landing Page + Dashboard First-Run Experience — Design

**Status:** Draft — ready for review (blocked on sub-projects 5a–5c merging to `main`, see Sub-project note)
**Sub-project:** 6 of N (onboarding flow). Extends sub-project 4 (dashboard tabs, merged to `main`) and is sequenced strictly **after** sub-projects 5a–5c — Linear issue linking, Slack display-name resolution, and usage analytics (all filed as "5 of N", each extending sub-project 4 independently, all currently in flight on stacked branches off `main`) — land first. All three touch `dashboard-web/src/App.tsx` (the tabs array, `NamespacesTable`, `UsersTable`, and — for usage analytics — a new third "Analytics" tab) and `src/db/schema.ts`, which this sub-project's dashboard-side components also touch. Building this before those merge would mean rebasing three times instead of once; see the implementation plan's Task 1.

## Goal

Design one coherent path from "someone hears about recall-bot" through to "their workspace is using it," reconciling the two gaps found by parallel research:

1. **No product-owned surface exists before Slack's OAuth consent screen.** `GET /slack/install` (Bolt's default install path, `directInstall: true`) redirects straight to `slack.com/oauth/v2/authorize` with zero framing — no explanation of what the bot does, no warning that installing requires workspace-admin approval, no list of requested scopes.
2. **A brand-new workspace's first dashboard login shows nothing actionable.** Once claimed, `Dashboard()` renders two (soon three) tabs, each an empty table with header row only — no copy anywhere in the UI tells a first-time viewer to tag `@recall-bot` on a thread or run `/recall-key`, even though that exact copy already exists, scattered across one-off Slack DMs (`receiver.ts`'s claim-link DM, `events.ts`'s in-thread confirmation, `recallKeyCommand.ts`'s key-delivery DM) that a viewer may never have seen.

The end-to-end flow this design produces:

```
discover recall-bot
  → land on a public install page (new, at GET /)
  → click "Add to Slack" → existing /slack/install → Slack's own OAuth consent screen
  → (approve) → existing sendClaimLinkDm → one-time claim link DMed to the installer
  → click the DM link → existing /dashboard/claim flow → session cookie set
  → land on /dashboard with zero captured namespaces
  → see a "Get started" panel (new) with the 3 steps that actually matter
  → tag @recall-bot on a thread → namespace count goes from 0 → 1
  → next dashboard load: panel collapses to a small persistent "Getting started" link;
    normal tabbed dashboard (Namespaces / Users / Analytics) takes over
```

Every step already implemented (OAuth mechanics, claim tokens, session cookies, table data-fetching) is reused verbatim. This design adds exactly the two missing surfaces — a pre-OAuth landing page and an in-dashboard first-run panel — plus the small connective-tissue fixes needed so a user is never dropped into a dead end between them (the discarded `install_error=1` signal, the unlinked `NoSession` fallback, the headers-only empty tables).

## Non-goals

- **No Slack App Directory / marketplace listing.** This design assumes self-hosted, invite-only distribution (share the landing page URL directly). If a Directory listing is pursued later, Slack's own asset/copy requirements for the official "Add to Slack" button are a separate follow-up — flagged in Open items.
- **No changes to OAuth scopes, `InstallProvider` mechanics, `directInstall` behavior, or claim-token TTL/single-use semantics.** `/slack/install` and `/dashboard/claim` keep doing exactly what they do today; this design wraps them, it does not touch them (the one exception — the `failureAsync` redirect target — is a one-line change, not a mechanics change; see Components #2).
- **No real-time push of the "first namespace captured" event into an open dashboard tab.** The `Dashboard` component already only refetches on mount (no polling, no SSE/WebSocket exists anywhere in this codebase); the Getting Started panel collapsing from full to small is therefore correct-on-next-load, not instant. Adding a live-update channel is a bigger change than this sub-project's scope.
- **No per-viewer / per-teammate onboarding state.** Dashboard sessions are workspace-scoped (`workspaceId` on the session cookie), not user-scoped — there is no notion of "which Slack user is looking at this dashboard right now." The Getting Started panel's full/collapsed state is therefore a workspace-wide signal (`namespaces.length === 0`), not "has *this* viewer personally run `/recall-key` yet." A teammate-specific nudge would require a bigger auth change; flagged in Open items.
- **No manual dismiss/skip control for the full zero-state panel.** It shows whenever `namespaces.length === 0` and there is no way to permanently hide it early — the cost of an admin seeing three sentences of instructions once is lower than the cost of a panel silently gone and a stuck teammate with no path back to it. A dismiss affordance is a reasonable future addition (Open items), not required for v1.
- **No ready-to-paste MCP client config block** (e.g. a full `mcpServers` JSON snippet for Claude Code/Cursor). v1 gives the bare `{origin}/mcp` URL plus "use it as a Bearer token" with a copy button — enough for someone who already knows how to configure an MCP server, which is the assumed audience (coding agents / their operators). A richer snippet is Open items.
- **No copy/design changes to the Analytics tab's own empty state** (`AnalyticsTable`'s "No recall activity yet." — already specified in the usage-analytics design). That tab's empty state is about recall *usage*, not setup; duplicating setup instructions into a third place would fragment the single source of truth this design is trying to establish (see Design reference).
- **No dark-mode / `prefers-color-scheme` handling for the new landing page.** The dashboard itself (`theme.css`) has no dark-mode handling today (single `:root` block); the landing page matches that precedent rather than introducing a new one.

## Design reference

**One canonical source of "how to use recall-bot," reused everywhere.** Today the 3-step instructions (tag the bot / run `/recall-key` / use the delegate key over MCP) exist only inside one-off Slack DM strings, phrased slightly differently in each of `receiver.ts` (claim-link DM), `events.ts` (in-thread confirmation), and `recallKeyCommand.ts` (key-delivery DM). This design does not touch those three DMs — they stay as immediate, contextual confirmations — but it adds a fourth, durable copy of the same 3 steps in the dashboard's `GettingStartedSteps` component (Components #4), phrased so it stands alone (a viewer might land here without having read any of the DMs). The landing page's own "how it works" section (Components #1) is a *compressed, pre-install* version of the same three ideas, not a fourth independent wording — same order, same nouns (`@recall-bot`, `/recall-key`, MCP), different register (marketing-brief vs. task-list).

**Landing page (`public/index.html`).** A single self-contained static HTML file — no build step, no bundler, no external assets (inline CSS, no webfonts, an emoji favicon via a data URI or `<link rel="icon" href="data:,">`-style inline value) — so it stays trivially fast, cacheable, and editable without touching the `dashboard-web` build pipeline. Visual continuity with the dashboard is achieved by hand-copying the handful of tokens that matter from `dashboard-web/src/theme.css` (`--color-accent: #2563eb`, `--color-border: #dddddd`, `--color-text-muted: #666666`, the serif `h1`/sans body split) directly into this file's `<style>` block, not by sharing a build pipeline — the two surfaces should look like the same product without being coupled to the same release cadence. Layout: hero headline + sub-line, a primary "Add to Slack" button linking to `/slack/install`, an explicit non-admin callout sitting directly beside that button (not buried in a footer — today a non-admin who clicks through gets no warning before hitting Slack's own "you don't have permission" screen cold), a numbered "how it works" (3 steps, matching Components #4's steps at the install-and-capture end), and a footer listing the exact requested OAuth scopes (pulled from `SCOPES` in `receiver.ts`) so an approving admin isn't guessing what they're granting.

**Dashboard Getting Started panel.** Reuses the existing visual language exactly — no new design language, matching every prior dashboard sub-project's precedent (tabs, display-name resolution, usage analytics all reused `theme.css` as-is). The full (zero-namespace) state is a bordered box using the same hairline `1px solid var(--color-border)` treatment already used for table rows and `.message` blocks, with a serif `h2` heading ("Get started") in the same style every other section heading uses. The collapsed (post-first-capture) state is a small text-button styled like the existing `.grid-toggle` affordance — `color: var(--color-text-muted)`, `font-size: 12px`, no border — establishing "small muted persistent utility control" as a repeatable pattern rather than a one-off.

## Components

1. **Public install landing page** (`public/index.html`, new top-level directory) — plain static HTML, self-contained per Design reference. Served via a new route in `src/server.ts`, registered right after the existing `/healthz` handler and before `createSlackReceiver(...)` is called (no actual collision risk either way — Bolt's `ExpressReceiver` only ever claims `/slack/install`, `/slack/oauth_redirect`, and its own events endpoint — but keeping the product's own routes together at the top of `buildApp` matches how `/healthz` is already placed):

   ```typescript
   const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
   // ...
   app.get("/", (_req, res) => {
     res.sendFile("index.html", { root: PUBLIC_DIR });
   });
   ```

   `PUBLIC_DIR` is resolved from `import.meta.url`, matching `MIGRATIONS_FOLDER`/`DASHBOARD_DIST`'s existing pattern (works identically under `tsx` and the compiled `dist/server.js`, and isn't sensitive to `process.cwd()` or a dot-prefixed worktree checkout directory — same reasoning as the comment already on the `/dashboard` route). No `express.static` mount is added for v1 since the page has no separate asset files to serve; if a future og-image or favicon file is added, mount `express.static(PUBLIC_DIR, { index: false })` at that point (`index: false` so it doesn't fight the explicit `GET /` handler above it).

2. **Fix the dropped OAuth-failure signal** (`src/slack/receiver.ts`) — one-line change. Today `failureAsync` redirects to `/dashboard?install_error=1`, but nothing in `App.tsx` ever reads `install_error` (confirmed by reading the whole file) — a denied/failed install silently looks identical to the generic `NoSession` dead end. Since a failed OAuth attempt never produced a session, `/dashboard` was always the wrong destination anyway; the new landing page is the correct one:

   ```typescript
   failureAsync: async (error, _options, _req, res) => {
     console.error("Slack OAuth install failed:", error);
     (res as import("express").Response).redirect("/?install_error=1");
   },
   ```

   The landing page reads `location.search` with a few lines of inline vanilla JS (no framework — this page has none) and shows a small inline banner above the hero when `install_error=1` is present: "Installation didn't complete — you may need workspace-admin approval, or the install was cancelled." `successAsync`'s redirect to `/dashboard` is unchanged (a successful install did produce a session-eligible workspace; `/dashboard` — which will show `NoSession` until the claim link is clicked — remains the right destination, and the real hand-off is the DM regardless, per the existing design).

3. **`NoSession` gets a way out** (`dashboard-web/src/App.tsx`) — today it's one dead-end sentence. It becomes:

   ```tsx
   export function NoSession() {
     return (
       <div>
         <p>No active session — check your Slack DM for the dashboard setup link.</p>
         <p>
           Missed the DM, or need to reinstall? <a href="/">Visit the recall-bot install page</a>.
         </p>
       </div>
     );
   }
   ```

   This is the one JSX-body-only edit to an existing exported component in this design — flagged explicitly in the plan as a small, isolated diff to minimize collision with sub-projects 5a–5c's unrelated edits to the same file.

4. **`GettingStartedPanel` / `GettingStartedSteps`** (`dashboard-web/src/App.tsx`, new components) — the durable, stand-alone copy of the 3-step instructions (Design reference), rendered by `Dashboard()` between the workspace header `<p>` and `<MorphingTabs .../>`:

   ```tsx
   function GettingStartedSteps({ origin }: { origin: string }) {
     const [copied, setCopied] = useState(false);
     const mcpUrl = `${origin}/mcp`;
     const copyUrl = () => {
       navigator.clipboard
         ?.writeText(mcpUrl)
         .then(() => {
           setCopied(true);
           setTimeout(() => setCopied(false), 1500);
         })
         .catch(() => {
           /* clipboard permission denied or unavailable — the URL is still visible as text, no fallback needed */
         });
     };
     return (
       <ol className="getting-started-steps">
         <li>
           Tag <code>@recall-bot</code> on any Slack thread you want to keep.
         </li>
         <li>
           DM the bot <code>/recall-key</code> to get your personal delegate key.
         </li>
         <li>
           Point an MCP-capable agent at <code>{mcpUrl}</code> using that key as a Bearer token.{" "}
           <button type="button" onClick={copyUrl}>
             {copied ? "Copied" : "Copy"}
           </button>
         </li>
       </ol>
     );
   }

   function GettingStartedPanel({ hasNamespaces }: { hasNamespaces: boolean }) {
     const [expanded, setExpanded] = useState(false);
     const origin = window.location.origin;

     if (!hasNamespaces) {
       return (
         <div className="getting-started-panel">
           <h2>Get started</h2>
           <GettingStartedSteps origin={origin} />
         </div>
       );
     }

     return (
       <div className="getting-started-collapsed">
         <button type="button" className="getting-started-link" onClick={() => setExpanded((v) => !v)}>
           Getting started
         </button>
         {expanded && <GettingStartedSteps origin={origin} />}
       </div>
     );
   }
   ```

   `Dashboard()` renders `<GettingStartedPanel hasNamespaces={namespaces.length > 0} />` using the `namespaces` state it already fetches every `reload()` — no new API call. Deliberately **not** a `MorphingTabsItem` / fourth tab: sub-project usage-analytics is already adding a real third tab, and stacking onboarding as a rotating fourth tab would both collide with that work and hide the instructions behind a click exactly when they matter most (first login, zero data). A panel that's simply present above the tabs by default needs no tab-selection logic and can't be missed by landing on the wrong tab.

5. **Empty-state rows in the existing tables** (`dashboard-web/src/App.tsx`, `NamespacesTable` / `UsersTable`) — a smaller, complementary fix so the tables themselves don't look broken even for a viewer who has scrolled past or collapsed the Getting Started panel. Each gets a zero-length branch rendering a single full-width row instead of an empty `<tbody>`:

   ```tsx
   {namespaces.length === 0 ? (
     <tr>
       <td colSpan={/* current header count at implementation time */}>
         No threads captured yet — tag @recall-bot on a thread to get started.
       </td>
     </tr>
   ) : (
     namespaces.map((n) => /* existing row */)
   )}
   ```

   `colSpan` must match whatever `NamespacesTable`'s header count is *after* sub-project 5a (Linear issue linking) has landed its new "Linked issues" `<th>` — 7, not today's 6. `UsersTable`'s column count is unaffected by sub-project 5b (Slack display-name resolution), since that sub-project changes the *content* of the existing "Slack user" cell (adds an avatar + resolved name) rather than adding a new column — its empty-state `colSpan` stays 3. This dependency is exactly why this sub-project is sequenced after 5a/5b/5c (see Sub-project note and the plan's Task 1).

6. **`theme.css` additions** (`dashboard-web/src/theme.css`) — three small rules, no new tokens, matching Design reference:

   ```css
   .getting-started-panel {
     border: 1px solid var(--color-border);
     padding: var(--space-4);
     margin: var(--space-4) 0;
   }

   .getting-started-steps {
     margin: 0;
     padding-left: var(--space-4);
   }

   .getting-started-steps li {
     margin-bottom: var(--space-2);
   }

   .getting-started-collapsed {
     margin: var(--space-2) 0;
   }

   .getting-started-link {
     border: none;
     background: none;
     padding: 0;
     color: var(--color-text-muted);
     font-size: 12px;
     text-decoration: underline;
     cursor: pointer;
   }
   ```

## Data flow

```
1. Visitor → GET /                                  (new: public/index.html, static, no DB read)
2. Visitor clicks "Add to Slack" → GET /slack/install  (unchanged: Bolt/InstallProvider, directInstall)
3.   → Slack's own OAuth consent screen               (unchanged, Slack-owned surface)
4a. Approved  → successAsync → sendClaimLinkDm (unchanged) → installer DMed a one-time
                /dashboard/claim?token=... link → browser redirected to /dashboard (unchanged;
                shows NoSession until the DM link is clicked, now with a link back to "/")
4b. Denied/cancelled → failureAsync → browser redirected to /?install_error=1 (changed target)
                → landing page reads location.search, shows inline error banner
5. Installer clicks the DM link → GET /dashboard/claim?token=...   (unchanged: ClaimView)
   → POST /api/dashboard/claim → session cookie set → redirect to /dashboard   (unchanged)
6. Dashboard() mounts → reload() → GET /me, /namespaces, /users (+ /analytics per
   usage-analytics)   (unchanged fetches)
7. namespaces.length === 0 → GettingStartedPanel renders full 3-step panel (new)
   namespaces.length === 0 (still) → NamespacesTable/UsersTable render empty-state rows (new)
8. A teammate tags @recall-bot on a thread (existing capture pipeline, untouched) → namespace
   count goes from 0 to 1
9. Next time anyone reloads /dashboard: namespaces.length > 0 → GettingStartedPanel renders the
   small collapsed "Getting started" link instead (new) → normal tabbed dashboard is now the
   primary surface
```

No new backend endpoints and no new database reads on the dashboard side — steps 7 and 9 are both pure client-side branches on the `namespaces` array `Dashboard()` already fetches. The only new server-side surface is the static landing page route (step 1) and the one-line redirect-target change (step 4b).

## Error handling

- **`GET /` before `public/index.html` exists or is misnamed** → `res.sendFile` errors, Express's default error handler returns a 500. Mitigated entirely by the plan's Task 2 verification step (`npm run build` + hit `/` locally) — no runtime fallback needed for a file that ships with the deploy.
- **Non-admin clicks "Add to Slack"** → unchanged downstream behavior (Slack's own consent screen shows its own "you don't have permission" state); the landing page's admin-approval callout (Design reference) is the mitigation — set expectations before the click, not after.
- **OAuth denied/cancelled** → `failureAsync` redirect now lands back on `/?install_error=1` (Components #2) instead of the auth-gated `/dashboard`, where the visitor has somewhere to retry instead of a bare `NoSession` sentence that doesn't explain *why*.
- **Second teammate / missed DM / expired (7-day) or already-consumed claim token** → still surfaces as `NoSession` (unchanged auth gate — no session cookie exists), but now with a link back to `/` (Components #3) instead of a dead end. `ClaimView`'s own "This link has expired or was already used" copy (unchanged, already exists) covers the case where the token itself is the problem rather than its absence.
- **`navigator.clipboard` unavailable or denied** (older browser, non-HTTPS `localhost` dev context, permission denied) → `copyUrl`'s `.catch()` swallows the error silently; the MCP URL is already visible as plain text in the step, so the copy button is a convenience, not the only way to get the value — no error UI needed.
- **A workspace whose only namespace gets archived back to zero *visible* namespaces** — out of scope for v1: `GettingStartedPanel` gates on `namespaces.length === 0` from the same array `NamespacesTable` renders, which includes archived rows (they still get a `<tr>`, just with no Archive button — see existing `n.status !== "archived"` guard). Only a workspace that has *never* captured anything sees the full panel; one that has captured-then-archived everything sees the collapsed link, which is arguably correct (they've done it before) and not worth special-casing.
- **Getting Started panel logic never blocks or delays the normal dashboard.** `GettingStartedPanel` is inserted as a pure additional render between two existing elements; it reads no state `Dashboard()` doesn't already have, makes no additional fetch, and has no loading/error state of its own to manage — if `namespaces` is `[]` because the fetch is still in flight (not yet resolved) rather than genuinely empty, the panel briefly shows the full onboarding copy before flipping to collapsed once real data arrives, which is a harmless, momentary false-positive (same class of "fetch not resolved yet" gap `Dashboard()` already tolerates elsewhere — e.g. `users`/`namespaces` both start as `[]` before their first `reload()` resolves).

## Testing

- **`tests/server.landing.test.ts`** (new) — `GET /` returns `200`, `content-type` starting with `text/html`, and the response body contains an `href="/slack/install"` (the primary CTA actually points at the real install route) and the literal string `Add to Slack`. Regression-checks alongside: `GET /healthz` and `GET /slack/install` still behave as `tests/server.wiring.test.ts` already asserts (route-ordering didn't break anything).
- **`tests/slack/receiver.test.ts`** (extend) — add a case that triggers the `InstallProvider`'s own failure path (e.g. hitting `GET /slack/oauth_redirect` with no/invalid state) and asserts `res.headers.location` starts with `/?install_error=1`, replacing the old `/dashboard?install_error=1` target. `successAsync`'s existing redirect-to-`/dashboard` behavior is unchanged and doesn't need a new test.
- **Frontend:** no dedicated test suite, matching every prior dashboard sub-project's precedent for this internal admin UI. `npx tsc --noEmit -p dashboard-web/tsconfig.json` is the build-time check for `GettingStartedPanel`/`GettingStartedSteps`/`NoSession`/the table empty-state branches.
- **Manual end-to-end verification** (the real test for this sub-project, since it's mostly UX/copy, not logic): run `npm run build && npm run dev` locally; visit `/` and confirm the hero, CTA, admin-approval callout, and scope footer render; visit `/?install_error=1` directly and confirm the inline banner appears; claim a freshly seeded workspace with zero namespaces and confirm the full Getting Started panel renders above the tabs, the Copy button copies `{origin}/mcp` to the clipboard; seed one namespace and reload, confirming the panel collapses to the small link and expands/collapses correctly on click; hit `/dashboard` with no cookie and confirm `NoSession`'s link back to `/` works.
- Full `npm test` must stay green — this sub-project's backend surface area is two small, additive changes (`public/index.html`'s route, one redirect-target line), so this is primarily a regression check.

## Open items (explicitly deferred, not blocking this sub-project)

- **Slack App Directory listing.** If pursued, imposes Slack's own branding/copy requirements (the official "Add to Slack" button asset) on the landing page — a follow-up, not this design's concern.
- **Per-viewer (not just per-workspace) onboarding state.** Whether a specific signed-in teammate has personally run `/recall-key` isn't answerable today without a bigger auth change (dashboard sessions are workspace-scoped, not user-scoped, per `src/dashboard/session.ts`/`auth.ts`). The collapsed "Getting started" link is workspace-global for v1.
- **Live collapse of the panel** without a page reload — would require polling or a push channel (SSE/WebSocket), neither of which exists anywhere in this codebase today.
- **Manual dismiss/skip control** for the full zero-state panel, for an admin who wants it gone immediately rather than after the first capture.
- **A ready-to-paste `mcpServers` JSON config block** instead of the bare `{origin}/mcp` + Bearer-token instruction, if the target audience (coding-agent operators) turns out to need more hand-holding than a raw URL.
- **Canonical marketing copy.** No README, brand guide, or prior marketing copy exists anywhere in this repo to pull from verbatim; the landing page's hero/how-it-works copy in this design is hand-written from the bot's actual mechanics (tag → capture → MCP recall) and should be treated as a first draft, not final copy, pending review.
