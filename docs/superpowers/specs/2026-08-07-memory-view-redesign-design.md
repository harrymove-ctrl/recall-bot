# Memory View Redesign — Captured Thread Presentation — Design

**Status:** Draft — ready for review
**Sub-project:** 7 of N (memory view redesign). Extends sub-project 3 (dashboard v2 grid redesign + namespace detail — introduced `NamespaceDetail.tsx` and its current bare-`<p>` message rendering) and consumes data already delivered by sub-project 5's Linear issue linking and Slack display-name resolution tracks (both merged to `main`: `displayName`/`avatarUrl` per message, `files[]` with `originalName`/`mimeType`, and `linearIssues[]` are all already present in the `GET /namespaces/:id/messages` response). Independent of sub-project 6 (onboarding flow, in flight) — touches only `dashboard-web/src/NamespaceDetail.tsx` and `dashboard-web/src/theme.css`, neither of which onboarding flow's plan lists as touched files.

## Goal

Redesign `NamespaceDetail.tsx` (the "Captured thread" page — internally the "memory" view: what recall-bot actually captured from a Slack thread) from a flat list of bare `<p>` tags into a page that reads like the thing it's showing: a real conversation. Messages get card/row treatment with hover state and grouping of consecutive same-author messages (Slack-style); avatars get an initials fallback when no photo is available (today's common case, since Slack avatars require a workspace reinstall that hasn't happened); plain URLs in message text get linkified, with Linear URLs specifically rendered as the same `.issue-badge` chip already shown at the top of the page; file attachments get a proper chip treatment matching that badge's shape language; and messages get day-grouped with short relative times instead of a full `toLocaleString()` on every single line.

This is a pure presentation change. No schema changes, no API changes, no new dependencies — every field this design touches (`displayName`, `avatarUrl`, `files[].originalName`, `files[].mimeType`, `files[].status`, `linearIssues[]`) is already returned by `GET /api/dashboard/namespaces/:id/messages` (see `src/dashboard/api.ts:99-153`) and already present in `NamespaceDetail.tsx`'s state today.

## Non-goals

- **No virtualization or pagination.** The endpoint returns the full message list in one shot today; this redesign renders that same full list, just better. Long-thread performance is out of scope.
- **No live-updating thread.** Still a one-shot `fetch` on mount, same as today — no polling, no websockets.
- **No moderation/editing actions.** No delete-message, no download-file, no edit. Presentation only.
- **No file preview or download.** `MessageFile` has no `url` field (only `id`, `originalName`, `mimeType`, `status`) — rendering a preview or a download link would need an API change, which is explicitly out of scope (`src/dashboard/api.ts` is not touched). File chips stay informational, non-interactive `<span>`s, same as the file `<li>`s they replace.
- **No changes to `App.tsx`'s `NamespacesTable`/`UsersTable`.** Those tables have the exact same "no avatar → nothing renders" gap this design fixes for the message thread (see `App.tsx:147-156`), but wiring the new `.avatar-initials` fallback into them is a separate, smaller follow-up outside this sub-project's scope. The new theme.css classes are written to be reusable there later without modification.
- **No dark mode / theming infrastructure.** `theme.css` has no dark-mode media query anywhere today (this is a single-palette internal admin tool); this design doesn't introduce one.
- **No new npm dependencies.** `lucide-react`, `motion`, `clsx`, `tailwind-merge` already exist in `package.json` (vendored for the Morphing Tabs sub-project) but are deliberately **not** imported here — file-type and grouping affordances stay typographic (text tags, borders, spacing), matching the rest of the page's icon-free convention (`.issue-badge`, buttons, and every other chip in the app are plain text today).

## Design reference

No external reference — this is an internal-system extension, grounded entirely in `dashboard-web/src/theme.css`'s existing tokens (`--space-1..5`, `--color-bg/surface/text/text-muted/border/accent`, `--font-serif`/`--font-sans`) and two existing precedents in that file: the `.avatar` circle (used today in `NamespaceDetail.tsx` and `App.tsx`'s Users table) and the `.issue-badge` chip (hairline border, 3px radius, 12px text, used today for the top-of-page linked-issues row).

**On the "flat, disconnected block" lesson from the tab chrome:** `morphing-tabs.tsx` got a transparency/gradient/blur pass because a flat solid dark rail read as bolted-on next to the light, hairline-divided rest of the dashboard. The lesson isn't "add gradients" — it's "don't introduce a visually disconnected surface." Applied here, that means two different things for two different elements:

1. **The message list itself stays flat, in-flow, undecorated** — no new bordered/shadowed "card panel" wrapping the thread. Wrapping it in an elevated surface would be exactly the mistake being corrected: a heavy foreign block dropped onto an otherwise plain page. Grouping and hover affordances are done with spacing, alignment, and the existing `--color-surface` hover tint (already used elsewhere, e.g. `.analytics-bar-track`) — not a new surface.
2. **The initials-avatar fallback is the one place a subtle gradient earns its keep.** It's standing in for a photograph; rendered as a single flat fill, it reads noticeably worse sitting next to real avatar photos in the same list. It gets a restrained two-stop gradient built entirely from existing tokens via `color-mix()` (`--color-surface` → a `--color-border`-tinted mix of `--color-surface`) — no new hex values, no new custom properties. `.issue-badge` and the new `.file-badge` stay exactly as flat/bordered/fill-less as their precedent — small hairline chips already read fine flat and shouldn't gain decoration for its own sake.

## Components

All changes live in two files: `dashboard-web/src/theme.css` (additive only — no existing selector's rules are modified, so `.avatar`, `.issue-badge`, and every other page that shares this stylesheet is visually unaffected) and `dashboard-web/src/NamespaceDetail.tsx` (full render rewrite, plus new pure helper functions and small subcomponents colocated in the same file, matching the existing convention of colocating small components in `App.tsx` rather than splitting into a `components/` directory).

### 1. Day grouping + consecutive-author grouping (fixes gap #1, #5)

A pure function partitions the already-sorted `messages` array (the API orders by `slackTs`; display/grouping stays keyed on `createdAt`, matching the field the page already renders today — no switch to `slackTs`) into day buckets, each containing runs of consecutive messages from the same `slackUserId`:

```typescript
interface MessageRun {
  slackUserId: string;
  displayName: string | null;
  avatarUrl: string | null;
  messages: MessageRow[];
}

interface DayGroup {
  dayKey: string;
  label: string;
  runs: MessageRun[];
}

function dayKey(d: Date): string {
  return d.toDateString();
}

function formatDayLabel(d: Date): string {
  const now = new Date();
  if (dayKey(d) === dayKey(now)) return "Today";
  if (dayKey(d) === dayKey(new Date(now.getTime() - 86_400_000))) return "Yesterday";
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

function groupMessagesByDay(messages: MessageRow[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const m of messages) {
    const d = new Date(m.createdAt);
    const key = dayKey(d);
    let group = groups.at(-1)?.dayKey === key ? groups.at(-1) : undefined;
    if (!group) {
      group = { dayKey: key, label: formatDayLabel(d), runs: [] };
      groups.push(group);
    }
    const lastRun = group.runs.at(-1);
    if (lastRun && lastRun.slackUserId === m.slackUserId) {
      lastRun.messages.push(m);
    } else {
      group.runs.push({ slackUserId: m.slackUserId, displayName: m.displayName, avatarUrl: m.avatarUrl, messages: [m] });
    }
  }
  return groups;
}
```

Rendering: a `<DayDivider label={group.label} />` (hairline rule either side of a centered muted label, `.day-divider`) precedes each day's runs; each run renders as one `.message-group` (avatar shown once, at the top).

### 2. Avatar with initials fallback (fixes gap #2)

An `Avatar` subcomponent replaces the raw `<img onError={hide}>`:

```tsx
function initialsFor(displayName: string | null, slackUserId: string): string {
  const name = displayName?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
  }
  return slackUserId.replace(/^U/, "").slice(0, 2).toUpperCase();
}

function Avatar({ displayName, avatarUrl, slackUserId }: { displayName: string | null; avatarUrl: string | null; slackUserId: string }) {
  const [failed, setFailed] = useState(false);
  if (avatarUrl && !failed) {
    return <img className="avatar" src={avatarUrl} alt="" onError={() => setFailed(true)} />;
  }
  return (
    <span className="avatar-initials" aria-hidden="true">
      {initialsFor(displayName, slackUserId)}
    </span>
  );
}
```

Behavior change from today: a broken image URL used to just disappear (`display: none`), leaving nothing; now it falls back to the same initials circle a missing `avatarUrl` gets. `.avatar-initials` matches `.avatar`'s exact box geometry (`--space-4` diameter, 1px `--color-border` border, `--space-1` right margin) so avatar and initials-fallback are interchangeable in the layout — see Design reference for its gradient fill.

### 3. Linkified message text, with Linear URLs rendered as the existing chip (fixes gap #3)

```typescript
const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"]+$/;

function linkifyText(text: string, linearIssues: LinearIssueRef[]): (string | JSX.Element)[] {
  const issueByUrl = new Map(linearIssues.map((i) => [i.url, i.identifier]));
  return text.split(URL_RE).map((part, i) => {
    if (i % 2 === 0) return part; // plain text — React escapes automatically, no dangerouslySetInnerHTML anywhere
    const trailingMatch = part.match(TRAILING_PUNCT_RE);
    const trailing = trailingMatch?.[0] ?? "";
    const url = trailing ? part.slice(0, -trailing.length) : part;
    const identifier = issueByUrl.get(url);
    const link = identifier ? (
      <a key={i} className="issue-badge issue-badge--inline" href={url} target="_blank" rel="noopener noreferrer">
        {identifier}
      </a>
    ) : (
      <a key={i} href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>
    );
    return trailing ? <>{link}{trailing}</> : link;
  });
}
```

`String.prototype.split` with a capturing-group regex interleaves the captures at odd indices — no manual `regex.exec` loop, no HTML string building. Every piece of Slack-authored text either stays a plain string (React escapes it as a text node) or becomes an explicit `<a>` element with `href` set to the literal matched substring. `dangerouslySetInnerHTML` is never used anywhere in this component.

Trailing-punctuation stripping (`https://example.com/foo.` → link is `https://example.com/foo`, `.` stays as trailing plain text) handles the common case of a URL sitting at the end of a sentence.

When the matched URL exactly equals one of the namespace's already-fetched `linearIssues[].url`, it renders as `.issue-badge` (same chip as the top-of-page row) showing the identifier instead of the raw URL — directly addressing the gap: the page already has this exact badge for this exact issue, it's just not applied inline. `.issue-badge--inline` is a small margin/baseline modifier so the chip sits cleanly inside a paragraph of running text instead of the chip-row spacing `.issue-badge` was designed for.

### 4. File attachment chips (fixes gap #4)

```tsx
const MIME_TAGS: Record<string, string> = {
  png: "PNG", jpeg: "JPG", gif: "GIF", webp: "WEBP", svg: "SVG",
  pdf: "PDF", zip: "ZIP", json: "JSON", csv: "CSV", plain: "TXT",
};

function fileTypeTag(mimeType: string, originalName: string): string {
  const subtype = mimeType.split("/")[1];
  if (subtype && MIME_TAGS[subtype]) return MIME_TAGS[subtype];
  const ext = originalName.split(".").pop();
  if (ext && ext.length <= 4 && ext !== originalName) return ext.toUpperCase();
  return "FILE";
}

function FileBadge({ file }: { file: MessageFile }) {
  const modifier = file.status === "failed" ? "file-badge--failed" : file.status === "pending" ? "file-badge--pending" : "";
  return (
    <span className={`file-badge ${modifier}`.trim()} title={file.mimeType}>
      <span className="file-badge-type">{fileTypeTag(file.mimeType, file.originalName)}</span>
      <span className="file-badge-name">{file.originalName}</span>
      {file.status === "failed" && " · upload failed"}
    </span>
  );
}
```

`.file-badge` deliberately reuses `.issue-badge`'s exact shape language (border, radius, padding, font-size) so the two chip families read as the same system, but stays in `--color-text` (not `--color-accent`) since files aren't links — that color difference alone is enough to distinguish "this is clickable" from "this is informational" without needing an icon. `file.status` (already returned by the API, currently rendered nowhere) gets a light touch: `pending`/`failed` get a dashed border instead of solid (an existing-token styling change, not a new color — this codebase has no error/danger color anywhere; even `workspace.revoked` in `App.tsx` renders as plain uncolored text), and `failed` additionally strikes through the filename. `stored` (the common case) renders as the plain solid chip.

### 5. Grouped-row markup and CSS

```tsx
{groupMessagesByDay(messages).map((group) => (
  <div key={group.dayKey}>
    <DayDivider label={group.label} />
    {group.runs.map((run, i) => (
      <div className="message-group" key={`${group.dayKey}-${i}`}>
        <div className="message-group-avatar-col">
          <Avatar displayName={run.displayName} avatarUrl={run.avatarUrl} slackUserId={run.slackUserId} />
        </div>
        <div className="message-group-body">
          {run.messages.map((m, j) => (
            <div className="message-row" key={m.id} title={new Date(m.createdAt).toLocaleString()}>
              {j === 0 && (
                <div className="message-group-header">
                  <span className="message-author">{run.displayName ?? run.slackUserId}</span>
                  <time className="message-time" dateTime={m.createdAt}>
                    {new Date(m.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                  </time>
                </div>
              )}
              {m.text && <p className="message-row-text">{linkifyText(m.text, linearIssues)}</p>}
              {m.files.length > 0 && (
                <div className="message-files">
                  {m.files.map((f) => <FileBadge key={f.id} file={f} />)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    ))}
  </div>
))}
```

New/extended `theme.css` rules (additive — `.message`/`.message-meta`, exclusively consumed by this page today, are removed once this rewrite lands; every other class in the file is left untouched):

```css
.day-divider {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-4) 0 var(--space-2);
  color: var(--color-text-muted);
  font-size: 12px;
}
.day-divider::before,
.day-divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--color-border);
}
.day-divider:first-child { margin-top: 0; }

.message-group {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2);
  margin: 0 calc(-1 * var(--space-2));
  border-radius: 4px;
}
.message-group:hover { background: var(--color-surface); }
.message-group-avatar-col { flex-shrink: 0; }
.message-group-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--space-1); }
.message-group-header { display: flex; align-items: baseline; gap: var(--space-2); }
.message-author { font-weight: 500; color: var(--color-text); }
.message-time { font-size: 12px; color: var(--color-text-muted); }
.message-row-text { margin: 0; overflow-wrap: anywhere; }

.avatar-initials {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--space-4);
  height: var(--space-4);
  border-radius: 50%;
  border: 1px solid var(--color-border);
  vertical-align: middle;
  margin-right: var(--space-1);
  background: linear-gradient(160deg, var(--color-surface), color-mix(in srgb, var(--color-border) 35%, var(--color-surface)));
  color: var(--color-text-muted);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  text-transform: uppercase;
}

.message-files { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-top: var(--space-1); }
.file-badge {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 12px;
  color: var(--color-text);
}
.file-badge-type { color: var(--color-text-muted); font-size: 10px; font-weight: 600; letter-spacing: 0.02em; }
.file-badge--pending,
.file-badge--failed { border-style: dashed; }
.file-badge--failed .file-badge-name { text-decoration: line-through; }

.issue-badge--inline { margin: 0 2px; vertical-align: -1px; }
```

`overflow-wrap: anywhere` on `.message-row-text` covers both plain text and the rendered `<a>` — a long unbroken URL wraps inside the page instead of forcing horizontal scroll (the page has no `overflow-x` guard today, so this matters more once URLs are live links people might paste huge ones into).

## Data flow

None — pure client-side rendering change, same precedent as the dashboard-tabs sub-project. `NamespaceDetail.tsx` still does exactly one `fetch("/api/dashboard/namespaces/:id/messages")` on mount and renders from the response already in state; `linearIssues` (already fetched) is now also threaded into `linkifyText` as a second consumer of that same state, not a second fetch.

## Error handling

No new failure modes beyond what exists today. The `unauthorized` / `notFound` / loading gates (`NoSession`, "Namespace not found.", "Loading…") are unchanged and still run before any of this rendering is reached.

Two behavior changes, both called out because they're deliberate improvements, not regressions: (1) a broken/expired `avatarUrl` (image `onError`) now falls back to the initials circle instead of silently rendering nothing, matching the no-`avatarUrl` case; (2) the message paragraph is now guarded by `m.text &&` before rendering — the pre-diff code rendered `<p>{m.text}</p>` unconditionally with no guard, so this is new, not preserved, and skips an empty `<p>` for file-only messages with empty text. Every other piece of data this design touches (`displayName`, `files`, `linearIssues`) is already nullable/optional-safe in the current code and stays exactly as defensive (`m.displayName ?? m.slackUserId`, `m.files.length > 0 &&` guard, empty-thread `"No messages captured yet."` message all preserved).

## Testing

- No dedicated frontend test suite for this internal admin UI, matching the v1/v2/dashboard-tabs precedent — `npx tsc --noEmit -p dashboard-web/tsconfig.json` is the build-time check.
- Full backend suite (`npm test`) must stay green — this sub-project touches no backend code (`src/dashboard/api.ts`, `src/db/schema.ts` are both untouched), so it's a regression check, not new coverage.
- Manual verification against a seeded thread with: messages from 2+ different Slack users across 2+ different days, at least one user with no `avatarUrl`, at least one message containing a bare Linear issue URL matching a `linearIssues[]` entry, at least one message containing a generic `https://` URL, at least one very long unbroken URL, and files in each of the `pending`/`stored`/`failed` statuses. Confirm: day dividers show "Today"/"Yesterday"/full-date correctly; consecutive same-author messages group under one avatar without repeating name/time; missing and broken avatars both show the initials circle; the Linear URL in text renders as the same badge shown at the top of the page; the generic URL is a working new-tab link; the long URL wraps without horizontal scroll; file chips show a type tag + filename, with `pending`/`failed` visibly dashed and `failed` struck through; hovering a message row shows the exact timestamp via native tooltip; the empty-thread state still renders.

## Open items (explicitly deferred, not blocking this sub-project)

- Wiring `.avatar-initials` into `App.tsx`'s `NamespacesTable`/`UsersTable` (same missing-avatar gap exists there) — separate follow-up, not touched here.
- File preview/download needs `files[].url` from the API, which is out of scope (no API changes in this sub-project).
- No automated visual regression coverage for this page (matches existing project-wide gap — no frontend test suite at all today).
- The 5-minute-style "still counts as the same message group even across a gap" threshold some chat UIs use is not implemented — grouping here is purely "same author, same calendar day, consecutive in the sorted list." If that ever reads wrong in practice (e.g., the same person posting twice, an hour apart, with nothing in between), a time-gap cutoff can be added to `groupMessagesByDay` later without touching anything else in this design.
