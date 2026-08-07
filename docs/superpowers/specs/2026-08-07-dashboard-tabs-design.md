# Dashboard Tabs — Morphing Tabs Navigation — Design

**Status:** Approved for planning
**Sub-project:** 4 of N (dashboard tabs). Extends sub-project 3 (dashboard v2 grid redesign + namespace detail, merged to `main`). Purely a navigation restyle — no data, auth, or capture-pipeline changes.

## Goal

Replace the dashboard's two stacked sections ("Namespaces" and "Users with an active delegate key") with a tabbed interface using the "Morphing Tabs" component (beui.dev — MIT licensed, vendored by hand, not installed via `shadcn add`), so the two views share screen space instead of always both rendering top-to-bottom.

## Non-goals

- No new data or endpoints — reuses the existing `GET /api/dashboard/namespaces` and `GET /api/dashboard/users` calls and their existing table markup/handlers (rename-on-blur, archive, revoke, View-link) verbatim.
- No tab reordering or closing as a real product feature. The component supports both natively (drag-to-reorder, an optional close button), but with exactly two fixed system tabs ("Namespaces", "Users") neither is meaningful: `onOrderChange` is omitted (nothing to persist), and `onClose` is omitted entirely, which is the documented way to disable the close affordance.
- No changes to the namespace detail view (`NamespaceDetail.tsx`) — it stays a separate page reached via the existing "View" link, not a third tab.
- No shadcn CLI / `components.json` setup. `npx shadcn@latest add @beui/morphing-tabs` targets a Vite/Next-shaped project with a registry config this repo doesn't have; the component + its two lib files (`lib/ease.ts`, `lib/utils.ts`) are vendored by hand instead, pulled from the registry's raw JSON (`https://beui.dev/r/morphing-tabs`).

## Design reference

Source: beui.dev "Morphing Tabs" block (https://beui.dev/components/blocks/morphing-tabs), pasted in full by the project owner. Dependencies per the registry: `clsx`, `lucide-react`, `motion`, `react`, `react-dom`, `tailwind-merge`. The component is written entirely in Tailwind utility classes with no themeable CSS-variable surface — its dark, rounded "liquid" tab rail (`bg-[#292929]`, a white content panel morphing between tab positions via SVG path animation) is the whole point of picking it, so it keeps its own built-in look rather than being reskinned to match theme.css's light/serif palette. It sits as a dark navigation control at the top of an otherwise light, hairline-divided page — a deliberate contrast, not a mismatch to fix. The two tab panels' *content* (the actual namespace/user tables) stay in theme.css's existing serif/hairline styling; only the tab chrome itself is Tailwind-styled.

## Components

1. **Tailwind build, scoped to `dashboard-web` only** — `dashboard-web/src/tailwind.css` (`@import "tailwindcss";` plus explicit `@source` globs covering `dashboard-web/src`) compiled by the standalone `@tailwindcss/cli` into `dist/dashboard-web/tailwind.css`, invoked as an extra step in `build-dashboard.mjs` alongside the existing esbuild step. `tailwindcss` and `@tailwindcss/cli` are devDependencies. The server bundle, tests, and root `tsconfig.json` build are untouched — Tailwind never enters `dist/server.js` or the Vitest run.
2. **Vendored component** (`dashboard-web/src/components/motion/morphing-tabs.tsx`, `dashboard-web/src/lib/ease.ts`, `dashboard-web/src/lib/utils.ts`) — copied verbatim from the registry's raw JSON response, with the only edit being import-path translation (`@/lib/...` → relative paths — this project has no path-alias config).
3. **New runtime dependencies** (root `package.json`, since `dashboard-web` has no `package.json` of its own — all frontend deps are hoisted from root): `motion`, `lucide-react`, `clsx`, `tailwind-merge`.
4. **`Dashboard` component rewrite** (`dashboard-web/src/App.tsx`) — the two `<h2>`/`<table>` blocks become the `content` of two `MorphingTabsItem`s (`{ id: "namespaces", label: "Namespaces", content: <NamespacesTable .../> }`, `{ id: "users", label: "Users", content: <UsersTable .../> }`), rendered through one `<MorphingTabs items={...} value={...} onValueChange={...} ariaLabel="Dashboard sections" />`. The two table blocks are extracted into their own small components (`NamespacesTable`, `UsersTable`) purely so they can be passed as `content` — same JSX, same handlers, no behavior change.
5. **Active tab persistence** — which tab is selected persists in `localStorage` (same pattern as `useGridMode`), so a reload doesn't always dump the admin back on "Namespaces".

## Data flow

None — this is a pure client-side rendering change. Both tabs' `content` render the same components that already fetch from `/api/dashboard/namespaces` and `/api/dashboard/users` on mount via the existing `Dashboard` component's `reload()`.

## Error handling

N/A — no new failure modes. The existing `unauthorized` / loading states in `Dashboard` gate rendering before the tabs are reached, same as today.

## Testing

- No dedicated frontend test suite, matching the v1 and v2 precedent for this internal admin UI (`tsc --noEmit -p dashboard-web/tsconfig.json` is the build-time check).
- Full backend suite (`npm test`) must stay green — this sub-project touches no backend code, so it's a regression check, not new coverage.
- Manual verification: `npm run build:dashboard` produces `dist/dashboard-web/tailwind.css` alongside the existing `bundle.js`/`bundle.css`; the dev server serves `/dashboard` without console errors; both tabs render their correct table content; switching tabs and reloading keeps the selected tab.

## Open items (explicitly deferred, not blocking this sub-project)

- Reduced-motion handling is inherited from the component itself (it calls `useReducedMotion` internally) — not something this sub-project needs to add.
- If a third dashboard section is ever added (e.g. future analytics), it becomes a third `MorphingTabsItem` — no structural change needed.
