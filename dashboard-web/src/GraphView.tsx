import { useEffect, useRef, useState } from "react";
import { GraphEngine } from "./graph/engine.js";
import type { GraphResponse, SceneId } from "./graph/types.js";
import { BlazeBackground } from "./components/effects/BlazeBackground.js";

function GraphSkeleton() {
  return (
    <div className="graph-loading">
      <div className="graph-loading-dots">
        <div className="graph-loading-dot" />
        <div className="graph-loading-dot" />
        <div className="graph-loading-dot" />
      </div>
      <div className="graph-loading-label">Mapping your memories…</div>
    </div>
  );
}

function GraphEmpty() {
  return (
    <div className="graph-empty">
      <div className="graph-empty-icon">🧠</div>
      <div className="graph-empty-title">No threads captured yet</div>
      <div className="graph-empty-desc">
        Tag <span className="kbd-brutal">@recall-bot</span> on a Slack thread to start
        building your knowledge graph.
      </div>
      <a href="/dashboard" className="btn-brutal btn-brutal-yellow" style={{ marginTop: 24 }}>
        Back to dashboard
      </a>
    </div>
  );
}

function GraphError({ message }: { message: string }) {
  return (
    <div className="graph-error">
      <div className="graph-error-icon">⚠</div>
      <div className="graph-error-title">Graph failed to load</div>
      <div className="graph-error-desc">{message}</div>
    </div>
  );
}

interface SceneBarProps {
  activeScene: SceneId | string | null;
  onSceneChange: (id: SceneId) => void;
  onBackToOverview: () => void;
  focusedLabel?: string;
}

function SceneBar({ activeScene, onSceneChange, onBackToOverview, focusedLabel }: SceneBarProps) {
  const tabs: { id: SceneId; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "recent", label: "Recent" },
  ];

  const isDrilldown = activeScene != null && activeScene !== "overview" && activeScene !== "recent";

  return (
    <div className="graph-scene-bar" role="tablist" aria-label="Graph views">
      {isDrilldown ? (
        <div className="graph-scene-bar__drilldown">
          <button
            type="button"
            className="btn-brutal btn-brutal-sm btn-brutal-ghost"
            onClick={onBackToOverview}
          >
            ← Back
          </button>
          <span className="graph-scene-bar__label">{focusedLabel ?? "Thread"}</span>
        </div>
      ) : (
        tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeScene === t.id}
            className={`graph-scene-btn${activeScene === t.id ? " graph-scene-btn--active" : ""}`}
            onClick={() => onSceneChange(t.id)}
          >
            {t.label}
          </button>
        ))
      )}
    </div>
  );
}

export function GraphView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GraphEngine | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [activeScene, setActiveScene] = useState<SceneId | null>(null);
  const [focusedLabel, setFocusedLabel] = useState<string | undefined>();
  const [floatAmp, setFloatAmp] = useState(3.5);

  useEffect(() => {
    if (!containerRef.current) return;

    const engine = new GraphEngine(containerRef.current, {
      onNodeClick: (_id, _type) => {
        // Reserved for tooltip/hover info
      },
    });
    engineRef.current = engine;

    fetch("/api/dashboard/graph")
      .then(async (res) => {
        if (res.status === 401) {
          setStatus("error");
          setErrorMessage("Sign in to view the knowledge graph.");
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: GraphResponse = await res.json();
        if (data.nodes.length === 0) {
          setStatus("empty");
          return;
        }
        engine.init(data.nodes, data.edges);
        setActiveScene("overview");
        setStatus("ready");
      })
      .catch((err) => {
        setStatus("error");
        setErrorMessage(String(err));
      });

    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  // Escape → overview
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && activeScene && activeScene !== "overview" && activeScene !== "recent") {
        engineRef.current?.goScene("overview");
        setActiveScene("overview");
        setFocusedLabel(undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeScene]);

  const handleSceneChange = (id: SceneId) => {
    engineRef.current?.goScene(id);
    setActiveScene(id);
    setFocusedLabel(undefined);
  };

  const handleBackToOverview = () => {
    engineRef.current?.goScene("overview");
    setActiveScene("overview");
    setFocusedLabel(undefined);
  };

  if (status === "loading") return <GraphSkeleton />;
  if (status === "empty") return <GraphEmpty />;
  if (status === "error") return <GraphError message={errorMessage} />;

  return (
    <>
      <BlazeBackground />
      <nav className="nav-bar">
        <a href="/dashboard" className="nav-bar-brand">
          <div className="nav-bar-brand-icon">R</div>
          <span className="nav-bar-brand-name">Recall Bot</span>
        </a>
        <div className="nav-bar-actions">
          <a href="/dashboard" className="btn-brutal btn-brutal-sm btn-brutal-ghost">
            Dashboard
          </a>
        </div>
      </nav>

      <div className="graph-page">
        <SceneBar
          activeScene={activeScene}
          onSceneChange={handleSceneChange}
          onBackToOverview={handleBackToOverview}
          focusedLabel={focusedLabel}
        />

        <div
          ref={containerRef}
          className="graph-container"
          role="application"
          aria-label="Knowledge graph — click a thread to explore, Escape to return"
        />

        <div className="graph-controls">
          <label className="graph-controls__label">
            Float
            <input
              type="range"
              min="0"
              max="12"
              step="0.5"
              value={floatAmp}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setFloatAmp(v);
                engineRef.current?.setFloatAmp(v);
              }}
              className="graph-controls__slider"
            />
          </label>
        </div>

        <div className="graph-legend">
          <div className="graph-legend-item">
            <div className="graph-legend-swatch graph-legend-swatch--namespace" />
            Thread
          </div>
          <div className="graph-legend-item">
            <div className="graph-legend-swatch graph-legend-swatch--user" />
            User
          </div>
          <div className="graph-legend-item">
            <div className="graph-legend-swatch graph-legend-swatch--message" />
            Message
          </div>
          <div className="graph-legend-item">
            <div className="graph-legend-swatch graph-legend-swatch--file" />
            File
          </div>
        </div>
      </div>
    </>
  );
}
