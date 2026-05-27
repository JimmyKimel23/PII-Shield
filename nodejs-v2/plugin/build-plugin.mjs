#!/usr/bin/env node

/**
 * PII Shield v2 — Plugin Builder (version read from manifest.json).
 *
 * Pipeline (order matters):
 *   1a. vite build ui/review.html → dist/ui/review.html (single-file via
 *       vite-plugin-singlefile — all TS/CSS inlined into one HTML document).
 *   1b. esbuild src/index.ts → dist/server.bundle.mjs, using the .html text
 *       loader so `import REVIEW_HTML from "../dist/ui/review.html"` gets
 *       inlined into the bundle as a string literal.
 *   2. Assemble plugin ZIP → dist/pii-shield-v{VERSION}-plugin.zip
 *      (server.bundle.mjs + .claude-plugin/plugin.json + .mcp.json + skills/
 *      + commands/). Models NOT included — kept for legacy compatibility.
 *   3. Stage + `mcpb pack` → dist/pii-shield-v{VERSION}.mcpb (Claude Desktop).
 *      THIN bundle: server.bundle.mjs + manifest.json + LICENSE only (~1 MB).
 *
 * **Why the .mcpb is thin (no model bundled):**
 * The 634 MB GLiNER model is installed separately by the end user via
 * `scripts/install-model.ps1` (Windows) or `scripts/install-model.sh`
 * (macOS/Linux), which pulls a single `gliner-pii-base-v1.0.zip` from the
 * PII Shield GitHub release and unpacks it into `~/.pii_shield/models/
 * gliner-pii-base-v1.0/`. This keeps the .mcpb small (fast Claude Desktop
 * install), avoids the 90 sec silent preview window, and decouples model
 * updates from code releases.
 *
 * At runtime `ensureModelFiles()` in `src/engine/ner-backend.ts` does an
 * auto-BFS over common locations (settings override → `~/.pii_shield/models/`
 * → CLAUDE_PLUGIN_DATA → Downloads → bundle-relative) — first valid dir
 * wins. If nothing is found, the server returns a `needs_setup` envelope
 * telling the user to run the install-model one-liner.
 *
 * Runtime deps (onnxruntime-node, transformers, gliner) still auto-install
 * on first NER call into ${CLAUDE_PLUGIN_DATA}/deps — unchanged.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const OUT_DIR = DIST;
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const VERSION = MANIFEST.version;
const ZIP_NAME = `pii-shield-v${VERSION}-plugin.zip`;
const MCPB_NAME = `pii-shield-v${VERSION}.mcpb`;
const SKIP_TESTKIT = process.argv.includes("--skip-testkit");

function addFileToZip(zip, zipPath, filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`  WARN: ${filePath} not found, skipping`);
    return;
  }
  const normalizedPath = zipPath.replace(/\\/g, "/");
  const data = fs.readFileSync(filePath);
  zip.file(normalizedPath, data);
}

function addDirToZip(zip, zipPrefix, dirPath, filter) {
  if (!fs.existsSync(dirPath)) {
    console.warn(`  WARN: ${dirPath} not found, skipping`);
    return;
  }
  const entries = fs.readdirSync(dirPath, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(entry.parentPath || entry.path, entry.name);
    const relativePath = path.relative(dirPath, fullPath);
    if (filter && !filter(relativePath)) continue;
    const zipPath = `${zipPrefix}/${relativePath}`.replace(/\\/g, "/");
    zip.file(zipPath, fs.readFileSync(fullPath));
  }
}

function runMcpb(args) {
  if (process.platform === "win32") {
    return spawnSync("cmd.exe", ["/d", "/c", "mcpb.cmd", ...args], { stdio: "inherit" });
  }
  return spawnSync("mcpb", args, { stdio: "inherit" });
}

async function buildSkillZip() {
  // Rebuild plugin/skills/pii-contract-analyze.zip from the live source dir
  // on every plugin build. Keeps the release artifact from going stale
  // silently when the source SKILL.md / references/*.md change.
  const skillSrcDir = path.join(__dirname, "skills/pii-contract-analyze");
  const skillZipPath = path.join(__dirname, "skills/pii-contract-analyze.zip");
  if (!fs.existsSync(skillSrcDir)) {
    throw new Error(`Skill source dir not found: ${skillSrcDir}`);
  }
  const skillZip = new JSZip();
  const pushTree = (dir, zipPath) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const zp = zipPath ? `${zipPath}/${e.name}` : e.name;
      if (e.isDirectory()) pushTree(full, zp);
      else if (e.isFile()) skillZip.file(zp, fs.readFileSync(full));
    }
  };
  pushTree(skillSrcDir, "pii-contract-analyze");
  const buf = await skillZip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  await fsp.writeFile(skillZipPath, buf);
  return { path: skillZipPath, size: buf.length };
}

async function build() {
  console.log(`=== PII Shield v${VERSION} Plugin Builder ===\n`);

  // Step 0: refresh the prebuilt skill zip from its source dir so the
  // release artefact never silently lags the canonical SKILL.md.
  console.log("0. Refreshing skill archive from plugin/skills/pii-contract-analyze/");
  const skillInfo = await buildSkillZip();
  const skillKb = (skillInfo.size / 1024).toFixed(1);
  console.log(`   ✓ ${path.relative(ROOT, skillInfo.path).replace(/\\/g, "/")} (${skillKb} KB)`);

  // Step 1a: vite build (twice — review.html + setup.html). Each pass is a
  // single-file build via INPUT env var (vite.config.ts reads it). esbuild's
  // text loader picks both up below.
  console.log("\n1a. vite build → dist/ui/review.html + dist/ui/setup.html");
  const uiOut = path.join(DIST, "ui");
  await fsp.mkdir(uiOut, { recursive: true });
  const viteCmd = process.platform === "win32" ? "npx.cmd" : "npx";

  for (const entry of ["review.html", "setup.html"]) {
    const viteResult = spawnSync(viteCmd, ["vite", "build", "--logLevel", "warn"], {
      cwd: ROOT,
      stdio: "inherit",
      shell: true,
      env: { ...process.env, INPUT: entry },
    });
    if (viteResult.status !== 0) {
      throw new Error(`vite build failed for ${entry} with exit code ${viteResult.status}`);
    }
    const builtPath = path.join(uiOut, entry);
    if (!fs.existsSync(builtPath)) {
      throw new Error(
        `vite build finished but ${builtPath} does not exist — check outDir in vite.config.ts`,
      );
    }
    const sizeKb = (fs.statSync(builtPath).size / 1024).toFixed(1);
    console.log(`   ✓ dist/ui/${entry} (${sizeKb} KB, single-file bundle)`);
  }

  // Step 1b: esbuild server bundle.
  console.log("\n1b. Building server bundle...");
  const { build } = await import("esbuild");
  await build({
    entryPoints: [path.join(ROOT, "src/index.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: path.join(DIST, "server.bundle.mjs"),
    sourcemap: false,
    external: [
      "@xenova/transformers",
      "gliner",
      "onnxruntime-node",
      "onnxruntime-common",
      "sharp",
      "canvas",
    ],
    loader: { ".html": "text" },
    banner: {
      js: [
        // ULTRA-EARLY diagnostic file. Written from the very first instruction
        // so we can tell if the bundle even started executing under Claude
        // Desktop's UtilityProcess Electron Node on macOS, where stderr is
        // dropped before the host captures it.
        //
        // Path cascade (first writable wins):
        //   1. PIISH_DEBUG_DIR env override (manual diagnostic)
        //   2. CLAUDE_PLUGIN_DATA (host-provided per-plugin dir)
        //   3. ~/Library/Logs/Claude/ on macOS (next to mcp-server-*.log
        //      that CD writes itself — proven CD-writable, visible to user
        //      without spelunking under sandbox redirects)
        //   4. %TEMP% / $TMPDIR / /tmp (platform default)
        //   5. ~/.pii_shield/ (legacy fallback)
        // Why ~/Library/Logs/Claude under macOS first: Yan tested 2026-04-23,
        // /tmp + ~/.pii_shield writes never appeared on disk, possibly due to
        // Tahoe sandbox redirect or Node fs being killed before flush. CD's
        // own logs in that dir DO survive — write next to them.
        'import * as __dbg_fs from "fs";',
        'import * as __dbg_path from "path";',
        // Alias createRequire — fflate (transitive via @adeu/core) ships its
        // own top-level `import { createRequire } from "module"` in
        // node_modules/fflate/esm/index.mjs, so a bare `createRequire` here
        // would collide and produce SyntaxError: Identifier already declared.
        'import { createRequire as __piiCreateRequire } from "module";',
        'import { fileURLToPath as __esm_fileURLToPath } from "url";',
        'import * as __early_os from "os";',
        'const require = __piiCreateRequire(import.meta.url);',
        'const __filename = __esm_fileURLToPath(import.meta.url);',
        'const __dirname = __dbg_path.dirname(__filename);',
        'function __resolveDbgPath() {',
        '  const cs = [];',
        '  if (process.env.PIISH_DEBUG_DIR) cs.push(process.env.PIISH_DEBUG_DIR);',
        '  if (process.env.CLAUDE_PLUGIN_DATA) cs.push(process.env.CLAUDE_PLUGIN_DATA);',
        '  if (process.platform === "darwin") {',
        '    cs.push(__dbg_path.join(__early_os.homedir(), "Library/Logs/Claude"));',
        '  }',
        '  if (process.platform === "win32") {',
        '    cs.push(process.env.TEMP || "C:\\\\Windows\\\\Temp");',
        '  } else {',
        '    cs.push(process.env.TMPDIR || "/tmp");',
        '  }',
        '  cs.push(__dbg_path.join(__early_os.homedir(), ".pii_shield"));',
        '  for (const dir of cs) {',
        '    try { __dbg_fs.mkdirSync(dir, { recursive: true }); return __dbg_path.join(dir, "piish-banner-debug.log"); } catch (_) {}',
        '  }',
        '  return null;',
        '}',
        'const __DBG_PATH = __resolveDbgPath();',
        'function __DBG(msg) {',
        '  const line = new Date().toISOString() + " pid=" + process.pid + " " + msg + "\\n";',
        '  try { process.stderr.write("[PIISH-DBG] " + line); } catch (_) {}',
        '  if (__DBG_PATH) { try { __dbg_fs.appendFileSync(__DBG_PATH, line); } catch (_) {} }',
        '}',
        '__DBG("STAGE-0 dbg-path=" + (__DBG_PATH || "<null-no-writable-dir>") + " home=" + __early_os.homedir() + " tmpdir=" + (process.env.TMPDIR || process.env.TEMP || "<unset>"));',
        '__DBG("STAGE-1 banner-top node=" + process.versions.node + " platform=" + process.platform + " arch=" + process.arch + " electron=" + (process.versions.electron || "<none>"));',
        'function __earlyDataDir() {',
        '  const pluginData = process.env.CLAUDE_PLUGIN_DATA;',
        '  if (pluginData && pluginData.length > 0) return pluginData;',
        '  return __dbg_path.join(__early_os.homedir(), ".pii_shield");',
        '}',
        'function __earlyLog(msg) {',
        '  try { process.stderr.write(msg + "\\n"); } catch (_) {}',
        '  try {',
        '    const dir = __dbg_path.join(__earlyDataDir(), "audit");',
        '    __dbg_fs.mkdirSync(dir, { recursive: true });',
        '    __dbg_fs.appendFileSync(__dbg_path.join(dir, "ner_init.log"), new Date().toISOString() + " " + msg + "\\n");',
        '  } catch (_) {}',
        '}',
        'process.on("uncaughtException", (err) => { __DBG("UNCAUGHT " + (err && err.stack || err)); __earlyLog("[UNCAUGHT] " + (err && err.stack || err)); });',
        'process.on("unhandledRejection", (reason) => { __DBG("UNHANDLED " + (reason && reason.stack || reason)); __earlyLog("[UNHANDLED] " + (reason && reason.stack || reason)); });',
        'process.on("exit", (code) => __DBG("EXIT code=" + code));',
        'process.on("beforeExit", (code) => __DBG("BEFORE-EXIT code=" + code));',
        '["SIGTERM","SIGINT","SIGHUP","SIGPIPE","SIGUSR2"].forEach(function(sig) { try { process.on(sig, function() { __DBG("SIGNAL " + sig); }); } catch (_) {} });',
        'try { setTimeout(function() { __DBG("HEARTBEAT 3s uptime=" + process.uptime().toFixed(2)); }, 3000).unref(); } catch (_) {}',
        'try { setTimeout(function() { __DBG("HEARTBEAT 15s uptime=" + process.uptime().toFixed(2)); }, 15000).unref(); } catch (_) {}',
        'globalThis.__earlyLog = __earlyLog;',
        'globalThis.__DBG = __DBG;',
        '__DBG("STAGE-2 handlers ok");',
        '__earlyLog("[init] node=" + process.version + " platform=" + process.platform + " pid=" + process.pid);',
        '__earlyLog("[init] cwd=" + process.cwd() + " CLAUDE_PLUGIN_DATA=" + (process.env.CLAUDE_PLUGIN_DATA || "<unset>"));',
        '__DBG("STAGE-3 banner done, entering bundle");',
      ].join("\n"),
    },
    footer: {
      js: 'try { (globalThis.__DBG || function(){})("STAGE-99 bundle top-level eval done"); } catch (_) {}',
    },
  });
  console.log("   ✓ dist/server.bundle.mjs");

  // Step 2: Legacy plugin ZIP (for non-.mcpb hosts).
  console.log("\n2. Creating plugin ZIP...");
  const zip = new JSZip();

  addFileToZip(zip, "server.bundle.mjs", path.join(DIST, "server.bundle.mjs"));

  const pluginJsonPath = path.join(__dirname, ".claude-plugin/plugin.json");
  const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
  if (pluginJson.version !== VERSION) {
    console.log(`   ⚠ plugin.json version ${pluginJson.version} → ${VERSION} (injected from manifest)`);
    pluginJson.version = VERSION;
  }
  zip.file(".claude-plugin/plugin.json", JSON.stringify(pluginJson, null, 2));
  addFileToZip(zip, ".mcp.json", path.join(__dirname, ".mcp.json"));
  addFileToZip(zip, ".claude/launch.json", path.join(__dirname, ".claude/launch.json"));

  const commandsDir = path.join(__dirname, "commands");
  if (fs.existsSync(commandsDir)) {
    addDirToZip(zip, "commands", commandsDir, (rel) => rel.endsWith(".md"));
    console.log(`   ✓ commands/ (slash commands)`);
  }

  // The skill is the canonical source of truth at
  // `plugin/skills/pii-contract-analyze/` (flat `references/*.md` layout).
  // The prebuilt `plugin/skills/pii-contract-analyze.zip` is refreshed from
  // that source in step 0 below before this point.
  const skillDir = path.join(__dirname, "skills/pii-contract-analyze");
  if (fs.existsSync(skillDir)) {
    addDirToZip(zip, "skills/pii-contract-analyze", skillDir);
  }

  console.log("   ⊘ models/ (not bundled; user installs via install-model script)");
  console.log("   ⊘ node_modules/ (onnxruntime-node auto-installed on first NER call)");

  console.log("\n3. Generating plugin ZIP...");
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const outPath = path.join(OUT_DIR, ZIP_NAME);
  fs.writeFileSync(outPath, buffer);
  const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
  console.log(`\n✓ Plugin ZIP created: ${outPath} (${sizeMB} MB)`);

  // Step 4: Stage + pack thin .mcpb.
  console.log("\n4. Packing thin .mcpb (Claude Desktop bundle)...");
  const stageDir = path.join(DIST, "staging", `pii-shield-v${VERSION}`);
  await fsp.rm(stageDir, { recursive: true, force: true });
  await fsp.mkdir(stageDir, { recursive: true });

  await fsp.copyFile(path.join(ROOT, "manifest.json"), path.join(stageDir, "manifest.json"));
  await fsp.copyFile(path.join(DIST, "server.bundle.mjs"), path.join(stageDir, "server.bundle.mjs"));
  const licenseSrc = path.join(ROOT, "..", "LICENSE");
  if (fs.existsSync(licenseSrc)) {
    await fsp.copyFile(licenseSrc, path.join(stageDir, "LICENSE"));
  }

  console.log("   ⊘ models/ (not bundled — user runs install-model.ps1 / .sh before installing .mcpb)");

  const mcpbOut = path.join(OUT_DIR, MCPB_NAME);
  await fsp.rm(mcpbOut, { force: true });
  const result = runMcpb(["pack", stageDir, mcpbOut]);
  if (result.status !== 0) {
    throw new Error(`mcpb pack failed with exit code ${result.status}`);
  }
  const mcpbSizeMB = (fs.statSync(mcpbOut).size / 1024 / 1024).toFixed(2);
  console.log(`\n✓ MCPB created: ${mcpbOut} (${mcpbSizeMB} MB)`);

  // Step 5: validate the staged manifest. Catches schema regressions
  // (`platform_overrides` typos, missing `mcp_config`, bad `runtimes`, etc.)
  // before users hit them at install time.
  console.log("\n5. Validating manifest...");
  const validateResult = runMcpb(["validate", path.join(stageDir, "manifest.json")]);
  if (validateResult.status !== 0) {
    throw new Error(`mcpb validate failed with exit code ${validateResult.status}`);
  }
  console.log("   ✓ manifest valid");

  // Step 6: assemble testkit (loose dist/testkit/ + single-file ZIP with
  // preserved Unix permissions on .command/.sh). Single ZIP is what we send
  // to testers.
  if (SKIP_TESTKIT) {
    console.log("\n6. Building testkit... skipped (--skip-testkit)");
    return;
  }
  console.log("\n6. Building testkit...");
  const nodeBin = process.execPath;
  const testkitResult = spawnSync(nodeBin, [path.join(__dirname, "build-testkit.mjs")], { stdio: "inherit" });
  if (testkitResult.status !== 0) {
    throw new Error(`build-testkit.mjs failed with exit code ${testkitResult.status}`);
  }
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
