# Onboarding Flow (Install Landing Page + Dashboard First-Run Experience) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public, pre-OAuth install landing page at `GET /`, fix the dropped OAuth-failure redirect signal, and add a first-run "Getting Started" experience to the dashboard (full panel at zero namespaces, collapsed persistent link afterward), plus empty-state copy in the existing tables — reconciling the install-side and dashboard-side onboarding gaps into one flow.

**Architecture:** One new static file (`public/index.html`) served by a new `GET /` route in `src/server.ts`; a one-line redirect-target fix in `src/slack/receiver.ts`; and additive changes to `dashboard-web/src/App.tsx` (`NoSession`, two new components, two tables' empty-state branches) plus three new `theme.css` rules. No new dependencies, no new database tables, no new API endpoints.

**Tech Stack:** Existing stack only (Express 5, React 19, Vitest, `theme.css`). No new runtime or dev dependencies.

## Global Constraints

- **Do not start Task 2 onward until Task 1 confirms sub-projects 5a (Linear issue linking), 5b (Slack display-name resolution), and 5c (usage analytics) are merged to `main`.** All three touch `dashboard-web/src/App.tsx` (tabs array, `NamespacesTable`, `UsersTable`, and a new third "Analytics" tab) and `src/db/schema.ts`. Building this plan's `App.tsx` changes against pre-merge `main` would mean rebasing through three more merges instead of starting from the final shape once.
- `public/index.html` is a self-contained static file: inline `<style>`, no external stylesheet/font/script requests, no build step. It is never processed by esbuild, Tailwind, or `tsc` — it ships as-is.
- No changes to OAuth scopes, `InstallProvider`/`ExpressReceiver` configuration, or claim-token issuance/consumption logic. The only edit inside `src/slack/receiver.ts` is the `failureAsync` redirect target string.
- Frontend imports stay extensionless (Bundler resolution), matching the rest of `dashboard-web`.
- Before committing any task, run `npx tsc --noEmit -p dashboard-web/tsconfig.json` for any `App.tsx`/`theme.css`-adjacent change, and `npm run build` for anything touching `src/server.ts` or `public/`. Run `npm test` once at the end (Task 7) to confirm no regression across the whole sub-project.
- Every `App.tsx` edit in this plan should be as small and isolated as the design intends (`NoSession`'s JSX body, two new standalone components, two empty-array branches) — do not restructure surrounding code that sub-projects 5a–5c already touched, to keep this sub-project's diff easy to review on its own.

---

## File Structure

```
recall-bot/
  public/
    index.html                        # NEW — self-contained static install landing page
  src/
    server.ts                         # MODIFY — PUBLIC_DIR resolution + GET / route
    slack/
      receiver.ts                     # MODIFY — failureAsync redirect target only
  dashboard-web/
    src/
      App.tsx                         # MODIFY — NoSession, GettingStartedSteps, GettingStartedPanel,
                                       #   NamespacesTable/UsersTable empty-state branches
      theme.css                       # MODIFY — .getting-started-panel / -steps / -collapsed / -link
  tests/
    server.landing.test.ts            # NEW — GET / smoke test
    slack/
      receiver.test.ts                # MODIFY — failureAsync redirect-target test
```

---

### Task 1: Rebase onto updated main

**Files:** none (verification and sync only)

**Interfaces:**
- Consumes: the merged state of sub-projects 5a–5c on `main`.
- Produces: a confirmed, current baseline for every later task in this plan — in particular, the real post-merge column counts for `NamespacesTable`/`UsersTable` that Task 5 depends on.

- [ ] **Step 1: Confirm sub-projects 5a–5c are merged**

  Check that `docs/superpowers/specs/2026-08-07-linear-issue-linking-design.md`, `2026-08-07-slack-display-name-resolution-design.md`, and `2026-08-07-usage-analytics-design.md` all have corresponding merged implementation work on `main` (not just design docs) — e.g. `namespace_linear_issues` and `recall_events` tables present in `src/db/schema.ts`, a third "Analytics" tab present in `dashboard-web/src/App.tsx`'s `tabs` array, `NamespacesTable` rendering a "Linked issues" column, `UsersTable`/`NamespaceDetail.tsx` rendering resolved display names/avatars. If any is still only a design doc with no corresponding code on `main`, stop here and wait — do not proceed against a moving target.

- [ ] **Step 2: Sync the local branch**

  ```bash
  git checkout main
  git pull
  ```

- [ ] **Step 3: Re-read the merged `App.tsx` and `theme.css` to confirm this plan's assumptions**

  Specifically confirm:
  - `NamespacesTable`'s `<thead>` column count (design assumed 7, post Linear issue linking's new "Linked issues" `<th>` — confirm the real number and use it, not the assumed one, in Task 5's `colSpan`).
  - `UsersTable`'s `<thead>` column count (design assumed unchanged at 3, since Slack display-name resolution changes cell *content*, not column count — confirm this is still true).
  - The `tabs` array in `Dashboard()` now has three entries (`namespaces`, `users`, `analytics`) — confirm `GettingStartedPanel`'s planned insertion point (between the workspace header `<p>` and `<MorphingTabs .../>`) still reads correctly against the merged JSX.
  - No naming collisions between this plan's new identifiers (`GettingStartedPanel`, `GettingStartedSteps`, `useDashboardTab`-adjacent state) and anything sub-projects 5a–5c introduced.

  If any assumption differs from the design doc, treat the merged code as authoritative and adjust the later tasks' `colSpan`/insertion-point details accordingly — the design doc's numbers were written against pre-merge `main` and are illustrative, not binding.

- [ ] **Step 4: Confirm a clean, green baseline**

  ```bash
  npm test
  npx tsc --noEmit -p dashboard-web/tsconfig.json
  ```

  Both must pass before any new code from this plan is added — a failure here belongs to the merged sub-projects, not this one, and should be resolved (or escalated) before continuing.

---

### Task 2: Public install landing page

**Files:**
- Create: `public/index.html`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: nothing new from the rest of the app — `public/index.html` is fully static; its "Add to Slack" link points at the existing `/slack/install` route (unchanged by this task).
- Produces: `GET /` serving the landing page. Task 3 adds the `install_error` banner's inline JS to this same file.

- [ ] **Step 1: Write `public/index.html`**

  Self-contained static HTML — inline `<style>` block hand-copying the relevant tokens from `dashboard-web/src/theme.css` (`--color-accent: #2563eb`, `--color-border: #dddddd`, `--color-text-muted: #666666`, serif `h1` / sans body), no external requests. Structure, top to bottom:

  1. An empty error-banner container (`<div id="install-error" hidden>...</div>`), populated by Task 3's inline script.
  2. Hero: `<h1>` headline ("Turn any Slack thread into memory a coding agent can recall.") + sub-line explaining tag-to-capture and MCP recall in one sentence.
  3. Primary CTA: `<a href="/slack/install">Add to Slack</a>`, styled as a button.
  4. Directly beside the CTA (not in a footer): an admin-approval callout — "Installing requires Slack workspace-admin permission or approval from whoever manages apps in your workspace. If that's not you, send this page to them — nothing is installed or configured until it clears Slack's own approval screen."
  5. "How it works" — a numbered 3-step list mirroring `GettingStartedSteps`' three ideas at install-time granularity: (1) a workspace admin approves the requested scopes; (2) you get a one-time Slack DM with a dashboard setup link; (3) tag `@recall-bot` on any thread to capture it, or run `/recall-key` in a DM to get a delegate key for your coding agent's MCP connection.
  6. Footer: the exact requested OAuth scopes, copied from `SCOPES` in `src/slack/receiver.ts` (`app_mentions:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `chat:write`, `im:write`, `files:read`, `commands`) — hand-transcribed here since this file has no way to import the TypeScript constant; if `SCOPES` ever changes, this list must be updated by hand too (leave a one-line HTML comment noting the source file, so a future scope change is discoverable).

- [ ] **Step 2: Serve it from `src/server.ts`**

  Add near the top of `buildApp`, right after the existing `app.get("/healthz", ...)` handler and before `createSlackReceiver(...)` is called:

  ```typescript
  const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
  ```

  (add alongside the existing `MIGRATIONS_FOLDER`/`DASHBOARD_DIST` constants at the top of the file)

  ```typescript
  app.get("/", (_req, res) => {
    res.sendFile("index.html", { root: PUBLIC_DIR });
  });
  ```

  No `express.static` mount — this file has no separate asset files to serve in v1.

- [ ] **Step 3: Verify locally**

  ```bash
  npm run dev
  curl -s http://localhost:3000/ | grep -o 'href="/slack/install"'
  ```

  Expected: the route responds, the "Add to Slack" link is present, `/healthz` and `/slack/install` still work unaffected (route order didn't break anything).

- [ ] **Step 4: Commit**

  ```bash
  git add public/index.html src/server.ts
  git commit -m "feat(onboarding): add public install landing page at GET /"
  ```

---

### Task 3: Fix the OAuth-failure redirect target

**Files:**
- Modify: `src/slack/receiver.ts`
- Modify: `public/index.html` (adds the inline `install_error` banner script — depends on Task 2's file existing)
- Modify: `tests/slack/receiver.test.ts`

**Interfaces:**
- Consumes: `public/index.html`'s error-banner container from Task 2, Step 1.
- Produces: `failureAsync` redirecting to `/?install_error=1` instead of `/dashboard?install_error=1`.

- [ ] **Step 1: Change the redirect target**

  In `src/slack/receiver.ts`, inside `installerOptions.callbackOptions.failureAsync`:

  ```typescript
  failureAsync: async (error, _options, _req, res) => {
    console.error("Slack OAuth install failed:", error);
    (res as import("express").Response).redirect("/?install_error=1");
  },
  ```

  `successAsync`'s redirect to `/dashboard` is unchanged — do not touch it.

- [ ] **Step 2: Add the inline error-banner script to `public/index.html`**

  A short vanilla-JS snippet near the end of `<body>`:

  ```html
  <script>
    if (new URLSearchParams(window.location.search).get("install_error") === "1") {
      var el = document.getElementById("install-error");
      el.hidden = false;
      el.textContent =
        "Installation didn't complete — you may need workspace-admin approval, or the install was cancelled.";
    }
  </script>
  ```

- [ ] **Step 3: Extend `tests/slack/receiver.test.ts`**

  Add a case that exercises `InstallProvider`'s own failure path (e.g. `GET /slack/oauth_redirect` with no/invalid `state`) and asserts the resulting redirect `Location` header starts with `/?install_error=1`:

  ```typescript
  it("redirects OAuth failures to the landing page with install_error=1", async () => {
    const app = express();
    const receiver = createSlackReceiver({ /* same params as the existing tests */ });
    createSlackApp(receiver);

    const res = await request(app).get("/slack/oauth_redirect"); // no state/code — triggers failureAsync
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.location).toBe("/?install_error=1");
  });
  ```

  Confirm against the real `@slack/oauth` behavior locally before finalizing the exact status code assertion — the important assertion is the `Location` header value.

- [ ] **Step 4: Verify**

  ```bash
  npm test -- receiver
  ```

  Expected: existing `createSlackReceiver` tests still pass, new failure-redirect test passes.

- [ ] **Step 5: Commit**

  ```bash
  git add src/slack/receiver.ts public/index.html tests/slack/receiver.test.ts
  git commit -m "fix(onboarding): redirect failed installs to the landing page instead of the dashboard"
  ```

---

### Task 4: `NoSession` gets a way out

**Files:**
- Modify: `dashboard-web/src/App.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `NoSession` links back to `/` (Task 2's landing page).

- [ ] **Step 1: Update `NoSession`**

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

  This is the only edit in this task — do not touch anything else in the file yet (kept separate from Task 5 so this isolated, low-risk change can land and be reviewed on its own).

- [ ] **Step 2: Verify types**

  ```bash
  npx tsc --noEmit -p dashboard-web/tsconfig.json
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add dashboard-web/src/App.tsx
  git commit -m "fix(dashboard): give NoSession a link back to the install landing page"
  ```

---

### Task 5: Getting Started panel + table empty states

**Files:**
- Modify: `dashboard-web/src/App.tsx`
- Modify: `dashboard-web/src/theme.css`

**Interfaces:**
- Consumes: the `namespaces` array `Dashboard()` already fetches via `reload()` — no new API call.
- Produces: `GettingStartedPanel`, `GettingStartedSteps` (new, exported only if a future sub-project needs them — otherwise module-private); empty-state branches inside `NamespacesTable`/`UsersTable`.

- [ ] **Step 1: Add `GettingStartedSteps` and `GettingStartedPanel`**

  In `dashboard-web/src/App.tsx`, add both components (placed near `NamespacesTable`/`UsersTable`, before `Dashboard`):

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
        .catch(() => {});
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

- [ ] **Step 2: Wire `GettingStartedPanel` into `Dashboard()`**

  In `Dashboard()`'s return JSX, insert between the workspace header `<p>` and `<MorphingTabs .../>`:

  ```tsx
  <GettingStartedPanel hasNamespaces={namespaces.length > 0} />
  ```

- [ ] **Step 3: Add empty-state rows to `NamespacesTable` and `UsersTable`**

  Using the **real, merged column counts confirmed in Task 1, Step 3** (not necessarily 7/3 — verify against the actual `<thead>` at implementation time):

  ```tsx
  <tbody>
    {namespaces.length === 0 ? (
      <tr>
        <td colSpan={/* confirmed NamespacesTable header count */}>
          No threads captured yet — tag @recall-bot on a thread to get started.
        </td>
      </tr>
    ) : (
      namespaces.map((n) => /* existing row, unchanged */)
    )}
  </tbody>
  ```

  ```tsx
  <tbody>
    {users.length === 0 ? (
      <tr>
        <td colSpan={/* confirmed UsersTable header count */}>
          No delegate keys issued yet — run /recall-key in a DM with @recall-bot to get one.
        </td>
      </tr>
    ) : (
      users.map((u) => /* existing row, unchanged */)
    )}
  </tbody>
  ```

- [ ] **Step 4: Add `theme.css` rules**

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

- [ ] **Step 5: Verify types and build**

  ```bash
  npx tsc --noEmit -p dashboard-web/tsconfig.json
  npm run build:dashboard
  ```

  Expected: zero errors.

- [ ] **Step 6: Commit**

  ```bash
  git add dashboard-web/src/App.tsx dashboard-web/src/theme.css
  git commit -m "feat(dashboard): add first-run Getting Started panel and table empty states"
  ```

---

### Task 6: Backend smoke test for the landing page

**Files:**
- Create: `tests/server.landing.test.ts`

**Interfaces:**
- Consumes: `buildApp` from `src/server.ts` (Task 2).
- Produces: regression coverage for `GET /`.

- [ ] **Step 1: Write the test**

  ```typescript
  import { describe, it, expect } from "vitest";
  import request from "supertest";
  import { db } from "../src/db/client.js";
  import { buildApp } from "../src/server.js";

  describe("GET / (install landing page)", () => {
    it("serves the landing page with a working Add to Slack link", async () => {
      const app = buildApp(db);
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.text).toContain('href="/slack/install"');
      expect(res.text).toContain("Add to Slack");
    });

    it("does not shadow /healthz or /slack/install", async () => {
      const app = buildApp(db);
      expect((await request(app).get("/healthz")).status).toBe(200);
      expect((await request(app).get("/slack/install")).status).toBe(302);
    });
  });
  ```

- [ ] **Step 2: Verify**

  ```bash
  npm test -- landing
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add tests/server.landing.test.ts
  git commit -m "test(onboarding): cover GET / and route-ordering regressions"
  ```

---

### Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

  ```bash
  npm test
  ```

  Expected: all tests pass, including Task 3's and Task 6's new/modified cases.

- [ ] **Step 2: Manual end-to-end check against the local test database**

  Start the server locally (`DATABASE_URL=postgres://recall:recall@localhost:55432/recall_test npm run dev`, migrations auto-apply on boot):
  - Visit `/` — confirm hero, CTA, admin-approval callout, and scope footer render; confirm the CTA points at `/slack/install`.
  - Visit `/?install_error=1` directly — confirm the inline error banner appears.
  - Seed a workspace with zero namespaces, claim a session, visit `/dashboard` — confirm the full `GettingStartedPanel` renders above the tabs, `NamespacesTable`/`UsersTable` show their empty-state rows instead of bare headers, and the MCP URL's Copy button copies `{origin}/mcp` to the clipboard.
  - Seed one namespace for that workspace and reload `/dashboard` — confirm the panel collapses to the small "Getting started" link, and clicking it expands/collapses the same 3-step content inline.
  - Clear the session cookie and hit `/dashboard` directly — confirm `NoSession` renders with a working link back to `/`.

- [ ] **Step 3: Self-review the full diff**

  ```bash
  git diff main --stat
  ```

  Read every changed/new file. Confirm: `public/index.html` makes no external network requests (fully self-contained); `src/server.ts`'s new route doesn't shadow `/healthz`, `/slack/install`, `/dashboard`, or `/api/dashboard/*`; the `receiver.ts` diff is exactly the one redirect-target line plus its test; `App.tsx`'s new components read only state `Dashboard()` already fetches (no new `fetch` calls introduced); `colSpan` values in the two empty-state branches match the real, merged header counts (not the design doc's illustrative numbers); no unrelated formatting churn in files sub-projects 5a–5c also touched.
