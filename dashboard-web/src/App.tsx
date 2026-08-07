import { useEffect, useState } from "react";
import { NamespaceDetail } from "./NamespaceDetail";
import { MeClaimView, PersonalDashboard, MeNamespaceDetail } from "./MePage";
import { MorphingTabs, type MorphingTabsItem } from "./components/motion/morphing-tabs";

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
  return <p>No active session — check your Slack DM for the dashboard setup link.</p>;
}

function NamespacesTable({
  namespaces,
  onRename,
  onArchive,
}: {
  namespaces: NamespaceRow[];
  onRename: (id: string, label: string) => void;
  onArchive: (id: string) => void;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Label</th>
          <th>Channel</th>
          <th>Status</th>
          <th>Created</th>
          <th>Linked issues</th>
          <th></th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {namespaces.map((n) => (
          <tr key={n.id}>
            <td>
              <input defaultValue={n.label ?? ""} placeholder={n.threadTs} onBlur={(e) => onRename(n.id, e.currentTarget.value)} />
            </td>
            <td>{n.channelId}</td>
            <td>{n.status}</td>
            <td>{new Date(n.createdAt).toLocaleDateString()}</td>
            <td>
              {n.linearIssues.map((issue) => (
                <a key={issue.identifier} className="issue-badge" href={issue.url} target="_blank" rel="noopener noreferrer">
                  {issue.identifier}
                </a>
              ))}
            </td>
            <td>
              <a href={`/dashboard/namespaces/${n.id}`}>View</a>
            </td>
            <td>{n.status !== "archived" && <button onClick={() => onArchive(n.id)}>Archive</button>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UsersTable({ users, onRevoke }: { users: UserRow[]; onRevoke: (id: string) => void }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Slack user</th>
          <th>Key issued/rotated</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {users.map((u) => (
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
            <td>{new Date(u.keyIssuedOrRotatedAt).toLocaleDateString()}</td>
            <td>
              <button onClick={() => onRevoke(u.id)}>Revoke</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AnalyticsTable({ analytics }: { analytics: AnalyticsRow[] }) {
  const maxCount = Math.max(1, ...analytics.map((a) => a.recallCount));
  if (analytics.length === 0) return <p>No recall activity yet.</p>;
  return (
    <table>
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
            <td>{a.channelId}</td>
            <td>
              <span className="analytics-bar-wrap">
                <svg className="analytics-bar" width="60" height="10" aria-hidden="true">
                  <rect width="60" height="10" className="analytics-bar-track" />
                  <rect width={(a.recallCount / maxCount) * 60} height="10" className="analytics-bar-fill" />
                </svg>
                {a.recallCount}
              </span>
            </td>
            <td>{new Date(a.lastRecalledAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

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

  const tabs: MorphingTabsItem[] = [
    {
      id: "namespaces",
      label: "Namespaces",
      content: <NamespacesTable namespaces={namespaces} onRename={renameNamespace} onArchive={archiveNamespace} />,
    },
    { id: "users", label: "Users", content: <UsersTable users={users} onRevoke={revokeKey} /> },
    { id: "analytics", label: "Analytics", content: <AnalyticsTable analytics={analytics} /> },
  ];

  return (
    <div>
      <h1>{workspace.name}</h1>
      <p>
        Slack team {workspace.slackTeamId} — installed{" "}
        {workspace.installedAt ? new Date(workspace.installedAt).toLocaleDateString() : "unknown"}
        {workspace.revoked ? " — REVOKED" : ""}
      </p>

      <MorphingTabs
        items={tabs}
        value={activeTab}
        onValueChange={(id) => id && setActiveTab(id)}
        ariaLabel="Dashboard sections"
        classNames={{ content: "tabs-panel-content" }}
      />
    </div>
  );
}

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
      {gridMode && <div className="grid-overlay" />}
      <button className="grid-toggle" onClick={toggleGridMode}>
        Grid Mode: {gridMode ? "On" : "Off"}
      </button>
      <div className="page">{view}</div>
    </>
  );
}
