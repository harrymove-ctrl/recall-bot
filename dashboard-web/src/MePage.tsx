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
    return <p>No captured threads yet — tag @recall-bot on a Slack thread you're part of.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Label</th>
          <th>Channel</th>
          <th>Created</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {namespaces.map((n) => (
          <tr key={n.id}>
            <td>{n.label ?? n.threadTs}</td>
            <td>{n.channelId}</td>
            <td>{new Date(n.createdAt).toLocaleDateString()}</td>
            <td>
              <a href={`/dashboard/me/namespaces/${n.id}`}>View</a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
      <h1>Your captured threads</h1>
      <p>
        Signed in as {identity.displayName ?? identity.slackUserId} — <button onClick={logout}>Log out</button>
      </p>
      <PersonalNamespacesTable namespaces={namespaces} />
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
