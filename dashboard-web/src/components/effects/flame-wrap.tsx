// dashboard-web/src/components/effects/flame-wrap.tsx
import { useEffect, useRef, useState, type ReactNode } from "react";
import { resolveFlameColor } from "./flame-wrap-color";
import { FLAME_WRAP_FRAGMENT_SHADER, FLAME_WRAP_VERTEX_SHADER } from "./flame-wrap-shaders";

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

// A few CSS px of slack around the measured box, on top of `height`/`spread`, so the
// noise's overshoot and the shader's analytic antialiasing never get hard-clipped at the
// canvas edge.
const EDGE_BUFFER = 4;

type ResolvedProps = Required<Omit<FlameWrapProps, "className" | "children">>;

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

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("FlameWrap: shader compile failed:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

const UNIFORM_NAMES = [
  "u_resolution",
  "u_boxSize",
  "u_boxCenter",
  "u_radius",
  "u_color",
  "u_intensity",
  "u_height",
  "u_spread",
  "u_time",
  "u_scale",
  "u_turbulence",
  "u_turbulenceScale",
  "u_turbulenceReach",
  "u_rim",
  "u_melt",
  "u_distortion",
  "u_sparks",
  "u_sparkSize",
  "u_sparkCount",
  "u_sparkSpeed",
] as const;

type UniformLocations = Record<(typeof UNIFORM_NAMES)[number], WebGLUniformLocation | null>;

export function FlameWrap({ children, className, ...rawProps }: FlameWrapProps) {
  const props: ResolvedProps = { ...DEFAULTS, ...rawProps };
  const reduce = usePrefersReducedMotion();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hasWebGL2 = supportsWebGL2();

  // Read from inside the RAF loop / ResizeObserver callback so prop changes update the next
  // frame's uniforms without tearing down and recompiling the GL program on every re-render.
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    if (!hasWebGL2) return;
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;

    let gl: WebGL2RenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let uniforms: UniformLocations | null = null;
    let rafId: number | null = null;
    const startTime = performance.now();

    let canvasBackingWidth = 0;
    let canvasBackingHeight = 0;
    let boxCenterCss = { x: 0, y: 0 }; // relative to the canvas's own top-left, CSS px
    let boxSizeCss = { w: 0, h: 0 };

    function initGL(): boolean {
      gl = canvas!.getContext("webgl2", {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        powerPreference: "low-power",
      });
      if (!gl) return false;

      const vertexShader = compileShader(gl, gl.VERTEX_SHADER, FLAME_WRAP_VERTEX_SHADER);
      const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FLAME_WRAP_FRAGMENT_SHADER);
      if (!vertexShader || !fragmentShader) return false;

      const nextProgram = gl.createProgram();
      if (!nextProgram) return false;
      gl.attachShader(nextProgram, vertexShader);
      gl.attachShader(nextProgram, fragmentShader);
      gl.linkProgram(nextProgram);
      // Shaders are flagged for deletion once detached; the program keeps them alive until then.
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      if (!gl.getProgramParameter(nextProgram, gl.LINK_STATUS)) {
        console.error("FlameWrap: program link failed:", gl.getProgramInfoLog(nextProgram));
        gl.deleteProgram(nextProgram);
        return false;
      }

      program = nextProgram;
      gl.useProgram(program);
      gl.enable(gl.BLEND);
      // Premultiplied-alpha blending — matches premultipliedAlpha:true above and the shader's
      // `fragColor = vec4(rgb * alpha, alpha)`. Using SRC_ALPHA here instead would produce a
      // dark fringe around the glow.
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      const locations = {} as UniformLocations;
      for (const name of UNIFORM_NAMES) {
        locations[name] = gl.getUniformLocation(program, name);
      }
      uniforms = locations;
      return true;
    }

    // Skips (rather than divides by zero / uploads NaN) whenever the measured box is 0×0 —
    // e.g. transiently if an ancestor is briefly `display: none`.
    function measureAndResize(): boolean {
      const rect = wrapper!.getBoundingClientRect();
      const boxWidth = rect.width;
      const boxHeight = rect.height;
      if (boxWidth <= 0 || boxHeight <= 0) return false;

      const p = propsRef.current;
      const marginTop = Math.ceil(p.height) + EDGE_BUFFER;
      const marginSide = Math.ceil(p.spread) + EDGE_BUFFER;

      const cssWidth = boxWidth + marginSide * 2;
      const cssHeight = boxHeight + marginTop + marginSide;

      canvas!.style.left = `${-marginSide}px`;
      canvas!.style.top = `${-marginTop}px`;
      canvas!.style.width = `${cssWidth}px`;
      canvas!.style.height = `${cssHeight}px`;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const backingWidth = Math.max(1, Math.round(cssWidth * dpr));
      const backingHeight = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas!.width !== backingWidth) canvas!.width = backingWidth;
      if (canvas!.height !== backingHeight) canvas!.height = backingHeight;

      canvasBackingWidth = backingWidth;
      canvasBackingHeight = backingHeight;
      boxCenterCss = { x: marginSide + boxWidth / 2, y: marginTop + boxHeight / 2 };
      boxSizeCss = { w: boxWidth, h: boxHeight };

      gl!.viewport(0, 0, backingWidth, backingHeight);
      return true;
    }

    function render(nowMs: number) {
      if (gl && program && uniforms && boxSizeCss.w > 0 && boxSizeCss.h > 0) {
        const p = propsRef.current;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const t = ((nowMs - startTime) / 1000) * p.speed;
        const [r, g, b] = resolveFlameColor(p.color);
        const sparkCount = Math.min(MAX_SPARKS, Math.max(0, Math.round(p.sparkDensity)));

        gl.viewport(0, 0, canvasBackingWidth, canvasBackingHeight);
        gl.uniform2f(uniforms.u_resolution, canvasBackingWidth, canvasBackingHeight);
        gl.uniform2f(uniforms.u_boxSize, boxSizeCss.w * dpr, boxSizeCss.h * dpr);
        gl.uniform2f(uniforms.u_boxCenter, boxCenterCss.x * dpr, boxCenterCss.y * dpr);
        gl.uniform1f(uniforms.u_radius, p.radius * dpr);
        gl.uniform3f(uniforms.u_color, r, g, b);
        gl.uniform1f(uniforms.u_intensity, p.intensity);
        gl.uniform1f(uniforms.u_height, p.height * dpr);
        gl.uniform1f(uniforms.u_spread, p.spread * dpr);
        gl.uniform1f(uniforms.u_time, t);
        gl.uniform1f(uniforms.u_scale, p.scale);
        gl.uniform1f(uniforms.u_turbulence, p.turbulence);
        gl.uniform1f(uniforms.u_turbulenceScale, p.turbulenceScale);
        gl.uniform1f(uniforms.u_turbulenceReach, p.turbulenceReach * dpr);
        gl.uniform1f(uniforms.u_rim, p.rim);
        gl.uniform1f(uniforms.u_melt, p.melt * dpr);
        gl.uniform1f(uniforms.u_distortion, p.distortion * dpr);
        gl.uniform1f(uniforms.u_sparks, p.sparks);
        gl.uniform1f(uniforms.u_sparkSize, p.sparkSize * dpr);
        gl.uniform1i(uniforms.u_sparkCount, p.sparks > 0 ? sparkCount : 0);
        gl.uniform1f(uniforms.u_sparkSpeed, p.sparkSpeed);

        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      if (!reduce) {
        rafId = requestAnimationFrame(render);
      }
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      } else if (!reduce && rafId === null && program) {
        rafId = requestAnimationFrame(render);
      }
    }

    function handleContextLost(event: Event) {
      // Required to make context restoration possible at all.
      event.preventDefault();
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      program = null;
      uniforms = null;
    }

    function handleContextRestored() {
      if (!initGL()) return;
      if (!measureAndResize()) return;
      if (reduce) {
        render(performance.now());
      } else if (!document.hidden) {
        rafId = requestAnimationFrame(render);
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      if (measureAndResize() && reduce) {
        // Reduced motion: no RAF loop, so a resize needs its own redraw to stay aligned.
        render(performance.now());
      }
    });

    if (!initGL()) {
      // Shader compile/link failure, or getContext returned null despite the feature probe
      // succeeding earlier — degrade to "no effect drawn" rather than throwing. The wrapper
      // div and (blank, fully transparent) canvas still mount; children render untouched.
      return;
    }

    measureAndResize();
    resizeObserver.observe(wrapper);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    canvas.addEventListener("webglcontextlost", handleContextLost, false);
    canvas.addEventListener("webglcontextrestored", handleContextRestored, false);

    if (reduce) {
      // One static frame — no RAF loop, no ongoing animation, sparks included (a frozen spark
      // reads as a stray dot, not motion, so this is a deliberate simplification, not a bug).
      render(performance.now());
    } else if (!document.hidden) {
      rafId = requestAnimationFrame(render);
    }

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      if (gl && program) gl.deleteProgram(program);
    };
    // Only remount the GL program on mount or when `reduce` flips — every other prop is read
    // live from `propsRef` inside the RAF loop / resize handler above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasWebGL2, reduce]);

  if (!hasWebGL2) return <>{children}</>;

  return (
    <div ref={wrapperRef} className={className} style={{ position: "relative" }}>
      <canvas ref={canvasRef} aria-hidden style={{ position: "absolute", pointerEvents: "none" }} />
      {children}
    </div>
  );
}
