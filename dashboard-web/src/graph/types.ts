// ─── API types (from graphApi.ts) ─────────────────────────────────

export interface GraphNamespaceNode {
  id: string;
  type: "namespace";
  label: string | null;
  channelId: string;
  threadTs: string;
  status: string;
  messageCount: number;
  fileCount: number;
  walrusStoredCount: number;
  createdAt: string;
  participantUserIds: string[];
}

export interface GraphUserNode {
  id: string;
  type: "user";
  slackUserId: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export type GraphNode = GraphNamespaceNode | GraphUserNode;

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: "participation";
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ─── Engine state types ───────────────────────────────────────────

export type NodeVisibility = "on" | "half" | "hid";

export interface NodeState {
  id: string;
  type: "namespace" | "user" | "message" | "file";
  el: HTMLElement;
  x: number;
  y: number;
  w: number;
  h: number;
  fx: number;
  fy: number;
  px: number;
  py: number;
  tx: number;
  ty: number;
  phase: number;
  dragging: boolean;
  visibility: NodeVisibility;
  parentId?: string;
}

export interface Camera {
  x: number;
  y: number;
  s: number;
}

export interface CameraTarget {
  x: number;
  y: number;
  s: number;
}

// ─── Scene types ──────────────────────────────────────────────────

export type SceneId = "overview" | "recent" | string;

export interface Scene {
  id: string;
  label: string;
  visibleIds?: string[];
  focusedId?: string;
  camTarget?: CameraTarget;
}
