# PII Shield CLI — developer notes

Standalone CLI variant of PII Shield. Installs as a normal npm package (`pii-shield`) and runs entirely offline — no MCP host, no Claude required. Reuses the same `src/engine/`, `src/docx/`, `src/pdf/`, `src/mapping/`, `src/portability/`, and `src/audit/` modules as the `.mcpb` and Claude Code plugin builds.

## Layout

```
cli/
├── README.md                      this file
├── USAGE.md                       end-user manual (ships in npm package)
├── build-cli.mjs                  vite + esbuild + chmod pipeline
└── src/
    ├── bin.ts                     commander dispatcher (CLI entry; shebang added by build banner)
    ├── runtime.ts                 PIIEngine.getInstance() init + audit hook + waitForNer()
    ├── prompts.ts                 readline y/n + masked passphrase
    ├── progress.ts                cli-progress wrappers (no-op under PII_QUIET)
    ├── color.ts                   picocolors wrapper with NO_COLOR / TTY gates
    ├── path-utils.ts              expandFileArgs() — tinyglobby for Windows cmd.exe
    ├── session-resolve.ts         resolveSessionId() — git-style unique-prefix lookup
    ├── cleanup-registry.ts        process-wide SIGINT cleanup queue
    ├── file-io.ts                 readDocumentText() — PDF/DOCX/TXT
    ├── hitl-server.ts             HTTP review server on 127.0.0.1, bearer-token auth
    ├── review-overrides.ts        applyOverridesToEntities() — duplicated from src/index.ts:158
    ├── html.d.ts                  ambient `*.html` module declaration for esbuild text loader
    └── commands/
        ├── anonymize.ts           single + multi-file batch (bypasses MCP chunking guard)
        ├── deanonymize.ts         text + .docx restore
        ├── scan.ts                preview without write
        ├── review.ts              open browser, await user, re-anonymize on overrides
        ├── verify.ts              re-detect on anonymized output, fail on real-PII leak
        ├── sessions.ts            list, show, find, export, import
        ├── install-model.ts       download GLiNER zip → extract → reinit
        └── doctor.ts              node version, dirs, model, deps
```

## Build

```bash
cd nodejs-v2
npm ci --ignore-scripts --legacy-peer-deps
npm run build:cli
# produces dist/cli/bin.mjs (~2.3 MB) + dist/ui/review-cli.html (~55 KB)
```

`build-cli.mjs` runs in three steps:
1. `vite build INPUT=review-cli.html` — single-file UI bundle. The `review-cli.html` reuses `src/review-app.ts` from the MCP build; vite alias swaps `@modelcontextprotocol/ext-apps` for `ui/src/cli-app-shim.ts` (HTTP-backed `App` class). See `vite.config.ts` `resolve.alias`.
2. `esbuild cli/src/bin.ts → dist/cli/bin.mjs` — esm bundle, Node 22 target, banner adds shebang + `createRequire` polyfill so CJS deps (commander, cli-progress) load. The HTML bundle from step 1 is inlined via `loader: { ".html": "text" }`.
3. `chmod +x dist/cli/bin.mjs` (POSIX only).

## Local install

```bash
cd nodejs-v2
npm link            # creates global `pii-shield` symlinking to dist/cli/bin.mjs
pii-shield --help
```

To unlink:
```bash
npm unlink -g pii-shield
```

## Smoke test

```bash
cd nodejs-v2
node scripts/smoke-cli.mjs
```

Generates three text files with shared entities (`John Smith`, `Acme Corp`, SSN `123-45-6789`), runs them through `anonymize` in a single batch, asserts that the SSN placeholder is **identical** across `doc1` and `doc3` (multi-doc invariant), then round-trips one through `deanonymize` and verifies bytewise equality with the original. Also exercises `sessions list/show/export/import` with a random passphrase.

## How it differs from the MCP server (`src/index.ts`)

| Concern | MCP server | CLI |
|---|---|---|
| Transport | stdio (JSON-RPC) | argv (commander) |
| HITL panel | MCP Apps `ui://` iframe | Local HTTP server on `127.0.0.1:6789–6799` + browser via `open` |
| Setup panel | `start_model_setup` MCP App tool | `pii-shield install-model` interactive prompt |
| `anonymize_file` chunking | Returns `error: session_id is not supported with chunked processing` for >15K-char docs (`src/index.ts:904`) | Calls `PIIEngine.anonymizeText(text, lang, prefix, sharedState)` directly — engine.detect chunks NER internally, so any size works with `--session` |
| Audit | `wrapPlainTool` middleware around each handler | `withAudit()` wrapper in `runtime.ts` mirrors the same `logToolCall` / `logToolResponse` / `logToolError` pattern |
| Audit stderr echo | On (Cowork / Desktop terminal capture) | Off by default (`PII_AUDIT_STDERR=false` set in bin.ts) — `--debug` flips back |
| State | `PIIEngine.getInstance()` singleton | Same singleton, initialized once via `initRuntime()` |
| Glob expansion | shell does it | CLI does it via `tinyglobby` (works on Windows cmd.exe) |
| Session id input | full id only | unique prefixes accepted (git-style `resolveSessionId`) |

All other invariants (mapping shape, session_id format, `~/.pii_shield/` dirs, GLiNER deps install) are identical, by design — sessions are portable between MCP and CLI use.

## Design choices

- **No native binaries / Docker / Homebrew yet.** npm-only is the cheapest distribution and the easiest to update. Adding standalone binaries via `bun build --compile` is a follow-up if Node 22+ adoption becomes a barrier.
- **HITL is browser-only — no TUI.** Reusing `review-app.ts` (~1500 lines of vetted UI code) via vite alias is far cheaper than building a terminal UI from scratch. SSH / headless users use `--no-review` or `PII_SKIP_REVIEW=true`.
- **Multi-doc batches are sequential.** `engine.anonymizeText` is stateful (shared `PlaceholderState`), and NER inference is single-threaded inside ONNX Runtime. Parallelizing across files would scramble cross-doc placeholder consistency. Expected throughput: ~10s/doc on CPU after warm cache, so ~5 min for 30 docs.
- **`review-overrides.ts` duplicates ~50 lines of `src/index.ts`** intentionally — the MCP entry point starts a stdio server on import, so we can't pull from there without breaking CLI startup. If the duplication grows, lift the helper into `src/engine/hitl-overrides.ts` and import from both sides.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `pii-shield: command not found` after `npm install -g` | Node's global bin dir isn't on `$PATH`. Run `npm root -g` to find it; add the parent `bin/` to `PATH`. |
| `Dynamic require of "node:events" is not supported` at startup | `dist/cli/bin.mjs` rebuilt without the `createRequire` polyfill. Re-run `npm run build:cli`. |
| First `anonymize` takes 1–2 min | Expected. NER deps installer runs `npm ci --ignore-scripts` into `~/.pii_shield/deps/installs/<slug>/`. Subsequent runs are instant. Monitor `~/.pii_shield/audit/ner_init.log`. |
| `model.onnx missing` in doctor output | Run `pii-shield install-model` — downloads ~634 MB from the GitHub release. Add `--yes` for non-interactive. |
| Browser doesn't open during review | `open` package falls back to printing the URL. Copy `http://127.0.0.1:<port>/?token=…` from the terminal manually. |
| HTTP server fails — port in use | We try `6789–6799`; if all are taken, the run aborts. Close other PII Shield processes or kill anything else listening on those ports. |
