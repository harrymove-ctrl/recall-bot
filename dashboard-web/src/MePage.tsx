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

  if (status === "error") {
    return (
      <>
        <nav className="nav-bar">
          <a href="/dashboard/me" className="nav-bar-brand">
            <div className="nav-bar-brand-icon">R</div>
            <span className="nav-bar-brand-name">Recall Bot</span>
          </a>
        </nav>
        <div className="page">
          <div className="alert alert-error" style={{ maxWidth: 560 }}>
            <div className="alert-icon">!</div>
            <div>
              <h4 className="alert-title">Claim failed</h4>
              <p className="alert-desc">{message}</p>
              <a href="/auth/slack" className="btn-brutal btn-brutal-sm" style={{ marginTop: 10, display: "inline-flex" }}>
                Sign in with Slack instead
              </a>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <nav className="nav-bar">
        <a href="/dashboard/me" className="nav-bar-brand">
          <div className="nav-bar-brand-icon">R</div>
          <span className="nav-bar-brand-name">Recall Bot</span>
        </a>
      </nav>
      <div className="page">
        <div className="sign-in-card" style={{ maxWidth: 560 }}>
          <div className="sign-in-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <circle cx="12" cy="12" r="10" stroke="#000" strokeWidth="2" fill="#ffdc58"/>
              <path d="M9 12l2 2 4-4" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="sign-in-body">
            <h2 className="sign-in-title">Logging you in…</h2>
            <p className="sign-in-desc">Please wait while we verify your claim token.</p>
          </div>
        </div>
      </div>
    </>
  );
}

function MeNoSession() {
  const mcpUrl = `${window.location.origin}/mcp`;
  return (
    <>
      <nav className="nav-bar">
        <a href="/" className="nav-bar-brand">
          <div className="nav-bar-brand-icon">R</div>
          <span className="nav-bar-brand-name">Recall Bot</span>
        </a>
        <div className="nav-bar-actions">
          <a href="/auth/slack" className="btn-brutal btn-brutal-sm btn-brutal-yellow">Sign in with Slack</a>
        </div>
      </nav>
      <div className="page">
        <div className="breadcrumb">
          <span className="breadcrumb-item">Recall Bot</span>
          <span className="breadcrumb-sep">›</span>
          <span className="breadcrumb-item breadcrumb-item--current">My Threads</span>
        </div>

        <h1 className="heading-xl">My Captured Threads</h1>
        <p className="subtitle">Sign in to view and manage your personal captured threads.</p>

        {/* Sign in card */}
        <div className="sign-in-card" style={{ maxWidth: 560 }}>
          <div className="sign-in-icon">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52z" fill="#E01E5A"/>
              <path d="M6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z" fill="#E01E5A"/>
              <path d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834z" fill="#36C5F0"/>
              <path d="M8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z" fill="#36C5F0"/>
              <path d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834z" fill="#2EB67D"/>
              <path d="M17.688 8.834a2.527 2.527 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z" fill="#2EB67D"/>
              <path d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52z" fill="#ECB22E"/>
              <path d="M15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" fill="#ECB22E"/>
            </svg>
          </div>
          <div className="sign-in-body">
            <h2 className="sign-in-title">Sign in with Slack</h2>
            <p className="sign-in-desc">
              Access your personal captured threads and manage your delegate key.
            </p>
            <a href="/auth/slack" className="btn-brutal btn-brutal-yellow sign-in-btn">
              Sign in with Slack
            </a>
          </div>
        </div>

        {/* MCP box */}
        <div className="mcp-box" style={{ marginTop: 24, maxWidth: 560 }}>
          <div className="mcp-box-label">MCP Endpoint</div>
          <div className="mcp-box-row">
            <code className="mcp-box-url">{mcpUrl}</code>
          </div>
          <div className="mcp-box-hint">Connect your coding agent with your delegate key from /recall-key</div>
        </div>
      </div>
    </>
  );
}

function PersonalNamespacesTable({ namespaces }: { namespaces: PersonalNamespaceRow[] }) {
  if (namespaces.length === 0) {
    return (
      <div className="nb-empty">
        <div className="nb-empty-icon">💬</div>
        <div className="nb-empty-title">No captured threads yet</div>
        <div className="nb-empty-desc">
          Tag <span className="kbd-brutal">@recall-bot</span> on a Slack thread you're part of to capture it.
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
  if (!identity) {
    return (
      <>
        <nav className="nav-bar">
          <a href="/dashboard/me" className="nav-bar-brand">
            <div className="nav-bar-brand-icon">R</div>
            <span className="nav-bar-brand-name">Recall Bot</span>
          </a>
        </nav>
        <div className="page">
          <div style={{ width: 280, height: 40, marginBottom: 16 }} className="skeleton skeleton-rounded" aria-hidden="true" />
          <div style={{ width: "50%", height: 18, marginBottom: 36 }} className="skeleton" aria-hidden="true" />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ height: 72 }} className="skeleton" aria-hidden="true" />
            ))}
          </div>
        </div>
      </>
    );
  }

  const logout = async () => {
    await fetch("/api/me/logout", { method: "POST" });
    setIdentity(null);
    setUnauthorized(true);
  };

  return (
    <>
      {/* Nav bar */}
      <nav className="nav-bar">
        <a href="/dashboard/me" className="nav-bar-brand">
          <div className="nav-bar-brand-icon">R</div>
          <span className="nav-bar-brand-name">Recall Bot</span>
        </a>
        <div className="nav-bar-actions">
          <a href="/dashboard" className="btn-brutal btn-brutal-sm btn-brutal-ghost">Workspace</a>
          <button type="button" className="btn-brutal btn-brutal-sm btn-brutal-ghost" onClick={logout}>
            Log out
          </button>
        </div>
      </nav>

      <div className="page">
        <div className="breadcrumb">
          <span className="breadcrumb-item">Recall Bot</span>
          <span className="breadcrumb-sep">›</span>
          <span className="breadcrumb-item breadcrumb-item--current">My Threads</span>
        </div>

        <h1 className="heading-xl">My Captured Threads</h1>
        <p className="subtitle">
          {identity.displayName ?? identity.slackUserId} · {namespaces.length} thread{namespaces.length !== 1 ? "s" : ""}
        </p>

        <PersonalNamespacesTable namespaces={namespaces} />
      </div>
    </>
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
