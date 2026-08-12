import type { GraphNode } from "./types.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Namespace node ────────────────────────────────────────────────

function buildNamespaceCard(n: GraphNode): HTMLElement {
  if (n.type !== "namespace") throw new Error("expected namespace");
  const el = document.createElement("div");
  el.className = "graph-node graph-node--namespace graph-node--hid";
  el.dataset.id = n.id;
  el.dataset.type = "namespace";
  el.innerHTML = `
    <div class="graph-node__label">${escapeHtml(n.label ?? n.id.slice(0, 8))}</div>
    <div class="graph-node__meta">
      <span class="graph-node__channel">#${escapeHtml(n.channelId)}</span>
      <span class="graph-node__counts">${n.messageCount}msg${n.fileCount > 0 ? ` · ${n.fileCount}f` : ""}</span>
    </div>
    ${n.walrusStoredCount > 0 ? `<div class="graph-node__walrus">${n.walrusStoredCount}/${n.messageCount} WAL</div>` : ""}
  `;
  return el;
}

// ─── User node ─────────────────────────────────────────────────────

function buildUserCard(n: GraphNode): HTMLElement {
  if (n.type !== "user") throw new Error("expected user");
  const el = document.createElement("div");
  el.className = "graph-node graph-node--user graph-node--hid";
  el.dataset.id = n.id;
  el.dataset.type = "user";
  const name = n.displayName ?? n.slackUserId;
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();
  el.innerHTML = `
    <div class="graph-node__avatar">
      ${n.avatarUrl ? `<img src="${escapeHtml(n.avatarUrl)}" alt="" />` : `<span>${escapeHtml(initials)}</span>`}
    </div>
    <div class="graph-node__name">${escapeHtml(name)}</div>
  `;
  return el;
}

// ─── Message sub-node ──────────────────────────────────────────────

function buildMessageCard(id: string, text: string, parentId: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "graph-node graph-node--message graph-node--hid";
  el.dataset.id = id;
  el.dataset.type = "message";
  el.dataset.parentId = parentId;
  const snippet = text.length > 60 ? text.slice(0, 60) + "…" : text;
  el.innerHTML = `<div class="graph-node__snippet">${escapeHtml(snippet)}</div>`;
  return el;
}

// ─── File sub-node ─────────────────────────────────────────────────

function buildFileCard(id: string, name: string, parentId: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "graph-node graph-node--file graph-node--hid";
  el.dataset.id = id;
  el.dataset.type = "file";
  el.dataset.parentId = parentId;
  el.innerHTML = `<div class="graph-node__filename">📎 ${escapeHtml(name)}</div>`;
  return el;
}

// ─── Node element builder ─────────────────────────────────────────

export function buildNodeElement(n: GraphNode): HTMLElement {
  switch (n.type) {
    case "namespace":
      return buildNamespaceCard(n);
    case "user":
      return buildUserCard(n);
  }
}

export function buildSubNodeElement(
  type: "message" | "file",
  id: string,
  label: string,
  parentId: string,
): HTMLElement {
  if (type === "message") return buildMessageCard(id, label, parentId);
  return buildFileCard(id, label, parentId);
}

// ─── SVG edge ──────────────────────────────────────────────────────

export function createEdgeEl(id: string): SVGPathElement {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("id", `edge-${id}`);
  path.setAttribute("class", "graph-edge graph-edge--hid");
  path.setAttribute("fill", "none");
  return path;
}

export function updateEdgePath(path: SVGPathElement, x1: number, y1: number, x2: number, y2: number): void {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const cx = mx - dy * 0.15;
  const cy = my + dx * 0.15;
  path.setAttribute("d", `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`);
}

// ─── Visibility ────────────────────────────────────────────────────

export function applyVisibility(el: HTMLElement | SVGPathElement, vis: "on" | "half" | "hid"): void {
  el.classList.remove("graph-node--on", "graph-node--half", "graph-node--hid");
  el.classList.remove("graph-edge--on", "graph-edge--half", "graph-edge--hid");
  if (el.classList.contains("graph-node")) {
    el.classList.add(`graph-node--${vis}`);
  } else {
    el.classList.add(`graph-edge--${vis}`);
  }
}
