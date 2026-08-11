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

// ─── Accordion ─────────────────────────────────────────────────

function AccordionItem({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="accordion-item">
      <button
        type="button"
        className="accordion-trigger"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{title}</span>
        <span className="accordion-trigger-icon" aria-hidden="true">+</span>
      </button>
      <div className="accordion-content" data-open={open}>
        <div className="accordion-content-inner">{children}</div>
      </div>
    </div>
  );
}

function Accordion({ children }: { children: React.ReactNode }) {
  return <div className="accordion">{children}</div>;
}

// ─── Skeleton ─────────────────────────────────────────────────

function Skeleton({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`skeleton ${className}`} style={style} aria-hidden="true" />;
}

// ─── Stat tile ────────────────────────────────────────────────

function StatTile({
  label,
  value,
  hint,
  variant = "default",
}: {
  label: string;
  value: string | number;
  hint?: string;
  variant?: "default" | "yellow" | "black";
}) {
  const variantClass = variant === "yellow" ? "stat-tile-yellow" : variant === "black" ? "stat-tile-black" : "";
  return (
    <div className={`stat-tile ${variantClass}`}>
      <div className="stat-tile-label">{label}</div>
      <div className="stat-tile-value">{value}</div>
      {hint && <div className="stat-tile-hint">{hint}</div>}
    </div>
  );
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
        <span className={`tooltip-wrap${copied ? " tooltip-yellow" : ""}`} data-tooltip={copied ? "Copied!" : "Copy MCP URL"}>
          <button
            type="button"
            className={`btn-copy${copied ? " btn-copy--copied" : ""}`}
            onClick={() => copy(mcpUrl)}
          >
            {copied ? "✓ Copied" : "Copy"}
          </button>
        </span>
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
    <div className="steps-row" style={{ margin: 0 }}>
      <div className="step-card">
        <div className="step-card-num">1</div>
        <h3>Tag <span className="kbd-brutal">@recall-bot</span></h3>
        <p>Add the bot to any Slack thread you want to capture — messages and files are stored securely.</p>
      </div>
      <div className="step-card">
        <div className="step-card-num">2</div>
        <h3>DM <span className="kbd-brutal">/recall-key</span></h3>
        <p>Get a personal delegate key to authenticate your coding agent against the recall-bot MCP.</p>
      </div>
      <div className="step-card">
        <div className="step-card-num">3</div>
        <h3>Connect via MCP</h3>
        <p>
          Point your agent at <code className="code-inline">{mcpUrl}</code> using the key as a Bearer token.{" "}
        </p>
        <div style={{ marginTop: 10 }}>
          <span className={`tooltip-wrap${copied ? " tooltip-yellow" : ""}`} data-tooltip={copied ? "Copied!" : "Copy MCP URL"}>
            <button type="button" className={`btn-copy${copied ? " btn-copy--copied" : ""}`} onClick={() => copy(mcpUrl)}>
              {copied ? "Copied" : "Copy URL"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

function GettingStartedPanel({ hasNamespaces }: { hasNamespaces: boolean }) {
  const origin = window.location.origin;
  if (!hasNamespaces) {
    return (
      <div style={{ marginBottom: 28 }}>
        <div className="section-heading">
          <div className="section-heading-dot"></div>
          <div className="section-heading-text">Get started in 3 steps</div>
        </div>
        <GettingStartedSteps origin={origin} />
      </div>
    );
  }
  return (
    <div style={{ marginBottom: 28 }}>
      <Accordion>
        <AccordionItem title="Getting started (3 steps)">
          <GettingStartedSteps origin={origin} />
        </AccordionItem>
      </Accordion>
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

// ─── Onboarding Checklist ───────────────────────────────────────

interface OnboardingStep {
  id: string;
  emoji: string;
  title: string;
  description: string;
  action?: { label: string; href: string };
  status: "done" | "pending";
}

function ChecklistItem({ step }: { step: OnboardingStep }) {
  return (
    <div className="checklist-item">
      <div className={`checklist-icon ${step.status === "done" ? "checklist-icon--done" : ""}`}>
        {step.status === "done" ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <span>{step.emoji}</span>
        )}
      </div>
      <div className="checklist-body">
        <div className="checklist-title">{step.title}</div>
        <div className="checklist-desc">{step.description}</div>
        {step.action && (
          <a href={step.action.href} className="btn-brutal btn-brutal-sm" style={{ marginTop: 8, display: "inline-flex" }}>
            {step.action.label}
          </a>
        )}
      </div>
    </div>
  );
}

function WorkspaceOnboarding({ workspaceName }: { workspaceName: string }) {
  const origin = window.location.origin;
  const mcpUrl = `${origin}/mcp`;
  const { copied, copy } = useCopyButton();

  const steps: OnboardingStep[] = [
    {
      id: "install",
      emoji: "1",
      title: "Install recall-bot in your Slack workspace",
      description: "Click the button below to authorize recall-bot for your workspace. You'll need workspace admin permission.",
      action: { label: "Add to Slack", href: "/slack/install" },
      status: "pending",
    },
    {
      id: "capture",
      emoji: "2",
      title: "Capture your first thread",
      description: "Go to any Slack channel and tag @recall-bot on a thread you want to remember. The bot will capture the full thread and store it.",
      status: "pending",
    },
    {
      id: "key",
      emoji: "3",
      title: "Get your delegate key",
      description: "DM @recall-bot with /recall-key to receive a personal delegate key. This key lets your coding agent authenticate with recall-bot.",
      status: "pending",
    },
    {
      id: "mcp",
      emoji: "4",
      title: "Connect your coding agent via MCP",
      description: "Point your agent (Cursor, Claude Code, Codex) at the MCP endpoint using your delegate key as a Bearer token.",
      action: { label: copied ? "Copied!" : "Copy MCP URL", href: "#" },
      status: "pending",
    },
  ];

  return (
    <div className="page">
      <div className="breadcrumb">
        <span className="breadcrumb-item">Recall Bot</span>
        <span className="breadcrumb-sep">›</span>
        <span className="breadcrumb-item breadcrumb-item--current">Setup</span>
      </div>

      <h1 className="heading-xl">Welcome to {workspaceName}</h1>
      <p className="subtitle">Complete these steps to start capturing and recalling Slack threads with your coding agent.</p>

      {/* Progress bar */}
      <div className="onboarding-progress">
        <div className="onboarding-progress-bar" style={{ width: "0%" }} />
      </div>
      <p className="onboarding-progress-label">0 / 4 steps complete</p>

      {/* Steps */}
      <div className="onboarding-card">
        <div className="onboarding-card-header">
          <div className="section-heading" style={{ margin: 0 }}>
            <div className="section-heading-dot" />
            <div className="section-heading-text">Getting Started Checklist</div>
          </div>
        </div>
        <div className="checklist">
          {steps.map((step) => (
            <ChecklistItem key={step.id} step={step} />
          ))}
        </div>
      </div>

      {/* MCP endpoint box */}
      <div className="mcp-box" style={{ marginTop: 24 }}>
        <div className="mcp-box-label">MCP Endpoint</div>
        <div className="mcp-box-row">
          <code className="mcp-box-url">{mcpUrl}</code>
          <span className={`tooltip-wrap${copied ? " tooltip-yellow" : ""}`} data-tooltip={copied ? "Copied!" : "Copy MCP URL"}>
            <button
              type="button"
              className={`btn-copy${copied ? " btn-copy--copied" : ""}`}
              onClick={() => copy(mcpUrl)}
            >
              {copied ? "✓ Copied" : "Copy"}
            </button>
          </span>
        </div>
        <div className="mcp-box-hint">Use this URL to connect AI agents via MCP — you'll need your delegate key from step 3</div>
      </div>

      {/* Help */}
      <div className="alert alert-info" style={{ marginTop: 24 }}>
        <div className="alert-icon">?</div>
        <div>
          <h4 className="alert-title">Need help?</h4>
          <p className="alert-desc">
            Run <span className="kbd-brutal">/recall-key</span> in a DM with <span className="kbd-brutal">@recall-bot</span> to get your delegate key. Tag <span className="kbd-brutal">@recall-bot</span> on any Slack thread to capture it.
          </p>
        </div>
      </div>
    </div>
  );
}

export function NoSession() {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const mcpUrl = `${origin}/mcp`;
  const { copied, copy } = useCopyButton();
  return (
    <>
      <nav className="nav-bar">
        <a href="/" className="nav-bar-brand">
          <div className="nav-bar-brand-icon">R</div>
          <span className="nav-bar-brand-name">Recall Bot</span>
        </a>
        <div className="nav-bar-actions">
          <a href="/slack/install" className="btn-brutal btn-brutal-sm btn-brutal-yellow">Add to Slack</a>
        </div>
      </nav>
      <div className="page">
        <div className="breadcrumb">
          <span className="breadcrumb-item">Recall Bot</span>
          <span className="breadcrumb-sep">›</span>
          <span className="breadcrumb-item breadcrumb-item--current">Dashboard</span>
        </div>
        <h1 className="heading-xl">Recall Bot Dashboard</h1>
        <p className="subtitle">Manage your workspace's captured threads and coding agents.</p>

        {/* Alert */}
        <div className="alert alert-warn" style={{ marginBottom: 24 }}>
          <div className="alert-icon">!</div>
          <div>
            <h4 className="alert-title">No active session</h4>
            <p className="alert-desc">
              Check your Slack DM from <span className="kbd-brutal">@recall-bot</span> for the dashboard setup link. Missed it?{" "}
              <a href="/" style={{ fontWeight: 700, textDecoration: "underline" }}>Reinstall the app</a>.
            </p>
          </div>
        </div>

        {/* Onboarding */}
        <div className="onboarding-card">
          <div className="onboarding-card-header">
            <div className="section-heading" style={{ margin: 0 }}>
              <div className="section-heading-dot" />
              <div className="section-heading-text">Setup Checklist</div>
            </div>
          </div>
          <div className="checklist">
            <ChecklistItem step={{
              id: "install",
              emoji: "1",
              title: "Install recall-bot in Slack",
              description: "Authorize recall-bot for your workspace. Requires workspace admin permission.",
              action: { label: "Add to Slack", href: "/slack/install" },
              status: "pending",
            }} />
            <ChecklistItem step={{
              id: "capture",
              emoji: "2",
              title: "Capture your first thread",
              description: 'Tag @recall-bot on any Slack thread to capture messages and files.',
              status: "pending",
            }} />
            <ChecklistItem step={{
              id: "key",
              emoji: "3",
              title: "Get your delegate key",
              description: 'DM @recall-bot with /recall-key to receive your personal delegate key.',
              status: "pending",
            }} />
            <ChecklistItem step={{
              id: "mcp",
              emoji: "4",
              title: "Connect a coding agent via MCP",
              description: `Use the MCP endpoint below with your delegate key as Bearer token.`,
              action: { label: copied ? "✓ Copied!" : "Copy MCP URL", href: "#" },
              status: "pending",
            }} />
          </div>
        </div>

        {/* MCP box */}
        <div className="mcp-box" style={{ marginTop: 24 }}>
          <div className="mcp-box-label">MCP Endpoint</div>
          <div className="mcp-box-row">
            <code className="mcp-box-url">{mcpUrl}</code>
            <span className={`tooltip-wrap${copied ? " tooltip-yellow" : ""}`} data-tooltip={copied ? "Copied!" : "Copy MCP URL"}>
              <button
                type="button"
                className={`btn-copy${copied ? " btn-copy--copied" : ""}`}
                onClick={() => copy(mcpUrl)}
              >
                {copied ? "✓ Copied" : "Copy"}
              </button>
            </span>
          </div>
          <div className="mcp-box-hint">Connect any MCP-capable agent (Cursor, Claude Code, Codex) using your delegate key</div>
        </div>
      </div>
    </>
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
                <div className="nb-empty">
                  <div className="nb-empty-icon">📡</div>
                  <div className="nb-empty-title">{search ? "No namespaces match your search" : "No threads captured yet"}</div>
                  <div className="nb-empty-desc">
                    {search ? "Try clearing your search." : 'Tag @recall-bot on a Slack thread to capture it, or click "Add to Slack" on the landing page.'}
                  </div>
                </div>
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
                    <span className="tooltip-wrap" data-tooltip="View thread messages">
                      <a href={`/dashboard/namespaces/${n.id}`} className="btn-brutal btn-brutal-sm btn-brutal-ghost">
                        View
                      </a>
                    </span>
                    <span className="tooltip-wrap" data-tooltip="Copy MCP agent snippet">
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
                    </span>
                    <span className="tooltip-wrap" data-tooltip="Copy markdown link">
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
                    </span>
                    {n.status !== "archived" && (
                      <span className="tooltip-wrap" data-tooltip="Archive this thread">
                        <button type="button" className="btn-brutal btn-brutal-sm btn-brutal-ghost" onClick={() => onArchive(n.id)}>
                          Archive
                        </button>
                      </span>
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
        <div className="nb-empty">
          <div className="nb-empty-icon">🧠</div>
          <div className="nb-empty-title">{search ? "No memories match your search" : "No memories captured yet"}</div>
          <div className="nb-empty-desc">
            {search ? "Try clearing your search." : "Tag @recall-bot on a Slack thread to start capturing memories."}
          </div>
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
                <span className="tooltip-wrap" data-tooltip="View thread messages">
                  <a href={`/dashboard/namespaces/${m.id}`} className="btn-brutal btn-brutal-sm btn-brutal-ghost">
                    View
                  </a>
                </span>
                <span className="tooltip-wrap" data-tooltip="Copy MCP agent snippet">
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
                </span>
                <span className="tooltip-wrap" data-tooltip="Copy markdown link">
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
                </span>
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
  if (!workspace) {
    return (
      <>
        <nav className="nav-bar">
          <a href="/dashboard" className="nav-bar-brand">
            <div className="nav-bar-brand-icon">R</div>
            <span className="nav-bar-brand-name">Recall Bot</span>
          </a>
        </nav>
        <div className="page">
          <Skeleton className="skeleton-rounded" style={{ width: 280, height: 40, marginBottom: 16 }} />
          <Skeleton style={{ width: "50%", height: 18, marginBottom: 36 }} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 36 }}>
            <Skeleton style={{ height: 100 }} />
            <Skeleton style={{ height: 100 }} />
            <Skeleton style={{ height: 100 }} />
            <Skeleton style={{ height: 100 }} />
          </div>
          <Skeleton style={{ height: 200 }} />
        </div>
      </>
    );
  }

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
  const totalFiles = memories.reduce((s, m) => s + m.fileCount, 0);
  const totalRecalls = analytics.reduce((s, a) => s + a.recallCount, 0);
  const subtitle = [
    namespaces.length,
    `thread${namespaces.length !== 1 ? "s" : ""}`,
    users.length,
    `user${users.length !== 1 ? "s" : ""}`,
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
          <span className="tooltip-wrap" data-tooltip="Sign out of dashboard">
            <button type="button" className="btn-brutal btn-brutal-sm btn-brutal-ghost" onClick={logout}>
              Log out
            </button>
          </span>
        </div>
      </nav>

      {/* Page header */}
      <div className="page">
        <div className="breadcrumb">
          <span className="breadcrumb-item">Recall Bot</span>
          <span className="breadcrumb-sep">›</span>
          <span className="breadcrumb-item breadcrumb-item--current">Dashboard</span>
        </div>

        <h1 className="heading-xl">{workspace.name}</h1>
        <p className="subtitle">{subtitle}</p>

        {/* Stat tiles */}
        <div className="stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 28 }}>
          <StatTile label="Threads" value={namespaces.length} hint={`${memories.filter((m) => m.status === "active").length} active`} />
          <StatTile label="Memories" value={totalMessages} hint={`${totalFiles} file${totalFiles !== 1 ? "s" : ""}`} variant="yellow" />
          <StatTile label="Recalls" value={totalRecalls} hint="total MCP calls" />
          <StatTile label="Users" value={users.length} hint="with delegate keys" />
        </div>

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
