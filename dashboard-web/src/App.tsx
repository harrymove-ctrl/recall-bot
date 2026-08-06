import { useEffect, useState } from "react";
import { NamespaceDetail } from "./NamespaceDetail";

interface WorkspaceInfo {
  name: string;
  slackTeamId: string;
  installedAt: string | null;
  revoked: boolean;
}

interface NamespaceRow {
  id: string;
  channelId: string;
  threadTs: string;
  label: string | null;
  status: string;
  createdAt: string;
}

interface UserRow {
  id: string;
  slackUserId: string;
  keyIssuedOrRotatedAt: string;
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

function Dashboard() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [namespaces, setNamespaces] = useState<NamespaceRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [unauthorized, setUnauthorized] = useState(false);

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

  return (
    <div>
      <h1>{workspace.name}</h1>
      <p>
        Slack team {workspace.slackTeamId} — installed{" "}
        {workspace.installedAt ? new Date(workspace.installedAt).toLocaleDateString() : "unknown"}
        {workspace.revoked ? " — REVOKED" : ""}
      </p>

      <h2>Namespaces</h2>
      <table>
        <thead>
          <tr>
            <th>Label</th>
            <th>Channel</th>
            <th>Status</th>
            <th>Created</th>
            <th></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {namespaces.map((n) => (
            <tr key={n.id}>
              <td>
                <input defaultValue={n.label ?? ""} placeholder={n.threadTs} onBlur={(e) => renameNamespace(n.id, e.currentTarget.value)} />
              </td>
              <td>{n.channelId}</td>
              <td>{n.status}</td>
              <td>{new Date(n.createdAt).toLocaleDateString()}</td>
              <td>
                <a href={`/dashboard/namespaces/${n.id}`}>View</a>
              </td>
              <td>{n.status !== "archived" && <button onClick={() => archiveNamespace(n.id)}>Archive</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Users with an active delegate key</h2>
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
              <td>{u.slackUserId}</td>
              <td>{new Date(u.keyIssuedOrRotatedAt).toLocaleDateString()}</td>
              <td>
                <button onClick={() => revokeKey(u.id)}>Revoke</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
  if (path === "/dashboard/claim") {
    view = <ClaimView />;
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
