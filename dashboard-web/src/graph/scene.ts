import type { GraphNode, Scene, SceneId } from "./types.js";

const GAP_X = 240;
const GAP_Y = 180;
const GRID_COLS = 4;

function circularLayout(
  nodes: GraphNode[],
  radiusScale = 1,
): Array<{ id: string; x: number; y: number }> {
  const r = Math.max(300, nodes.length * 50) * radiusScale;
  return nodes.map((n, i) => {
    const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
    return { id: n.id, x: Math.cos(angle) * r, y: Math.sin(angle) * r };
  });
}

function gridLayout(
  nodes: GraphNode[],
): Array<{ id: string; x: number; y: number }> {
  const cols = Math.min(GRID_COLS, nodes.length);
  const offsetX = ((cols - 1) * GAP_X) / 2;
  return nodes.map((n, i) => ({
    id: n.id,
    x: (i % cols) * GAP_X - offsetX,
    y: Math.floor(i / cols) * GAP_Y - (Math.floor((nodes.length - 1) / cols) * GAP_Y) / 2,
  }));
}

// Attach layout positions to a scene object (as _pos_<id> properties)
function attachLayout(
  scene: Scene,
  positions: Array<{ id: string; x: number; y: number }>,
): void {
  (scene as Record<string, unknown>)[`_pos`] = positions;
  for (const p of positions) {
    (scene as Record<string, unknown>)[`_pos_${p.id}`] = p;
  }
}

function getLayoutPos(scene: Scene, id: string): { x: number; y: number } | undefined {
  return (scene as Record<string, unknown>)[`_pos_${id}`] as { x: number; y: number } | undefined;
}

export function buildScenes(
  nodes: GraphNode[],
  edges: Array<{ from: string; to: string }>,
): Map<SceneId, Scene> {
  const namespaceNodes = nodes.filter((n) => n.type === "namespace");
  const userNodes = nodes.filter((n) => n.type === "user");

  const recentNs = namespaceNodes.slice(0, 10);
  const recentNsSet = new Set(recentNs.map((n) => n.id));
  const recentParticipantIds = new Set(
    edges.filter((e) => recentNsSet.has(e.from)).map((e) => e.to),
  );

  const overviewPositions = circularLayout([...namespaceNodes, ...userNodes], 1.2);
  const overview: Scene = {
    id: "overview",
    label: "Overview",
    visibleIds: undefined,
    camTarget: { x: 0, y: 0, s: 1 },
  };
  attachLayout(overview, overviewPositions);

  const recentVisible = [
    ...recentNs.map((n) => n.id),
    ...userNodes.filter((u) => recentParticipantIds.has(u.id)).map((u) => u.id),
  ];
  const recentPositions = gridLayout([...recentNs, ...userNodes.filter((u) => recentParticipantIds.has(u.id))]);
  const recent: Scene = {
    id: "recent",
    label: "Recent",
    visibleIds: recentVisible,
    camTarget: { x: 0, y: 0, s: 1.2 },
  };
  attachLayout(recent, recentPositions);

  return new Map<SceneId, Scene>([
    ["overview", overview],
    ["recent", recent],
  ]);
}

export function addNamespaceScene(
  scenes: Map<SceneId, Scene>,
  namespaceId: string,
  nodes: GraphNode[],
  messages: Array<{ id: string; text: string }>,
  files: Array<{ id: string; name: string }>,
  allEdges: Array<{ from: string; to: string }>,
): Scene {
  const cx = 0;
  const cy = 0;

  const participantIds = new Set(allEdges.filter((e) => e.from === namespaceId).map((e) => e.to));
  const participantNodes = nodes.filter((n) => participantIds.has(n.id));
  const participantPositions = participantNodes.map((n, i) => {
    const angle = (i / Math.max(1, participantNodes.length)) * Math.PI * 2 - Math.PI / 2;
    return { id: n.id, x: cx + Math.cos(angle) * 300, y: cy + Math.sin(angle) * 300 };
  });

  const msgPositions = messages.map((m, i) => ({
    id: m.id,
    x: cx + (i % 4) * 150 - 225,
    y: cy + 350 + Math.floor(i / 4) * 100,
  }));

  const filePositions = files.map((f, i) => ({
    id: f.id,
    x: cx + i * 130 - ((files.length - 1) * 130) / 2,
    y: cy + 520,
  }));

  const allPositions = [
    { id: namespaceId, x: cx, y: cy },
    ...participantPositions,
    ...msgPositions,
    ...filePositions,
  ];

  const scene: Scene = {
    id: namespaceId,
    label: "Thread",
    visibleIds: [
      namespaceId,
      ...participantIds,
      ...messages.map((m) => m.id),
      ...files.map((f) => f.id),
    ],
    focusedId: namespaceId,
    camTarget: { x: cx, y: cy, s: 0.85 },
  };
  attachLayout(scene, allPositions);

  scenes.set(namespaceId, scene);
  return scene;
}

export function staggerReveal(
  ids: string[],
  allIds: string[],
  onReveal: (id: string) => void,
  delayMs = 80,
  stepMs = 140,
): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const revealed = new Set<string>();

  ids.forEach((id, i) => {
    timers.push(
      setTimeout(() => {
        revealed.add(id);
        onReveal(id);
      }, delayMs + i * stepMs),
    );
  });

  // After all revealed, force-hide any nodes not in the list
  const lastTimer = ids.length > 0
    ? delayMs + (ids.length - 1) * stepMs + 200
    : delayMs;
  timers.push(
    setTimeout(() => {
      allIds.forEach((id) => {
        if (!revealed.has(id)) onReveal(id);
      });
    }, lastTimer),
  );

  return () => timers.forEach(clearTimeout);
}
