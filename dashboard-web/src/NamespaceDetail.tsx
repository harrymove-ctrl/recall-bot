import { Fragment, useEffect, useState } from "react";
import { parse, NodeType, type Node as MrkdwnNode } from "slack-message-parser";
import { get as getEmoji } from "node-emoji";
import { ImageOutline, DocumentTextOutline, DocumentCodeOutline, ArchiveOutline, DocumentOutline } from "mx-icons";

interface MessageFile {
  id: string;
  originalName: string;
  mimeType: string;
  status: string;
}

interface MessageRow {
  id: string;
  slackUserId: string;
  displayName: string | null;
  avatarUrl: string | null;
  text: string;
  slackTs: string;
  walrusBlobId: string | null;
  walrusStorageStatus: string;
  walrusStoredAt: string | null;
  createdAt: string;
  files: MessageFile[];
}

interface LinearIssueRef {
  identifier: string;
  url: string;
}

interface NamespaceMessagesResponse {
  messages: MessageRow[];
  linearIssues: LinearIssueRef[];
  mentionNames: Record<string, string | null>;
}

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

const BARE_URL_RE = /(https?:\/\/[^\s<>"']+)/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"]+$/;

interface MrkdwnContext {
  linearIssues: LinearIssueRef[];
  mentionNames: Record<string, string | null>;
}

function issueBadgeOrLink(url: string, label: (string | JSX.Element)[] | string, ctx: MrkdwnContext) {
  const identifier = ctx.linearIssues.find((issue) => issue.url === url)?.identifier;
  if (identifier) {
    return (
      <a className="issue-badge issue-badge--inline" href={url} target="_blank" rel="noopener noreferrer">
        {identifier}
      </a>
    );
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}

// Slack auto-wraps URLs a user types as `<url>` before the message is ever stored, so this only
// fires for the rare message that reaches us with a plain, unbracketed URL (e.g. posted via an
// API path that skips Slack's own client-side linkification) — the parser below leaves those as
// plain Text nodes since bare-URL detection isn't part of Slack's own mrkdwn grammar.
function linkifyBareUrls(text: string, ctx: MrkdwnContext): (string | JSX.Element)[] {
  return text.split(BARE_URL_RE).map((part, i) => {
    if (i % 2 === 0) return part; // plain text — React escapes automatically, no dangerouslySetInnerHTML anywhere
    const trailingMatch = part.match(TRAILING_PUNCT_RE);
    const trailing = trailingMatch?.[0] ?? "";
    const url = trailing ? part.slice(0, -trailing.length) : part;
    return (
      <Fragment key={i}>
        {issueBadgeOrLink(url, url, ctx)}
        {trailing}
      </Fragment>
    );
  });
}

function renderMrkdwnList(nodes: MrkdwnNode[], ctx: MrkdwnContext): JSX.Element[] {
  return nodes.map((node, i) => <Fragment key={i}>{renderMrkdwnNode(node, ctx)}</Fragment>);
}

function renderMrkdwnNode(node: MrkdwnNode, ctx: MrkdwnContext): JSX.Element | string {
  switch (node.type) {
    case NodeType.Root:
      return <>{renderMrkdwnList(node.children, ctx)}</>;
    case NodeType.Text:
      return <>{linkifyBareUrls(node.text, ctx)}</>;
    case NodeType.Bold:
      return <strong>{renderMrkdwnList(node.children, ctx)}</strong>;
    case NodeType.Italic:
      return <em>{renderMrkdwnList(node.children, ctx)}</em>;
    case NodeType.Strike:
      return <del>{renderMrkdwnList(node.children, ctx)}</del>;
    case NodeType.Quote:
      return <blockquote className="mrkdwn-quote">{renderMrkdwnList(node.children, ctx)}</blockquote>;
    case NodeType.Code:
      return <code className="mrkdwn-code">{node.text}</code>;
    case NodeType.PreText:
      return (
        <pre className="mrkdwn-pre">
          <code>{node.text.replace(/^\n/, "").replace(/\n$/, "")}</code>
        </pre>
      );
    case NodeType.URL:
      return issueBadgeOrLink(node.url, node.label ? renderMrkdwnList(node.label, ctx) : node.url, ctx);
    case NodeType.UserLink: {
      const resolved = ctx.mentionNames[node.userID];
      return (
        <span className="mrkdwn-mention">@{node.label ? renderMrkdwnList(node.label, ctx) : (resolved ?? node.userID)}</span>
      );
    }
    case NodeType.ChannelLink:
      return <span className="mrkdwn-mention">#{node.label ? renderMrkdwnList(node.label, ctx) : node.channelID}</span>;
    case NodeType.Command:
      return <span className="mrkdwn-mention">@{node.label ? renderMrkdwnList(node.label, ctx) : node.name}</span>;
    case NodeType.Emoji: {
      const char = getEmoji(node.name);
      return <span title={`:${node.name}:`}>{char ?? `:${node.name}:`}</span>;
    }
  }
}

function renderMrkdwn(text: string, linearIssues: LinearIssueRef[], mentionNames: Record<string, string | null>): JSX.Element {
  return <>{renderMrkdwnList(parse(text).children, { linearIssues, mentionNames })}</>;
}

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

const FILE_TYPE_ICONS: Record<string, typeof DocumentOutline> = {
  png: ImageOutline,
  jpeg: ImageOutline,
  gif: ImageOutline,
  webp: ImageOutline,
  svg: ImageOutline,
  html: DocumentCodeOutline,
  json: DocumentCodeOutline,
  zip: ArchiveOutline,
  csv: DocumentTextOutline,
  pdf: DocumentTextOutline,
  plain: DocumentTextOutline,
};

function fileTypeIcon(mimeType: string, originalName: string): typeof DocumentOutline {
  const subtype = mimeType.split("/")[1];
  if (subtype && FILE_TYPE_ICONS[subtype]) return FILE_TYPE_ICONS[subtype];
  const ext = originalName.split(".").pop()?.toLowerCase();
  if (ext && FILE_TYPE_ICONS[ext]) return FILE_TYPE_ICONS[ext];
  return DocumentOutline;
}

function FileBadge({ file, apiBase }: { file: MessageFile; apiBase: string }) {
  const modifier = file.status === "failed" ? "file-badge--failed" : file.status === "pending" ? "file-badge--pending" : "";
  const Icon = fileTypeIcon(file.mimeType, file.originalName);
  const inner = (
    <>
      <Icon size={14} className="file-badge-icon" aria-hidden="true" />
      <span className="file-badge-type">{fileTypeTag(file.mimeType, file.originalName)}</span>
      <span className="file-badge-name">{file.originalName}</span>
      {file.status === "failed" && " · upload failed"}
    </>
  );
  if (file.status !== "stored") {
    return (
      <span className={`file-badge ${modifier}`.trim()} title={file.mimeType}>
        {inner}
      </span>
    );
  }
  return (
    <a className="file-badge" title={file.mimeType} href={`${apiBase}/files/${file.id}`} target="_blank" rel="noopener noreferrer">
      {inner}
    </a>
  );
}

function DayDivider({ label }: { label: string }) {
  return <div className="day-divider">{label}</div>;
}

export function NamespaceDetail({
  namespaceId,
  apiBase = "/api/dashboard",
  backHref = "/dashboard",
  unauthorizedMessage = "No active session — check your Slack DM for the dashboard setup link.",
}: {
  namespaceId: string;
  apiBase?: string;
  backHref?: string;
  unauthorizedMessage?: string;
}) {
  const [messages, setMessages] = useState<MessageRow[] | null>(null);
  const [linearIssues, setLinearIssues] = useState<LinearIssueRef[]>([]);
  const [mentionNames, setMentionNames] = useState<Record<string, string | null>>({});
  const [unauthorized, setUnauthorized] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetch(`${apiBase}/namespaces/${namespaceId}/messages`).then(async (res) => {
      if (res.status === 401) {
        setUnauthorized(true);
        return;
      }
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      const body: NamespaceMessagesResponse = await res.json();
      setMessages(body.messages);
      setLinearIssues(body.linearIssues);
      setMentionNames(body.mentionNames);
    });
  }, [namespaceId, apiBase]);

  if (unauthorized) return <p>{unauthorizedMessage}</p>;
  if (notFound) return <p>Namespace not found.</p>;
  if (!messages) return <p>Loading…</p>;

  return (
    <div>
      <p>
        <a href={backHref}>← Back to namespaces</a>
      </p>
      <h1>Captured thread</h1>
      {linearIssues.length > 0 && (
        <div className="linked-issues">
          {linearIssues.map((issue) => (
            <a key={issue.identifier} className="issue-badge" href={issue.url} target="_blank" rel="noopener noreferrer">
              {issue.identifier}
            </a>
          ))}
        </div>
      )}
      {messages.length === 0 && <p>No messages captured yet.</p>}
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
                    {m.text && <p className="message-row-text">{renderMrkdwn(m.text, linearIssues, mentionNames)}</p>}
                    <div className={`walrus-proof walrus-proof--${m.walrusStorageStatus}`}>
                      <span className="walrus-proof-status">Walrus: {m.walrusStorageStatus}</span>
                      {m.walrusBlobId ? (
                        <code className="walrus-proof-blob">{m.walrusBlobId}</code>
                      ) : (
                        <span className="walrus-proof-empty">No blob ID yet</span>
                      )}
                    </div>
                    {m.files.length > 0 && (
                      <div className="message-files">
                        {m.files.map((f) => (
                          <FileBadge key={f.id} file={f} apiBase={apiBase} />
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
    </div>
  );
}
