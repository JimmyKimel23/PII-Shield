# PII Shield v2 — developer notes

Developer-facing docs for the Node.js MCP server that lives under `nodejs-v2/`. For end-user install instructions (download the `.mcpb`, run install-model, use the skill) see the [repo root README](../README.md).

## What's here

| Path | What it is |
|---|---|
| `src/index.ts` | MCP tool handlers — one function per tool exposed to Claude Desktop. |
| `src/engine/ner-backend.ts` | GLiNER bootstrap — deps-aware sharp shim, versioned deps cache, ONNX triplet sanity check, deterministic `npm ci --ignore-scripts` install. |
| `src/engine/ner-deps-lockfile.json` | Embedded lockfile template. Gets written into `~/.pii_shield/deps/installs/<slug>/` so `npm ci` has something deterministic to consume. |
| `src/docx/`, `src/pdf/`, `src/mapping/`, `src/chunking/` | Document IO + session state. Pure JS, no Python. |
| `src/audit/`, `src/sidecar/` | Audit log + bootstrap beacon that stays writable even when Claude Desktop drops stderr. |
| `src/portability/session-archive.ts` | `export_session` / `import_session` round-trip (encrypted `.pii-session` archive). |
| `plugin/build-plugin.mjs` | Builds the thin Windows/Linux `.mcpb` (step 0 also refreshes `plugin/skills/pii-contract-analyze.zip` from the live source dir). |
| `plugin/build-mac-binary.mjs` | Builds the darwin-universal `.mcpb` with bundled Node 24.15.0. |
| `plugin/build-testkit.mjs` | Packages the internal tester bundle (`pii-shield-testkit-*.zip`). NOT public. |
| `plugin/skills/pii-contract-analyze/` | Skill source (SKILL.md + `references/*.md`). Single source of truth. |
| `plugin/skills/pii-contract-analyze.zip` | Auto-rebuilt release artefact. Don't hand-edit; run `npm run build:plugin` to refresh. |
| `scripts/install-model.{ps1,bat,sh,command}` | End-user model installer (downloads `gliner-pii-base-v1.0.zip` from the GitHub release). |
| `scripts/smoke-protocol.mjs` | MCP protocol round-trip smoke (initialize → tools/list → resources/list → tools/call). |
| `scripts/smoke-sharp-shim.mjs` | Focused clean-install smoke for the deps-aware sharp Module._load shim. |
| `ui/` | Vite source for the MCP Apps review iframe. `vite build` produces a single-file `dist/ui/review.html` that esbuild inlines into `dist/server.bundle.mjs`. |

## Dev setup

```bash
# Install exact-pinned dev deps (ignore scripts because sharp's postinstall
# fails on hosts without libvips — runtime shim intercepts sharp anyway).
npm ci --ignore-scripts --legacy-peer-deps

# Build the thin .mcpb → dist/pii-shield-v<version>.mcpb
npm run build:plugin

# Also build the darwin-universal .mcpb (downloads Node 24.15.0 arm64 + x64
# into dist/.cache/node-runtime/ on first run; cached afterwards)
npm run build:plugin:mac

# Type check only
node node_modules/typescript/bin/tsc --noEmit

# Protocol smoke against the latest dist/server.bundle.mjs
npm run smoke

# Full clean-install smoke: real npm ci in a temp dir + shim intercept assert
npm run smoke:sharp-shim
```

`npm run build:plugin` writes three artefacts to `dist/`:

- `pii-shield-v<version>-plugin.zip` — legacy `.zip` for non-`.mcpb` hosts
- `pii-shield-v<version>.mcpb` — the actual MCPB (what you drag into Claude Desktop on Windows/Linux)
- `pii-shield-testkit-v<version>.zip` — internal tester bundle

`npm run build:plugin:mac` additionally writes `pii-shield-v<version>-darwin-universal.mcpb` (~82 MB, bundles Node).

At release time these build outputs get renamed on upload to OS-clear names (`pii-shield-v<version>-windows-linux.mcpb`, `pii-shield-v<version>-macos.mcpb`) — release page handles that.

## Runtime data layout

PII Shield keeps four kinds of data, intentionally in separate paths so `/plugin remove` never loses your sessions or forces a model re-download:

| Path | What lives here | Wiped on `/plugin remove`? |
|---|---|---|
| `~/.pii_shield/models/` | GLiNER model (634 MB ONNX + 4 tokenizer files) | **No** — manual only |
| `~/.pii_shield/deps/installs/<slug>/` | Runtime npm deps (`onnxruntime-node`, `@xenova/transformers`, `gliner`, pinned to 1.22.0 / 2.17.2 / 0.0.19). `<slug>` is an ORT-triplet-pin hash so multiple pin sets can coexist. | **No** |
| `~/.pii_shield/audit/` | Append-only audit logs (`mcp_audit.log`, `ner_init.log`, `pii_shield_server.log`). Used as the "proof that no PII left the machine" artefact. | **No** |
| `~/.pii_shield/mappings/` | Per-session placeholder ↔ real-PII map. 0o700 permissions on POSIX. TTL-based cleanup on startup (`PII_MAPPING_TTL_DAYS`, default 7). | **No** |

All four dirs share the same `~/.pii_shield/` root so `/plugin remove` never wipes them — MCPB plugins don't get `CLAUDE_PLUGIN_DATA` from Claude Desktop anyway, so `getDataDir()` resolves to the user-global fallback. `PII_SHIELD_DATA_DIR` overrides the root; `PII_SHIELD_MAPPINGS_DIR` overrides just the mappings sub-path (for tests / enterprise split-disk setups).

## Model auto-discovery order

If `~/.pii_shield/models/gliner-pii-base-v1.0/` isn't present at startup, `ensureModelFiles()` walks a BFS:

1. `models_path` from extension settings
2. `~/.pii_shield/models/gliner-pii-base-v1.0/` (default install-model target)
3. `$CLAUDE_PLUGIN_DATA/models/gliner-pii-base-v1.0/` (old fat-bundle dev layout)
4. `~/Downloads/gliner-pii-base-v1.0/` (if the user hand-moved the folder)
5. Plugin-relative (next to `server.bundle.mjs`)

First valid dir wins. If nothing is found the server returns a `needs_setup` envelope — see [root README](../README.md) for the user flow.

## Dev-facing troubleshooting

### First-run `npm ci` hangs or fails

The first ever NER call runs `npm ci --ignore-scripts` against the embedded lockfile template into `~/.pii_shield/deps/installs/<slug>/`. ~600 MB, 1–2 min. Watch `~/.pii_shield/audit/ner_init.log` — it streams the exact resolved `onnxruntime-node` / `onnxruntime-common` / `onnxruntime-web` paths for root / transformers / gliner at the end, so you can see if any component resolved a wrong copy.

### ONNX mismatch (`Unsupported model IR version: 9, max supported IR version: 8`)

A stale pre-1.22.0 `onnxruntime-node` got resolved somewhere. Delete `~/.pii_shield/deps/` and retry — the versioned-install layout will refuse to reuse a deps root that fails the triplet sanity check on init, so subsequent runs self-heal.

### `Cannot find module '../build/Release/sharp-*.node'`

Means the sharp shim isn't intercepting correctly. Text-only NER doesn't need sharp — the shim in `ner-backend.ts:installSharpShimForDeps` intercepts bare `require("sharp")`, the absolute sharp entry path, and nested requires inside sharp's own root. Run `npm run smoke:sharp-shim` to reproduce and assert the shim fires at least once.

### macOS: server immediately disconnects after install

Install the `darwin-universal` variant (`pii-shield-v<version>-macos.mcpb` on the release page). Thin `.mcpb` hits Claude Desktop's built-in Node which closes the transport after `initialize` on Tahoe-era builds. The darwin variant ships its own Node and runs via `server.type="binary"` + `launch.sh`.

Debug log lives at `/tmp/piish-banner-debug.log` (Unix) or `%TEMP%\piish-banner-debug.log` (Windows) — written from the very first instruction of `server.bundle.mjs` so it survives the transport dying.

### Skill references don't load

If `pii-contract-analyze.zip` has `references/references/*.md` (double-nested) instead of `references/*.md`, the skill is broken — SKILL.md reads by the flat path. Rebuild via `npm run build:plugin` (step 0 regenerates the zip from source).

## License

MIT. See `../LICENSE`.
