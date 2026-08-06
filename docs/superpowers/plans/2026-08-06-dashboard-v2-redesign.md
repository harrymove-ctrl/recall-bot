# Dashboard v2 (Grid-Mode Redesign & Namespace Detail) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the admin dashboard with a minimal serif/sans design system and a toggleable dotted-grid overlay, and add a namespace detail view so an admin can read the actual captured Slack thread instead of only its metadata.

**Architecture:** Pure frontend restyle (a small CSS file plus a `useGridMode` hook in the existing no-router React app) plus one new scoped-and-tested backend endpoint that reuses the existing `messages`/`files` tables — no schema changes.

**Tech Stack:** Existing stack only — React 19 + esbuild (already bundles `.css` imports natively, no plugin needed), Express 5 + Drizzle ORM, Vitest + Supertest for the backend test.

## Global Constraints

- No new npm dependencies. The serif/sans fonts are system font stacks (`Georgia`/`Times New Roman` for serif, the existing OS UI font for sans) — no webfont loading.
- ESM throughout; backend relative imports use `.js` extensions (NodeNext resolution); frontend (`dashboard-web/`) imports stay extensionless (Bundler resolution) — same split as the rest of this project.
- Before committing any backend change, run `npx tsc --noEmit -p tsconfig.json`. Before committing any frontend change, run `npx tsc --noEmit -p dashboard-web/tsconfig.json`.
- No dedicated frontend test suite for this sub-project (matches the existing dashboard's precedent for this internal admin UI) — `tsc --noEmit` is the only build-time check on the React code. The new backend endpoint DOES get real-Postgres integration tests, same `tests/setup.ts` pattern as every other dashboard route.
- Every route stays scoped by the session's `workspaceId` exactly like the existing routes in `src/dashboard/api.ts` — a namespace not owned by the session's workspace returns 404, never 403, never a silent leak.

---

## File Structure

```
recall-bot/
  dashboard-web/
    src/
      theme.css          # NEW — design tokens, base styles, grid-overlay CSS
      main.tsx            # MODIFY — import theme.css
      index.html           # MODIFY — add <link> to the emitted bundle.css
      App.tsx                # MODIFY — Grid Mode toggle + overlay wrapper, namespace-detail routing branch, "View" link per namespace row, export NoSession
      NamespaceDetail.tsx      # NEW — the captured-thread view
  src/
    dashboard/
      api.ts                    # MODIFY — add GET /namespaces/:id/messages
    server.ts                     # MODIFY — add GET /dashboard/namespaces/:id route
  tests/
    dashboard/
      api.test.ts                  # MODIFY — add tests for the new endpoint
```

---

### Task 1: Design system + Grid Mode toggle

**Files:**
- Create: `dashboard-web/src/theme.css`
- Modify: `dashboard-web/src/main.tsx`
- Modify: `dashboard-web/src/index.html`
- Modify: `dashboard-web/src/App.tsx`

**Interfaces:**
- Consumes: nothing new — restyles the existing `Dashboard`/`ClaimView` components in place.
- Produces: the `.page`, `.grid-overlay`, `.grid-toggle`, `.message`, `.message-meta` CSS classes that Task 3's `NamespaceDetail.tsx` will also use; `NoSession` becomes an exported symbol from `App.tsx` (was previously a private, unexported function) — Task 3 imports it.

- [ ] **Step 1: Write dashboard-web/src/theme.css**

```css
:root {
  --color-bg: #ffffff;
  --color-surface: #fafafa;
  --color-text: #111111;
  --color-text-muted: #666666;
  --color-border: #dddddd;
  --color-accent: #2563eb;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 16px;
  --space-4: 24px;
  --space-5: 40px;
  --font-serif: Georgia, "Times New Roman", serif;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
}

h1,
h2 {
  font-family: var(--font-serif);
  font-weight: 400;
  margin: 0 0 var(--space-2) 0;
}

h1 {
  font-size: 28px;
}

h2 {
  font-size: 18px;
  margin-top: var(--space-5);
}

table {
  border-collapse: collapse;
  width: 100%;
}

th,
td {
  text-align: left;
  padding: var(--space-2) var(--space-3) var(--space-2) 0;
  border-bottom: 1px solid var(--color-border);
  font-size: 13px;
}

th {
  color: var(--color-text-muted);
  font-weight: 500;
}

input:not([type]) {
  border: none;
  border-bottom: 1px solid transparent;
  background: transparent;
  font: inherit;
  color: inherit;
  padding: 2px 0;
  width: 100%;
}

input:not([type]):hover,
input:not([type]):focus {
  border-bottom-color: var(--color-border);
  outline: none;
}

button {
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text);
  padding: 4px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  border-radius: 3px;
}

button:hover {
  border-color: var(--color-text);
}

a {
  color: var(--color-accent);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

.page {
  max-width: 900px;
  margin: 0 auto;
  padding: var(--space-5) var(--space-4);
  position: relative;
  z-index: 1;
}

.grid-toggle {
  position: fixed;
  top: var(--space-3);
  right: var(--space-3);
  z-index: 2;
  font-size: 12px;
  color: var(--color-text-muted);
}

.grid-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  opacity: 0.4;
  background-image: repeating-linear-gradient(
      to right,
      var(--color-border) 0,
      var(--color-border) 1px,
      transparent 1px,
      transparent 80px
    ),
    repeating-linear-gradient(
      to bottom,
      var(--color-border) 0,
      var(--color-border) 1px,
      transparent 1px,
      transparent 80px
    );
}

.message {
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--color-border);
}

.message-meta {
  color: var(--color-text-muted);
  font-size: 12px;
  margin: 0 0 var(--space-1) 0;
}
```

- [ ] **Step 2: Import the stylesheet from the entry point**

```tsx
// dashboard-web/src/main.tsx — full replacement content
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./theme.css";

const container = document.getElementById("root")!;
createRoot(container).render(<App />);
```

esbuild bundles a `.css` import from a JS/TS entry point automatically (no plugin/config needed) — it emits a companion `dist/dashboard-web/bundle.css` file alongside `bundle.js`, it does not inline the CSS into the JS bundle. `build-dashboard.mjs` needs no changes for this — the companion file appears automatically because `main.tsx` now imports a `.css` file.

- [ ] **Step 3: Link the emitted stylesheet from the HTML shell**

```html
<!-- dashboard-web/src/index.html — full replacement content -->
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>recall-bot dashboard</title>
    <link rel="stylesheet" href="/dashboard/bundle.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="/dashboard/bundle.js"></script>
  </body>
</html>
```

- [ ] **Step 4: Add the Grid Mode toggle and page wrapper, and export NoSession**

Modify `dashboard-web/src/App.tsx`:

1. Change `function NoSession()` to `export function NoSession()` (Task 3's `NamespaceDetail.tsx` imports it — this is the only change to that function).
2. Add this above the existing `export function App()`:

```tsx
const GRID_MODE_KEY = "recall_dashboard_grid_mode";

function useGridMode(): [boolean, () => void] {
  const [enabled, setEnabled] = useState(() => {
    const stored = localStorage.getItem(GRID_MODE_KEY);
    return stored === null ? true : stored === "true";
  });
  const toggle = () => {
    setEnabled((prev) => {
      const next = !prev;
      localStorage.setItem(GRID_MODE_KEY, String(next));
      return next;
    });
  };
  return [enabled, toggle];
}
```

3. Find this exact block (the current end of the file):

```tsx
export function App() {
  if (window.location.pathname === "/dashboard/claim") {
    return <ClaimView />;
  }
  return <Dashboard />;
}
```

and replace it with:

```tsx
export function App() {
  const [gridMode, toggleGridMode] = useGridMode();
  const path = window.location.pathname;

  let view: JSX.Element;
  if (path === "/dashboard/claim") {
    view = <ClaimView />;
  } else {
    const namespaceMatch = path.match(/^\/dashboard\/namespaces\/([0-9a-fA-F-]+)$/);
    view = namespaceMatch ? <NamespaceDetail namespaceId={namespaceMatch[1]} /> : <Dashboard />;
  }

  return (
    <>
      {gridMode && <div className="grid-overlay" />}
      <button className="grid-toggle" onClick={toggleGridMode}>
        Grid Mode: {gridMode ? "On" : "Off"}
      </button>
      <div className="page">{view}</div>
    </>
  );
}
```

4. Add this import at the top of `App.tsx` (Task 3 creates the module this points to — this reference stays broken until Task 3 runs, which is expected mid-plan; both tasks land before this plan's tests are re-verified end to end):

```tsx
import { NamespaceDetail } from "./NamespaceDetail";
```

- [ ] **Step 5: Verify the frontend type-checks and builds**

Run:
```bash
npx tsc --noEmit -p dashboard-web/tsconfig.json
```
Expected: FAILS at this point in the plan — `./NamespaceDetail` doesn't exist yet (Task 3 creates it). This is expected; do not attempt to work around it by removing the import. Confirm the ONLY error is the missing module (`Cannot find module './NamespaceDetail'`), not something else — if there's any other error, fix it before proceeding.

- [ ] **Step 6: Commit**

```bash
git add dashboard-web/src/theme.css dashboard-web/src/main.tsx dashboard-web/src/index.html dashboard-web/src/App.tsx
git commit -m "feat(dashboard): add design system and Grid Mode toggle"
```

---

### Task 2: Namespace messages endpoint

**Files:**
- Modify: `src/dashboard/api.ts`
- Test: `tests/dashboard/api.test.ts`

**Interfaces:**
- Consumes: `messages` and `files` tables from `src/db/schema.ts` (existing — `messages`: `id`, `namespaceId`, `slackUserId`, `text`, `slackTs`, `createdAt`; `files`: `id`, `messageId`, `originalName`, `mimeType`, `status`); the existing `UUID_RE`, `auth`, `DashboardRequest` already defined in `api.ts`.
- Produces: `GET /namespaces/:id/messages` route returning `Array<{ id, slackUserId, text, slackTs, createdAt, files: Array<{ id, originalName, mimeType, status }> }>`. Task 3's `NamespaceDetail.tsx` fetches this exact shape.

- [ ] **Step 1: Write the failing test**

Add to the existing `describe("dashboard API", ...)` block in `tests/dashboard/api.test.ts`:

```typescript
  it("GET /namespaces/:id/messages returns the captured thread in order, with attached files", async () => {
    const app = buildTestApp();
    const workspace = await seedWorkspace("T7");
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.1" })
      .returning();
    const [firstMessage] = await db
      .insert(messages)
      .values({ namespaceId: namespace.id, slackUserId: "U1", text: "first", slackTs: "1700000000.000100" })
      .returning();
    await db
      .insert(messages)
      .values({ namespaceId: namespace.id, slackUserId: "U2", text: "second", slackTs: "1700000001.000200" });
    await db.insert(files).values({
      messageId: firstMessage.id,
      originalName: "diagram.png",
      mimeType: "image/png",
      status: "stored",
    });
    const cookie = await claimSessionCookie(app, workspace.id);

    const res = await request(app).get(`/api/dashboard/namespaces/${namespace.id}/messages`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].text).toBe("first");
    expect(res.body[0].files).toHaveLength(1);
    expect(res.body[0].files[0].originalName).toBe("diagram.png");
    expect(res.body[1].text).toBe("second");
    expect(res.body[1].files).toHaveLength(0);
  });

  it("GET /namespaces/:id/messages returns 404 for a namespace owned by another workspace", async () => {
    const app = buildTestApp();
    const workspaceA = await seedWorkspace("T8A");
    const workspaceB = await seedWorkspace("T8B");
    const [namespaceB] = await db
      .insert(namespaces)
      .values({ workspaceId: workspaceB.id, channelId: "C1", threadTs: "1.1" })
      .returning();
    const cookieA = await claimSessionCookie(app, workspaceA.id);

    const res = await request(app).get(`/api/dashboard/namespaces/${namespaceB.id}/messages`).set("Cookie", cookieA);
    expect(res.status).toBe(404);
  });
```

Add `messages, files` to the existing `import { workspaces, installations, namespaces, users } from "../../src/db/schema.js";` line (making it `import { workspaces, installations, namespaces, users, messages, files } from "../../src/db/schema.js";`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/dashboard/api.test.ts`
Expected: FAIL — `GET /namespaces/:id/messages` doesn't exist yet (404 from the router's default, or the two new tests fail their assertions).

- [ ] **Step 3: Implement the endpoint**

In `src/dashboard/api.ts`:

1. Change the import line from:
```typescript
import { installations, namespaces, users, workspaces } from "../db/schema.js";
```
to:
```typescript
import { installations, namespaces, users, workspaces, messages, files } from "../db/schema.js";
```

2. Change the drizzle-orm import line from:
```typescript
import { and, desc, eq, isNotNull } from "drizzle-orm";
```
to:
```typescript
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
```

3. Add this route (place it after the existing `router.get("/namespaces", ...)` handler, before `router.patch("/namespaces/:id", ...)`):

```typescript
  router.get("/namespaces/:id/messages", auth, async (req: DashboardRequest, res: Response) => {
    const namespaceId = String(req.params.id);
    if (!UUID_RE.test(namespaceId)) {
      res.status(404).json({ error: "namespace_not_found" });
      return;
    }

    const [namespace] = await db
      .select()
      .from(namespaces)
      .where(and(eq(namespaces.id, namespaceId), eq(namespaces.workspaceId, req.workspaceId!)));
    if (!namespace) {
      res.status(404).json({ error: "namespace_not_found" });
      return;
    }

    const messageRows = await db.select().from(messages).where(eq(messages.namespaceId, namespaceId)).orderBy(messages.slackTs);

    const messageIds = messageRows.map((m) => m.id);
    const fileRows = messageIds.length > 0 ? await db.select().from(files).where(inArray(files.messageId, messageIds)) : [];
    const filesByMessageId = new Map<string, typeof fileRows>();
    for (const f of fileRows) {
      const list = filesByMessageId.get(f.messageId) ?? [];
      list.push(f);
      filesByMessageId.set(f.messageId, list);
    }

    res.json(
      messageRows.map((m) => ({
        id: m.id,
        slackUserId: m.slackUserId,
        text: m.text,
        slackTs: m.slackTs,
        createdAt: m.createdAt,
        files: (filesByMessageId.get(m.id) ?? []).map((f) => ({
          id: f.id,
          originalName: f.originalName,
          mimeType: f.mimeType,
          status: f.status,
        })),
      })),
    );
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/dashboard/api.test.ts`
Expected: PASS

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/api.ts tests/dashboard/api.test.ts
git commit -m "feat(dashboard): add GET /namespaces/:id/messages endpoint"
```

---

### Task 3: Namespace detail view

**Files:**
- Create: `dashboard-web/src/NamespaceDetail.tsx`
- Modify: `dashboard-web/src/App.tsx`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `GET /api/dashboard/namespaces/:id/messages` (Task 2); `NoSession` exported from `App.tsx` (Task 1).
- Produces: `NamespaceDetail` component imported by `App.tsx`'s Task-1-added `import { NamespaceDetail } from "./NamespaceDetail";` line — this closes out that import, which was left dangling at the end of Task 1.

- [ ] **Step 1: Write dashboard-web/src/NamespaceDetail.tsx**

```tsx
import { useEffect, useState } from "react";
import { NoSession } from "./App";

interface MessageFile {
  id: string;
  originalName: string;
  mimeType: string;
  status: string;
}

interface MessageRow {
  id: string;
  slackUserId: string;
  text: string;
  slackTs: string;
  createdAt: string;
  files: MessageFile[];
}

export function NamespaceDetail({ namespaceId }: { namespaceId: string }) {
  const [messages, setMessages] = useState<MessageRow[] | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetch(`/api/dashboard/namespaces/${namespaceId}/messages`).then(async (res) => {
      if (res.status === 401) {
        setUnauthorized(true);
        return;
      }
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      setMessages(await res.json());
    });
  }, [namespaceId]);

  if (unauthorized) return <NoSession />;
  if (notFound) return <p>Namespace not found.</p>;
  if (!messages) return <p>Loading…</p>;

  return (
    <div>
      <p>
        <a href="/dashboard">← Back to namespaces</a>
      </p>
      <h1>Captured thread</h1>
      {messages.length === 0 && <p>No messages captured yet.</p>}
      {messages.map((m) => (
        <div className="message" key={m.id}>
          <p className="message-meta">
            {m.slackUserId} — {new Date(m.createdAt).toLocaleString()}
          </p>
          <p>{m.text}</p>
          {m.files.length > 0 && (
            <ul>
              {m.files.map((f) => (
                <li key={f.id}>
                  {f.originalName} ({f.mimeType})
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Add a "View" link per namespace row in the Dashboard table**

In `dashboard-web/src/App.tsx`, inside the `Dashboard` component's namespaces `<table>`, change the header row from:

```tsx
          <tr>
            <th>Label</th>
            <th>Channel</th>
            <th>Status</th>
            <th>Created</th>
            <th></th>
          </tr>
```

to:

```tsx
          <tr>
            <th>Label</th>
            <th>Channel</th>
            <th>Status</th>
            <th>Created</th>
            <th></th>
            <th></th>
          </tr>
```

And change the body row from:

```tsx
            <tr key={n.id}>
              <td>
                <input defaultValue={n.label ?? ""} placeholder={n.threadTs} onBlur={(e) => renameNamespace(n.id, e.currentTarget.value)} />
              </td>
              <td>{n.channelId}</td>
              <td>{n.status}</td>
              <td>{new Date(n.createdAt).toLocaleDateString()}</td>
              <td>{n.status !== "archived" && <button onClick={() => archiveNamespace(n.id)}>Archive</button>}</td>
            </tr>
```

to:

```tsx
            <tr key={n.id}>
              <td>
                <input defaultValue={n.label ?? ""} placeholder={n.threadTs} onBlur={(e) => renameNamespace(n.id, e.currentTarget.value)} />
              </td>
              <td>{n.channelId}</td>
              <td>{n.status}</td>
              <td>{new Date(n.createdAt).toLocaleDateString()}</td>
              <td>
                <a href={`/dashboard/namespaces/${n.id}`}>View</a>
              </td>
              <td>{n.status !== "archived" && <button onClick={() => archiveNamespace(n.id)}>Archive</button>}</td>
            </tr>
```

- [ ] **Step 3: Add the server-side route for direct navigation and refresh**

In `src/server.ts`, find this exact block:

```typescript
  app.get("/dashboard", (_req, res) => {
    res.sendFile("index.html", { root: DASHBOARD_DIST });
  });
  app.get("/dashboard/claim", (_req, res) => {
    res.sendFile("index.html", { root: DASHBOARD_DIST });
  });
  app.use("/dashboard", express.static(DASHBOARD_DIST));
```

and replace it with:

```typescript
  app.get("/dashboard", (_req, res) => {
    res.sendFile("index.html", { root: DASHBOARD_DIST });
  });
  app.get("/dashboard/claim", (_req, res) => {
    res.sendFile("index.html", { root: DASHBOARD_DIST });
  });
  app.get("/dashboard/namespaces/:id", (_req, res) => {
    res.sendFile("index.html", { root: DASHBOARD_DIST });
  });
  app.use("/dashboard", express.static(DASHBOARD_DIST));
```

The new route must stay ahead of the `express.static` mount, same as the two existing routes above it — express matches routes in registration order, and this keeps the same "avoid serve-static's directory-index/redirect behavior for anything that isn't a real static file" precedent already established by those two.

- [ ] **Step 4: Build the frontend and verify types**

Run:
```bash
npm run build:dashboard
npx tsc --noEmit -p dashboard-web/tsconfig.json
npx tsc --noEmit -p tsconfig.json
```
Expected: all three succeed with zero errors — this also resolves the dangling `NamespaceDetail` import from Task 1.

- [ ] **Step 5: Manual end-to-end verification**

Run: `npm test` (full suite, confirms nothing else broke)
Expected: all tests pass.

Then, since this task has no dedicated frontend test suite, verify manually: start the server locally against the test database, seed a workspace with a namespace that has at least one message, claim it, and confirm clicking "View" on a namespace row navigates to `/dashboard/namespaces/:id` and shows the captured message(s); confirm refreshing that URL directly still works (proves Step 3's server route); confirm the "← Back to namespaces" link returns to `/dashboard`; confirm the Grid Mode toggle shows/hides the dotted overlay and the choice survives a page reload (proves `localStorage` persistence from Task 1).

- [ ] **Step 6: Commit**

```bash
git add dashboard-web/src/NamespaceDetail.tsx dashboard-web/src/App.tsx src/server.ts
git commit -m "feat(dashboard): add namespace detail view for reading captured messages"
```
