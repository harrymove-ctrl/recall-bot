import { useEffect, useState } from "react";

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
    </div>
  );
}
