#!/usr/bin/env node
/**
 * PII Shield CLI build script.
 *
 * Pipeline:
 *   1. vite build with INPUT=review-cli.html → dist/ui/review-cli.html
 *      (single-file via vite-plugin-singlefile, with vite alias swapping
 *      `@modelcontextprotocol/ext-apps` → ui/src/cli-app-shim.ts).
 *   2. esbuild cli/src/bin.ts → dist/cli/bin.mjs
 *      with the .html text loader so review-cli.html is inlined as a
 *      string literal in hitl-server.ts.
 *   3. chmod +x dist/cli/bin.mjs (POSIX) so npm-link / global install can
 *      run it directly via the shebang.
 *
 * Run with `npm run build:cli`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

console.log(`=== PII Shield CLI builder ===\n`);

// Sync LICENSE from repo root so the npm package always carries the
// current license. The repo root LICENSE is the source of truth; this
// keeps nodejs-v2/LICENSE from drifting if it gets edited there.
const PARENT_LICENSE = path.resolve(ROOT, "..", "LICENSE");
const LOCAL_LICENSE = path.join(ROOT, "LICENSE");
if (fs.existsSync(PARENT_LICENSE)) {
  try {
    fs.copyFileSync(PARENT_LICENSE, LOCAL_LICENSE);
  } catch (e) {
    console.warn(`   ! LICENSE sync failed (non-fatal): ${e.message}`);
  }
}

// ── Step 1: vite build review-cli.html ────────────────────────────────────
console.log("1. vite build → dist/ui/review-cli.html");
fs.mkdirSync(path.join(DIST, "ui"), { recursive: true });
// Invoke the locally-installed vite.js via the current node binary. Avoids
// npx + shell:true (which trips Node DEP0190 about non-escaped args) and
// avoids depending on PATH lookup of `npx.cmd` on Windows.
const viteBin = path.resolve(ROOT, "node_modules", "vite", "bin", "vite.js");
if (!fs.existsSync(viteBin)) {
  throw new Error(`vite not installed at ${viteBin} — run npm install first`);
}
const viteResult = spawnSync(
  process.execPath,
  [viteBin, "build", "--logLevel", "warn"],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, INPUT: "review-cli.html" },
  },
);
if (viteResult.status !== 0) {
  throw new Error(`vite build failed (exit ${viteResult.status})`);
}
const reviewHtmlPath = path.join(DIST, "ui", "review-cli.html");
if (!fs.existsSync(reviewHtmlPath)) {
  throw new Error(`Expected ${reviewHtmlPath} after vite build`);
}
const reviewHtmlKb = (fs.statSync(reviewHtmlPath).size / 1024).toFixed(1);
console.log(`   ✓ dist/ui/review-cli.html (${reviewHtmlKb} KB)`);

// ── Step 2: esbuild bin.ts → dist/cli/bin.mjs ─────────────────────────────
console.log("\n2. esbuild → dist/cli/bin.mjs");
const { build } = await import("esbuild");
fs.mkdirSync(path.join(DIST, "cli"), { recursive: true });
await build({
  entryPoints: [path.join(ROOT, "cli/src/bin.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: path.join(DIST, "cli", "bin.mjs"),
  sourcemap: false,
  external: [
    "@xenova/transformers",
    "gliner",
    "onnxruntime-node",
    "onnxruntime-common",
    "onnxruntime-web",
    "sharp",
    "canvas",
    // pdf.js-extract is CommonJS and uses __dirname/__filename internally.
    // Bundling it into ESM produces a runtime ReferenceError on first PDF
    // read. Keep it external so Node's CJS loader supplies the dirname
    // shim — the npm package already lists it as a dependency.
    "pdf.js-extract",
  ],
  loader: { ".html": "text" },
  banner: {
    // Shebang + createRequire shim. Bundled CJS deps (commander, cli-progress)
    // call require() at runtime; ESM output must polyfill it.
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __piiCreateRequire } from "node:module";',
      'const require = __piiCreateRequire(import.meta.url);',
    ].join("\n"),
  },
});
console.log("   ✓ dist/cli/bin.mjs");

// ── Step 3: chmod +x (POSIX) ──────────────────────────────────────────────
if (process.platform !== "win32") {
  fs.chmodSync(path.join(DIST, "cli", "bin.mjs"), 0o755);
  console.log("\n3. chmod +x dist/cli/bin.mjs");
}

const binSizeKb = (fs.statSync(path.join(DIST, "cli", "bin.mjs")).size / 1024).toFixed(1);
console.log(`\n=== Done. dist/cli/bin.mjs (${binSizeKb} KB) ===`);
