import { useEffect, useState } from "react";
import { NamespaceDetail } from "./NamespaceDetail";

interface PersonalNamespaceRow {
  id: string;
  channelId: string;
  threadTs: string;
  label: string | null;
  status: string;
  createdAt: string;
}

interface PersonalIdentity {
  slackUserId: string;
  displayName: string | null;
}

const PERSONAL_NO_SESSION_MESSAGE = "No active session — run /recall-key in Slack and use the link it DMs you.";

export function MeClaimView() {
  const [status, setStatus] = useState<"claiming" | "error">("claiming");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setStatus("error");
      setMessage("Missing token in the link.");
      return;
    }
    fetch("/api/me/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(typeof body.error === "string" ? body.error : "claim_failed");
        }
        window.location.href = "/dashboard/me";
      })
      .catch((err: unknown) => {
        setStatus("error");
        setMessage(
          err instanceof Error && err.message === "invalid_or_expired_token"
            ? "This link has expired or was already used — run /recall-key in Slack again for a fresh one."
            : "Something went wrong logging you in.",
        );
      });
  }, []);

  if (status === "error") return <p>{message}</p>;
  return <p>Logging you in…</p>;
}

function MeNoSession() {
  return <p>{PERSONAL_NO_SESSION_MESSAGE}</p>;
}

function PersonalNamespacesTable({ namespaces }: { namespaces: PersonalNamespaceRow[] }) {
  if (namespaces.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">💬</div>
        No captured threads yet — tag @recall-bot on a Slack thread you're part of.
      </div>
    );
  }
  return (
    <div>
      {namespaces.map((n) => (
        <div key={n.id} className="row-card">
          <div className="row-card-icon">💬</div>
          <div className="row-card-body">
            <div className="row-card-title">{n.label ?? n.threadTs}</div>
            <div className="row-card-sub">
              #{n.channelId} · {new Date(n.createdAt).toLocaleDateString()}
              {n.status === "archived" && " · archived"}
            </div>
          </div>
          <div className="row-card-actions">
            <a href={`/dashboard/me/namespaces/${n.id}`} className="btn-brutal btn-brutal-sm btn-brutal-ghost">
              View
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}

export function PersonalDashboard() {
  const [identity, setIdentity] = useState<PersonalIdentity | null>(null);
  const [namespaces, setNamespaces] = useState<PersonalNamespaceRow[]>([]);
  const [unauthorized, setUnauthorized] = useState(false);

  useEffect(() => {
    fetch("/api/me/me").then((res) => {
      if (res.status === 401) {
        setUnauthorized(true);
        return;
      }
      res.json().then(setIdentity);
    });
    fetch("/api/me/namespaces").then((res) => {
      if (res.status === 401) {
        setUnauthorized(true);
        return;
      }
      res.json().then(setNamespaces);
    });
  }, []);

  if (unauthorized) return <MeNoSession />;
  if (!identity) return <p>Loading…</p>;

  const logout = async () => {
    await fetch("/api/me/logout", { method: "POST" });
    setIdentity(null);
    setUnauthorized(true);
  };

  return (
    <div>
      {/* Nav bar */}
      <nav className="nav-bar">
        <a href="/dashboard/me" className="nav-bar-brand">
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
        <h1 className="heading-xl">Your Captured Threads</h1>
        <p className="subtitle">
          Signed in as {identity.displayName ?? identity.slackUserId} · {namespaces.length} thread{ namespaces.length !== 1 ? "s" : ""}
        </p>

        <PersonalNamespacesTable namespaces={namespaces} />
      </div>
    </div>
  );
}

export function MeNamespaceDetail({ namespaceId }: { namespaceId: string }) {
  return (
    <NamespaceDetail
      namespaceId={namespaceId}
      apiBase="/api/me"
      backHref="/dashboard/me"
      unauthorizedMessage={PERSONAL_NO_SESSION_MESSAGE}
    />
  );
}
