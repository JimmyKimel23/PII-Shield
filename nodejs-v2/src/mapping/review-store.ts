/**
 * PII Shield v2.1.3 — Review session persistence with per-document support.
 *
 * Stores HITL review data keyed by session_id, where each session can hold
 * N per-document review blocks (v2.1 multi-file feature). Memory-first with
 * disk fallback at PATHS.MAPPINGS_DIR/review_{sid}.json (co-located with
 * mapping files; latestSessionId() filters them out via the `review_` prefix).
 *
 * Legacy single-doc format (flat `entities`/`original_text` fields) is
 * auto-migrated on read via `getReview()` — no manual migration needed.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PATHS } from "../utils/config.js";
import { logServer } from "../audit/audit-logger.js";
import { assertSafeSessionId, isSafeSessionId } from "./mapping-store.js";

export interface ReviewEntity {
  text: string;
  type: string;
  start: number;
  end: number;
  score?: number;
  placeholder: string;
}

export interface ReviewOverrides {
  remove: number[];
  add: Array<{ text: string; type: string; start: number; end: number }>;
}

/**
 * Review data for ONE document within a session. Multiple instances live in
 * `ReviewData.documents[]` when a session has been extended via
 * `anonymize_file(..., session_id=S)`.
 */
export interface PerDocReview {
  doc_id: string;
  source_filename: string;
  source_file_path: string;
  entities: ReviewEntity[];
  original_text: string;
  anonymized_text: string;
  html_text?: string;
  overrides: ReviewOverrides;
  approved: boolean;
  /** Per-doc output directory — used by apply_review_overrides to archive decisions.json. */
  output_dir: string;
  /**
   * Paths produced by the FIRST anonymize_file call for this doc. Preserved
   * so that `anonymize_file(..., review_session_id=sid)` can return them
   * unchanged when the user approved without edits (`approved_no_changes`).
   */
  output_path_original: string;
  docx_output_path_original?: string;
  added_at: number; // epoch ms, for ordering
}

export interface ReviewData {
  session_id: string;
  timestamp: number;
  /** Per-document review blocks, ordered by added_at. v2.1 multi-file. */
  documents: PerDocReview[];
  /** AES-256-GCM key (hex) for encrypting decisions in transit — rarely used. */
  review_secret?: string;
  /**
   * Set to the error code (e.g. "ENOSPC") if the disk write in saveReview
   * failed. Surfaced by start_review so the user knows in-memory state is
   * all we have — a process restart will lose the review.
   */
  _disk_write_failed?: string;
}

// In-memory store
const _reviews = new Map<string, ReviewData>();

/**
 * Per-session disk mtime as observed at the time we last read/wrote the
 * review file. Used by getReview to detect cross-process writes — when
 * Claude Desktop spawns multiple MCP server instances (a known Windows
 * race) each process holds its own _reviews Map; without an mtime check
 * a process that wrote `approved: false` initially would keep returning
 * that stale value even after another process wrote `approved: true` to
 * disk via apply_review_overrides.
 */
const _reviewMtimes = new Map<string, number>();

function reviewFilePath(sessionId: string): string {
  return path.join(PATHS.MAPPINGS_DIR, `review_${sessionId}.json`);
}

function ensureDir(): void {
  try {
    fs.mkdirSync(PATHS.MAPPINGS_DIR, { recursive: true });
  } catch {
    // will retry
  }
}

/** Save review data to memory + disk */
export function saveReview(sessionId: string, data: ReviewData): void {
  assertSafeSessionId(sessionId);
  // Normalise: if caller forgot timestamp / documents, fill in safe defaults.
  if (typeof data.timestamp !== "number") data.timestamp = Date.now();
  if (!Array.isArray(data.documents)) data.documents = [];
  data.session_id = sessionId;

  _reviews.set(sessionId, data);

  try {
    ensureDir();
    const filePath = reviewFilePath(sessionId);
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
    if (data._disk_write_failed) delete data._disk_write_failed;
    // Record the mtime we just produced so getReview can later detect
    // whether ANOTHER process has overwritten the file since this write.
    try {
      _reviewMtimes.set(sessionId, fs.statSync(filePath).mtimeMs);
    } catch {
      // Stat failure here is non-fatal — the next getReview will simply
      // observe mtime > -1 (default) and reload, which is correct.
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code || "UNKNOWN";
    data._disk_write_failed = code;
    const msg = `[Review] disk write FAILED for session=${sessionId} code=${code} dir=${PATHS.MAPPINGS_DIR} err=${e}. ` +
      `In-memory copy kept, but a process restart will lose the review.`;
    console.error(msg);
    try { logServer(msg); } catch { /* audit dir may not exist yet */ }
  }
}

/**
 * Migrate a legacy single-doc ReviewData record to the v2.1.3
 * `documents[]` shape. Returns the migrated data (new object). Safe to call
 * on already-migrated records (returns them unchanged).
 */
function migrateLegacyReview(raw: unknown): ReviewData {
  const obj = raw as Record<string, unknown> & Partial<ReviewData>;
  // Already in new format — just ensure documents is an array.
  if (Array.isArray((obj as Partial<ReviewData>).documents)) {
    return {
      session_id: (obj.session_id as string) || "",
      timestamp: (obj.timestamp as number) || Date.now(),
      documents: (obj.documents as PerDocReview[]).map(normaliseDoc),
      review_secret: obj.review_secret as string | undefined,
      _disk_write_failed: obj._disk_write_failed as string | undefined,
    };
  }
  // Legacy: build a single PerDocReview from the flat fields.
  const legacyDocId = `legacy-${crypto.randomBytes(3).toString("hex")}`;
  const doc: PerDocReview = {
    doc_id: legacyDocId,
    source_filename:
      (obj.source_filename as string)
      || (obj.original_filename as string)
      || path.basename((obj.source_file_path as string) || "")
      || legacyDocId,
    source_file_path: (obj.source_file_path as string) || "",
    entities: Array.isArray(obj.entities) ? (obj.entities as ReviewEntity[]) : [],
    original_text: (obj.original_text as string) || "",
    anonymized_text: (obj.anonymized_text as string) || "",
    html_text: obj.html_text as string | undefined,
    overrides: (obj.overrides as ReviewOverrides) || { remove: [], add: [] },
    approved: !!obj.approved,
    output_dir: (obj.output_dir as string) || "",
    output_path_original: (obj.output_path_original as string) || "",
    docx_output_path_original: obj.docx_output_path_original as string | undefined,
    added_at: (obj.timestamp as number) || Date.now(),
  };
  return {
    session_id: (obj.session_id as string) || "",
    timestamp: (obj.timestamp as number) || Date.now(),
    documents: [doc],
    review_secret: obj.review_secret as string | undefined,
    _disk_write_failed: obj._disk_write_failed as string | undefined,
  };
}

/** Fill in missing optional fields on a PerDocReview (defensive). */
function normaliseDoc(doc: Partial<PerDocReview>): PerDocReview {
  return {
    doc_id: doc.doc_id || `legacy-${crypto.randomBytes(3).toString("hex")}`,
    source_filename: doc.source_filename || "",
    source_file_path: doc.source_file_path || "",
    entities: Array.isArray(doc.entities) ? doc.entities : [],
    original_text: doc.original_text || "",
    anonymized_text: doc.anonymized_text || "",
    html_text: doc.html_text,
    overrides: doc.overrides || { remove: [], add: [] },
    approved: !!doc.approved,
    output_dir: doc.output_dir || "",
    output_path_original: doc.output_path_original || "",
    docx_output_path_original: doc.docx_output_path_original,
    added_at: typeof doc.added_at === "number" ? doc.added_at : Date.now(),
  };
}

/**
 * Get review data: memory first, but cross-checked against the on-disk
 * mtime so a fresher copy written by ANOTHER server process (Windows
 * multi-spawn case) supersedes our cached one. Auto-migrates legacy
 * format on cold reads.
 *
 * Decision matrix:
 *   - File missing on disk       → return memory if any, else null.
 *   - Memory absent              → cold read from disk, populate caches.
 *   - Disk mtime <= cached mtime → memory is fresh, fast path.
 *   - Disk mtime  >  cached mtime → another process wrote; reload + log.
 */
export function getReview(sessionId: string): ReviewData | null {
  if (!isSafeSessionId(sessionId)) return null;

  const filePath = reviewFilePath(sessionId);
  const memData = _reviews.get(sessionId);

  // Cheap mtime probe (single syscall on Windows/Linux/macOS).
  let diskMtime = -1;
  try {
    diskMtime = fs.statSync(filePath).mtimeMs;
  } catch {
    // File doesn't exist (ENOENT) or unreadable — trust memory.
    return memData || null;
  }

  const cachedMtime = _reviewMtimes.get(sessionId) ?? -1;

  // Fast path: memory present and disk hasn't been touched since our
  // last load/write. No reload needed.
  if (memData && diskMtime <= cachedMtime) {
    return memData;
  }

  // Cold read OR cross-process write detected — reload from disk.
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const migrated = migrateLegacyReview(raw);
    _reviews.set(sessionId, migrated);
    _reviewMtimes.set(sessionId, diskMtime);
    if (memData && cachedMtime >= 0) {
      // Log only when we ACTUALLY supersede an existing cache — the
      // cold-read case is uninteresting. This trace is the audit-trail
      // evidence that the multi-process race is being handled.
      logServer(
        `[Review] cache invalidated for session=${sessionId}: ` +
        `disk mtime ${Math.round(diskMtime)} > cached ${Math.round(cachedMtime)} ` +
        `(another server process wrote; reloading)`,
      );
    }
    return migrated;
  } catch (e) {
    console.error(`[Review] disk read failed: ${e}`);
    // Best-effort: hand back stale memory rather than null when we know
    // the file exists but we couldn't parse it (transient I/O hiccup).
    return memData || null;
  }
}

/**
 * Append (or update) a per-document review block within a session. Creates
 * the session record if it doesn't exist. If a doc with the same doc_id
 * already exists, it is replaced — useful when re-anonymizing after HITL.
 */
export function appendDocReview(sessionId: string, doc: PerDocReview): ReviewData {
  const existing = getReview(sessionId) || {
    session_id: sessionId,
    timestamp: Date.now(),
    documents: [],
  };
  const normalised = normaliseDoc(doc);
  const idx = existing.documents.findIndex((d) => d.doc_id === normalised.doc_id);
  if (idx >= 0) {
    existing.documents[idx] = normalised;
  } else {
    existing.documents.push(normalised);
  }
  existing.timestamp = Date.now();
  saveReview(sessionId, existing);
  return existing;
}

/**
 * Find a specific per-doc review by doc_id, or (when docId is omitted) the
 * first doc in the session — used for legacy single-doc compat.
 */
export function findDocReview(
  sessionId: string,
  docId?: string,
): PerDocReview | null {
  const data = getReview(sessionId);
  if (!data) return null;
  if (!docId) return data.documents[0] || null;
  return data.documents.find((d) => d.doc_id === docId) || null;
}

/**
 * Find a per-doc review by matching the stored `source_file_path` against
 * the given absolute path. When multiple docs match (rare — user re-added
 * the same file), the one with the latest `added_at` wins.
 */
export function findDocReviewByPath(
  sessionId: string,
  sourceFilePath: string,
): PerDocReview | null {
  const data = getReview(sessionId);
  if (!data) return null;
  const matches = data.documents.filter((d) => d.source_file_path === sourceFilePath);
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.added_at - a.added_at);
  return matches[0];
}

/**
 * Mutate a specific per-doc review in place and persist the whole session.
 * Returns the updated doc, or null if doc_id wasn't found.
 */
export function updateDocReview(
  sessionId: string,
  docId: string,
  patch: Partial<PerDocReview>,
): PerDocReview | null {
  const data = getReview(sessionId);
  if (!data) return null;
  const idx = data.documents.findIndex((d) => d.doc_id === docId);
  if (idx < 0) return null;
  data.documents[idx] = normaliseDoc({ ...data.documents[idx], ...patch });
  saveReview(sessionId, data);
  return data.documents[idx];
}

// ── Legacy single-doc helpers (kept thin for BC with any external consumers) ──

/** Update review overrides (from HITL UI) — legacy single-doc path. */
export function updateReviewOverrides(
  sessionId: string,
  overrides: ReviewOverrides,
): void {
  const data = getReview(sessionId);
  if (!data || data.documents.length === 0) return;
  data.documents[0].overrides = overrides;
  saveReview(sessionId, data);
}

/** Mark review as approved — legacy single-doc path. */
export function approveReview(sessionId: string): void {
  const data = getReview(sessionId);
  if (!data || data.documents.length === 0) return;
  data.documents[0].approved = true;
  saveReview(sessionId, data);
}
