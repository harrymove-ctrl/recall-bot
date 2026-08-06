// build-dashboard.mjs — project root. Always parsed as ESM regardless of package.json "type".
import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const outdir = "dist/dashboard-web";
mkdirSync(outdir, { recursive: true });

await esbuild.build({
  entryPoints: ["dashboard-web/src/main.tsx"],
  bundle: true,
  outfile: `${outdir}/bundle.js`,
  platform: "browser",
  format: "iife",
  target: ["es2022"],
  jsx: "automatic",
  sourcemap: true,
  minify: true,
  logLevel: "info",
});

cpSync("dashboard-web/src/index.html", `${outdir}/index.html`);
