# Recall-Bot Dashboard Redesign — Plan

## Context

The recall-bot admin dashboard at `https://recall-bot-production-105d.up.railway.app/` serves two audiences:
- **Workspace admins** — manage all users, all namespaces, see analytics
- **Personal users** — manage their own captured threads

Current issues:
1. Headings use `Georgia` serif font — feels dated, weak hierarchy
2. No context headers for each tab/section
3. Users can't see MCP tool endpoint or how to integrate agents
4. No blobId visibility for stored files
5. No per-namespace actions (copy agent snippet, link MD, search)

**Goal:** Matching neobrutalist design (Archivo Black + Space Grotesk, yellow/black, chunky borders) while reusing existing `MorphingTabs`, API, and theme infrastructure.

---

## Design Reference

Font stack (already configured in dashboard's `tailwind.css`):
- Heading: `Archivo Black` (from `mx-icons` vendor, already in `public/`)
- Body: `Space Grotesk` (from Google Fonts CDN)
- Code/mono: `Geist Mono`

Theme tokens:
```css
--color-bg: #ffffff
--color-surface: #fafafa
--color-text: #111111
--color-text-muted: #666666
--color-border: #dddddd
--color-accent: #2563eb
```
New accent color: `#ffdc58` (yellow), black borders `2px solid #000000`.

---

## Changes

### 1. New CSS styles — `dashboard-web/src/theme.css`

Add neobrutalist tokens and classes at the end of the file.

**New CSS variables:**
```css
--font-head: 'Archivo Black', sans-serif;
--font-sans: 'Space Grotesk', sans-serif;
--color-accent-yellow: #ffdc58;
--color-accent-yellow-hover: #ffd12e;
--shadow-brutal: 3px 3px 0 #000000;
--shadow-brutal-sm: 2px 2px 0 #000000;
```

**New classes:**
- `.heading-xl` — Archivo Black, ~3rem, line-height 0.9
- `.heading-lg` — Archivo Black, ~2rem, line-height 0.95
- `.heading-md` — Archivo Black, ~1.5rem
- `.nav-accent-bar` — top bar in `#ffdc58`
- `.btn-brutal` — black border, black bg, yellow text, chunky shadow on hover
- `.btn-brutal-ghost` — outline style
- `.card-brutal` — white bg, 2px black border, shadow on hover
- `.tab-brutal` — pill style, yellow active state
- `.input-brutal` — black border, no rounded corners
- `.badge-yellow` — inline yellow pill

### 2. Header redesign — `App.tsx` `Dashboard` component

Replace current `<h1>` + `<p>` header with:
```
┌─────────────────────────────────────────────────────┐
│ [RECALL]                              [Grid] [Logout] │  ← nav bar, yellow accent
├─────────────────────────────────────────────────────┤
│                                                       │
│  Your Recall Workspace                    ← h1 Archivo Black
│  8 threads · 3 users · last active 2h ago            ← subtitle
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │ MCP Endpoint: recall-bot.up.railway.app/mcp  [Copy] │  ← NEW
│  └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

- Import Google Fonts via `<link>` in `index.html` (Archivo Black + Space Grotesk)
- Nav bar: solid black top bar with workspace name left, logout right
- Yellow accent underline on the logo
- MCP endpoint box — always visible, with one-click copy (matches existing copy pattern in `GettingStartedSteps`)

### 3. New "Memories" tab — extend `MorphingTabs` in `Dashboard`

Add a **4th tab** called "Memories" to the existing tabs array:

```tsx
{ id: 'memories', label: 'Memories', content: <MemoriesPanel /> }
```

**`MemoriesPanel` component** (inline in `App.tsx`):

Shows all messages across namespaces with:
- Search bar (filters by text, namespace label, channel)
- Table columns: **Text preview** | **Namespace** | **Channel** | **Blob ID** | **Actions**
- Blob ID column shows file storage keys (from DB `files.bucketKey`)
- Copy blobId button (matches `GettingStartedSteps` copy pattern)
- "Copy Agent" per-namespace button → generates MCP `recall` tool call snippet
- "Link MD" per-namespace button → generates markdown embed

**Data source:** Fetch `/api/dashboard/namespaces` (already returns namespace list), then for each namespace fetch `/api/dashboard/namespaces/:id/messages`. In production this should be a single aggregated endpoint — add a new one:

**New API endpoint** `GET /api/dashboard/memories` in `src/dashboard/api.ts`:
```ts
// Returns all messages across all namespaces with file blobIds
// Aggregated in one query to avoid N+1
router.get("/memories", auth, async (req, res) => {
  const rows = await db.select({
    namespaceId: namespaces.id,
    namespaceLabel: namespaces.label,
    channelId: namespaces.channelId,
    messageId: messages.id,
    messageText: messages.text,
    messageCreatedAt: messages.createdAt,
    fileId: files.id,
    fileBucketKey: files.bucketKey,
    fileOriginalName: files.originalName,
  })
  .from(namespaces)
  .leftJoin(messages, eq(messages.namespaceId, namespaces.id))
  .leftJoin(files, eq(files.messageId, messages.id))
  .where(eq(namespaces.workspaceId, req.workspaceId!))
  // ... returns flat list, frontend groups by namespace
})
```

### 4. Copy Agent snippet generation

For each namespace, generate this when user clicks "Copy Agent":

```md
# Recall Bot — MCP Integration

## Setup
Your MCP endpoint: `https://recall-bot-production-105d.up.railway.app/mcp`
Your workspace token: `<user's session cookie>` (auto-handled by browser)

## Recall a namespace
Use the `recall` MCP tool:
- tool: `recall`
- namespace_id: `<namespace UUID>`

Result: all messages + files in that namespace, ready to use as context.
```

### 5. Namespace list enhancement — NamespacesTable

Add to each row:
- Search/filter input above table
- Copy Agent button (per row)
- Link MD button (per row)
- Blob ID indicator if namespace has stored files

### 6. Personal dashboard (`MePage.tsx`)

Apply same heading treatment to `PersonalDashboard` and `MeNamespaceDetail`:
- Import new fonts
- Replace `<h1>` with `.heading-xl`
- Add MCP endpoint copy box (personal MCP URL differs)

---

## Files to modify

| File | Change |
|------|--------|
| `dashboard-web/src/index.html` | Add Google Fonts `<link>` for Archivo Black + Space Grotesk |
| `dashboard-web/src/theme.css` | Add neobrutalist CSS tokens and utility classes |
| `dashboard-web/src/App.tsx` | New header, new Memories tab, enhanced NamespacesTable, copy-agent logic |
| `src/dashboard/api.ts` | New `GET /api/dashboard/memories` endpoint |
| `dashboard-web/src/MePage.tsx` | Apply same heading/font treatment |

## Verification

1. `npm run build` succeeds
2. Railway deploys successfully (`railway up`)
3. Dashboard loads at `/dashboard` with new header + tabs
4. Memories tab shows messages with blobIds
5. Copy Agent / Link MD buttons work per-namespace
6. Search filters work in Memories and Namespaces tabs
