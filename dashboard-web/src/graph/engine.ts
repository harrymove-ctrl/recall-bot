import type { GraphEdge, GraphNode } from "./types.js";
import { addNamespaceScene, buildScenes, staggerReveal } from "./scene.js";
import { applyVisibility, buildNodeElement, buildSubNodeElement, createEdgeEl, updateEdgePath } from "./render.js";
import type { Camera, CameraTarget, NodeState, Scene, SceneId } from "./types.js";

const CAM_LERP = 0.065;
const FLOAT_AMP_DEFAULT = 3.5;
const PUSH_LERP = 0.06;
const DRAG_SPRING = 0.88;

export class GraphEngine {
  private nodes = new Map<string, NodeState>();
  private edges = new Map<string, { el: SVGPathElement; from: string; to: string }>();
  private cam: Camera = { x: 0, y: 0, s: 1 };
  private camTarget: CameraTarget | null = null;
  private floatAmp = FLOAT_AMP_DEFAULT;
  private rafId = 0;
  private frameCount = 0;

  private dragging: NodeState | null = null;
  private container: HTMLElement;
  private svg: SVGSVGElement;
  private nodesLayer: HTMLElement;
  private graphNodes: GraphNode[] = [];
  private graphEdges: GraphEdge[] = [];
  private scenes = new Map<SceneId, Scene>();
  private staggerCleanup: (() => void) | null = null;
  private onNodeClick?: (id: string, type: string) => void;

  constructor(
    container: HTMLElement,
    callbacks?: { onNodeClick?: (id: string, type: string) => void },
  ) {
    this.container = container;
    this.onNodeClick = callbacks?.onNodeClick;

    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.setAttribute("class", "graph-svg");
    Object.assign(this.svg.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      overflow: "visible",
      pointerEvents: "none",
    });
    container.appendChild(this.svg);

    this.nodesLayer = document.createElement("div");
    this.nodesLayer.setAttribute("class", "graph-nodes-layer");
    Object.assign(this.nodesLayer.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      overflow: "visible",
    });
    container.appendChild(this.nodesLayer);

    this.setupMouseEvents();
    this.startLoop();
  }

  init(nodes: GraphNode[], edges: GraphEdge[]): void {
    this.graphNodes = nodes;
    this.graphEdges = edges;
    this.scenes = buildScenes(nodes, edges);

    for (const n of nodes) {
      this.addNode(n);
    }
    for (const e of edges) {
      this.addEdge(e);
    }

    this.goScene("overview");
  }

  async revealNamespaceDetails(namespaceId: string): Promise<void> {
    try {
      const res = await fetch(`/api/dashboard/namespaces/${namespaceId}/messages`);
      if (!res.ok) return;
      const data = await res.json() as {
        messages?: Array<{ id: string; text: string }>;
        files?: Array<{ id: string; originalName: string }>;
      };
      const messages = (data.messages ?? []).slice(0, 16);
      const files = data.files ?? [];

      const scene = addNamespaceScene(
        this.scenes,
        namespaceId,
        this.graphNodes,
        messages.map((m) => ({ id: m.id, text: m.text })),
        files.map((f) => ({ id: f.id, name: f.originalName })),
        this.graphEdges.map((e) => ({ from: e.from, to: e.to })),
      );

      for (const msg of messages) {
        const el = buildSubNodeElement("message", msg.id, msg.text, namespaceId);
        this.nodesLayer.appendChild(el);
        this.nodes.set(msg.id, {
          id: msg.id,
          type: "message",
          el,
          x: 0,
          y: 0,
          w: 140,
          h: 56,
          fx: 0,
          fy: 0,
          px: 0,
          py: 0,
          tx: 0,
          ty: 0,
          phase: Math.random() * 6.283,
          dragging: false,
          visibility: "hid",
          parentId: namespaceId,
        });
      }

      for (const file of files) {
        const el = buildSubNodeElement("file", file.id, file.originalName, namespaceId);
        this.nodesLayer.appendChild(el);
        this.nodes.set(file.id, {
          id: file.id,
          type: "file",
          el,
          x: 0,
          y: 0,
          w: 120,
          h: 40,
          fx: 0,
          fy: 0,
          px: 0,
          py: 0,
          tx: 0,
          ty: 0,
          phase: Math.random() * 6.283,
          dragging: false,
          visibility: "hid",
          parentId: namespaceId,
        });
      }

      this.goSceneById(namespaceId, scene);
    } catch {
      // Silently ignore — graph works without sub-nodes
    }
  }

  goScene(id: SceneId): void {
    const scene = this.scenes.get(id);
    if (!scene) return;
    this.goSceneById(id, scene);
  }

  private goSceneById(id: SceneId, scene: Scene): void {
    this.staggerCleanup?.();
    this.staggerCleanup = null;

    // Apply layout positions
    for (const [nodeId, state] of this.nodes) {
      const pos = (scene as Record<string, unknown>)[`_pos_${nodeId}`] as
        | { x: number; y: number }
        | undefined;
      if (pos) {
        state.x = pos.x;
        state.y = pos.y;
      }
    }

    if (scene.camTarget) {
      this.camTarget = { ...scene.camTarget };
    }

    const visibleIds = scene.visibleIds ?? [...this.nodes.keys()];

    this.staggerCleanup = staggerReveal(
      visibleIds,
      [...this.nodes.keys()],
      (id) => {
        const state = this.nodes.get(id);
        if (state) {
          state.visibility = "on";
          applyVisibility(state.el, "on");
        }
      },
    );
  }

  private addNode(n: GraphNode): void {
    const el = buildNodeElement(n);
    this.nodesLayer.appendChild(el);
    const w = n.type === "namespace" ? 190 : 80;
    const h = n.type === "namespace" ? 88 : 80;
    this.nodes.set(n.id, {
      id: n.id,
      type: n.type,
      el,
      x: 0,
      y: 0,
      w,
      h,
      fx: 0,
      fy: 0,
      px: 0,
      py: 0,
      tx: 0,
      ty: 0,
      phase: (this.nodes.size * 1.83) % 6.283,
      dragging: false,
      visibility: "hid",
    });
  }

  private addEdge(e: GraphEdge): void {
    const el = createEdgeEl(e.id);
    this.svg.appendChild(el);
    this.edges.set(e.id, { el, from: e.from, to: e.to });
  }

  private startLoop(): void {
    const loop = (t: number) => {
      this.frame(t);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private frame(t: number): void {
    this.frameCount++;

    // Camera lerp
    if (this.camTarget) {
      this.cam.x += (this.camTarget.x - this.cam.x) * CAM_LERP;
      this.cam.y += (this.camTarget.y - this.cam.y) * CAM_LERP;
      this.cam.s += (this.camTarget.s - this.cam.s) * CAM_LERP;
    }

    const scale = this.cam.s;
    const ox = this.container.clientWidth / 2;
    const oy = this.container.clientHeight / 2;

    // Node positions
    for (const state of this.nodes.values()) {
      const dxf = Math.sin(t * 0.00055 + state.phase) * this.floatAmp;
      const dyf = Math.cos(t * 0.00045 + state.phase * 1.4) * this.floatAmp;

      // Push-out (always zero for now — applied via camTarget on scene change)
      state.px += (0 - state.px) * PUSH_LERP;
      state.py += (0 - state.py) * PUSH_LERP;

      // Spring-back
      if (!state.dragging) {
        state.tx *= DRAG_SPRING;
        state.ty *= DRAG_SPRING;
      }

      const wx = state.x + dxf + state.px + state.tx;
      const wy = state.y + dyf + state.py + state.ty;
      const sx = ox + wx * scale;
      const sy = oy + wy * scale;

      state.fx = sx;
      state.fy = sy;
      state.el.style.transform = `translate(${sx - (state.w * scale) / 2}px, ${sy - (state.h * scale) / 2}px) scale(${scale})`;
    }

    // Edge paths every other frame
    if (this.frameCount % 2 === 0) {
      for (const edge of this.edges.values()) {
        const a = this.nodes.get(edge.from);
        const b = this.nodes.get(edge.to);
        if (a && b) {
          updateEdgePath(edge.el, a.fx, a.fy, b.fx, b.fy);
        }
      }
    }
  }

  private setupMouseEvents(): void {
    const onMove = (e: MouseEvent) => {
      if (!this.dragging) return;
      const rect = this.container.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const ox = this.container.clientWidth / 2;
      const oy = this.container.clientHeight / 2;
      const scale = this.cam.s;
      this.dragging.tx = (sx - ox) / scale - this.dragging.x;
      this.dragging.ty = (sy - oy) / scale - this.dragging.y;
    };
    const onUp = () => {
      if (this.dragging) {
        this.dragging.dragging = false;
        this.dragging = null;
      }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    this.nodesLayer.addEventListener("mousedown", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
      if (!el) return;
      const state = this.nodes.get(el.dataset.id!);
      if (!state) return;
      state.dragging = true;
      this.dragging = state;
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });

    this.nodesLayer.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
      if (!el) return;
      const id = el.dataset.id!;
      const type = el.dataset.type ?? "unknown";
      this.onNodeClick?.(id, type);
      if (type === "namespace") {
        this.revealNamespaceDetails(id);
      }
    });
  }

  setFloatAmp(amp: number): void {
    this.floatAmp = amp;
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.staggerCleanup?.();
    this.svg.remove();
    this.nodesLayer.remove();
  }
}
