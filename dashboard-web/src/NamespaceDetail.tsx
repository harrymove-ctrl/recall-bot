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

interface LinearIssueRef {
  identifier: string;
  url: string;
}

interface NamespaceMessagesResponse {
  messages: MessageRow[];
  linearIssues: LinearIssueRef[];
}

export function NamespaceDetail({ namespaceId }: { namespaceId: string }) {
  const [messages, setMessages] = useState<MessageRow[] | null>(null);
  const [linearIssues, setLinearIssues] = useState<LinearIssueRef[]>([]);
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
      const body: NamespaceMessagesResponse = await res.json();
      setMessages(body.messages);
      setLinearIssues(body.linearIssues);
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
