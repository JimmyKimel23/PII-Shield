/**
 * PII Shield v2.0.4 — Configuration
 * Environment variable defaults and constants.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const VERSION = "2.0.4";

/**
 * Resolve the persistent data directory for this plugin instance.
 *
 * Resolution order (first match wins):
 *
 * 1. **`PII_SHIELD_DATA_DIR`** — explicit power-user / test override.
 * 2. **`CLAUDE_PLUGIN_DATA`** — host-provided per-plugin persistent dir.
 *    Claude Code / Claude Desktop set this env var before spawning the MCP
 *    server process. It's a stable path chosen by the host (typically under
 *    `~/.claude/data/<plugin>/` on *nix, `%LOCALAPPDATA%\Claude\data\…` on
 *    Windows) and survives host restarts and plugin updates.
 * 3. **`~/.pii_shield`** — stable cross-platform fallback for standalone /
 *    dev usage when no host env var is set.
 *
 * The resolved path is memoised for the lifetime of the process; explicit
 * reset via `_resetDataDirCache()` is exposed for tests. No filesystem BFS,
 * no workspace marker files, no "workspace hints" — those were Cowork VM
 * artefacts that don't apply to modern Claude hosts where the plugin runs
 * against a stable user filesystem.
 */
let _cachedDataDir: string | null = null;
let _cachedDataDirSource: string | null = null;
let _cachedMappingsDir: string | null = null;
let _cachedMappingsDirSource: string | null = null;

/** Reset the memoized data-dir choice (for tests). */
export function _resetDataDirCache(): void {
  _cachedDataDir = null;
  _cachedDataDirSource = null;
  _cachedMappingsDir = null;
  _cachedMappingsDirSource = null;
}

/** Source-of-truth description for the currently resolved data dir. */
export function getDataDirSource(): string {
  getDataDir(); // ensure resolution has run at least once
  return _cachedDataDirSource || "unknown";
}

/** Source-of-truth description for the currently resolved mappings dir. */
export function getMappingsDirSource(): string {
  getMappingsDir();
  return _cachedMappingsDirSource || "unknown";
}

function ensureDir(dir: string): void {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
}

/**
 * Create a directory that should be user-private (mode 0o700 on POSIX).
 * On Windows chmod is a no-op; the dir is still effectively private because
 * it lives under the user's home profile.
 */
function ensureDirSecure(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* no-op on Windows */ }
  } catch {
    /* best effort */
  }
}

function getDataDir(): string {
  if (_cachedDataDir) return _cachedDataDir;

  // 1. Explicit env override (power user / tests).
  const explicit = process.env.PII_SHIELD_DATA_DIR;
  if (explicit && explicit.length > 0) {
    ensureDir(explicit);
    _cachedDataDir = explicit;
    _cachedDataDirSource = "PII_SHIELD_DATA_DIR env override";
    return explicit;
  }

  // 2. Host-provided per-plugin persistent dir. Claude Code / Claude Desktop
  // expose this as the canonical place to keep model cache, deps, audit logs.
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData && pluginData.length > 0) {
    ensureDir(pluginData);
    _cachedDataDir = pluginData;
    _cachedDataDirSource = "CLAUDE_PLUGIN_DATA (host-provided)";
    return pluginData;
  }

  // 3. Stable cross-platform fallback. Same path for the same OS user,
  // every run — no scanning, no markers, no probes. If a user or the host
  // wants a different location they set one of the env vars above.
  const fallback = path.join(os.homedir(), ".pii_shield");
  ensureDir(fallback);
  _cachedDataDir = fallback;
  _cachedDataDirSource = "~/.pii_shield fallback";
  return fallback;
}

/**
 * Resolve the MAPPINGS directory. Sits next to models / deps / audit under
 * the same `~/.pii_shield/` root (underscore — historical data dir). Claude
 * Desktop does not set `CLAUDE_PLUGIN_DATA` for mcpb plugins, so
 * `getDataDir()` falls back to this user-global path which already survives
 * `/plugin remove`. No separate "dash-prefixed" dir needed.
 *
 * Resolution order:
 * 1. `PII_SHIELD_MAPPINGS_DIR` — explicit override for tests / enterprise
 * 2. `<getDataDir()>/mappings` — follows whatever the shared data dir resolves to
 */
function getMappingsDir(): string {
  if (_cachedMappingsDir) return _cachedMappingsDir;

  const explicit = process.env.PII_SHIELD_MAPPINGS_DIR;
  if (explicit && explicit.length > 0) {
    ensureDirSecure(explicit);
    _cachedMappingsDir = explicit;
    _cachedMappingsDirSource = "PII_SHIELD_MAPPINGS_DIR env override";
    return explicit;
  }

  const mappings = path.join(getDataDir(), "mappings");
  ensureDirSecure(mappings);
  _cachedMappingsDir = mappings;
  _cachedMappingsDirSource = `${getDataDirSource()}/mappings`;
  return mappings;
}

export const ENV = {
  /** Minimum confidence score for pattern-based detections (0.0–1.0) */
  PII_MIN_SCORE: parseFloat(process.env.PII_MIN_SCORE || "0.30"),

  /** Minimum confidence score for NER detections (0.0–1.0) */
  PII_NER_THRESHOLD: parseFloat(process.env.PII_NER_THRESHOLD || "0.30"),

  /** GLiNER model name (for ONNX export reference) */
  PII_GLINER_MODEL: process.env.PII_GLINER_MODEL || "knowledgator/gliner-pii-base-v1.0",

  /** Mapping TTL in days */
  PII_MAPPING_TTL_DAYS: parseInt(process.env.PII_MAPPING_TTL_DAYS || "7", 10),

  /** Working directory for find_file */
  PII_WORK_DIR: process.env.PII_WORK_DIR || "",

  /** Skip HITL review step */
  PII_SKIP_REVIEW: process.env.PII_SKIP_REVIEW === "true",
} as const;

/** Chunk processing thresholds */
export const CHUNK = {
  /** Documents above this char count trigger chunked processing */
  THRESHOLD: 15_000,
  /** Default chunk size in chars */
  DEFAULT_SIZE: 2500,
  /** Chunk session TTL in ms (30 minutes) */
  SESSION_TTL_MS: 30 * 60 * 1000,
} as const;

/**
 * Paths — all getters so `CLAUDE_PLUGIN_DATA` is re-read lazily. Claude Code
 * sets the env var before spawning our stdio process, but lazy reads also
 * protect against any early-init race and make tests trivially overridable.
 */
export const PATHS = {
  get DATA_DIR()     { return getDataDir(); },
  get MODELS_DIR()   { return path.join(getDataDir(), "models"); },
  get DEPS_DIR()     { return path.join(getDataDir(), "deps"); },
  /**
   * v2.1: MAPPINGS_DIR is resolved independently from DATA_DIR so session
   * mappings survive `/plugin remove` (CLAUDE_PLUGIN_DATA wipe). See
   * `getMappingsDir()` for resolution rules.
   */
  get MAPPINGS_DIR() { return getMappingsDir(); },
  /** Reviews co-located with mappings (prefixed `review_<sid>.json`). */
  get REVIEWS_DIR()  { return getMappingsDir(); },
  get AUDIT_DIR()    { return path.join(getDataDir(), "audit"); },
};

/**
 * Legacy `~/.pii_shield` location. Kept as a read-only fallback so pre-plugin
 * users with a warmed-up model cache (~665 MB ONNX download) don't have to
 * re-download on the first plugin launch after migrating to the host-managed
 * `CLAUDE_PLUGIN_DATA` layout. Function-form (not const) so `os.homedir()`
 * isn't called at module-eval — keeps top-level synchronous work minimal,
 * which matters for the macOS Claude Desktop UtilityProcess startup window.
 */
export function getLegacyDataDir(): string {
  return path.join(os.homedir(), ".pii_shield");
}
