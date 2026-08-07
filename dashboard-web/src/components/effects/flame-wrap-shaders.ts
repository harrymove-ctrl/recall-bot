// dashboard-web/src/components/effects/flame-wrap-shaders.ts
//
// Original GLSL for the FlameWrap fire-border effect. Two well-known public techniques are
// used as building blocks (credited inline where defined below) — everything else here is
// original work for this component, not copied or adapted from any proprietary source.

export const FLAME_WRAP_VERTEX_SHADER = /* glsl */ `#version 300 es
// Fullscreen-triangle trick: no vertex buffer needed, one drawArrays(TRIANGLES, 0, 3) call.
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FLAME_WRAP_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

uniform vec2  u_resolution;       // canvas backing-store size, px (used to flip gl_FragCoord to a
                                   // top-left-origin, y-down space matching u_boxCenter below —
                                   // WebGL's default framebuffer has a bottom-left origin/y-up)
uniform vec2  u_boxSize;          // wrapped content box, canvas px (not counting margin)
uniform vec2  u_boxCenter;        // wrapped content box center, canvas px, y-down from canvas top
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

const int MAX_SPARKS = 24;
const float TWO_PI = 6.28318530718;

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

// Given an arc-length fraction s in [0,1) and a rounded-rect half-size/radius, return the
// point on its perimeter (in the same card-local, y-down px space as p in main()) at that
// fraction of the total arc length. The perimeter is 4 straight edges + 4 quarter-circle
// corner arcs; walk them in order (starting at the top-right corner's start, going clockwise:
// top edge, right edge, bottom edge, left edge, with a quarter-arc between each pair),
// accumulating length, and return the position on whichever segment contains s * total.
vec2 pointOnRoundedRectPerimeter(float s, vec2 halfSize, float r) {
  vec2 straight = max(halfSize - vec2(r), vec2(0.0)); // half-length of the flat part of each edge
  float straightLen = straight.x * 2.0;                // top or bottom edge's flat length
  float straightHeight = straight.y * 2.0;              // left or right edge's flat length
  float arcLen = r * (TWO_PI / 4.0);                    // one quarter-circle arc length
  float total = 2.0 * straightLen + 2.0 * straightHeight + 4.0 * arcLen;
  if (total <= 0.0) return vec2(0.0);

  float target = fract(s) * total;

  // Segment order, clockwise from the midpoint of the top edge:
  // half top edge -> TR arc -> right edge -> BR arc -> bottom edge -> BL arc
  // -> left edge -> TL arc -> back to half top edge.
  float halfTop = straightLen * 0.5;
  if (target < halfTop) {
    return vec2(-straight.x + target, -halfSize.y);
  }
  target -= halfTop;

  if (target < arcLen) {
    float a = target / r; // 0..PI/2, sweeping from "up" to "right" around the TR corner
    vec2 c = vec2(straight.x, -straight.y);
    return c + vec2(sin(a), -cos(a)) * r;
  }
  target -= arcLen;

  if (target < straightHeight) {
    return vec2(halfSize.x, -straight.y + target);
  }
  target -= straightHeight;

  if (target < arcLen) {
    float a = target / r;
    vec2 c = vec2(straight.x, straight.y);
    return c + vec2(cos(a), sin(a)) * r;
  }
  target -= arcLen;

  if (target < straightLen) {
    return vec2(straight.x - target, halfSize.y);
  }
  target -= straightLen;

  if (target < arcLen) {
    float a = target / r;
    vec2 c = vec2(-straight.x, straight.y);
    return c + vec2(-sin(a), cos(a)) * r;
  }
  target -= arcLen;

  if (target < straightHeight) {
    return vec2(-halfSize.x, straight.y - target);
  }
  target -= straightHeight;

  if (target < arcLen) {
    float a = target / r;
    vec2 c = vec2(-straight.x, -straight.y);
    return c + vec2(-cos(a), -sin(a)) * r;
  }
  target -= arcLen;

  // Remaining sliver of the top edge, back to the start.
  return vec2(-target, -halfSize.y);
}

void main() {
  // Flip to a top-left-origin, y-down space so "top edge" / "bottom edge" below match the
  // JS side's plain CSS-pixel measurement of the wrapped box (WebGL's gl_FragCoord is
  // bottom-left-origin, y-up).
  vec2 fragCoord = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  vec2 p = fragCoord - u_boxCenter;   // card-local coords, px, y-down
  vec2 boxHalf = u_boxSize * 0.5;
  float d = sdRoundBox(p, boxHalf, u_radius);  // negative inside, positive outside

  // Finite-difference gradient of the SDF ~= outward normal direction at this point.
  vec2 e = vec2(1.0, 0.0);
  vec2 grad = normalize(vec2(
    sdRoundBox(p + e.xy, boxHalf, u_radius) - sdRoundBox(p - e.xy, boxHalf, u_radius),
    sdRoundBox(p + e.yx, boxHalf, u_radius) - sdRoundBox(p - e.yx, boxHalf, u_radius)
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
  // smoothstep(-inwardReach, 0, dTurb) is 0 deep inside (dTurb <= -inwardReach) and rises to 1
  // right at the boundary (dTurb -> 0) — i.e. strongest at the edge, fading to nothing further
  // in. (An earlier version of this formula negated this, which inverted it: full-strength deep
  // inside the card and fading OUT toward the edge — the opposite of an inward-eating glow.)
  float inwardReach = u_melt + u_distortion;
  float inward = smoothstep(-inwardReach, 0.0, dTurb) * step(dTurb, 0.0);

  float alpha = clamp(glow + rimGlow + inward * 0.6, 0.0, 1.0) * u_intensity;
  vec3 rgb = u_color * (1.0 + rimGlow * 0.6); // rim pushes the core toward brighter/whiter

  // Sparks: MAX_SPARKS-capped analytic loop, each a soft point sprite drifting outward from
  // the border along the local SDF normal, looping through a life cycle driven by u_time so
  // no CPU-side particle buffer or per-instance draw call is ever needed.
  for (int i = 0; i < MAX_SPARKS; i++) {
    if (i >= u_sparkCount) break;
    float seed = float(i) * 12.9898;
    float life = fract(u_time * (u_sparkSpeed / 200.0) + seed);
    float s = fract(sin(seed) * 43758.5453);
    vec2 borderPos = pointOnRoundedRectPerimeter(s, boxHalf, u_radius);
    vec2 normalAtSpark = normalize(vec2(
      sdRoundBox(borderPos + e.xy, boxHalf, u_radius) - sdRoundBox(borderPos - e.xy, boxHalf, u_radius),
      sdRoundBox(borderPos + e.yx, boxHalf, u_radius) - sdRoundBox(borderPos - e.yx, boxHalf, u_radius)
    ));
    vec2 drift = normalAtSpark * life * u_height * 0.6;
    // A little lateral wobble along the border direction keeps sparks from all drifting on
    // perfectly straight radial lines.
    vec2 lateral = vec2(-normalAtSpark.y, normalAtSpark.x) * sin(life * 6.0 + seed) * u_sparkSize;
    float sparkD = length(p - (borderPos + drift + lateral));
    float spark = exp(-sparkD * sparkD / max(u_sparkSize * u_sparkSize, 0.001)) * (1.0 - life);
    alpha += spark * u_sparks * 0.5;
    rgb = mix(rgb, vec3(1.0), spark * 0.5);
  }
  alpha = clamp(alpha, 0.0, 1.0);

  // Premultiplied — must match the WebGL context's premultipliedAlpha: true (see Performance).
  fragColor = vec4(rgb * alpha, alpha);
}
`;
