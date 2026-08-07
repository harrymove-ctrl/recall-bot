# Dashboard Tabs (Morphing Tabs Navigation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's stacked "Namespaces" / "Users" sections with the beui.dev "Morphing Tabs" component, vendored by hand, with a scoped Tailwind build added only for `dashboard-web`.

**Architecture:** Vendor three files verbatim from the beui.dev registry JSON, add four new root dependencies, add a Tailwind v4 CLI build step that runs alongside (not instead of) the existing esbuild step, then refactor `App.tsx`'s `Dashboard` component to route its two existing table blocks through `MorphingTabs` instead of rendering them stacked.

**Tech Stack:** Existing stack (React 19, esbuild, Express 5, Vitest) plus new: `motion`, `lucide-react`, `clsx`, `tailwind-merge` (runtime deps), `tailwindcss` + `@tailwindcss/cli` (dev deps, dashboard-web build only).

## Global Constraints

- Tailwind must never enter the server build (`tsconfig.json` / `dist/server.js`) or the Vitest run — it is exclusively a `dashboard-web` build-time concern, invoked from `build-dashboard.mjs`.
- Vendored files (`morphing-tabs.tsx`, `lib/ease.ts`, `lib/utils.ts`) are copied verbatim from the registry response — only import paths are translated (`@/lib/...` → relative). No behavioral edits, so future upstream updates stay a clean diff.
- Before committing, run `npx tsc --noEmit -p dashboard-web/tsconfig.json` and `npm run build:dashboard`. Backend is untouched by this plan, but run `npm test` once at the end to confirm no regression.
- ESM throughout, frontend imports stay extensionless (Bundler resolution), matching the rest of `dashboard-web`.

---

## File Structure

```
recall-bot/
  package.json                          # MODIFY — add motion, lucide-react, clsx, tailwind-merge, tailwindcss, @tailwindcss/cli
  build-dashboard.mjs                   # MODIFY — add Tailwind CLI build step
  dashboard-web/
    src/
      tailwind.css                      # NEW — Tailwind v4 entry
      components/
        motion/
          morphing-tabs.tsx             # NEW — vendored verbatim
      lib/
        ease.ts                         # NEW — vendored verbatim
        utils.ts                        # NEW — vendored verbatim (exports cn)
      index.html                        # MODIFY — add <link> to tailwind.css
      App.tsx                           # MODIFY — Dashboard renders MorphingTabs instead of stacked sections
```

---

### Task 1: Vendor the component and wire up the Tailwind build

**Files:**
- Create: `dashboard-web/src/components/motion/morphing-tabs.tsx`
- Create: `dashboard-web/src/lib/ease.ts`
- Create: `dashboard-web/src/lib/utils.ts`
- Create: `dashboard-web/src/tailwind.css`
- Modify: `package.json`
- Modify: `build-dashboard.mjs`
- Modify: `dashboard-web/src/index.html`

**Interfaces:**
- Consumes: nothing new from the rest of the app yet.
- Produces: `MorphingTabs`, `MorphingTabsItem`, `MorphingTabsClassNames` exported from `./components/motion/morphing-tabs`; `dist/dashboard-web/tailwind.css` emitted by the build. Task 2 imports both.

- [ ] **Step 1: Add dependencies**

```bash
npm install motion@^13.0.0 lucide-react@^1.29.0 clsx@^2.1.1 tailwind-merge@^3.6.0
npm install -D tailwindcss@^4.3.3 @tailwindcss/cli@^4.3.3
```

- [ ] **Step 2: Vendor `lib/utils.ts`**

```typescript
// dashboard-web/src/lib/utils.ts — vendored verbatim from https://beui.dev/r/morphing-tabs (lib/utils.ts)
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 3: Vendor `lib/ease.ts`**

Fetch `https://beui.dev/r/morphing-tabs` (JSON), take the `files[].content` where `path === "lib/ease.ts"`, write it verbatim to `dashboard-web/src/lib/ease.ts`. No edits — it has no imports to translate.

- [ ] **Step 4: Vendor `components/motion/morphing-tabs.tsx`**

Fetch the same registry JSON, take `files[].content` where `path === "components/motion/morphing-tabs.tsx"`, write it to `dashboard-web/src/components/motion/morphing-tabs.tsx`. Translate only the two local imports:

```typescript
// before
import { EASE_OUT, SPRING_GLIDE, SPRING_PRESS } from "@/lib/ease";
import { cn } from "@/lib/utils";

// after
import { EASE_OUT, SPRING_GLIDE, SPRING_PRESS } from "../../lib/ease";
import { cn } from "../../lib/utils";
```

No other edits. `import { X } from "lucide-react"`, `from "motion/react"`, `from "react"`, `from "react-dom"` stay as-is — they resolve from the root `node_modules` after Step 1.

- [ ] **Step 5: Add the Tailwind entry file**

```css
/* dashboard-web/src/tailwind.css */
@import "tailwindcss";
@source "./";
```

The `@source "./"` (relative to this file, i.e. `dashboard-web/src/`) makes Tailwind v4's automatic class-scanner cover every file under `dashboard-web/src` regardless of where `npx tailwindcss` is invoked from — needed because this isn't a project root Tailwind would auto-detect on its own.

- [ ] **Step 6: Add the Tailwind CLI build step**

Modify `build-dashboard.mjs` — add after the existing `esbuild.build(...)` call and before the `cpSync(...)` line:

```javascript
import { execFileSync } from "node:child_process";
```

(add to the top imports, alongside the existing `esbuild`/`node:fs` imports)

```javascript
execFileSync(
  "npx",
  [
    "@tailwindcss/cli",
    "-i", "dashboard-web/src/tailwind.css",
    "-o", `${outdir}/tailwind.css`,
    "--minify",
  ],
  { stdio: "inherit" },
);
```

Place this call right after the `esbuild.build({...})` call resolves (the script is top-level `await`, so just add it as the next statement), before `cpSync("dashboard-web/src/index.html", ...)`.

- [ ] **Step 7: Link the compiled Tailwind CSS from the HTML shell**

In `dashboard-web/src/index.html`, add a second stylesheet link alongside the existing `theme.css`-derived `bundle.css` link:

```html
<link rel="stylesheet" href="/dashboard/bundle.css" />
<link rel="stylesheet" href="/dashboard/tailwind.css" />
```

Order matters only if there's a class collision between theme.css and Tailwind utilities — there isn't (theme.css has no utility-style class names), so this ordering is safe either way.

- [ ] **Step 8: Verify the build**

Run: `npm run build:dashboard`
Expected: succeeds, and `dist/dashboard-web/tailwind.css` now exists alongside `bundle.js`/`bundle.css`. The file will be near-empty at this point (no Tailwind classes are used anywhere yet — Task 2 introduces the first ones via the vendored component and its JSX usage in `App.tsx`) — that's expected and not a bug to chase in this task.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json build-dashboard.mjs dashboard-web/src/tailwind.css dashboard-web/src/components/motion/morphing-tabs.tsx dashboard-web/src/lib/ease.ts dashboard-web/src/lib/utils.ts dashboard-web/src/index.html
git commit -m "feat(dashboard): vendor Morphing Tabs component and add scoped Tailwind build"
```

---

### Task 2: Wire MorphingTabs into the Dashboard view

**Files:**
- Modify: `dashboard-web/src/App.tsx`

**Interfaces:**
- Consumes: `MorphingTabs`, `MorphingTabsItem` from `./components/motion/morphing-tabs` (Task 1).
- Produces: no new exports — this is the terminal consumer.

- [ ] **Step 1: Extract the two table blocks into standalone components**

In `dashboard-web/src/App.tsx`, inside the `Dashboard` component, the two `<table>` blocks (currently rendered stacked under `<h2>Namespaces</h2>` and `<h2>Users with an active delegate key</h2>`) become two small components taking the same props the parent `Dashboard` already computes (`namespaces`, `renameNamespace`, `archiveNamespace` for one; `users`, `revokeKey` for the other). Same JSX, same `<table>`/`<thead>`/`<tbody>` markup, same handlers — only extracted into their own function so they can be passed as a `MorphingTabsItem`'s `content`. Drop the `<h2>` headings from inside them (the tab label now carries that role); keep everything else identical.

- [ ] **Step 2: Add tab persistence, matching the existing `useGridMode` pattern**

```tsx
const DASHBOARD_TAB_KEY = "recall_dashboard_active_tab";

function useDashboardTab(): [string, (id: string) => void] {
  const [tab, setTab] = useState(() => localStorage.getItem(DASHBOARD_TAB_KEY) ?? "namespaces");
  const setAndPersist = (id: string) => {
    setTab(id);
    localStorage.setItem(DASHBOARD_TAB_KEY, id);
  };
  return [tab, setAndPersist];
}
```

- [ ] **Step 3: Replace the stacked sections with `MorphingTabs`**

In the `Dashboard` component's return statement, replace the `<h2>Namespaces</h2><table>...</table><h2>Users...</h2><table>...</table>` block with:

```tsx
const [activeTab, setActiveTab] = useDashboardTab();

const tabs: MorphingTabsItem[] = [
  { id: "namespaces", label: "Namespaces", content: <NamespacesTable namespaces={namespaces} onRename={renameNamespace} onArchive={archiveNamespace} /> },
  { id: "users", label: "Users", content: <UsersTable users={users} onRevoke={revokeKey} /> },
];

// ...in the JSX, replacing the two stacked sections:
<MorphingTabs items={tabs} value={activeTab} onValueChange={(id) => id && setActiveTab(id)} ariaLabel="Dashboard sections" />
```

Add the import at the top of the file:

```tsx
import { MorphingTabs, type MorphingTabsItem } from "./components/motion/morphing-tabs";
```

`onValueChange`'s `id` is typed `string | null` (the component allows deselecting); this dashboard always has an active tab, so the `id &&` guard just satisfies that type without changing behavior — `MorphingTabs` never actually calls back with `null` here since both items are always present and neither is `disabled`.

- [ ] **Step 4: Verify types and build**

Run:
```bash
npx tsc --noEmit -p dashboard-web/tsconfig.json
npm run build:dashboard
```
Expected: zero errors. `dist/dashboard-web/tailwind.css` should now be non-trivially sized (contains the utility classes the vendored component and its Tailwind-classed JSX actually use).

- [ ] **Step 5: Commit**

```bash
git add dashboard-web/src/App.tsx
git commit -m "feat(dashboard): route Namespaces/Users sections through Morphing Tabs"
```

---

### Task 3: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `npm test`
Expected: all existing tests pass (this sub-project touches no backend code — this is a pure regression check).

- [ ] **Step 2: Manual end-to-end check against the local test database**

Start the server locally (`DATABASE_URL=postgres://recall:recall@localhost:55432/recall_test npm run dev`, migrations auto-apply on boot), seed a workspace with at least one namespace and one user with a delegate key, claim a session, and confirm: the dashboard loads with a dark tab rail showing "Namespaces" and "Users"; clicking each tab morphs the active surface across and swaps the content panel; the namespace table's rename-on-blur, Archive, and "View" link still work exactly as before; the users table's Revoke button still works; reloading the page keeps whichever tab was last selected.

- [ ] **Step 3: Self-review the full diff**

```bash
git diff main --stat
```

Read every changed/new file. Confirm: Tailwind config never leaks into the server build or `tsconfig.json`'s `include`; the vendored component's only edits are the two import-path lines; no behavior change to the namespace/user table logic beyond being relocated into tab content; bundle size increase (motion + lucide-react + Tailwind runtime CSS) is reasonable for an internal admin tool, not a public-facing page.
