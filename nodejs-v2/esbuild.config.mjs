import { build } from "esbuild";

/**
 * PII Shield bundle config.
 *
 * @xenova/transformers, gliner, onnxruntime-node, onnxruntime-common, and sharp
 * are NOT bundled. They are installed at runtime into ~/.pii_shield/deps/ by
 * ensureNerDeps() in src/engine/ner-backend.ts and loaded via createRequire
 * anchored at that directory.
 *
 * Why: bundling transformers.js triggers a stack overflow due to its conditional
 * onnxruntime imports + ghost dependency on onnxruntime-common (huggingface/
 * transformers.js#875, #1087). Upstream's own fix (e.g. Next.js
 * `serverExternalPackages`) is to mark transformers as external.
 */
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/server.bundle.mjs",
  sourcemap: true,
  external: [
    "@xenova/transformers",
    "gliner",
    "onnxruntime-node",
    "onnxruntime-common",
    "sharp",
    "canvas",  // optional pdf.js dependency for rendering (not needed for text extraction)
  ],
  loader: { ".html": "text" },
  banner: {
    js: [
      // Alias createRequire — fflate (transitive via @adeu/core) ships its
      // own top-level `import { createRequire } from "module"` in
      // node_modules/fflate/esm/index.mjs, so a bare `createRequire` here
      // would collide and produce SyntaxError: Identifier already declared.
      'import { createRequire as __piiCreateRequire } from "module";',
      'import { fileURLToPath as __esm_fileURLToPath } from "url";',
      'import { dirname as __esm_dirname } from "path";',
      'import * as __early_fs from "fs";',
      'import * as __early_path from "path";',
      'import * as __early_os from "os";',
      'const require = __piiCreateRequire(import.meta.url);',
      'const __filename = __esm_fileURLToPath(import.meta.url);',
      'const __dirname = __esm_dirname(__filename);',
      // Install crash handlers BEFORE any other code runs.
      // The banner reads CLAUDE_PLUGIN_DATA at runtime from the spawned
      // server process environment (Claude Code sets it before spawning),
      // falling back to ~/.pii_shield for non-plugin launches.
      'function __earlyDataDir() {',
      '  const pluginData = process.env.CLAUDE_PLUGIN_DATA;',
      '  if (pluginData && pluginData.length > 0) return pluginData;',
      '  return __early_path.join(__early_os.homedir(), ".pii_shield");',
      '}',
      'function __earlyLog(msg) {',
      '  try {',
      '    const dir = __early_path.join(__earlyDataDir(), "audit");',
      '    __early_fs.mkdirSync(dir, { recursive: true });',
      '    __early_fs.appendFileSync(__early_path.join(dir, "ner_init.log"), new Date().toISOString() + " " + msg + "\\n");',
      '  } catch (_) {}',
      '  try { console.error(msg); } catch (_) {}',
      '}',
      'process.on("uncaughtException", (err) => { __earlyLog("[UNCAUGHT] " + (err && err.stack || err)); });',
      'process.on("unhandledRejection", (reason) => { __earlyLog("[UNHANDLED] " + (reason && reason.stack || reason)); });',
    ].join("\n"),
  },
});

console.log("✓ Built dist/server.bundle.mjs");
