# recall-bot Dashboard — Neobrutalist Redesign

## Context
Redesign the recall-bot dashboard with a neobrutalist aesthetic (Archivo Black, Space Grotesk, yellow/black, chunky borders). Applied across: landing page, dashboard, onboarding, and sign-in.

## What was done

### 1. Design System (`dashboard-web/src/theme.css`)
Pure CSS neobrutalist components — no shadcn, no extra deps:
- `.heading-xl/lg/md/sm` — Archivo Black headings
- `.nav-bar` — sticky yellow nav with black border
- `.btn-brutal` + variants (`-sm`, `-ghost`, `-yellow`) — chunky press-down buttons
- `.mcp-box` — black background, yellow MCP URL display
- `.search-brutal` — warm-cream input with search icon
- `.badge`, `.badge-yellow`, `.badge-black`, `.badge-muted`
- `.table-brutal` — thick borders, yellow active rows
- `.row-card` — hover-lift card for Memories tab
- `.tooltip-wrap[data-tooltip]` — CSS-only tooltips with arrow, fade-in
- `.skeleton` + `.skeleton-rounded` — pulsing loading placeholders
- `.accordion`, `.accordion-trigger`, `.accordion-content` — disclosure widget
- `.stat-tile` (+ variants) — metric display tiles
- `.onboarding-card`, `.checklist`, `.checklist-item` — onboarding UI
- `.step-card`, `.step-card-num` — 3-step how-it-works cards
- `.sign-in-card` — OAuth sign-in CTA with Slack logo
- `.alert` (info/success/warn/error variants) — inline callouts
- `.nb-empty` — empty state with icon, title, description
- `.kbd-brutal` — keyboard/command style badge
- `.breadcrumb` — page hierarchy navigation

### 2. Fonts (`dashboard-web/src/index.html`)
Added to Google Fonts link: Archivo Black + Space Grotesk.

### 3. Landing page (`public/index.html`)
Complete rewrite with neobrutalist design:
- Sticky yellow nav bar with Recall Bot branding + Dashboard/Add-to-Slack CTAs
- Hero with 4.5rem Archivo Black display heading
- MCP endpoint bar (black bg, yellow text, copy button)
- 4 stat tiles (Recall / Capture / Agents / Storage)
- 3-step card flow with chunky borders
- Admin callout card
- Footer with scope pills

### 4. Dashboard (`dashboard-web/src/App.tsx`)
- `Dashboard` component: breadcrumb, stat tiles row, MCP box, accordion/getting-started
- `NamespacesTable`: search bar, per-row Copy Agent / Link MD / Archive buttons, tooltip wrappers
- `MemoriesTable`: card list view, empty state, per-card actions
- `AnalyticsTable`: recall count bars
- `UsersTable`: avatar, revoke key
- `Skeleton` component (loading state with block elements)
- `StatTile` component
- `Accordion` + `AccordionItem` components
- `ChecklistItem` component
- `useCopyButton` hook for clipboard
- `useGridMode` toggle
- `NoSession` → "Sign in with Slack" card with Slack logo SVG + how-it-works steps

### 5. Personal Dashboard (`MePage.tsx`)
- Nav bar matching main dashboard
- Row cards for namespaces
- Empty state

### 6. Backend — Memories API (`src/dashboard/api.ts`)
- `GET /api/dashboard/memories` — returns all namespaces with messageCount and fileCount per namespace

### 7. Backend — Slack OAuth (`src/server.ts`)
- `GET /auth/slack` — redirects to Slack OAuth authorize URL with scopes + user_scope
- `GET /auth/slack/callback` — exchanges code for token, looks up workspace by teamId, issues `recall_user_session` cookie, redirects to `/dashboard/me`

## Files modified
| File | Change |
|------|--------|
| `dashboard-web/src/theme.css` | ~800 lines of neobrutalist CSS |
| `dashboard-web/src/index.html` | Added Archivo Black + Space Grotesk fonts |
| `dashboard-web/src/App.tsx` | Full rewrite: nav, stat tiles, tabs, tables, accordion, skeleton, NoSession OAuth |
| `dashboard-web/src/MePage.tsx` | Nav bar + row cards |
| `src/dashboard/api.ts` | `GET /api/dashboard/memories` endpoint |
| `src/server.ts` | `GET /auth/slack` + `GET /auth/slack/callback` OAuth routes |
| `public/index.html` | Full neobrutalist landing page rewrite |

## Verification
1. `npm run build` ✅ (builds clean)
2. Railway deploys ✅
3. `/` → landing page with yellow nav, hero, MCP bar, stat tiles ✅
4. `/dashboard` → no session shows "Sign in with Slack" card with Slack logo ✅
5. Clicking "Sign in with Slack" → redirects to Slack OAuth ✅
6. After OAuth → lands on `/dashboard/me` with personal session ✅
7. `/dashboard` (logged in) → workspace dashboard with stat tiles, tabs, MCP box ✅
8. Skeleton loading state shows block elements with pulse animation ✅
