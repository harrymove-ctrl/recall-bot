# FlameWrap (WebGL2 Fire-Border Accent) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an original, from-scratch `FlameWrap` React component (raw WebGL2, no 3D library) matching the public canvasui.dev prop shape closely enough to be a drop-in-compatible API, tuned down to a quiet ember accent, and wrap the dashboard's `<MorphingTabs>` tab card in it.

**Architecture:** Three new files under `dashboard-web/src/components/effects/` (component, GLSL source, color utility), no new dependencies, no `theme.css` changes. One modified file (`App.tsx`) to wire it in. Full design rationale, the tuned prop table, the reduced-fidelity decisions for `melt`/`distortion`, and a proof-of-concept GLSL sketch all live in `docs/superpowers/specs/2026-08-07-flame-wrap-design.md` — **read it before starting**, this plan assumes it.

**Tech Stack:** Existing stack (React 19, esbuild, TypeScript strict) plus nothing new — raw WebGL2 + `ResizeObserver` + `matchMedia`, all browser-native APIs already available in this repo's target (`lib: ["ES2022", "DOM", "DOM.Iterable"]` in `dashboard-web/tsconfig.json`).

## Global Constraints

- `FlameWrap` must render `children` untouched (same DOM structure, same props flowing to them) when WebGL2 is unavailable — never a blank or broken page. This is checked with the *component itself* returning early, not just a CSS `display: none` on a canvas that still exists.
- The canvas is always `pointer-events: none`. It must never intercept a click meant for `MorphingTabs`' tab buttons, its drag-reorder, or the wrapped tables' rename inputs / Archive / Revoke / "View" / issue-badge links.
- No new dependencies. No `motion`, no `lucide-react`, no `clsx`/`tailwind-merge`, no 3D library — this component uses none of `MorphingTabs`' stack, deliberately (see design doc's Non-goals).
- No `theme.css` changes, no new CSS classes. All positioning is inline styles computed in JS from a measured bounding box — keeps the component portable, matching the design doc's "arbitrary children" framing.
- `radius` at the `App.tsx` call site (`32`) **must** stay in sync with `morphing-tabs.tsx`'s `rounded-[2rem]` Tailwind class. There is no automatic way to keep these in sync — flag the coupling with a code comment at the call site (already in the design doc's Integration snippet; carry it over verbatim).
- Respect `prefers-reduced-motion: reduce` — a single static frame at mount, no RAF loop, no sparks, and a live `matchMedia` listener so toggling the OS setting mid-session takes effect without a reload.
- Named exports only (`export function FlameWrap`), no default export — matches `morphing-tabs.tsx`'s convention. **Unlike** that vendored file, do **not** add a `"use client"` directive — this is a plain esbuild SPA, not Next.js; that directive would be meaningless copy-paste cruft here.
- Before committing any task below, run `npx tsc --noEmit -p dashboard-web/tsconfig.json` and `npm run build:dashboard`. Run `npm test` once at the end (Task 5) to confirm no backend regression — this plan touches no backend code, so it's a pure regression check.
- ESM throughout, extensionless imports (Bundler resolution), matching the rest of `dashboard-web`.

---

## File Structure

```
recall-bot/
  dashboard-web/
    src/
      components/
        effects/
          flame-wrap.tsx           # NEW — FlameWrap component
          flame-wrap-shaders.ts    # NEW — GLSL vertex/fragment source
          flame-wrap-color.ts      # NEW — hex/tuple color normalization
      App.tsx                      # MODIFY — wrap <MorphingTabs> in <FlameWrap>
```

---

### Task 1: Color utility, prop types, and feature-detection scaffold

**Files:**
- Create: `dashboard-web/src/components/effects/flame-wrap-color.ts`
- Create: `dashboard-web/src/components/effects/flame-wrap.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `FlameWrap`, `type FlameWrapProps` exported from `./components/effects/flame-wrap`. Tasks 2–4 fill in this file's body; Task 5 (App.tsx) is the consumer.

This task builds the shell — types, defaults, color parsing, WebGL2/reduced-motion detection, and both fallback paths (no-WebGL2, reduced-motion) — with **no shader code yet**. The canvas element isn't even created until Task 2. This makes the two fallback paths reviewable and testable in isolation before any GLSL exists.

- [ ] **Step 1: `flame-wrap-color.ts`**

```typescript
// dashboard-web/src/components/effects/flame-wrap-color.ts
const FALLBACK_COLOR: [number, number, number] = [1, 0.42, 0.1]; // warm amber, used only if parsing fails

function hexToRgb01(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return null;
  let value = match[1];
  if (value.length === 3) {
    value = value.split("").map((c) => c + c).join("");
  }
  const num = Number.parseInt(value, 16);
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}

export function resolveFlameColor(color: string | [number, number, number]): [number, number, number] {
  if (Array.isArray(color)) return color;
  const parsed = hexToRgb01(color);
  if (parsed) return parsed;
  if (typeof process === "undefined" || process.env?.NODE_ENV !== "production") {
    console.warn(`FlameWrap: could not parse color "${color}" as hex — falling back to a default.`);
  }
  return FALLBACK_COLOR;
}
```

Note: `dashboard-web` has no `process.env` polyfill today (it's a browser bundle) — check whether `process` is defined at all in this bundle's environment before relying on the `process.env.NODE_ENV` guard above; if esbuild doesn't define it, simplify to an unconditional `console.warn` (a dev-only admin tool console warning on a malformed color string is harmless either way, so the guard is a nice-to-have, not required).

- [ ] **Step 2: `flame-wrap.tsx` — types, defaults, and feature detection (no rendering yet)**

```tsx
// dashboard-web/src/components/effects/flame-wrap.tsx
import { useEffect, useRef, useState, type ReactNode } from "react";
import { resolveFlameColor } from "./flame-wrap-color";

export interface FlameWrapProps {
  color: string | [number, number, number];
  children: ReactNode;
  intensity?: number;
  height?: number;
  spread?: number;
  radius?: number;
  speed?: number;
  scale?: number;
  turbulence?: number;
  turbulenceScale?: number;
  turbulenceReach?: number;
  sparks?: number;
  sparkSize?: number;
  sparkDensity?: number;
  sparkSpeed?: number;
  rim?: number;
  melt?: number;
  distortion?: number;
  className?: string;
}

const DEFAULTS = {
  intensity: 0.5,
  height: 170,
  spread: 8,
  radius: 40,
  speed: 0.25,
  scale: 0.75,
  turbulence: 0.5,
  turbulenceScale: 1.0,
  turbulenceReach: 60,
  sparks: 1.5,
  sparkSize: 3,
  sparkDensity: 14,
  sparkSpeed: 40,
  rim: 1.0,
  melt: 4.5,
  distortion: 10,
} as const satisfies Omit<Required<FlameWrapProps>, "color" | "children" | "className">;

export const MAX_SPARKS = 24;

let webgl2Supported: boolean | null = null;
function supportsWebGL2(): boolean {
  if (webgl2Supported !== null) return webgl2Supported;
  try {
    const probe = document.createElement("canvas");
    webgl2Supported = Boolean(probe.getContext("webgl2"));
  } catch {
    webgl2Supported = false;
  }
  return webgl2Supported;
}

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduce(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return reduce;
}

export function FlameWrap({ children, className, ...rawProps }: FlameWrapProps) {
  const props = { ...DEFAULTS, ...rawProps };
  const reduce = usePrefersReducedMotion();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hasWebGL2 = supportsWebGL2();

  // Task 2 fills in the GL init/render effect here, gated on `hasWebGL2`.

  if (!hasWebGL2) return <>{children}</>;

  return (
    <div ref={wrapperRef} className={className} style={{ position: "relative" }}>
      <canvas ref={canvasRef} aria-hidden style={{ position: "absolute", pointerEvents: "none" }} />
      {children}
    </div>
  );
}
```

- [ ] **Step 3: Verify types and build**

```bash
npx tsc --noEmit -p dashboard-web/tsconfig.json
npm run build:dashboard
```

Expected: zero errors. `FlameWrap` isn't imported anywhere yet, so this only validates the new files in isolation (unused-export is fine — `noUnusedLocals`/`noUnusedParameters` aren't set in `dashboard-web/tsconfig.json`, confirm that's still true before assuming this is silent).

- [ ] **Step 4: Commit**

```bash
git add dashboard-web/src/components/effects/flame-wrap.tsx dashboard-web/src/components/effects/flame-wrap-color.ts
git commit -m "feat(dashboard): add FlameWrap scaffold (props, color parsing, WebGL2/reduced-motion detection)"
```

---

### Task 2: Shaders and the core render loop (border, glow, turbulence, rim, melt, distortion — no sparks yet)

**Files:**
- Create: `dashboard-web/src/components/effects/flame-wrap-shaders.ts`
- Modify: `dashboard-web/src/components/effects/flame-wrap.tsx`

**Interfaces:**
- Consumes: `FLAME_WRAP_VERTEX_SHADER`, `FLAME_WRAP_FRAGMENT_SHADER` from the new shaders file.
- Produces: a working, visible (once temporarily wired up per Step 3 below) fire-border render, minus sparks.

- [ ] **Step 1: `flame-wrap-shaders.ts`**

Adapt the proof-of-concept sketch in `docs/superpowers/specs/2026-08-07-flame-wrap-design.md` ("Proof-of-concept GLSL sketch" section) into two exported `const` strings, `FLAME_WRAP_VERTEX_SHADER` and `FLAME_WRAP_FRAGMENT_SHADER`. For this task, **omit the sparks loop entirely** (Task 3 adds it) — drop `u_sparks`/`u_sparkSize`/`u_sparkCount`/`u_sparkSpeed` and the `for` loop from the fragment shader for now, and set `alpha`/`rgb` from `glow + rimGlow + inward * 0.6` only. Re-add the spark uniforms and loop in Task 3 rather than leaving unused uniforms sitting around this task's version.

Keep both cited techniques' credit comments (`sdRoundBox` — Inigo Quilez; `snoise` — Ashima Arts / Ian McEwan) intact — they're there because both are genuinely well-known public techniques, not because they need permission, but removing the attribution would be a worse look for no benefit.

- [ ] **Step 2: GL init + render loop in `flame-wrap.tsx`**

Fill in the `useEffect` marked in Task 1 Step 2. In order:

1. Bail out immediately if `!hasWebGL2` (defensive — the component already returns early above this point, but the effect can still fire once before that return commits in some render orders; guard it explicitly).
2. `canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: "low-power" })`.
3. Compile both shaders, link the program, `gl.useProgram`. On any compile/link failure, `console.error` the shader info log and fall back to not drawing anything further this mount (do not throw — a shader bug should degrade to "no effect," not a crashed page).
4. `gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);` — premultiplied-alpha blending, matching the context's `premultipliedAlpha: true` and the shader's `fragColor = vec4(rgb * alpha, alpha)`. Getting this blend func wrong is the single most likely source of an ugly dark fringe around the glow — call this out in review.
5. Look up every uniform location once (`gl.getUniformLocation`), store in a ref.
6. `ResizeObserver` on `wrapperRef.current` (not on `children` — matches `morphing-tabs.tsx`'s own pattern of observing its root, not individual children) measuring the box, then:
   - Compute canvas element size: content box + `Math.ceil(props.height) + buffer` on top, `Math.ceil(props.spread) + buffer` on the other three sides (`buffer` = a few px for AA/turbulence overshoot — `4` is a reasonable starting point, tune visually).
   - Position the canvas via inline `top`/`left`/`width`/`height` (negative insets on top/left relative to the wrapper).
   - Set the canvas's backing-store size to `cssWidth * dpr` / `cssHeight * dpr` where `dpr = Math.min(window.devicePixelRatio, 2)`, and `gl.viewport(0, 0, backingWidth, backingHeight)`.
   - Skip the resize/redraw entirely if the measured box is `0×0` (see design doc's Error handling — don't divide by zero or upload NaN uniforms).
7. `document.visibilitychange` listener — cancel the RAF loop when `document.hidden`, restart it when visible again (only if `!reduce`).
8. The render function: compute `u_time` from a `startTime` captured once (`(performance.now() - startTime) / 1000 * props.speed`), upload every uniform, `gl.clear(gl.COLOR_BUFFER_BIT)`, `gl.drawArrays(gl.TRIANGLES, 0, 3)`.
   - If `reduce` is true: call the render function exactly once with `u_time = 0` and never schedule a `requestAnimationFrame`.
   - Otherwise: a normal `requestAnimationFrame` loop, respecting the visibility pause from Step 7.
9. Cleanup on unmount / dependency change: `cancelAnimationFrame`, `resizeObserver.disconnect()`, remove the `visibilitychange` listener, `gl.deleteProgram(program)` (and any buffers/textures added later).
10. `webglcontextlost` / `webglcontextrestored` — `event.preventDefault()` on `contextlost` (required to make restoration possible at all), cancel the RAF loop on loss, re-run the init path on restore. Wire this in this task even though it's a rare path — it's a handful of lines and the alternative is a silently broken canvas after any GPU driver hiccup.

Prop changes (color, intensity, height, etc.) should update the uniforms on the next frame without a full teardown/rebuild of the GL program — keep the effect's dependency array scoped to things that actually require re-init (mount, `reduce` flipping) versus things that just need a fresh uniform upload (every other prop) to avoid recompiling shaders on every keystroke-adjacent re-render. A `useRef` holding the latest `props` object, read from inside the RAF callback, is the simplest way to get this without over-splitting the effect into many small ones.

- [ ] **Step 3: Temporary local verification (do not commit)**

Locally and temporarily, wrap something visible in `App.tsx` — e.g. `<FlameWrap color="#2e00ff" height={40} spread={20}><MorphingTabs .../></FlameWrap>` with deliberately larger-than-final numbers so the effect is easy to see — and run the dev server. Confirm: a glowing rounded-rect border appears around the tab card, roughly tracing its corners; the noise makes the edge flicker rather than sit perfectly still; disabling WebGL2 (temporarily forcing `supportsWebGL2()` to return `false`) shows the card with zero visual difference from before this task; emulating reduced motion in DevTools freezes the border with no flicker. **Revert this temporary `App.tsx` edit** before moving on — Task 5 does the real, permanent, tuned-down wiring.

- [ ] **Step 4: Verify types and build**

```bash
npx tsc --noEmit -p dashboard-web/tsconfig.json
npm run build:dashboard
```

- [ ] **Step 5: Commit**

```bash
git add dashboard-web/src/components/effects/flame-wrap-shaders.ts dashboard-web/src/components/effects/flame-wrap.tsx
git commit -m "feat(dashboard): implement FlameWrap's fire-border shader and render loop"
```

---

### Task 3: Sparks

**Files:**
- Modify: `dashboard-web/src/components/effects/flame-wrap-shaders.ts`
- Modify: `dashboard-web/src/components/effects/flame-wrap.tsx`

**Interfaces:**
- Consumes: nothing new externally.
- Produces: the four spark uniforms (`u_sparks`, `u_sparkSize`, `u_sparkCount`, `u_sparkSpeed`) wired end-to-end.

- [ ] **Step 1: Add `pointOnRoundedRectPerimeter` and the spark loop to the fragment shader**

The proof-of-concept sketch left this as a deliberate gap:

```glsl
// Given arc-length fraction s in [0,1) and a rounded-rect half-size/radius, return the
// point on its perimeter at that fraction of the total arc length. Straightforward but
// fiddly: the perimeter is 4 straight segments + 4 quarter-circle arcs, of different
// lengths depending on halfSize vs radius; walk the segments in order, accumulating
// length, and return the position on whichever segment/arc contains `s * totalPerimeter`.
vec2 pointOnRoundedRectPerimeter(float s, vec2 halfSize, float r) { /* ... */ }
```

Re-add the spark uniforms (`uniform float u_sparks; uniform float u_sparkSize; uniform int u_sparkCount; uniform float u_sparkSpeed;`) and the per-instance loop from the design doc's sketch, replacing its `borderPos = p` placeholder with a real call to `pointOnRoundedRectPerimeter(s, half, u_radius)`. Keep the `MAX_SPARKS`(24)-capped `for` loop with an early `break` on `i >= u_sparkCount` — this is what keeps sparks a single-draw-call, no-instancing-needed feature.

- [ ] **Step 2: Wire `sparkDensity` → `u_sparkCount` on the JS side**

`sparkDensity` is documented as "target concurrent count" — clamp it into an actual integer uniform: `Math.min(MAX_SPARKS, Math.max(0, Math.round(props.sparkDensity)))`. If `props.sparks <= 0`, skip uploading spark uniforms at all (or upload `u_sparkCount = 0`) — `sparks: 0` disabling the feature entirely is explicit in the target prop API and should be a cheap early-out, not just an invisible-but-still-computed loop.

- [ ] **Step 3: Temporary local verification (do not commit)**

Same throwaway `App.tsx` wrap as Task 2 Step 3, with `sparks` turned up (e.g. `sparks={2} sparkDensity={10} sparkSize={3}`) to make them easy to see: confirm small bright points drift outward from the border over time, fading out, and that `sparks={0}` visibly removes them entirely (not just dims them). Revert the temporary edit afterward.

- [ ] **Step 4: Verify types and build**

```bash
npx tsc --noEmit -p dashboard-web/tsconfig.json
npm run build:dashboard
```

- [ ] **Step 5: Commit**

```bash
git add dashboard-web/src/components/effects/flame-wrap-shaders.ts dashboard-web/src/components/effects/flame-wrap.tsx
git commit -m "feat(dashboard): add spark particles to FlameWrap"
```

---

### Task 4: Wire FlameWrap into the Dashboard view

**Files:**
- Modify: `dashboard-web/src/App.tsx`

**Interfaces:**
- Consumes: `FlameWrap` from `./components/effects/flame-wrap` (Tasks 1–3).
- Produces: no new exports — terminal consumer.

- [ ] **Step 1: Import and wrap**

Add the import and wrap the existing `<MorphingTabs .../>` call exactly as in the design doc's Integration section — copy it verbatim rather than re-deriving the numbers, they're the reviewed, rationale-backed tuned values:

```tsx
import { FlameWrap } from "./components/effects/flame-wrap";
```

```tsx
<FlameWrap
  color="#2e00ff"
  intensity={0.18}
  height={14}
  spread={5}
  radius={32} // keep in sync with morphing-tabs.tsx's `rounded-[2rem]` — see design doc
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
```

No other changes to `Dashboard` — `tabs`, `activeTab`, `setActiveTab`, and everything else stay exactly as they are today.

- [ ] **Step 2: Verify types and build**

```bash
npx tsc --noEmit -p dashboard-web/tsconfig.json
npm run build:dashboard
```

Expected: zero errors, `dist/dashboard-web/bundle.js` regenerated with no new external dependencies pulled in (this task adds zero `package.json` entries — if the bundle size jumps meaningfully, something unexpected got imported; check for an accidental `motion`/`lucide-react` import inside `flame-wrap.tsx`, which shouldn't exist per Global Constraints).

- [ ] **Step 3: Commit**

```bash
git add dashboard-web/src/App.tsx
git commit -m "feat(dashboard): wrap the dashboard tab card in FlameWrap"
```

---

### Task 5: Full verification

**Files:** none (verification only, no commit)

- [ ] **Step 1: Run the full backend test suite**

```bash
npm test
```

Expected: all existing tests pass — this plan touches no backend code, this is a pure regression check.

- [ ] **Step 2: Manual end-to-end check against the local test database**

Start the server locally (`DATABASE_URL=postgres://recall:recall@localhost:55432/recall_test npm run dev`, a free `PORT`, distinct `DASHBOARD_SESSION_SECRET`/`USER_SESSION_SECRET`/`SLACK_STATE_SECRET`, matching `PUBLIC_BASE_URL` — per the worktree setup already established for this session). Seed at least one namespace and one user with a delegate key, claim a session, and confirm, in order:

1. The dashboard loads with the tab card showing a faint blue-violet molten outline tracing its actual rounded corners — present on close inspection, not dominating the page at a glance.
2. A few small sparks occasionally drift off the border; they're easy to miss if you're not looking for them, which is the point.
3. Switching tabs (Namespaces / Users / Analytics) still morphs correctly — the liquid tab-surface animation and the panel's blur/fade transition both look exactly as they did before this plan.
4. Drag-reordering a tab still works (pointer down, drag, release) — the FlameWrap canvas never grabs the drag gesture.
5. Namespace rename-on-blur, Archive, and the "View"/issue-badge links still work; the Users table's Revoke button still works.
6. Resizing the browser window keeps the flame outline aligned to the card — no drift, no stale-sized canvas.
7. DevTools → emulate `prefers-reduced-motion: reduce` → the border freezes (no flicker, no sparks) without a reload; toggling the emulation back off resumes animation live.
8. Force WebGL2 unavailable (DevTools has a WebGL disable in some versions; otherwise a temporary one-line local edit to `supportsWebGL2()` returning `false`) → the tab card renders identically to how it looked before this entire plan, zero console errors, zero layout shift.

- [ ] **Step 3: Self-review the full diff**

```bash
git diff main --stat
```

Read every changed/new file. Confirm: no new `package.json` dependency; no `theme.css` changes; the canvas is `pointer-events: none` everywhere it's rendered; `radius={32}` at the call site has its "keep in sync with `morphing-tabs.tsx`" comment; the reduced-motion and no-WebGL2 fallback paths are both real early returns, not CSS hacks; `flame-wrap.tsx` has no `"use client"` directive; every `useEffect` that starts a `ResizeObserver`/`requestAnimationFrame`/event listener has a matching cleanup.
