# Memory View Redesign (Captured Thread Presentation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `dashboard-web/src/NamespaceDetail.tsx`'s captured-thread rendering — grouped messages with hover state, initials-fallback avatars, linkified message text (with Linear URLs rendered as the existing `.issue-badge` chip), file-attachment chips matching that same shape language, and day/time grouping — using only data the API already returns and only tokens `theme.css` already defines.

**Architecture:** Additive `theme.css` rules first (new classes only — every existing selector's rules stay byte-for-byte unchanged so other consumers of `.avatar`/`.issue-badge` are unaffected), then a full render rewrite of `NamespaceDetail.tsx` behind new pure helper functions and small colocated subcomponents, then cleanup of the two classes (`.message`, `.message-meta`) that become dead once the rewrite lands.

**Tech Stack:** Existing stack only (React 19, esbuild, TypeScript). No new dependencies — `lucide-react`/`motion`/`clsx`/`tailwind-merge` already in `package.json` from the Morphing Tabs sub-project are deliberately not imported here (see design doc's Non-goals).

## Global Constraints

- Do not touch `src/dashboard/api.ts` or `src/db/schema.ts` — every field this plan renders is already returned by `GET /api/dashboard/namespaces/:id/messages`.
- `theme.css` changes are additive only. Do not modify the existing rules for `.avatar`, `.issue-badge`, `.linked-issues`, `.page`, or any other selector consumed outside `NamespaceDetail.tsx` (`.avatar` and `.issue-badge` are also used by `App.tsx`). Only `.message`/`.message-meta` (exclusively consumed by this page) get removed, and only in Task 2 once nothing references them anymore.
- No `dangerouslySetInnerHTML`, no raw HTML string concatenation, anywhere. URL linkification builds React child arrays only (`String.split` with a capturing-group regex, plain-text segments stay strings).
- No new npm dependencies, no new `package.json` edits.
- ESM, extensionless imports, matching the rest of `dashboard-web`.
- Before committing each task, run `npx tsc --noEmit -p dashboard-web/tsconfig.json` and `npm run build:dashboard`. Run `npm test` once at the end (Task 3) to confirm no backend regression — this plan touches no backend code.

---

## File Structure

```
recall-bot/
  dashboard-web/
    src/
      theme.css                 # MODIFY — add day-divider/message-group/avatar-initials/file-badge rules (Task 1); remove dead .message/.message-meta rules (Task 2 cleanup step)
      NamespaceDetail.tsx       # MODIFY — full render rewrite: grouping/formatting helpers, Avatar/DayDivider/FileBadge subcomponents, new JSX (Task 2)
```

---

### Task 1: Add the new presentation styles to `theme.css`

**Files:**
- Modify: `dashboard-web/src/theme.css`

**Interfaces:**
- Consumes: nothing new — pure CSS additions referencing existing custom properties (`--space-1..5`, `--color-*`).
- Produces: `.day-divider`, `.message-group` (+ `-avatar-col`, `-body`, `-header`), `.message-author`, `.message-time`, `.message-row-text`, `.avatar-initials`, `.message-files`, `.file-badge` (+ `-type`, `-name`, `--pending`, `--failed`), `.issue-badge--inline` — all new class names. Task 2 consumes every one of these from `NamespaceDetail.tsx`.

- [ ] **Step 1: Add day-divider rules**

Append to `dashboard-web/src/theme.css` (anywhere after the existing `.linked-issues` block is a natural spot, keeping message-related rules grouped together):

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
.day-divider:first-child {
  margin-top: 0;
}
```

- [ ] **Step 2: Add message-group layout rules**

```css
.message-group {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2);
  margin: 0 calc(-1 * var(--space-2));
  border-radius: 4px;
}
.message-group:hover {
  background: var(--color-surface);
}
.message-group-avatar-col {
  flex-shrink: 0;
}
.message-group-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.message-group-header {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.message-author {
  font-weight: 500;
  color: var(--color-text);
}
.message-time {
  font-size: 12px;
  color: var(--color-text-muted);
}
.message-row-text {
  margin: 0;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 3: Add the initials-avatar fallback rules**

```css
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
```

Note: this duplicates `.avatar`'s box geometry (size/border/radius/margin) rather than sharing a selector with it — deliberate, so `.avatar`'s existing rule is never touched and every other consumer of `.avatar` (`App.tsx`'s Users table) is guaranteed unaffected.

- [ ] **Step 4: Add file-badge rules**

```css
.message-files {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-1);
}
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
.file-badge-type {
  color: var(--color-text-muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.file-badge--pending,
.file-badge--failed {
  border-style: dashed;
}
.file-badge--failed .file-badge-name {
  text-decoration: line-through;
}
```

- [ ] **Step 5: Add the inline issue-badge modifier**

```css
.issue-badge--inline {
  margin: 0 2px;
  vertical-align: -1px;
}
```

- [ ] **Step 6: Verify — no visual change yet**

Run:
```bash
npx tsc --noEmit -p dashboard-web/tsconfig.json
npm run build:dashboard
```
Expected: both succeed. Load `/dashboard/namespaces/:id` in a browser (or just read the diff) and confirm the page is visually unchanged — every class added in this task is unused until Task 2 wires them in. This is a regression guard, not a feature step.

- [ ] **Step 7: Commit**

```bash
git add dashboard-web/src/theme.css
git commit -m "feat(dashboard): add memory-view presentation styles to theme.css"
```

---

### Task 2: Rewrite `NamespaceDetail.tsx`'s rendering

**Files:**
- Modify: `dashboard-web/src/NamespaceDetail.tsx`
- Modify: `dashboard-web/src/theme.css` (cleanup step only)

**Interfaces:**
- Consumes: every class added in Task 1; the existing `MessageRow`/`LinearIssueRef`/`NamespaceMessagesResponse` interfaces and `fetch` logic already in the file (unchanged).
- Produces: no new exports — `NamespaceDetail` is still the only export `App.tsx` consumes, its signature (`{ namespaceId }: { namespaceId: string }`) unchanged.

- [ ] **Step 1: Add the day/run grouping helper**

Add above the `NamespaceDetail` function:

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

Grouping is keyed on `createdAt` (the field the page already displays today), not `slackTs` (used only for API-side ordering) — no behavior switch there, just formatting.

- [ ] **Step 2: Add the `Avatar` subcomponent with initials fallback**

```tsx
function initialsFor(displayName: string | null, slackUserId: string): string {
  const name = displayName?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
  }
  return slackUserId.replace(/^U/, "").slice(0, 2).toUpperCase();
}

function Avatar({
  displayName,
  avatarUrl,
  slackUserId,
}: {
  displayName: string | null;
  avatarUrl: string | null;
  slackUserId: string;
}) {
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

- [ ] **Step 3: Add the `linkifyText` helper**

```typescript
const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"]+$/;

function linkifyText(text: string, linearIssues: LinearIssueRef[]): (string | JSX.Element)[] {
  const issueByUrl = new Map(linearIssues.map((i) => [i.url, i.identifier]));
  return text.split(URL_RE).map((part, i) => {
    if (i % 2 === 0) return part;
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
    return trailing ? (
      <span key={i}>
        {link}
        {trailing}
      </span>
    ) : (
      link
    );
  });
}
```

Verify manually while writing this step: `text.split(URL_RE)` with a capturing-group regex returns matched URLs at odd indices — even indices are always plain, un-linked text. No `dangerouslySetInnerHTML`, no HTML string building anywhere in this function.

- [ ] **Step 4: Add the `FileBadge` subcomponent**

```tsx
const MIME_TAGS: Record<string, string> = {
  png: "PNG",
  jpeg: "JPG",
  gif: "GIF",
  webp: "WEBP",
  svg: "SVG",
  pdf: "PDF",
  zip: "ZIP",
  json: "JSON",
  csv: "CSV",
  plain: "TXT",
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

- [ ] **Step 5: Add the `DayDivider` subcomponent**

```tsx
function DayDivider({ label }: { label: string }) {
  return <div className="day-divider">{label}</div>;
}
```

- [ ] **Step 6: Replace the render body**

Replace the current `{messages.map((m) => ...)}` block (the whole `.message` div loop) with:

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
                  {m.files.map((f) => (
                    <FileBadge key={f.id} file={f} />
                  ))}
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

Leave everything above it (`← Back to namespaces`, `<h1>Captured thread</h1>`, the top `.linked-issues` badge row, the `unauthorized`/`notFound`/loading/empty-thread early returns) exactly as-is — none of those are in scope.

- [ ] **Step 7: Cleanup — remove the now-dead `.message`/`.message-meta` rules**

In `dashboard-web/src/theme.css`, delete the `.message` and `.message-meta` rule blocks (confirm first with `grep -rn "className=\"message\"\|message-meta" dashboard-web/src` that `NamespaceDetail.tsx`'s rewritten JSX — the only consumer — no longer references either class name).

- [ ] **Step 8: Verify types and build**

```bash
npx tsc --noEmit -p dashboard-web/tsconfig.json
npm run build:dashboard
```
Expected: zero errors.

- [ ] **Step 9: Commit**

```bash
git add dashboard-web/src/NamespaceDetail.tsx dashboard-web/src/theme.css
git commit -m "feat(dashboard): redesign captured-thread view with grouped messages, avatar fallbacks, linkified text, and file chips"
```

---

### Task 3: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `npm test`
Expected: all existing tests pass — this plan touches no backend code, so this is a pure regression check. (`npm test` TRUNCATEs the shared local Postgres test DB — reseed afterward if a manual visual check is still needed.)

- [ ] **Step 2: Manual end-to-end check against the local test database**

Start the server locally against `postgres://recall:recall@localhost:55432/recall_test` (migrations auto-apply on boot), seed or reuse a namespace whose captured thread has: messages from at least 2 different Slack users spanning at least 2 different days; at least one user with no `avatarUrl` and, if feasible, one with a deliberately broken `avatarUrl` to exercise the `onError` fallback path; at least one message containing a bare URL matching one of the namespace's linked Linear issues; at least one message containing a generic `https://` URL; one message with a very long unbroken URL; and files across the `pending`/`stored`/`failed` statuses. Load `/dashboard/namespaces/:id` and confirm:
- Day dividers read "Today" / "Yesterday" / a full weekday-month-day (plus year only if not the current year) correctly.
- Consecutive messages from the same author in the same day group under a single avatar, with name/time shown only once at the top of the group.
- Hovering a message group shows the `--color-surface` background tint; hovering an individual message row's title tooltip shows the exact original timestamp.
- Both the no-avatar and broken-avatar cases render the same gradient-filled initials circle; a working `avatarUrl` still renders the photo.
- The message text containing a linked-issue URL renders as the same `.issue-badge` chip shown in the top-of-page row (same identifier, same style), not a raw link.
- The generic URL renders as a normal working link that opens in a new tab.
- The long URL wraps inside the page — no horizontal scrollbar appears.
- File chips show a type tag + filename; `pending`/`failed` files show a dashed border, and `failed` additionally shows the filename struck through plus the "upload failed" suffix.
- The empty-thread ("No messages captured yet.") and `unauthorized`/`notFound` states are all unchanged.
- `App.tsx`'s Namespaces/Users/Analytics tabs and the top-of-page linked-issues badges are visually unchanged (confirms `.avatar`/`.issue-badge`'s base rules weren't touched).

- [ ] **Step 3: Self-review the full diff**

```bash
git diff main --stat
```
Read every changed file. Confirm: `src/dashboard/api.ts` and `src/db/schema.ts` have zero diff; `theme.css`'s only removed rules are `.message`/`.message-meta`, every other existing rule is untouched; no `dangerouslySetInnerHTML` or raw HTML string concatenation anywhere in `NamespaceDetail.tsx`; no new `package.json` dependency.
