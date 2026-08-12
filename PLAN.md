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
- `.sign-in-card` — OAuth sign-in CTA with Slack logo SVG
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
- `NamespacesTable`: search bar, per-row Copy Agent / Link MD / Archive buttons, tooltip wrappers, linear issue badges
- `MemoriesTable`: card list view, empty state, per-card actions
- `AnalyticsTable`: recall count bars
- `UsersTable`: avatar, revoke key
- `Skeleton` component: `<div>` based, React.CSSProperties objects (not `<span>` or style strings)
- `StatTile` component
- `Accordion` + `AccordionItem` components
- `ChecklistItem` component
- `useCopyButton` hook for clipboard
- `useGridMode` toggle
- `NoSession` → "Sign in with Slack" card with Slack logo SVG + how-it-works steps

### 5. Personal Dashboard (`MePage.tsx`)
- Nav bar matching main dashboard (brand + workspace link + logout)
- Breadcrumb and page heading
- Loading skeleton (3 placeholder rows)
- `MeNoSession`: full "Sign in with Slack" card, MCP endpoint box
- `MeClaimView`: branded error alert + loading spinner
- `PersonalNamespacesTable`: nb-empty state, row-card grid layout

### 6. Backend — Memories API (`src/dashboard/api.ts`)
- `GET /api/dashboard/memories` — returns all namespaces with messageCount and fileCount per namespace

### 7. Backend — Slack OAuth (`src/server.ts`)
- `GET /auth/slack` — redirects to Slack OAuth v2 authorize URL with bot scopes + user scopes
  - Bot scopes: `app_mentions:read,channels:history,groups:history,im:history,mpim:history,chat:write,im:write,files:read,commands,users:read`
  - User scopes (excludes bot-only): `channels:history,groups:history,im:history,mpim:history,chat:write,im:write,files:read,users:read`
- `GET /auth/slack/callback` — exchanges code via `oauth.v2.access`, calls `users.identity{}`, issues `recall_user_session` cookie, redirects to `/dashboard/me`

### 8. Walrus Memory — Data Model
- `messages.walrus_blob_id`, `walrus_blob_object_id`, `walrus_tx_digest`, `walrus_end_epoch`, `walrus_storage_status`, `walrus_stored_at`
- `files.walrus_blob_id`, `walrus_blob_object_id`, `walrus_tx_digest`, `walrus_end_epoch`, `walrus_storage_status`, `walrus_stored_at`

### 9. Walrus Memory — Storage (`src/storage/walrusMemory.ts`)
- `publishWalrusMemory()` — builds typed payload, publishes JSON
- `persistMessageToWalrus()` — publish + update DB with blob ID, tx digest, epoch, status
- `persistFileToWalrus()` — same pattern for files
- `readWalrusBlob()` — reads via WALRUS_AGGREGATOR_URL

### 10. Walrus Memory — Capture Flow
- `handleMessage()` in `src/slack/events.ts` calls `persistMessageToWalrus()`
- `captureSlackFile()` in `src/slack/files.ts` calls `persistFileToWalrus()`
- Pending if WALRUS_PUBLISHER_URL unset; failed preserved if publish errors

### 11. Walrus Memory — MCP Tools (`src/mcp/`)
- `recall()` returns `walrusBlobId`, `walrusBlobObjectId`, `walrusTxDigest`, `walrusEndEpoch`, `walrusStorageStatus`, `contentSource`, `walrusVerified`
- `list_namespaces()` for user-scoped discovery
- `memory_plan()` — formats recalled messages into implementation plan
- `memory_checklist()` — formats recalled messages into verification checklist
- `verify_blob()` — live Walrus aggregator verification
- E2E tests for `buildMemoryPlan` and `buildMemoryChecklist`: 9 cases, all passing

### 12. Walrus Memory — Dashboard Display
- Per-message Walrus proof badge (`.walrus-proof`, `.walrus-proof--stored/failed/pending`)
- Per-file Walrus proof badge
- Namespace-level `walrusStoredMessageCount` shown in namespace list
- Copy blob ID button per message/file

### 13. Walrus Memory — Backfill (`src/storage/walrusBackfill.ts`)
- `backfillWalrusMessages()` — republishes messages with null blob ID
- `backfillWalrusFiles()` — downloads from bucket, republishes files with null blob ID

### 14. Configuration (`drizzle/`, `.env.example`)
- Migration `0007` adds Walrus columns to `messages` and `files` tables
- `.env.example` documents `WALRUS_PUBLISHER_URL`, `WALRUS_AGGREGATOR_URL`, `WALRUS_EPOCHS`, `WALRUS_PERMANENT`, `WALRUS_DELETABLE`, `WALRUS_SEND_OBJECT_TO`

### 15. Linear Linking
- `namespaceLinearIssues` table maps namespaces → Linear issues
- `linearIssueUrl()` generates Linear web URLs
- API endpoints return `linearIssues[]` per namespace
- Dashboard renders `issue-badge` links in namespace list and namespace detail

## Files modified
| File | Change |
|------|--------|
| `dashboard-web/src/theme.css` | ~800 lines neobrutalist CSS |
| `dashboard-web/src/index.html` | Fonts |
| `dashboard-web/src/App.tsx` | Full rewrite: nav, stat tiles, tabs, tables, accordion, skeleton, NoSession OAuth |
| `dashboard-web/src/MePage.tsx` | Full neobrutalist: nav, breadcrumbs, skeletons, sign-in card, empty states |
| `dashboard-web/src/NamespaceDetail.tsx` | Walrus proof display, Linear issue badges |
| `src/dashboard/api.ts` | Memories endpoint, linearIssues in API |
| `src/dashboard/meApi.ts` | linearIssues in API |
| `src/server.ts` | OAuth v2 sign-in flow |
| `src/slack/events.ts` | Walrus publish on message capture |
| `src/slack/files.ts` | Walrus publish on file capture |
| `src/storage/walrusMemory.ts` | Publisher + reader adapter |
| `src/storage/walrusBackfill.ts` | Backfill jobs |
| `src/mcp/recallTool.ts` | Walrus fields in recall + plan/checklist tools |
| `src/mcp/server.ts` | All MCP tools registered |
| `public/index.html` | Full neobrutalist landing page |
| `tests/mcp/recallTool.test.ts` | 9 test cases for plan/checklist |
| `drizzle/0007_low_prima.sql` | Walrus column migrations |
| `.env.example` | Walrus env var documentation |

## Verification
- `npm run build` ✅ (builds clean)
- `npx vitest run` ✅ 42 tests passing (recallNamespace + buildMemoryPlan + buildMemoryChecklist)
- Railway deploys ✅
- `/` → landing page ✅
- `/dashboard` → "Sign in with Slack" card ✅
- `/auth/slack` → OAuth v2 with correct scopes ✅
- `client_id` present in OAuth URL ✅
- `/dashboard/me` → personal dashboard neobrutalist ✅
- Linear issue badges in namespace table ✅
- Walrus proof display in namespace detail ✅
