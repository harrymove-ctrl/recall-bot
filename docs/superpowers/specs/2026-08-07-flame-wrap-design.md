# FlameWrap — WebGL2 Fire-Border Accent for the Dashboard Tab Card — Design

**Status:** Draft — ready for review
**Sub-project:** 9 of N (FlameWrap fire-border accent). Extends sub-project 4 (dashboard tabs — introduced `morphing-tabs.tsx` and its `bg-[#fafafa]` card, the element this wraps, merged to `main`) and picks up directly where that component's own history left off: two rounds of stripping a mismatched dark/heavy visual treatment off it (`8fa250d` "drop the dark tab chrome for a light palette", `3b08260` before it, "give the tab chrome transparency, gradient, and blur instead of a flat solid block"). That lesson — one cohesive, light, minimal system; no bolted-on foreign chrome — is the design constraint this whole spec is organized around. Purely a decorative/visual wrapper — no data, auth, or capture-pipeline changes. Independent of sub-project 6 (onboarding flow) and sub-project 8 (personal view); onboarding flow has **not** merged as of this writing (no `public/index.html`, no Getting Started panel in `App.tsx`) and, per its own design doc, will also touch the `Dashboard` component's return JSX — whichever of the two lands second should expect a small rebase (see Open items).

## Goal

Wrap the `Dashboard` component's `<MorphingTabs>` card — the rounded, hairline-bordered `#fafafa` panel rendering the Namespaces/Users/Analytics tab rail and content — in an original, from-scratch WebGL2 "FlameWrap" effect: a molten outline tracing the card's rounded border, a handful of drifting sparks, and a faint heat-shimmer right at the edge.

The public API shape (prop names, semantics, defaults) is deliberately modeled on the paid canvasui.dev `FlameWrap` component's public docs — a call site written against that shape is easy to reason about, and easy to re-point at the real thing later if it's ever licensed. But every line of GLSL and JS in this doc and the implementation it plans is new, original work. Nothing was fetched, scraped, or copied from canvasui.dev.

## Non-goals

- **Not a reproduction of canvasui.dev's implementation.** Only the prop names/semantics/defaults from the "Target prop API" brief (already public, fair to reference as an API shape) are the target. No access to, and no attempt to access, their actual GLSL or bundle.
- **Not a general-purpose particle/fire engine.** No instanced draw calls, no CPU-side particle buffer, no Three.js or any other 3D library — this repo has zero 3D dependencies today and one decorative effect doesn't justify adding one. Sparks are a small fixed-count loop inside a single fragment shader running on a single full-screen triangle: one draw call, full stop.
- `smoke`, `ember`, `scorch` are cut for v1 — not implemented, not stubbed. See "Dropped props."
- No true per-pixel displacement of the wrapped DOM content for `distortion`, and no real silhouette cutout for `melt`. See "Reduced-fidelity props." Both are deliberate scope cuts, not oversights.
- No visual or motion changes to `MorphingTabs` itself. FlameWrap is a pure outer wrapper; the liquid tab-morph, drag-reorder, and tab-switch blur/fade animations inside the card are untouched and must keep working exactly as they do today.
- No new `theme.css` tokens or classes, no new dependencies, no `package.json` changes. FlameWrap positions itself entirely via inline styles computed in JS and reads no CSS custom properties from the host page — it's written to be a portable component that could wrap any block-level children, not something coupled to this dashboard's stylesheet.

## Design reference

Source: the "Target prop API" section of the task brief — prop names, types, semantics, and defaults extracted from canvasui.dev's public docs/demo pages. Fair-use API-shape reference, not their source.

Two public, well-known GLSL techniques are the building blocks (cited inline in code, not proprietary to any vendor):
- **Rounded-box signed distance field** — the standard `sdRoundBox` formula from Inigo Quilez's public 2D SDF reference (iquilezles.org/articles/distfunctions2d), used in essentially every SDF-based shader that needs a rounded rect.
- **2D simplex noise** — the classic Ashima Arts / Ian McEwan `webgl-noise` GLSL snippet (MIT-licensed, ubiquitous in WebGL fire/water/cloud demos), used for the flame's turbulence.

The visual target is explicitly **not** canvasui.dev's own demo (a large, bright, hero-section-scale fire). It's closer to a single glowing ember tracing a rounded edge — the same restraint already applied twice to `morphing-tabs.tsx` itself, applied here before a mismatch ever ships instead of after.

## Target prop API vs. this dashboard's tuned usage

FlameWrap's own component defaults track the library's documented defaults as closely as reasonable (so the component reads as a faithful, general-purpose implementation of the public API shape). The call site in `App.tsx` overrides nearly every one of them down to a quiet accent, per the explicit "subtle, not a spectacle" direction. Two props (`color`, `children`) have no sensible library-style default and are required.

| Prop | Type | FlameWrap's own default | **This dashboard's tuned value** |
|---|---|---|---|
| `color` | `string \| [number, number, number]` | *(required — see below)* | `"#2e00ff"` |
| `children` | `React.ReactNode` | *(required)* | `<MorphingTabs .../>` |
| `intensity` | `number` | `0.5` | `0.18` |
| `height` | `number` (px) | `170` | `14` |
| `spread` | `number` (px) | `8` | `5` |
| `radius` | `number` (px) | `40` | `32` (must match `morphing-tabs.tsx`'s `rounded-[2rem]`) |
| `speed` | `number` | `0.25` | `0.18` |
| `scale` | `number`, 0–1 | `0.75` | `0.55` |
| `turbulence` | `number` | `0.5` | `0.3` |
| `turbulenceScale` | `number` | `1.0` | `0.8` |
| `turbulenceReach` | `number` (px) | `60` | `20` |
| `sparks` | `number` (0 disables) | `1.5` | `0.4` |
| `sparkSize` | `number` (px) | `3` | `1.6` |
| `sparkDensity` | `number` (target concurrent count) | `14` | `3` |
| `sparkSpeed` | `number` (px/s) | `40` | `18` |
| `rim` | `number` | `1.0` | `0.5` |
| `melt` | `number` (px, reduced-fidelity — see below) | `4.5` | `2` |
| `distortion` | `number` (px, reduced-fidelity — see below) | `10` | `3` |
| `className` | `string \| undefined` | `undefined` | *(not passed)* |

`color` has no default in the public brief either (every other numeric prop is given an explicit default; `color` isn't) — there's no principled default fire color, and every actual call site here always passes one, so it's typed as **required** rather than guessed at.

### Why these tuned numbers, not the library defaults

1. **`height: 14` (not the library's `170`).** The brief calls this out explicitly as needing to be "MUCH smaller" for this use case, and it's the single biggest lever on whether this reads as an accent or a spectacle — 170px of flame reaching above a ~56px-tall tab rail on a 900px-max-width admin page would dominate the page. 14px is on the order of the card's own corner radius: present, legible on hover-close inspection, invisible at a glance.
2. **`radius: 32`, exactly (not the library's `40`).** This isn't a "subtle" aesthetic choice, it's a correctness requirement: `morphing-tabs.tsx`'s root div is `rounded-[2rem]` = 32px. If FlameWrap's outline radius doesn't match the actual card's CSS radius, the molten border visibly drifts away from the card's real edge at the corners. This is a hard coupling between two files that live in different components — flagged explicitly at the call site with a comment, and again in the plan's Global Constraints, precisely because nothing enforces it automatically.
3. **`intensity: 0.18`, `sparks: 0.4`, `rim: 0.5` — all well under half their library defaults.** These three are the "how loud is this" knobs. Bias conservative, per the explicit direction: it's much cheaper to turn a too-quiet effect up later than to have shipped something that repeats the exact "heavy foreign chrome on an otherwise light page" mistake this dashboard already backed out of twice.
4. **`turbulence`, `turbulenceScale`, `turbulenceReach`, `scale`, `speed` all scaled down together, not independently.** These jointly control how "busy" and how fast the noise reads. Scaling only the amplitude (`turbulence`) while leaving frequency/speed at library defaults would produce a small-but-frantic flicker — visually louder than the raw numbers suggest. All five move toward "broader, slower, calmer" together; `turbulenceReach: 20` in particular is sized to roughly match the (now-tiny) `height`/`spread` reach itself, so the noise doesn't wobble across a footprint larger than the glow it's supposed to be perturbing.
5. **`melt: 2`, `distortion: 3` — both small even before accounting for their reduced-fidelity implementation below.** At this scale the two reduced-fidelity approximations (an alpha-blended glow band instead of a true silhouette cut / true pixel displacement) are visually indistinguishable from the literal effect anyway — another reason the fidelity cut is an acceptable trade at these tuned values, even though it wouldn't be at the library's own defaults (4.5px / 10px).

## Dropped props (v1 non-goals)

`smoke`, `ember`, `scorch` are not implemented:

- **`smoke`** — rising smoke wisps above the flame. This is pure spectacle by definition (atmosphere with no functional signal) and directly works against "a quiet ember-like accent." It would also be the single most expensive addition (a second, larger-radius noise layer with its own alpha compositing) for the least value at this intensity.
- **`ember`** — glowing ember-particle atmosphere, distinct from `sparks` in the library's docs but visually overlapping with what `sparks` + `rim` already cover here. Adding a second, near-redundant particle layer isn't worth the complexity for an effect that's supposed to be barely noticed.
- **`scorch`** — a persistent darkening/burn-mark accumulation on the surface. This one is a different *kind* of feature, not just more atmosphere: it implies state that persists and accumulates over time (the surface "remembers" being burned), where everything else here is a stateless, continuously-looping decorative render. Building real accumulated state for a decorative effect on an admin dashboard isn't proportionate.

All three can be added later behind new props with no breaking change to the ones implemented here, if the visual direction ever shifts toward something more expressive.

## Reduced-fidelity props

Two props are implemented, but not literally:

- **`distortion` (heat-shimmer near the edges).** The literal reading — displacing the actual rendered pixels of the wrapped DOM content — isn't done. Reasons, in order of how hard each is a blocker:
  1. **Cross-origin images taint the canvas.** The wrapped card renders Slack avatar `<img>` tags (`u.avatarUrl`, from Slack's CDN) with no control over their CORS headers. Any approach that needs to rasterize the DOM into a WebGL texture (e.g. `foreignObject` → image → canvas, or an `html2canvas`-style capture) either throws on `drawImage` or silently produces a blank/frozen texture the moment an avatar is present — not a corner case, the Users tab hits it on every render.
  2. **A live per-frame DOM rasterization is expensive** and would need to run continuously for a shimmer that's supposed to be barely perceptible.
  3. **A CSS-only route (`feDisplacementMap` via `filter`/`backdrop-filter` on the content itself)** has inconsistent cross-browser support, and — more importantly for an *admin tool* — visually displacing an interactive element can create a mismatch between where something is drawn and where it's actually clickable, which is a real usability cost on a card whose whole job is rename-on-blur inputs, Archive/Revoke buttons, and drag-to-reorder tabs.

  Instead, `distortion` controls how far inward (in px) the flame's own noise-perturbed edge is allowed to read as a "shimmer band" sitting on top of the content, at low alpha, using the same turbulence noise as the outward glow. It reads as heat haze bleeding onto the edge without moving a single actual content pixel or touching hit-testing at all. This is the prop with the largest gap between "literal library semantics" and "what's actually built" — called out here so it isn't mistaken for a bug later.

- **`melt` (fire eating into the content silhouette).** Same shape of decision, lower stakes: rather than an actual silhouette cutout (a mask that hides the outer N px of content), `melt` is an inward alpha-blended glow band, using the same SDF/noise as everything else. At `melt: 2`, the practical visual difference between "hides 2px of the edge" and "glows warmly over the outer 2px of the edge" is negligible, and the latter avoids a second compositing layer (an SVG mask with its own sizing/ID-collision bookkeeping, echoing the `morphing-tabs.tsx` comment about its own fixed gradient ID only being safe because a single instance renders at a time) for a difference nobody will see.

Both bands share one implementation detail: they're drawn by the *same* WebGL canvas that draws the outward glow (see Components below) — additively/alpha-blended on top of the DOM, not a second layer. `pointer-events: none` on the canvas means neither band can ever intercept a click regardless of how far inward it reads.

## Components

New files, all under a new `components/effects/` directory (parallel to the existing `components/motion/`):

1. **`dashboard-web/src/components/effects/flame-wrap.tsx`** — the `FlameWrap` component. Owns: prop defaults, children measurement (`ResizeObserver` on its own wrapper `div`, same pattern `morphing-tabs.tsx` already uses on its root), WebGL2 feature detection with a plain-children fallback, `prefers-reduced-motion` detection (static single frame, no RAF, no sparks) with a live `matchMedia` change listener, the RAF render loop (paused on `document.visibilitychange`), and cleanup (cancel RAF, disconnect observer, remove listeners, delete GL objects) on unmount. No default export — named export only, matching `morphing-tabs.tsx`'s convention. Unlike that file, **no `"use client"` directive** — that only exists there because it was vendored verbatim from a Next.js-shaped registry; this is a plain esbuild-bundled SPA and the directive would be meaningless cruft here.
2. **`dashboard-web/src/components/effects/flame-wrap-shaders.ts`** — exported GLSL source strings (`FLAME_WRAP_VERTEX_SHADER`, `FLAME_WRAP_FRAGMENT_SHADER`). The cited `sdRoundBox` and `snoise` functions live here, each with a one-line comment crediting the public technique.
3. **`dashboard-web/src/components/effects/flame-wrap-color.ts`** — `resolveFlameColor(color: string | [number, number, number]): [number, number, number]`, converting `"#2e00ff"`-style hex (3- or 6-digit) to a 0–1 RGB triple, passing a tuple through unchanged, and falling back to a neutral default with a dev-only `console.warn` on anything unparseable (never throws).
4. **`dashboard-web/src/App.tsx`** (modified) — `Dashboard`'s return JSX wraps `<MorphingTabs .../>` in `<FlameWrap>` with the tuned props from the table above; one new import line.

No `package.json` changes (zero new dependencies — raw WebGL2 + React only). No `theme.css` changes.

### Why one canvas, sized to the card plus a margin, not a full-viewport canvas

The canvas is `position: absolute`, sized to the measured content box plus an outward margin (`height` on top, `spread` on the other three sides, each plus a small buffer for the noise's overshoot and shader-side antialiasing), sitting as an extra sibling inside FlameWrap's own `position: relative` wrapper `div` — not a full-viewport canvas layered over the whole page. This keeps the draw area (and therefore the per-frame fragment cost) proportional to the one card being decorated, keeps the component usable anywhere without a global canvas singleton, and means resizing/repositioning is just "remeasure this one box," not "track every FlameWrap instance against a shared canvas's coordinate space" (a real problem the single-instance-only comment in `morphing-tabs.tsx`'s SVG gradient ID already hints this codebase would rather not deal with more than once).

`pointer-events: none` on the canvas is load-bearing: it's the entire reason layering it *above* `MorphingTabs` in paint order is safe. Clicks always fall through to the real DOM underneath regardless of z-index, so the tab rail's drag-reorder, the tab buttons themselves, and the wrapped tables' rename inputs / Archive / Revoke buttons never need to know FlameWrap exists.

## Proof-of-concept GLSL sketch

This is an illustrative sketch to de-risk the build phase, not a working file — exact constants and the spark-position parametrization are left as documented gaps for the plan to fill in.

```glsl
// flame-wrap-shaders.ts — FLAME_WRAP_VERTEX_SHADER
#version 300 es
// Fullscreen-triangle trick: no vertex buffer needed, one drawArrays(TRIANGLES, 0, 3) call.
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
```

```glsl
// flame-wrap-shaders.ts — FLAME_WRAP_FRAGMENT_SHADER
#version 300 es
precision highp float;

uniform vec2  u_boxSize;          // wrapped content box, canvas px (not counting margin)
uniform vec2  u_boxCenter;        // wrapped content box center, canvas px
uniform float u_radius;           // corner radius, px — MUST match the wrapped card's own CSS radius
uniform vec3  u_color;            // 0-1 rgb, from resolveFlameColor()
uniform float u_intensity;
uniform float u_height;           // px, outward reach above the top edge
uniform float u_spread;           // px, outward reach past sides/bottom
uniform float u_time;             // elapsed seconds * speed
uniform float u_scale;            // 0-1, flame noise detail
uniform float u_turbulence;       // noise amplitude
uniform float u_turbulenceScale;  // noise spatial frequency multiplier
uniform float u_turbulenceReach;  // px, how far from the border the turbulence is allowed to act
uniform float u_rim;              // molten-rim intensity
uniform float u_melt;             // px, inward glow band (reduced-fidelity — see design doc)
uniform float u_distortion;       // px, inward shimmer band (reduced-fidelity — see design doc)
uniform float u_sparks;           // spark brightness, 0 disables
uniform float u_sparkSize;        // px
uniform int   u_sparkCount;       // derived from sparkDensity on the JS side, clamped to MAX_SPARKS
uniform float u_sparkSpeed;       // px/s

out vec4 fragColor;

// Rounded-box SDF — Inigo Quilez, iquilezles.org/articles/distfunctions2d (public technique).
float sdRoundBox(vec2 p, vec2 halfSize, float r) {
  vec2 q = abs(p) - halfSize + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// 2D simplex noise — Ashima Arts / Ian McEwan, webgl-noise (MIT license, public/ubiquitous).
vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

void main() {
  vec2 p = gl_FragCoord.xy - u_boxCenter;   // card-local coords, px
  vec2 half = u_boxSize * 0.5;
  float d = sdRoundBox(p, half, u_radius);  // negative inside, positive outside

  // Finite-difference gradient of the SDF ~= outward normal direction at this point.
  vec2 e = vec2(1.0, 0.0);
  vec2 grad = normalize(vec2(
    sdRoundBox(p + e.xy, half, u_radius) - sdRoundBox(p - e.xy, half, u_radius),
    sdRoundBox(p + e.yx, half, u_radius) - sdRoundBox(p - e.yx, half, u_radius)
  ));
  // grad.y ~ -1 at the top edge, ~0 at the sides, ~+1 at the bottom: blend height vs. spread reach.
  float topWeight = smoothstep(0.2, -0.6, grad.y);
  float reach = mix(u_spread, u_height, topWeight);

  // Turbulence perturbs the distance field itself so the edge flickers instead of tracing
  // a perfectly smooth offset curve. Amplitude fades to 0 beyond turbulenceReach.
  float freq = mix(0.08, 0.4, u_scale) * u_turbulenceScale;
  float n = snoise(p * freq + vec2(0.0, u_time));
  float turbAmount = u_turbulence * smoothstep(u_turbulenceReach, 0.0, abs(d));
  float dTurb = d - n * turbAmount * 14.0;

  // Outward glow (the flame reaching past the edge).
  float glow = (1.0 - smoothstep(0.0, reach, dTurb)) * step(0.0, dTurb);

  // Rim: a bright core right at the boundary.
  float rimGlow = (1.0 - smoothstep(0.0, 3.0, abs(dTurb))) * u_rim;

  // Melt + distortion: soft inward bleed over the content, same noise, reduced-fidelity
  // per the design doc (an alpha-blended band, not a real cutout or pixel displacement).
  float inwardReach = u_melt + u_distortion;
  float inward = (1.0 - smoothstep(-inwardReach, 0.0, dTurb)) * step(dTurb, 0.0);

  float alpha = clamp(glow + rimGlow + inward * 0.6, 0.0, 1.0) * u_intensity;
  vec3 rgb = u_color * (1.0 + rimGlow * 0.6); // rim pushes the core toward brighter/whiter

  // Sparks: MAX_SPARKS(24)-capped analytic loop, each a soft point sprite drifting off the
  // border along the outward normal. pointOnRoundedRectPerimeter(s, half, radius) — a
  // closed-form "arc-length s -> point on the rounded-rect boundary" helper — is the one
  // piece intentionally left unwritten here; it's a mechanical function, not a design risk.
  for (int i = 0; i < 24; i++) {
    if (i >= u_sparkCount) break;
    float seed = float(i) * 12.9898;
    float life = fract(u_time * (u_sparkSpeed / 200.0) + seed);
    float s = fract(sin(seed) * 43758.5453);
    vec2 borderPos = p; // TODO(build phase): pointOnRoundedRectPerimeter(s, half, u_radius)
    vec2 drift = grad * life * u_height * 0.6;
    float sparkD = length(p - (borderPos + drift));
    float spark = exp(-sparkD * sparkD / (u_sparkSize * u_sparkSize)) * (1.0 - life);
    alpha += spark * u_sparks * 0.5;
    rgb = mix(rgb, vec3(1.0), spark * 0.5);
  }

  // Premultiplied — must match the WebGL context's premultipliedAlpha: true (see Performance).
  fragColor = vec4(rgb * alpha, alpha);
}
```

## JS-side structure sketch

```tsx
// flame-wrap.tsx — illustrative shape, not final code
export interface FlameWrapProps {
  color: string | [number, number, number];
  children: React.ReactNode;
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

const MAX_SPARKS = 24;

// Cached at module scope — the answer can't change mid-session.
let webgl2Supported: boolean | null = null;
function supportsWebGL2(): boolean {
  if (webgl2Supported !== null) return webgl2Supported;
  const probe = document.createElement("canvas");
  webgl2Supported = Boolean(probe.getContext("webgl2"));
  return webgl2Supported;
}

export function FlameWrap({ children, className, ...props }: FlameWrapProps) {
  const reduce = usePrefersReducedMotion(); // matchMedia("(prefers-reduced-motion: reduce)"), live-updating
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!supportsWebGL2()) return; // no canvas mounted at all — plain children fallback
    // ... compile/link program, get uniform locations, set gl.blendFunc / clearColor,
    // ResizeObserver on wrapperRef sizing + repositioning the canvas,
    // document.visibilitychange pausing the RAF loop,
    // RAF loop calling render(t) -> uniform upload -> gl.drawArrays(TRIANGLES, 0, 3)
    // (single static frame + no loop at all when `reduce` is true, sparks skipped too),
    // "webglcontextlost"/"webglcontextrestored" handling,
    // full cleanup (cancelAnimationFrame, observer.disconnect(), gl.deleteProgram, etc.) on unmount.
  }, [reduce, props /* individual prop deps in the real implementation */]);

  if (!supportsWebGL2()) return <>{children}</>;

  return (
    <div ref={wrapperRef} className={className} style={{ position: "relative" }}>
      <canvas ref={canvasRef} aria-hidden style={{ position: "absolute", pointerEvents: "none" }} />
      {children}
    </div>
  );
}
```

## Reduced motion and WebGL2 fallback handling

- **`prefers-reduced-motion: reduce`** — one static frame is rendered at mount (`u_time` fixed at `0`, sparks skipped entirely — a frozen spark reads as a stray dot, not a design), and no RAF loop ever starts. The `matchMedia` listener is live: flipping the OS setting while the page is open starts or stops the loop immediately, no reload needed. This mirrors the intent of `morphing-tabs.tsx`'s own `useReducedMotion()` handling (skip animation, keep the content) even though the mechanism differs — that component uses `motion/react`'s hook because it's already using that library for everything else; a raw-WebGL2 component has no reason to pull in `motion` just for this one check, so it uses the underlying `matchMedia` query directly.
- **No WebGL2** — `supportsWebGL2()` (module-scoped, checked once) gates both the render effect and the JSX itself: if false, `FlameWrap` renders `children` directly, no wrapper `div`, no canvas element, nothing. Exactly the "graceful degradation, not a broken/blank page" requirement, and cheap enough to check unconditionally on every mount.
- **Context loss** (`webglcontextlost`) — cancel the RAF loop immediately and suppress draws; `webglcontextrestored` re-runs the same init path used on mount. Rare on a decorative admin-tool canvas, cheap to handle, and the alternative (silently throwing into the console on every frame after a GPU driver hiccup) is worse.

## Performance

- **DPR cap** — canvas backing store sized at `Math.min(window.devicePixelRatio, 2)`, not the raw device pixel ratio, to bound fill cost on high-density displays.
- **Context attributes** — `{ alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: "low-power" }`. `antialias: false` because every edge in the shader is already analytically anti-aliased via `smoothstep`; `low-power` because this is a decorative accent on an internal admin tool, not a reason to wake a discrete GPU.
- **Visibility pause** — `document.visibilitychange` stops the RAF loop when the tab isn't visible (matches the general "don't animate what nobody can see" practice; not specific to this codebase but worth stating since nothing else here does continuous RAF work today).
- **One draw call per frame** — fullscreen triangle via the `gl_VertexID` trick (no vertex buffer), sparks computed analytically inside the fragment shader rather than as separate instanced geometry. The whole effect is one compiled program, one uniform upload, one `drawArrays` call per frame.
- **Canvas sized to the card, not the viewport** — see "Why one canvas" above; keeps per-frame fragment cost proportional to one card, not the page.
- **No fight with `MorphingTabs`' own animation.** `MorphingTabs`' liquid tab-morph, drag-reorder, and tab-switch blur/fade all run inside its own `isolate`d stacking context, entirely within the card's interior; FlameWrap's canvas sits outside and above that box in paint order but is fully transparent except in the (small, tuned-down) glow/melt/distortion bands right at the edge, which — at `melt: 2`, `distortion: 3` — don't reach the tab panel's own `mx-4` inset. The two animation systems never touch the same pixels in a normal render.

## Integration

`dashboard-web/src/App.tsx`, `Dashboard`'s return JSX — the existing `<MorphingTabs .../>` call is wrapped, not replaced:

```tsx
import { FlameWrap } from "./components/effects/flame-wrap";
// ...
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

## Data flow

None. FlameWrap reads no application data — its only inputs are its own props and the measured bounding box of its children.

## Error handling

- **Unparseable `color`** — `resolveFlameColor` falls back to a neutral default and `console.warn`s in dev; never throws.
- **`getContext("webgl2")` returns `null`** — plain-children fallback, no canvas mounted (see above).
- **`webglcontextlost`** — RAF loop cancelled, no draws attempted until `webglcontextrestored` re-initializes.
- **Zero-size measured box** — e.g. transiently if an ancestor is briefly `display: none`, or during a layout thrash. Skip drawing that frame rather than dividing by zero / uploading NaN uniforms; resume on the next valid measurement.
- **OS-level reduced-motion toggled mid-session** — live `matchMedia` listener starts/stops the RAF loop without a reload.

## Testing

No dedicated frontend test suite, matching every prior sub-project's precedent for this internal admin UI (`npx tsc --noEmit -p dashboard-web/tsconfig.json` is the build-time check). This sub-project is frontend/visual-only and needs zero backend test changes; `npm test` is run once at the end purely as a regression check on code this plan never touches.

Manual verification (browser):
- `npm run build:dashboard` succeeds; dev server serves `/dashboard` with no console errors.
- The molten outline traces the tab card's actual rounded corners (no radius mismatch at the corners), at the intended low, barely-there intensity.
- Tab switching, drag-reorder, rename-on-blur, Archive, Revoke, and every "View"/issue-badge link inside the card still work exactly as before — the canvas never intercepts a click.
- Resizing the browser window keeps the outline aligned to the card's real box (`ResizeObserver`-driven, not a one-time measurement).
- Emulating `prefers-reduced-motion: reduce` in DevTools shows a static frame with no ongoing RAF loop (no sparks, no flicker) — verifiable via the Performance panel or a temporary debug log.
- Forcing WebGL2 unavailable (e.g. a DevTools override, or a temporary local edit making `supportsWebGL2()` return `false`) falls back to the plain card with zero console errors and zero visual regression otherwise.

## Open items (explicitly deferred, not blocking this sub-project)

- **Onboarding-flow rebase.** Sub-project 6 (onboarding flow) is still in flight and, per its own design doc, will also touch the `Dashboard` component's return JSX (a "Getting Started panel"). Whichever of that sub-project or this one merges second should expect a small, mechanical rebase around the same JSX region — not a design conflict, just overlapping lines.
- **A literal `distortion`/`melt` implementation** (true content-pixel displacement / true silhouette cutout) could be revisited later via a proper SVG `feDisplacementMap`/mask layer if the visual direction ever moves toward something more expressive than "quiet accent." Not planned now; the reduced-fidelity approximation is judged sufficient at the tuned values in this spec.
- **`smoke` / `ember` / `scorch`** — see Dropped props. Additive later, no breaking change to what's built here.
- **No visual tuning harness.** Retuning any of the numeric props happens by editing the `App.tsx` call site directly and reloading — matching this repo's existing "no frontend tooling beyond `tsc` + esbuild" precedent, not a gap specific to this component.
- **If canvasui.dev is ever actually licensed**, matching its public prop shape here means a future swap to the real package would be a call-site-compatible change, not a rewrite — a side benefit of the shape-matching decision, not a commitment to do so.
