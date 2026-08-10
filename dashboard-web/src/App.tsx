import { Fragment, useEffect, useState, useCallback } from "react";
import { NamespaceDetail } from "./NamespaceDetail";
import { MeClaimView, PersonalDashboard, MeNamespaceDetail } from "./MePage";
import { MorphingTabs, type MorphingTabsItem } from "./components/motion/morphing-tabs";
import { BlazeBackground } from "./components/effects/BlazeBackground";
import { FlameWrap } from "./components/effects/flame-wrap";

// ─── Shared types ───────────────────────────────────────────────

interface WorkspaceInfo {
  name: string;
  slackTeamId: string;
  installedAt: string | null;
  revoked: boolean;
}

interface LinearIssueRef {
  identifier: string;
  url: string;
}

interface NamespaceRow {
  id: string;
  channelId: string;
  threadTs: string;
  label: string | null;
  status: string;
  createdAt: string;
  linearIssues: LinearIssueRef[];
}

interface UserRow {
  id: string;
  slackUserId: string;
  displayName: string | null;
  avatarUrl: string | null;
  keyIssuedOrRotatedAt: string;
}

interface AnalyticsRow {
  namespaceId: string;
  label: string | null;
  channelId: string;
  recallCount: number;
  lastRecalledAt: string;
}

interface MemoryRow {
  id: string;
  channelId: string;
  threadTs: string;
  label: string | null;
  status: string;
  createdAt: string;
  messageCount: number;
  fileCount: number;
}

// ─── Utility: copy to clipboard ─────────────────────────────────

function useCopyButton() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  }, []);
  return { copied, copy };
}

// ─── Copy Agent snippet generator ────────────────────────────────

function buildAgentSnippet(namespaceId: string, label: string | null): string {
  const nsLabel = label ?? namespaceId;
  return `# Recall Bot — MCP Integration

## Setup
MCP endpoint: ${window.location.origin}/mcp

## Recall a thread
Use the \`recall\` MCP tool:

\`\`\`json
{
  "tool": "recall",
  "parameters": {
    "namespace_id": "${namespaceId}"
  }
}
\`\`\`

Result: all messages + files from "${nsLabel}", ready to use as agent context.`;
}

function buildLinkMd(namespaceId: string, label: string | null, origin: string): string {
  const nsLabel = label ?? namespaceId;
  return `## ${nsLabel}

Captured thread from recall-bot · [View in dashboard](${origin}/dashboard/namespaces/${namespaceId})

<!-- fetch-recall: ${namespaceId} -->`;
}

// ─── MCP Endpoint Box ────────────────────────────────────────────

function McpEndpointBox({ origin }: { origin: string }) {
  const { copied, copy } = useCopyButton();
  const mcpUrl = `${origin}/mcp`;
  return (
    <div className="mcp-box">
      <div className="mcp-box-label">MCP Endpoint</div>
      <div className="mcp-box-row">
        <code className="mcp-box-url">{mcpUrl}</code>
        <button
          type="button"
          className={`btn-copy${copied ? " btn-copy--copied" : ""}`}
          onClick={() => copy(mcpUrl)}
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
      <div className="mcp-box-hint">Use this URL to connect AI agents via the MCP protocol</div>
    </div>
  );
}

// ─── Getting Started Steps ───────────────────────────────────────

function GettingStartedSteps({ origin }: { origin: string }) {
  const mcpUrl = `${origin}/mcp`;
  const { copied, copy } = useCopyButton();
  return (
    <ol className="getting-started-steps">
      <li>
        Tag <code>@recall-bot</code> on any Slack thread you want to capture.
      </li>
      <li>
        DM the bot <code>/recall-key</code> to get your personal delegate key.
      </li>
      <li>
        Point an MCP-capable agent at <code>{mcpUrl}</code> using that key as a Bearer token.{" "}
        <button type="button" className={`btn-copy${copied ? " btn-copy--copied" : ""}`} onClick={() => copy(mcpUrl)}>
          {copied ? "Copied" : "Copy URL"}
        </button>
      </li>
    </ol>
  );
}

function GettingStartedPanel({ hasNamespaces }: { hasNamespaces: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const origin = window.location.origin;
  if (!hasNamespaces) {
    return (
      <div className="getting-started-panel">
        <h2>Get started</h2>
        <GettingStartedSteps origin={origin} />
      </div>
    );
  }
  return (
    <div className="getting-started-collapsed">
      <button type="button" className="getting-started-link" onClick={() => setExpanded((v) => !v)}>
        Getting started
      </button>
      {expanded && <GettingStartedSteps origin={origin} />}
    </div>
  );
}

// ─── Claim View ─────────────────────────────────────────────────

function ClaimView() {
  const [status, setStatus] = useState<"claiming" | "error">("claiming");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setStatus("error");
      setMessage("Missing token in the link.");
      return;
    }
    fetch("/api/dashboard/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(typeof body.error === "string" ? body.error : "claim_failed");
        }
        window.location.href = "/dashboard";
      })
      .catch((err: unknown) => {
        setStatus("error");
        setMessage(
          err instanceof Error && err.message === "invalid_or_expired_token"
            ? "This link has expired or was already used — reinstall the app or contact support."
            : "Something went wrong claiming this workspace.",
        );
      });
  }, []);

  if (status === "error") return <p>{message}</p>;
  return <p>Setting up your dashboard…</p>;
}

export function NoSession() {
  return (
    <div>
      <p>No active session — check your Slack DM for the dashboard setup link.</p>
      <p>
        Missed the DM, or need to reinstall? <a href="/">Visit the recall-bot install page</a>.
      </p>
    </div>
  );
}

// ─── NamespacesTable ────────────────────────────────────────────

function NamespacesTable({
  namespaces,
  onRename,
  onArchive,
}: {
  namespaces: NamespaceRow[];
  onRename: (id: string, label: string) => void;
  onArchive: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const { copied, copy } = useCopyButton();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const origin = window.location.origin;

  const filtered = namespaces.filter((n) => {
    const q = search.toLowerCase();
    return (
      !q ||
      (n.label ?? "").toLowerCase().includes(q) ||
      n.channelId.toLowerCase().includes(q) ||
      n.id.toLowerCase().includes(q)
    );
  });

  return (
    <div>
      <div className="search-brutal mb-4">
        <svg className="search-brutal-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          className="search-brutal-input"
          placeholder="Search namespaces…"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
      </div>
      <table className="table-brutal">
        <thead>
          <tr>
            <th>Label</th>
            <th>Channel</th>
            <th>Status</th>
            <th>Created</th>
            <th>Linked issues</th>
            <th style={{ minWidth: 180 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 ? (
            <tr>
              <td colSpan={6}>
                {search ? "No namespaces match your search." : "No threads captured yet — tag @recall-bot on a thread to get started."}
              </td>
            </tr>
          ) : (
            filtered.map((n) => (
              <tr key={n.id}>
                <td>
                  <input
                    defaultValue={n.label ?? ""}
                    placeholder={n.threadTs}
                    onBlur={(e) => onRename(n.id, e.currentTarget.value)}
                    style={{ border: "none", borderBottom: "1px solid #c5b89a", background: "transparent", font: "inherit", color: "inherit", padding: "2px 0", width: "100%" }}
                  />
                </td>
                <td className="table-cell-mono">{n.channelId}</td>
                <td>
                  <span className={`badge ${n.status === "archived" ? "badge-muted" : "badge-yellow"}`}>{n.status}</span>
                </td>
                <td className="table-cell-mono">{new Date(n.createdAt).toLocaleDateString()}</td>
                <td>
                  {n.linearIssues.map((issue) => (
                    <a key={issue.identifier} className="issue-badge" href={issue.url} target="_blank" rel="noopener noreferrer">
                      {issue.identifier}
                    </a>
                  ))}
                </td>
                <td>
                  <div className="table-cell-actions">
                    <a href={`/dashboard/namespaces/${n.id}`} className="btn-brutal btn-brutal-sm btn-brutal-ghost">
                      View
                    </a>
                    <button
                      type="button"
                      className={`btn-brutal btn-brutal-sm${copiedId === `agent-${n.id}` ? " btn-brutal-yellow" : ""}`}
                      onClick={() => {
                        const snippet = buildAgentSnippet(n.id, n.label ?? null);
                        navigator.clipboard?.writeText(snippet).catch(() => {});
                        setCopiedId(`agent-${n.id}`);
                        setTimeout(() => setCopiedId(null), 1800);
                      }}
                    >
                      {copiedId === `agent-${n.id}` ? "✓ Copied!" : "Copy Agent"}
                    </button>
                    <button
                      type="button"
                      className={`btn-brutal btn-brutal-sm${copiedId === `link-${n.id}` ? " btn-brutal-yellow" : ""}`}
                      onClick={() => {
                        const md = buildLinkMd(n.id, n.label ?? null, origin);
                        navigator.clipboard?.writeText(md).catch(() => {});
                        setCopiedId(`link-${n.id}`);
                        setTimeout(() => setCopiedId(null), 1800);
                      }}
                    >
                      {copiedId === `link-${n.id}` ? "✓ Copied!" : "Link MD"}
                    </button>
                    {n.status !== "archived" && (
                      <button type="button" className="btn-brutal btn-brutal-sm btn-brutal-ghost" onClick={() => onArchive(n.id)}>
                        Archive
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── UsersTable ─────────────────────────────────────────────────

function UsersTable({ users, onRevoke }: { users: UserRow[]; onRevoke: (id: string) => void }) {
  return (
    <table className="table-brutal">
      <thead>
        <tr>
          <th>Slack user</th>
          <th>Key issued/rotated</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {users.length === 0 ? (
          <tr>
            <td colSpan={3}>No delegate keys issued yet — run /recall-key in a DM with @recall-bot to get one.</td>
          </tr>
        ) : (
          users.map((u) => (
            <tr key={u.id}>
              <td>
                {u.avatarUrl && (
                  <img
                    className="avatar"
                    src={u.avatarUrl}
                    alt=""
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                )}
                {u.displayName ?? u.slackUserId}
              </td>
              <td className="table-cell-mono">{new Date(u.keyIssuedOrRotatedAt).toLocaleDateString()}</td>
              <td>
                <button type="button" className="btn-brutal btn-brutal-sm btn-brutal-ghost" onClick={() => onRevoke(u.id)}>
                  Revoke
                </button>
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

// ─── AnalyticsTable ─────────────────────────────────────────────

function AnalyticsTable({ analytics }: { analytics: AnalyticsRow[] }) {
  const maxCount = Math.max(1, ...analytics.map((a) => a.recallCount));
  if (analytics.length === 0) return <p>No recall activity yet.</p>;
  return (
    <table className="table-brutal">
      <thead>
        <tr>
          <th>Namespace</th>
          <th>Channel</th>
          <th>Recalls</th>
          <th>Last recalled</th>
        </tr>
      </thead>
      <tbody>
        {analytics.map((a) => (
          <tr key={a.namespaceId}>
            <td>
              <a href={`/dashboard/namespaces/${a.namespaceId}`}>{a.label ?? a.namespaceId}</a>
            </td>
            <td className="table-cell-mono">{a.channelId}</td>
            <td>
              <span className="analytics-bar-wrap">
                <svg className="analytics-bar" width="60" height="10" aria-hidden="true">
                  <rect width="60" height="10" className="analytics-bar-track" />
                  <rect width={(a.recallCount / maxCount) * 60} height="10" className="analytics-bar-fill" />
                </svg>
                {a.recallCount}
              </span>
            </td>
            <td className="table-cell-mono">{new Date(a.lastRecalledAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── MemoriesTable ───────────────────────────────────────────────

function MemoriesTable({ memories }: { memories: MemoryRow[] }) {
  const [search, setSearch] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const origin = window.location.origin;

  const filtered = memories.filter((m) => {
    const q = search.toLowerCase();
    return (
      !q ||
      (m.label ?? "").toLowerCase().includes(q) ||
      m.channelId.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q)
    );
  });

  return (
    <div>
      <div className="search-brutal mb-4">
        <svg className="search-brutal-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          className="search-brutal-input"
          placeholder="Search memories…"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">💾</div>
          {search
            ? "No memories match your search."
            : "No memories captured yet. Tag @recall-bot on a Slack thread to start."}
        </div>
      ) : (
        <div>
          {filtered.map((m) => (
            <div key={m.id} className="row-card">
              <div className="row-card-icon">💬</div>
              <div className="row-card-body">
                <div className="row-card-title">{m.label ?? m.id}</div>
                <div className="row-card-sub">
                  #{m.channelId} · {m.messageCount} message{m.messageCount !== 1 ? "s" : ""}
                  {m.fileCount > 0 && ` · ${m.fileCount} file${m.fileCount !== 1 ? "s" : ""}`}
                  {m.status === "archived" && " · archived"}
                  {" · "}
                  {new Date(m.createdAt).toLocaleDateString()}
                </div>
              </div>
              <div className="row-card-actions">
                <a href={`/dashboard/namespaces/${m.id}`} className="btn-brutal btn-brutal-sm btn-brutal-ghost">
                  View
                </a>
                <button
                  type="button"
                  className={`btn-brutal btn-brutal-sm${copiedId === `agent-${m.id}` ? " btn-brutal-yellow" : ""}`}
                  onClick={() => {
                    const snippet = buildAgentSnippet(m.id, m.label ?? null);
                    navigator.clipboard?.writeText(snippet).catch(() => {});
                    setCopiedId(`agent-${m.id}`);
                    setTimeout(() => setCopiedId(null), 1800);
                  }}
                >
                  {copiedId === `agent-${m.id}` ? "✓ Copied!" : "Copy Agent"}
                </button>
                <button
                  type="button"
                  className={`btn-brutal btn-brutal-sm${copiedId === `link-${m.id}` ? " btn-brutal-yellow" : ""}`}
                  onClick={() => {
                    const md = buildLinkMd(m.id, m.label ?? null, origin);
                    navigator.clipboard?.writeText(md).catch(() => {});
                    setCopiedId(`link-${m.id}`);
                    setTimeout(() => setCopiedId(null), 1800);
                  }}
                >
                  {copiedId === `link-${m.id}` ? "✓ Copied!" : "Link MD"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Dashboard ──────────────────────────────────────────────────

const DASHBOARD_TAB_KEY = "recall_dashboard_active_tab";

function useDashboardTab(): [string, (id: string) => void] {
  const [tab, setTab] = useState(() => localStorage.getItem(DASHBOARD_TAB_KEY) ?? "namespaces");
  const setAndPersist = (id: string) => {
    setTab(id);
    localStorage.setItem(DASHBOARD_TAB_KEY, id);
  };
  return [tab, setAndPersist];
}

function Dashboard() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [namespaces, setNamespaces] = useState<NamespaceRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsRow[]>([]);
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [unauthorized, setUnauthorized] = useState(false);
  const [activeTab, setActiveTab] = useDashboardTab();

  const reload = () => {
    fetch("/api/dashboard/me").then((res) => {
      if (res.status === 401) {
        setUnauthorized(true);
        return;
      }
      res.json().then(setWorkspace);
    });
    fetch("/api/dashboard/namespaces")
      .then((res) => (res.ok ? res.json() : []))
      .then(setNamespaces);
    fetch("/api/dashboard/users")
      .then((res) => (res.ok ? res.json() : []))
      .then(setUsers);
    fetch("/api/dashboard/analytics")
      .then((res) => (res.ok ? res.json() : []))
      .then(setAnalytics);
    fetch("/api/dashboard/memories")
      .then((res) => (res.ok ? res.json() : []))
      .then(setMemories);
  };

  useEffect(reload, []);

  if (unauthorized) return <NoSession />;
  if (!workspace) return <p>Loading…</p>;

  const renameNamespace = async (id: string, label: string) => {
    await fetch(`/api/dashboard/namespaces/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    reload();
  };

  const archiveNamespace = async (id: string) => {
    await fetch(`/api/dashboard/namespaces/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
    reload();
  };

  const revokeKey = async (id: string) => {
    await fetch(`/api/dashboard/users/${id}/revoke-key`, { method: "POST" });
    reload();
  };

  const logout = async () => {
    await fetch("/api/dashboard/logout", { method: "POST" });
    setUnauthorized(true);
  };

  const origin = window.location.origin;
  const totalMessages = memories.reduce((s, m) => s + m.messageCount, 0);
  const subtitle = [
    namespaces.length,
    `thread${namespaces.length !== 1 ? "s" : ""}`,
    users.length,
    `user${users.length !== 1 ? "s" : ""}`,
    totalMessages > 0 ? `${totalMessages} message${totalMessages !== 1 ? "s" : ""}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const tabs: MorphingTabsItem[] = [
    {
      id: "namespaces",
      label: "Threads",
      content: <NamespacesTable namespaces={namespaces} onRename={renameNamespace} onArchive={archiveNamespace} />,
    },
    {
      id: "memories",
      label: "Memories",
      content: <MemoriesTable memories={memories} />,
    },
    { id: "users", label: "Users", content: <UsersTable users={users} onRevoke={revokeKey} /> },
    { id: "analytics", label: "Analytics", content: <AnalyticsTable analytics={analytics} /> },
  ];

  return (
    <>
      {/* Nav bar */}
      <nav className="nav-bar">
        <a href="/dashboard" className="nav-bar-brand">
          <div className="nav-bar-brand-icon">R</div>
          <span className="nav-bar-brand-name">Recall Bot</span>
        </a>
        <div className="nav-bar-actions">
          <button type="button" className="btn-brutal btn-brutal-sm btn-brutal-ghost" onClick={logout}>
            Log out
          </button>
        </div>
      </nav>

      <div className="page">
        {/* Page header */}
        <h1 className="heading-xl">{workspace.name}</h1>
        <p className="subtitle">{subtitle}</p>

        {/* MCP endpoint */}
        <McpEndpointBox origin={origin} />

        {/* Getting started (collapsed) */}
        <GettingStartedPanel hasNamespaces={namespaces.length > 0} />

        {/* Tabs */}
        <FlameWrap
          color="#2e00ff"
          intensity={0.18}
          height={14}
          spread={5}
          radius={32}
          speed={0.18}
          scale={0.55}
          turbulence={0.3}
          turbulenceScale={0.8}
          turbulenceReach={20}
          sparks={0.4}
          sparkSize={1.6}
          sparkDensity={3}
          sparkSpeed={18}
          rim={0.5}
          melt={2}
          distortion={3}
        >
          <MorphingTabs
            items={tabs}
            value={activeTab}
            onValueChange={(id) => id && setActiveTab(id)}
            ariaLabel="Dashboard sections"
            classNames={{ content: "tabs-panel-content" }}
          />
        </FlameWrap>
      </div>
    </>
  );
}

// ─── Grid mode toggle ───────────────────────────────────────────

const GRID_MODE_KEY = "recall_dashboard_grid_mode";

function useGridMode(): [boolean, () => void] {
  const [enabled, setEnabled] = useState(() => {
    const stored = localStorage.getItem(GRID_MODE_KEY);
    return stored === null ? true : stored === "true";
  });
  const toggle = () => {
    setEnabled((prev) => {
      const next = !prev;
      localStorage.setItem(GRID_MODE_KEY, String(next));
      return next;
    });
  };
  return [enabled, toggle];
}

// ─── App root ───────────────────────────────────────────────────

export function App() {
  const [gridMode, toggleGridMode] = useGridMode();
  const path = window.location.pathname;

  let view: JSX.Element;
  const meNamespaceMatch = path.match(/^\/dashboard\/me\/namespaces\/([0-9a-fA-F-]+)$/);
  if (path === "/dashboard/claim") {
    view = <ClaimView />;
  } else if (path === "/dashboard/me/claim") {
    view = <MeClaimView />;
  } else if (meNamespaceMatch) {
    view = <MeNamespaceDetail namespaceId={meNamespaceMatch[1]} />;
  } else if (path === "/dashboard/me") {
    view = <PersonalDashboard />;
  } else {
    const namespaceMatch = path.match(/^\/dashboard\/namespaces\/([0-9a-fA-F-]+)$/);
    view = namespaceMatch ? <NamespaceDetail namespaceId={namespaceMatch[1]} /> : <Dashboard />;
  }

  return (
    <>
      <BlazeBackground />
      {gridMode && <div className="grid-overlay" />}
      <button className="grid-toggle" onClick={toggleGridMode}>
        Grid Mode: {gridMode ? "On" : "Off"}
      </button>
      <div className="page">{view}</div>
    </>
  );
}
