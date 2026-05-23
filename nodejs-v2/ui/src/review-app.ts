/**
 * @file PII Shield review iframe — main module.
 *
 * Runs inside the sandboxed iframe the MCP host renders for
 * `ui://pii-shield/review.html`.  Uses the `App` class from
 * `@modelcontextprotocol/ext-apps` to:
 *
 *   - Receive the initial session payload via `ontoolresult` (comes from the
 *     `start_review` tool response, field `structuredContent`).
 *   - Send the user's approve payload back via `app.callServerTool({ name:
 *     "apply_review_overrides", arguments: { session_id, overrides } })`.
 *
 * Replaces the v1.x fetch-based client that talked to a localhost HTTP
 * server — that server doesn't exist in v2.0.0.  All data travels through
 * MCP over stdio, so no network access or browser tab is needed.
 *
 * The render/selection/approve logic is ported verbatim from
 * `nodejs/assets/review_ui.html` (~1400 lines of inline script).  Only the
 * bulk-mode tabbed navigation was dropped — the v2.0.0 flow opens one panel
 * per `start_review` call, which is how every known host renders MCP Apps
 * today.  Bulk can be reintroduced later by either (a) opening multiple
 * panels or (b) letting `ontoolresult` deliver an array of sessions and
 * keeping them in-memory.
 */

import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "./review.css";

// ── Types ───────────────────────────────────────────────────────────────────

interface Entity {
  text: string;
  type: string;
  start: number;
  end: number;
  score: number;
  placeholder?: string;
  /** Assigned by the UI when entities arrive (stable index into `entities[]`). */
  idx: number;
  /** All entities from the server are considered verified. */
  verified: boolean;
}

interface AddedEntity {
  text: string;
  type: string;
  start: number;
  end: number;
}

interface FormatRun {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

interface BlockMapEntry {
  start: number;
  end: number;
  tag: string;
}

interface SessionPayload {
  session_id: string;
  /** v2.1.3: doc_id scopes the payload to a single PerDocReview within a
   *  multi-file session. For legacy single-doc sessions this is omitted
   *  and the server applies overrides to documents[0]. */
  doc_id?: string;
  original_text?: string;
  /** v2.0.0 server field name. */
  html_text?: string;
  /** Legacy field alias (v1.x). */
  original_html?: string;
  anonymized_text?: string;
  entities?: Array<Omit<Entity, "idx" | "verified">>;
  overrides?: { remove?: number[]; add?: AddedEntity[] };
  approved?: boolean;
  source_filename?: string;
}

/**
 * v2.0.3 (issue #2): start_review now returns metadata-only entries here.
 * Raw PII (original_text, entities, html_text) is pulled separately by the
 * iframe via the model-invisible `get_review_payload` tool.
 */
interface SessionMetadata {
  session_id: string;
  doc_id?: string;
  source_filename?: string;
  entity_count?: number;
  approved?: boolean;
  has_overrides?: boolean;
}

interface StartReviewStructuredContent {
  status?: string;
  sessions?: SessionMetadata[];
  count?: number;
  is_bulk?: boolean;
}

interface Family {
  type: string;
  rootText: string;
  rootNorm: string;
  members: Array<{
    text: string;
    norm: string;
    indices: number[];
    score: number;
  }>;
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`element #${id} not found in review.html shell`);
  return el;
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── State ───────────────────────────────────────────────────────────────────

let SESSION_ID = "";
/** v2.1.3: doc_id for the currently loaded single-session review (empty when
 *  the server didn't emit one — legacy single-doc flow). */
let DOC_ID = "";
let originalText = "";
let originalHtml = "";
let anonymizedText = "";
let entities: Entity[] = [];
let removedIndices = new Set<number>();
let addedEntities: AddedEntity[] = [];
let formatRuns: FormatRun[] = [];
let blockMap: BlockMapEntry[] = [];
let collapsedFamilies = new Set<string>();
let splitView = false;
let focusedFamilyIdx = -1;
let currentFamilies: Family[] = [];
/**
 * Sidebar text filter. Normalized (lowercased, trimmed) substring — if non-empty,
 * `renderSidebar()` hides any family/added-entity whose text doesn't contain it.
 * Updated by the `#filter-input` input handler (initSidebarFilter), and focused
 * on `/` keystroke (see keydown listener).
 */
let sidebarFilter = "";

// ── Bulk mode state (multi-document review) ─────────────────────────────────
// When start_review is called with 2+ session_ids, we switch to tabbed UI:
// one tab per document, independent per-doc state cached in memory, global
// approve-gating (all docs must be approved before the panel closes), and
// cross-document entity propagation (adding/removing in doc A auto-applies
// the same decision to matching text in docs B..N).

interface BulkSession {
  session_id: string;
  /** v2.1.3: per-doc id inside a multi-file session. Empty for legacy single-doc. */
  doc_id: string;
  source_filename: string;
  approved: boolean;
  /** Cached original payload from the server. */
  payload: SessionPayload;
  /** Per-session user decisions. */
  state: { removedIndices: Set<number>; addedEntities: AddedEntity[] };
}

let bulkSessions: BulkSession[] = [];
let currentBulkIdx = 0;

function isBulkMode(): boolean {
  return bulkSessions.length > 1;
}

/**
 * Set both the top and bottom Approve buttons to the same disabled/text
 * state. The bottom button is added by review.html so users can approve
 * after reviewing a long doc without scrolling back up — we keep their
 * states in sync so the UI always shows one coherent "Approve" / "Saving…"
 * action everywhere.
 */
function setApproveBtnState(disabled: boolean, text: string): void {
  const top = $("approve-btn") as HTMLButtonElement;
  top.disabled = disabled;
  top.textContent = text;
  const bottom = document.getElementById("approve-btn-bottom") as HTMLButtonElement | null;
  if (bottom) {
    bottom.disabled = disabled;
    bottom.textContent = text;
  }
}

// ── Theme ───────────────────────────────────────────────────────────────────

function isDark(): boolean {
  if (document.documentElement.classList.contains("dark")) return true;
  if (document.documentElement.classList.contains("light")) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function updateThemeIcon(): void {
  const btn = document.getElementById("theme-btn");
  if (btn) btn.textContent = isDark() ? "\u2600\uFE0F" : "\uD83C\uDF19";
}

function initTheme(): void {
  const saved = localStorage.getItem("pii-theme");
  if (saved === "dark") {
    document.documentElement.classList.add("dark");
    document.documentElement.classList.remove("light");
  } else if (saved === "light") {
    document.documentElement.classList.add("light");
    document.documentElement.classList.remove("dark");
  }
  updateThemeIcon();
}

function toggleTheme(): void {
  const goingDark = !isDark();
  document.documentElement.classList.toggle("dark", goingDark);
  document.documentElement.classList.toggle("light", !goingDark);
  localStorage.setItem("pii-theme", goingDark ? "dark" : "light");
  updateThemeIcon();
}

// ── Entity grouping ─────────────────────────────────────────────────────────

const ENTITY_GROUP: Record<string, string> = {
  PERSON: "PERSON", NRP: "PERSON",
  ORGANIZATION: "ORG", ORG: "ORG",
  LOCATION: "LOCATION",
  EMAIL_ADDRESS: "COMM", PHONE_NUMBER: "COMM", URL: "COMM", IP_ADDRESS: "COMM",
  CREDIT_CARD: "FINANCIAL", IBAN_CODE: "FINANCIAL", CRYPTO: "FINANCIAL",
  US_SSN: "ID_DOC", US_PASSPORT: "ID_DOC", US_DRIVER_LICENSE: "ID_DOC",
  UK_NHS: "ID_DOC", UK_NIN: "ID_DOC", UK_PASSPORT: "ID_DOC", UK_CRN: "ID_DOC",
  UK_DRIVING_LICENCE: "ID_DOC",
  EU_VAT: "ID_DOC", EU_PASSPORT: "ID_DOC",
  DE_TAX_ID: "ID_DOC", DE_SOCIAL_SECURITY: "ID_DOC",
  FR_NIR: "ID_DOC", FR_CNI: "ID_DOC",
  IT_FISCAL_CODE: "ID_DOC", IT_VAT: "ID_DOC",
  ES_DNI: "ID_DOC", ES_NIE: "ID_DOC",
  CY_TIC: "ID_DOC", CY_ID_CARD: "ID_DOC",
  MEDICAL_LICENSE: "MEDICAL",
};

function getEntityClass(type: string): string {
  return "entity-" + (ENTITY_GROUP[type] || "OTHER");
}

function getTypeClass(type: string): string {
  return "type-" + (ENTITY_GROUP[type] || "OTHER");
}

function makeGroupKey(type: string, text: string): string {
  const norm = (text || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "_");
  return `${type}__${norm}`;
}

// ── Format parsing from docx HTML ───────────────────────────────────────────

function parseHtmlFormatting(html: string): void {
  const temp = document.createElement("div");
  temp.innerHTML = html;
  formatRuns = [];
  blockMap = [];
  let charPos = 0;

  for (const block of Array.from(temp.children)) {
    const tag = block.tagName.toLowerCase();
    const blockStart = charPos;

    function walkNode(node: Node, inherited: { bold: boolean; italic: boolean; underline: boolean }) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || "";
        if (text.length > 0) {
          if (inherited.bold || inherited.italic || inherited.underline) {
            formatRuns.push({
              start: charPos, end: charPos + text.length,
              bold: inherited.bold, italic: inherited.italic, underline: inherited.underline,
            });
          }
          charPos += text.length;
        }
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const t = (node as Element).tagName.toLowerCase();
        if (t === "br") { charPos++; return; }
        const next = { ...inherited };
        // Bold intentionally NOT tracked: DOCX runs are often split mid-word
        // with inconsistent bold flags, producing ugly "ha**lf wor**d" renders.
        // Italic/underline are much less frequently mis-split so stay.
        // if (t === "b" || t === "strong") next.bold = true;
        if (t === "i" || t === "em") next.italic = true;
        if (t === "u") next.underline = true;
        for (const child of Array.from(node.childNodes)) walkNode(child, next);
      }
    }

    walkNode(block, { bold: false, italic: false, underline: false });
    blockMap.push({ start: blockStart, end: charPos, tag });
    charPos++; // \n between paragraphs
  }
}

// ── Render ──────────────────────────────────────────────────────────────────

interface DisplayEntity extends Entity {
  source: "original" | "added";
  _tooltipHtml?: string;
}

function render(): void {
  renderDocument();
  renderSidebar();
  updateStats();
  if (splitView) renderAnonymizedPanel();
}

function renderDocument(): void {
  const container = $("doc-content");
  const hasHtml = formatRuns.length > 0 || blockMap.length > 0;
  container.classList.toggle("html-mode", hasHtml);

  const allEntities: DisplayEntity[] = [
    ...entities.filter(e => e.verified).map<DisplayEntity>(e => ({ ...e, source: "original" })),
    ...addedEntities.map<DisplayEntity>((e, i) => ({
      text: e.text, type: e.type, start: e.start, end: e.end, score: 1.0,
      idx: (`added_${i}` as unknown) as number, verified: false, source: "added",
    })),
  ].sort((a, b) => a.start - b.start);

  const segments = buildSegments(allEntities);

  const paragraphs = originalText.split("\n");
  let html = "";
  let offset = 0;
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi];
    const start = offset;
    const end = offset + para.length;
    const tag = (hasHtml && blockMap[pi] && blockMap[pi].tag) || "p";
    html += `<${tag}>`;
    html += renderSegmentsRange(segments, start, end);
    html += `</${tag}>`;
    offset = end + 1;
  }
  container.innerHTML = html;
  wireDocumentEntityHandlers();
}

interface Segment {
  start: number; end: number; entity?: DisplayEntity;
  bold: boolean; italic: boolean; underline: boolean;
}

function buildSegments(allEntities: DisplayEntity[]): Segment[] {
  const points = new Set<number>([0, originalText.length]);
  for (const e of allEntities) {
    if (e.start >= 0) { points.add(e.start); points.add(e.end); }
  }
  for (const f of formatRuns) { points.add(f.start); points.add(f.end); }
  const sorted = Array.from(points).sort((a, b) => a - b);

  const segments: Segment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i], end = sorted[i + 1];
    if (start >= end) continue;
    const entity = allEntities.find(e => e.start <= start && end <= e.end);
    const fmt = formatRuns.find(f => f.start <= start && end <= f.end) || {} as FormatRun;
    segments.push({
      start, end, entity,
      bold: !!fmt.bold, italic: !!fmt.italic, underline: !!fmt.underline,
    });
  }
  return segments;
}

function buildTooltipHtml(e: DisplayEntity): string {
  const label = e.type.replace("_", " ");
  return `<span class="entity-tooltip">${label}</span>`;
}

function renderSegmentsRange(segments: Segment[], rangeStart: number, rangeEnd: number): string {
  let html = "";
  let currentEntity: DisplayEntity | undefined = undefined;

  for (const seg of segments) {
    if (seg.end <= rangeStart || seg.start >= rangeEnd) continue;
    const s = Math.max(seg.start, rangeStart);
    const e = Math.min(seg.end, rangeEnd);
    const text = escapeHtml(originalText.slice(s, e));

    let formatted = text;
    // Bold intentionally not rendered — see parseHtmlFormatting for rationale
    // (DOCX run splits produce half-word bolds that look bad).
    // if (seg.bold) formatted = `<b>${formatted}</b>`;
    if (seg.italic) formatted = `<i>${formatted}</i>`;
    if (seg.underline) formatted = `<u>${formatted}</u>`;

    if (seg.entity) {
      if (currentEntity !== seg.entity) {
        if (currentEntity) html += currentEntity._tooltipHtml + `</span>`;
        const ent = seg.entity;
        const isRemoved = ent.source === "original" && removedIndices.has(ent.idx as unknown as number);
        const isAdded = ent.source === "added";
        const cls = `entity ${getEntityClass(ent.type)} ${isRemoved ? "removed" : ""} ${isAdded ? "entity-added" : ""}`;
        const groupKey = makeGroupKey(ent.type, ent.text);
        const dataIdx = String(ent.idx);
        html +=
          `<span class="${cls}" data-idx="${dataIdx}" data-source="${ent.source}" data-group-key="${groupKey}">`;
        currentEntity = seg.entity;
        currentEntity._tooltipHtml = buildTooltipHtml(ent);
      }
      html += formatted;
    } else {
      if (currentEntity) {
        html += currentEntity._tooltipHtml + `</span>`;
        currentEntity = undefined;
      }
      html += formatted;
    }
  }
  if (currentEntity) html += currentEntity._tooltipHtml + `</span>`;
  return html;
}

function wireDocumentEntityHandlers(): void {
  const container = $("doc-content");
  for (const el of Array.from(container.querySelectorAll(".entity"))) {
    const span = el as HTMLElement;
    span.addEventListener("click", () => toggleEntity(span));
    const groupKey = span.dataset.groupKey || "";
    span.addEventListener("mouseenter", () => highlightGroup(groupKey));
    span.addEventListener("mouseleave", () => unhighlightGroup(groupKey));
  }
}

// ── Family building for sidebar ─────────────────────────────────────────────

function buildFamilies(confirmed: Entity[]): Family[] {
  const families: Family[] = [];

  for (const e of confirmed) {
    const norm = e.text.trim().toLowerCase();
    const type = e.type;
    let found: Family | null = null;
    if (norm.length >= 4) {
      for (const fam of families) {
        if (fam.type !== type) continue;
        if (fam.rootNorm.length >= 4 && (norm.includes(fam.rootNorm) || fam.rootNorm.includes(norm))) {
          const shorter = Math.min(norm.length, fam.rootNorm.length);
          const longer = Math.max(norm.length, fam.rootNorm.length);
          if (shorter / longer >= 0.5) { found = fam; break; }
        }
        const w1 = norm.split(/\s+/)[0], w2 = fam.rootNorm.split(/\s+/)[0];
        if (w1.length >= 4 && w1 === w2) {
          const shorter = Math.min(norm.length, fam.rootNorm.length);
          const longer = Math.max(norm.length, fam.rootNorm.length);
          if (shorter / longer >= 0.5) { found = fam; break; }
        }
      }
    }

    if (found) {
      const existing = found.members.find(m => m.norm === norm);
      if (existing) {
        existing.indices.push(e.idx);
      } else {
        found.members.push({ text: e.text, norm, indices: [e.idx], score: e.score });
        if (norm.length < found.rootNorm.length) {
          found.rootText = e.text;
          found.rootNorm = norm;
        }
      }
    } else {
      families.push({
        type, rootText: e.text, rootNorm: norm,
        members: [{ text: e.text, norm, indices: [e.idx], score: e.score }],
      });
    }
  }

  for (const fam of families) {
    fam.members.sort((a, b) => {
      if (a.norm === fam.rootNorm) return -1;
      if (b.norm === fam.rootNorm) return 1;
      return a.text.localeCompare(b.text);
    });
  }
  return families;
}

function renderSidebar(): void {
  const list = $("entity-list");
  const confirmed = entities.filter(e => e.verified);
  const families = buildFamilies(confirmed);
  currentFamilies = families;

  // ── Filter pass: narrow families + addedEntities to the sidebar search text.
  // Substring match (case-insensitive) on family root AND every variant text
  // so typing "acme" finds "Acme LLC" family regardless of which variant is
  // the root. Empty filter → show all. Update match-count footer for the
  // user's awareness. See #filter-input + initSidebarFilter().
  const filter = sidebarFilter;
  const addedGroupsTotalKeys = new Set(addedEntities.map(e => makeGroupKey(e.type, e.text)));
  const totalGroups = families.length + addedGroupsTotalKeys.size;

  const filteredFamilies = filter === ""
    ? families
    : families.filter(fam => fam.members.some(m => m.text.toLowerCase().includes(filter)));
  const filteredAddedEntities = filter === ""
    ? addedEntities
    : addedEntities.filter(e => e.text.toLowerCase().includes(filter));
  const filteredAddedKeys = new Set(filteredAddedEntities.map(e => makeGroupKey(e.type, e.text)));
  const visibleGroups = filteredFamilies.length + filteredAddedKeys.size;

  const matchCountEl = document.getElementById("filter-match-count");
  if (matchCountEl) {
    matchCountEl.textContent = filter === ""
      ? ""
      : `${visibleGroups} of ${totalGroups}`;
  }

  if (families.length === 0 && addedEntities.length === 0) {
    list.innerHTML =
      '<div style="padding:24px 16px;text-align:center;color:var(--text-secondary);font-size:13px;">No PII entities detected in this document.</div>';
    return;
  }
  if (visibleGroups === 0) {
    list.innerHTML =
      '<div style="padding:24px 16px;text-align:center;color:var(--text-secondary);font-size:13px;">No entities match the filter.</div>';
    return;
  }

  let html = "";
  for (const fam of filteredFamilies) {
    const allIndices = fam.members.flatMap(m => m.indices);
    const totalCount = allIndices.length;
    const allRemoved = allIndices.every(i => removedIndices.has(i));
    const hasVariants = fam.members.length > 1;
    const familyKey = makeGroupKey(fam.type, fam.rootText);
    const isCollapsed = collapsedFamilies.has(familyKey);
    const root = fam.members[0];
    const firstIdx = root.indices[0];

    html += `<div class="entity-item ${getTypeClass(fam.type)} ${allRemoved ? "removed" : ""}" data-group-key="${familyKey}" data-action="scrollto" data-idx="${firstIdx}">`;
    if (hasVariants) {
      html += `<span class="family-toggle ${isCollapsed ? "collapsed" : ""}" data-action="toggle-family" data-family="${familyKey}">&#x25BC;</span>`;
    }
    // Abbreviate type label via ENTITY_GROUP (ORGANIZATION → ORG, EMAIL_ADDRESS
    // → COMM, etc.) so the badge doesn't get truncated against the score +
    // count + action-button chips. Fall back to raw type for unknown labels.
    html += `<span class="type-badge">${ENTITY_GROUP[fam.type] || fam.type}</span>`;
    // Native `title` attribute shows the full entity text on hover — needed
    // because `.text` truncates via overflow:hidden+ellipsis for long names
    // like "Thornbridge Capital Holdings Limited".
    html += `<span class="text" title="${escapeHtml(root.text)}">${escapeHtml(root.text)}</span>`;
    if (totalCount > 1) html += `<span class="group-count">&times;${totalCount}</span>`;
    html += `<span class="score">${(root.score * 100).toFixed(0)}%</span>`;
    if (hasVariants) {
      const dataIndices = allIndices.join(",");
      if (allRemoved) {
        html += `<button class="action-btn restore-btn" title="Restore all" data-action="restore-family" data-indices="${dataIndices}">&#x21A9;</button>`;
      } else {
        html += `<button class="action-btn remove-btn" title="Remove all" data-action="remove-family" data-indices="${dataIndices}">&#x2715;</button>`;
      }
    } else {
      if (allRemoved) {
        html += `<button class="action-btn restore-btn" title="Restore" data-action="restore" data-idx="${firstIdx}">&#x21A9;</button>`;
      } else {
        html += `<button class="action-btn remove-btn" title="Remove" data-action="remove" data-idx="${firstIdx}">&#x2715;</button>`;
      }
    }
    html += `</div>`;

    if (hasVariants && !isCollapsed) {
      for (let i = 1; i < fam.members.length; i++) {
        const m = fam.members[i];
        const variantKey = makeGroupKey(fam.type, m.text);
        const varRemoved = m.indices.every(idx => removedIndices.has(idx));
        const varFirstIdx = m.indices[0];
        html += `<div class="entity-item variant ${getTypeClass(fam.type)} ${varRemoved ? "removed" : ""}" data-group-key="${variantKey}" data-action="scrollto" data-idx="${varFirstIdx}">`;
        html += `<span class="type-badge" style="font-size:9px">${String.fromCharCode(96 + i)}</span>`;
        // tooltip on hover — shows full variant text when truncated by ellipsis
        html += `<span class="text" title="${escapeHtml(m.text)}">${escapeHtml(m.text)}</span>`;
        if (m.indices.length > 1) html += `<span class="group-count">&times;${m.indices.length}</span>`;
        html += `<span class="score">${(m.score * 100).toFixed(0)}%</span>`;
        if (varRemoved) {
          html += `<button class="action-btn restore-btn" title="Restore" data-action="restore" data-idx="${varFirstIdx}">&#x21A9;</button>`;
        } else {
          html += `<button class="action-btn remove-btn" title="Remove" data-action="remove" data-idx="${varFirstIdx}">&#x2715;</button>`;
        }
        html += `</div>`;
      }
    }
  }

  if (filteredAddedEntities.length > 0) {
    // Group by (type, text) key. Use filteredAddedEntities (pre-filtered by
    // sidebarFilter) but indices still point into original addedEntities
    // array so click handlers / remove-added-group resolve correctly.
    const addedGroups = new Map<string, { type: string; text: string; indices: number[] }>();
    for (let i = 0; i < addedEntities.length; i++) {
      const e = addedEntities[i];
      if (filter !== "" && !e.text.toLowerCase().includes(filter)) continue;
      const key = makeGroupKey(e.type, e.text);
      if (!addedGroups.has(key)) {
        addedGroups.set(key, { type: e.type, text: e.text, indices: [i] });
      } else {
        addedGroups.get(key)!.indices.push(i);
      }
    }
    html += `<div class="sidebar-header" style="margin-top:8px;padding:8px 12px">Added by you</div>`;
    for (const [key, group] of addedGroups) {
      const count = group.indices.length;
      html += `<div class="entity-item ${getTypeClass(group.type)}">`;
      html += `<span class="idx">+</span>`;
      html += `<span class="type-badge">${ENTITY_GROUP[group.type] || group.type}</span>`;
      html += `<span class="text" title="${escapeHtml(group.text)}">${escapeHtml(group.text)}</span>`;
      if (count > 1) html += `<span class="group-count">&times;${count}</span>`;
      html += `<button class="action-btn remove-btn" title="Remove all" data-action="remove-added-group" data-key="${key}">&#x2715;</button>`;
      html += `</div>`;
    }
  }

  list.innerHTML = html;
  wireSidebarHandlers();
}

function wireSidebarHandlers(): void {
  const list = $("entity-list");

  for (const el of Array.from(list.querySelectorAll<HTMLElement>(".entity-item"))) {
    const groupKey = el.dataset.groupKey || "";
    if (groupKey) {
      el.addEventListener("mouseenter", () => highlightGroup(groupKey));
      el.addEventListener("mouseleave", () => unhighlightGroup(groupKey));
    }
    if (el.dataset.action === "scrollto" && el.dataset.idx) {
      const idx = Number(el.dataset.idx);
      el.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).closest("button,[data-action=toggle-family]")) return;
        scrollToEntity(idx);
      });
    }
  }

  for (const btn of Array.from(list.querySelectorAll<HTMLElement>("[data-action=toggle-family]"))) {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleFamily(btn.dataset.family || "");
    });
  }
  for (const btn of Array.from(list.querySelectorAll<HTMLElement>("[data-action=remove]"))) {
    btn.addEventListener("click", (ev) => { ev.stopPropagation(); removeEntity(Number(btn.dataset.idx)); });
  }
  for (const btn of Array.from(list.querySelectorAll<HTMLElement>("[data-action=restore]"))) {
    btn.addEventListener("click", (ev) => { ev.stopPropagation(); restoreEntity(Number(btn.dataset.idx)); });
  }
  for (const btn of Array.from(list.querySelectorAll<HTMLElement>("[data-action=remove-family]"))) {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const indices = (btn.dataset.indices || "").split(",").map(Number).filter(n => !Number.isNaN(n));
      removeFamilyAll(indices);
    });
  }
  for (const btn of Array.from(list.querySelectorAll<HTMLElement>("[data-action=restore-family]"))) {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const indices = (btn.dataset.indices || "").split(",").map(Number).filter(n => !Number.isNaN(n));
      restoreFamilyAll(indices);
    });
  }
  for (const btn of Array.from(list.querySelectorAll<HTMLElement>("[data-action=remove-added-group]"))) {
    btn.addEventListener("click", (ev) => { ev.stopPropagation(); removeAddedGroup(btn.dataset.key || ""); });
  }
}

function toggleFamily(familyKey: string): void {
  if (collapsedFamilies.has(familyKey)) collapsedFamilies.delete(familyKey);
  else collapsedFamilies.add(familyKey);
  renderSidebar();
}

function updateStats(): void {
  const confirmed = entities.filter(e => e.verified).length;
  $("entity-count").textContent = String(confirmed - removedIndices.size + addedEntities.length);
  $("removed-count").textContent = String(removedIndices.size);
  $("added-count").textContent = String(addedEntities.length);
}

// ── Remove / restore ────────────────────────────────────────────────────────

function toggleEntity(el: HTMLElement): void {
  const source = el.dataset.source;
  const idxStr = el.dataset.idx || "";
  if (source === "original") {
    const numIdx = parseInt(idxStr);
    if (removedIndices.has(numIdx)) restoreEntity(numIdx);
    else removeEntity(numIdx);
  } else if (source === "added") {
    removeAdded(parseInt(idxStr.replace("added_", "")));
  }
}

function removeEntity(idx: number): void {
  const entity = entities.find(e => e.idx === idx);
  if (entity) {
    const normText = entity.text.trim().toLowerCase();
    const type = entity.type;
    let count = 0;
    for (const e of entities) {
      if (e.verified && e.text.trim().toLowerCase() === normText && e.type === type) {
        removedIndices.add(e.idx);
        count++;
      }
    }
    showToast(`Removed${count > 1 ? ` ${count} occurrences of` : ""} "${entity.text}"`, "remove");
    // Removal is per-tab on purpose. Cross-tab "remove" propagation is a
    // less-redaction decision: a string that's a false positive in this
    // doc may be real PII in a sibling doc, and we don't want to silently
    // unmask it before the user reviews that tab. Only "add" propagates
    // (more-redaction direction is always safe). Matches USAGE.md.
    renderDocTabs();
  } else {
    removedIndices.add(idx);
  }
  render();
}

function restoreEntity(idx: number): void {
  const entity = entities.find(e => e.idx === idx);
  if (entity) {
    const normText = entity.text.trim().toLowerCase();
    const type = entity.type;
    let count = 0;
    for (const e of entities) {
      if (e.text.trim().toLowerCase() === normText && e.type === type) {
        removedIndices.delete(e.idx);
        count++;
      }
    }
    showToast(`Restored${count > 1 ? ` ${count} occurrences of` : ""} "${entity.text}"`, "restore");
    // Restore is per-tab; the symmetric counterpart of removal staying per-tab.
    renderDocTabs();
  } else {
    removedIndices.delete(idx);
  }
  render();
}

function removeAdded(idx: number): void {
  addedEntities.splice(idx, 1);
  render();
}

function removeAddedGroup(groupKey: string): void {
  addedEntities = addedEntities.filter(e => makeGroupKey(e.type, e.text) !== groupKey);
  render();
}

function removeFamilyAll(indices: number[]): void {
  for (const idx of indices) removedIndices.add(idx);
  showToast(`Removed ${indices.length} entities (all variants)`, "remove");
  render();
}

function restoreFamilyAll(indices: number[]): void {
  for (const idx of indices) removedIndices.delete(idx);
  showToast(`Restored ${indices.length} entities (all variants)`, "restore");
  render();
}

function resetAll(): void {
  if (removedIndices.size === 0 && addedEntities.length === 0) return;
  if (!confirm("Reset all changes? This will restore all removed entities and discard added ones.")) return;
  removedIndices.clear();
  addedEntities = [];
  showToast("All changes reset", "restore");
  render();
}

// ── Group highlighting ──────────────────────────────────────────────────────

function highlightGroup(groupKey: string): void {
  if (!groupKey) return;
  document.querySelectorAll(`[data-group-key="${CSS.escape(groupKey)}"]`).forEach(el => el.classList.add("group-hover"));
}
function unhighlightGroup(groupKey: string): void {
  if (!groupKey) return;
  document.querySelectorAll(`[data-group-key="${CSS.escape(groupKey)}"]`).forEach(el => el.classList.remove("group-hover"));
}

// ── Toast ───────────────────────────────────────────────────────────────────

let toastTimer: number | null = null;
function showToast(message: string, type: "remove" | "restore"): void {
  const toast = $("toast");
  const icon = toast.querySelector(".toast-icon") as HTMLElement;
  const textEl = toast.querySelector(".toast-text") as HTMLElement;
  icon.textContent = type === "remove" ? "\u2796" : "\u2795";
  textEl.textContent = message;
  toast.classList.add("visible");
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 2500);
}

// ── Selection → add entity ──────────────────────────────────────────────────

let pendingSelection: { text: string; start: number; end: number } | null = null;
let toolbarShownAt = 0;

function showToolbarForSelection(e: MouseEvent): void {
  const toolbar = $("selection-toolbar");
  const sel = window.getSelection();
  const text = (sel ? sel.toString() : "").trim();

  const target = e.target as HTMLElement | null;
  if (!sel || !text || text.length < 2 || target?.closest(".selection-toolbar") || target?.closest(".sidebar")) {
    if (!target?.closest(".selection-toolbar")) toolbar.classList.remove("visible");
    return;
  }

  const range = sel.getRangeAt(0);
  const container = $("doc-content");
  if (!container.contains(range.commonAncestorContainer)) {
    toolbar.classList.remove("visible");
    return;
  }

  const start = findTextPositionFromRange(range, container, text);
  if (start === -1) { toolbar.classList.remove("visible"); return; }
  pendingSelection = { text, start, end: start + text.length };

  const rect = range.getBoundingClientRect();
  const toolbarW = 260;
  let left = rect.left + rect.width / 2 - toolbarW / 2;
  let top = rect.top - 44;
  left = Math.max(8, Math.min(left, window.innerWidth - toolbarW - 8));
  if (top < 8) top = rect.bottom + 8;
  toolbar.style.left = `${left}px`;
  toolbar.style.top = `${top}px`;
  toolbar.classList.add("visible");
  toolbarShownAt = Date.now();
}

function findTextPositionFromRange(range: Range, container: HTMLElement, selectedText: string): number {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (parent && parent.closest(".entity-tooltip")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let charOffset = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node === range.startContainer) {
      const approxPos = charOffset + range.startOffset;
      if (originalText.substr(approxPos, selectedText.length) === selectedText) return approxPos;
      const searchStart = Math.max(0, approxPos - 100);
      const region = originalText.substring(searchStart, Math.min(originalText.length, approxPos + 100));
      const localIdx = region.indexOf(selectedText);
      if (localIdx !== -1) return searchStart + localIdx;
      return originalText.indexOf(selectedText);
    }
    charOffset += (node.textContent || "").length;
  }
  return originalText.indexOf(selectedText);
}

function addEntity(type: string): void {
  ($("type-dropdown")).classList.remove("visible");
  if (!pendingSelection) return;
  const searchText = pendingSelection.text;
  const newLen = searchText.length;
  let pos = 0;
  let count = 0;
  while ((pos = originalText.indexOf(searchText, pos)) !== -1) {
    const newStart = pos, newEnd = pos + newLen;
    const overlappingOriginals = entities.filter(e =>
      e.verified && !removedIndices.has(e.idx) && e.start < newEnd && e.end > newStart);
    const overlappingAdded = addedEntities.filter(e => e.start < newEnd && e.end > newStart);

    const blockedByExisting =
      overlappingOriginals.some(e => (e.end - e.start) >= newLen) ||
      overlappingAdded.some(e => (e.end - e.start) >= newLen);
    if (blockedByExisting) { pos += newLen; continue; }

    for (const e of overlappingOriginals) removedIndices.add(e.idx);
    addedEntities = addedEntities.filter(e => !(e.start < newEnd && e.end > newStart));
    addedEntities.push({ text: searchText, type, start: newStart, end: newEnd });
    count++;
    pos += newLen;
  }
  if (count > 1) showToast(`Added ${count} occurrences of "${searchText}"`, "restore");

  // Bulk: propagate the add decision to sibling (non-approved) sessions.
  propagateAddToSiblings(searchText, type);
  renderDocTabs();

  pendingSelection = null;
  ($("selection-toolbar")).classList.remove("visible");
  window.getSelection()?.removeAllRanges();
  render();
}

// ── Approve ────────────────────────────────────────────────────────────────

async function approve(): Promise<void> {
  setApproveBtnState(true, "Saving\u2026");

  // Snapshot current doc's in-flight state into bulk cache before sending.
  saveCurrentBulkState();

  // Bulk mode: send ALL sessions' overrides on every Approve click. Server
  // stores per-session; the overlay only shows when every doc is approved.
  if (isBulkMode()) {
    try {
      // Mark current doc as approved locally, then flush all pending sessions.
      bulkSessions[currentBulkIdx].approved = true;
      for (const s of bulkSessions) {
        const overrides = {
          remove: Array.from(s.state.removedIndices),
          add: s.state.addedEntities.map((e) => ({
            text: e.text,
            type: e.type,
            start: e.start,
            end: e.end,
          })),
        };
        // v2.1.3: include doc_id so the server can route overrides to the
        // correct PerDocReview inside a multi-file session. For legacy
        // single-doc sessions the server falls back to documents[0].
        const args: Record<string, unknown> = {
          session_id: s.session_id,
          overrides,
        };
        if (s.doc_id) args.doc_id = s.doc_id;
        await app.callServerTool({
          name: "apply_review_overrides",
          arguments: args,
        });
      }
      renderDocTabs();
      const allApproved = bulkSessions.every((s) => s.approved);
      if (allApproved) {
        $("approved-overlay").classList.add("visible");
      } else {
        setApproveBtnState(false, "Approve");
        showToast(
          `Approved "${bulkSessions[currentBulkIdx].source_filename}" \u2014 continuing to next document`,
          "restore",
        );
        setTimeout(() => bulkAdvanceToNext(), 400);
      }
    } catch (err) {
      setApproveBtnState(false, "Approve");
      bulkSessions[currentBulkIdx].approved = false;
      renderDocTabs();
      showToast("Failed to save: " + (err instanceof Error ? err.message : String(err)), "remove");
    }
    return;
  }

  // Single-session mode (original behavior)
  const overrides = {
    remove: Array.from(removedIndices),
    add: addedEntities.map(e => ({ text: e.text, type: e.type, start: e.start, end: e.end })),
  };

  try {
    const args: Record<string, unknown> = {
      session_id: SESSION_ID,
      overrides,
    };
    // v2.1.3: include doc_id when server emitted one (multi-doc or
    // single-doc session with explicit doc id).
    if (DOC_ID) args.doc_id = DOC_ID;
    await app.callServerTool({
      name: "apply_review_overrides",
      arguments: args,
    });
    $("approved-overlay").classList.add("visible");
  } catch (err) {
    setApproveBtnState(false, "Approve");
    showToast("Failed to save: " + (err instanceof Error ? err.message : String(err)), "remove");
  }
}

// ── Scroll / split view ─────────────────────────────────────────────────────

function scrollToEntity(idx: number): void {
  const el = document.querySelector<HTMLElement>(
    `.entity[data-idx="${CSS.escape(String(idx))}"][data-source="original"]`,
  );
  if (!el) return;
  // scrollIntoView works through MCP Apps iframes because the iframe is
  // loaded as same-origin (srcdoc / about:blank), so it can drive the host
  // chat's scroll — effectively jumping the user to the entity location.
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  // Flash a briefly-visible outline so the user can spot the entity in a
  // dense document after the jump. Re-trigger by toggling the class.
  el.classList.remove("flash-highlight");
  // Force reflow so that removing + re-adding the class restarts the
  // animation if the user clicks the same entity twice in a row.
  void el.offsetWidth;
  el.classList.add("flash-highlight");
  window.setTimeout(() => el.classList.remove("flash-highlight"), 1300);
}

function toggleSplitView(): void {
  splitView = !splitView;
  const main = $("main-container");
  const btn = $("split-btn");
  main.classList.toggle("split-view", splitView);
  btn.classList.toggle("active", splitView);
  if (splitView) { renderAnonymizedPanel(); setupScrollSync(); }
}

const PH_GROUP = ENTITY_GROUP;

function renderAnonymizedPanel(): void {
  const container = $("doc-content-anon");
  if (!anonymizedText) { container.textContent = "Anonymized text not available."; return; }
  const hasHtml = formatRuns.length > 0 || blockMap.length > 0;
  container.classList.toggle("html-mode", hasHtml);

  const paragraphs = anonymizedText.split("\n");
  let html = "";
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi];
    const tag = (hasHtml && blockMap[pi] && blockMap[pi].tag) || "p";
    html += `<${tag}>` + escapeHtml(para).replace(/&lt;(\w+?)&gt;/g, (_m, phTag: string) => {
      const stripped = phTag.replace(/^D\d+_/, "");
      const baseType = stripped.replace(/_\d+\w*$/, "");
      const group = PH_GROUP[baseType] || "OTHER";
      return `<span class="anon-placeholder ph-${group}">&lt;${phTag}&gt;</span>`;
    }) + `</${tag}>`;
  }

  for (const e of entities) {
    if (!removedIndices.has(e.idx)) continue;
    if (!e.placeholder) continue;
    const escapedPh = `&lt;${escapeHtml(e.placeholder)}&gt;`;
    const phRegex = new RegExp(
      `<span class="anon-placeholder[^"]*">${escapedPh.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</span>`,
      "g",
    );
    html = html.replace(phRegex, `<span class="anon-restored">${escapeHtml(e.text)}</span>`);
  }

  if (addedEntities.length > 0) {
    for (const ae of addedEntities) {
      const escaped = escapeHtml(ae.text);
      if (!escaped) continue;
      const group = PH_GROUP[ae.type] || "OTHER";
      const placeholder =
        `<span class="anon-placeholder ph-${group} ph-added">&lt;${ae.type}&gt;</span>`;
      const safeText = escaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      html = html.replace(
        new RegExp("(?<=>)([^<]*?)(" + safeText + ")", "g"),
        (_m, before) => before + placeholder,
      );
    }
  }

  container.innerHTML = html;
}

function setupScrollSync(): void {
  const origPane = document.querySelector(".doc-pane-orig") as HTMLElement | null;
  const anonPane = document.querySelector(".doc-pane-anon") as HTMLElement | null;
  if (!origPane || !anonPane) return;
  let syncing = false;
  function syncScroll(source: HTMLElement, target: HTMLElement): void {
    if (syncing) return;
    syncing = true;
    const pct = source.scrollTop / (source.scrollHeight - source.clientHeight || 1);
    target.scrollTop = pct * (target.scrollHeight - target.clientHeight || 1);
    syncing = false;
  }
  origPane.addEventListener("scroll", () => syncScroll(origPane, anonPane));
  anonPane.addEventListener("scroll", () => syncScroll(anonPane, origPane));
}

// ── Keyboard navigation ─────────────────────────────────────────────────────

function focusFamily(idx: number): void {
  focusedFamilyIdx = idx;
  document.querySelectorAll(".entity.focused").forEach(el => el.classList.remove("focused"));
  document.querySelectorAll(".entity-item.focused").forEach(el => el.classList.remove("focused"));

  if (idx < 0 || idx >= currentFamilies.length) { focusedFamilyIdx = -1; return; }

  const fam = currentFamilies[idx];
  const groupKey = makeGroupKey(fam.type, fam.rootText);
  const sidebarItem = document.querySelector(`.entity-item[data-group-key="${CSS.escape(groupKey)}"]`);
  if (sidebarItem) {
    sidebarItem.classList.add("focused");
    sidebarItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  document.querySelectorAll(`.entity[data-group-key="${CSS.escape(groupKey)}"]`).forEach(el => el.classList.add("focused"));
  const firstIdx = fam.members[0].indices[0];
  scrollToEntity(firstIdx);
}

function getFocusedFamily(): Family | null {
  if (focusedFamilyIdx < 0 || focusedFamilyIdx >= currentFamilies.length) return null;
  return currentFamilies[focusedFamilyIdx];
}

document.addEventListener("keydown", (e) => {
  const tgt = e.target as HTMLElement | null;
  const key = e.key;

  // `/` → focus the sidebar filter input. Works from anywhere in the iframe
  // EXCEPT when the filter input itself is already focused (so user can type
  // `/` into the search box). Must come BEFORE the INPUT/TEXTAREA early-return
  // below, otherwise it never fires when a sibling input has focus.
  if (key === "/" && tgt?.id !== "filter-input") {
    e.preventDefault();
    const input = document.getElementById("filter-input") as HTMLInputElement | null;
    input?.focus();
    input?.select();
    return;
  }

  if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
  const sel = window.getSelection();
  if (sel && sel.toString().trim().length > 0 && e.key !== "Escape" && e.key !== "Tab") return;

  if (key === "Tab") {
    e.preventDefault();
    if (currentFamilies.length === 0) return;
    if (e.shiftKey) {
      focusFamily(focusedFamilyIdx <= 0 ? currentFamilies.length - 1 : focusedFamilyIdx - 1);
    } else {
      focusFamily(focusedFamilyIdx >= currentFamilies.length - 1 ? 0 : focusedFamilyIdx + 1);
    }
    return;
  }
  if (key === "d" || key === "D") {
    const fam = getFocusedFamily();
    if (!fam) return;
    const allIndices = fam.members.flatMap(m => m.indices);
    if (!allIndices.every(i => removedIndices.has(i))) {
      removeFamilyAll(allIndices);
      setTimeout(() => focusFamily(focusedFamilyIdx), 50);
    }
    return;
  }
  if (key === "r" || key === "R") {
    const fam = getFocusedFamily();
    if (!fam) return;
    const allIndices = fam.members.flatMap(m => m.indices);
    if (allIndices.some(i => removedIndices.has(i))) {
      restoreFamilyAll(allIndices);
      setTimeout(() => focusFamily(focusedFamilyIdx), 50);
    }
    return;
  }
  if (key === "a" || key === "A") { approve(); return; }
  if (key === "Escape") {
    focusFamily(-1);
    $("selection-toolbar").classList.remove("visible");
    $("type-dropdown").classList.remove("visible");
    return;
  }
});

document.addEventListener("mousedown", (e) => {
  const target = e.target as HTMLElement | null;
  if (!target?.closest(".type-dropdown") && !target?.closest(".type-btn-more")) {
    $("type-dropdown").classList.remove("visible");
  }
  if (!target?.closest(".selection-toolbar")) {
    setTimeout(() => {
      if (Date.now() - toolbarShownAt < 400) return;
      if (!target?.closest(".selection-toolbar")) {
        $("selection-toolbar").classList.remove("visible");
      }
    }, 300);
  }
});

document.addEventListener("mouseup", showToolbarForSelection);
document.addEventListener("dblclick", (e) => setTimeout(() => showToolbarForSelection(e), 10));

// ── Bulk helpers ────────────────────────────────────────────────────────────

/** Initialize bulk review from N sessions. Renders tabs, loads doc 0. */
function initBulk(sessions: SessionPayload[]): void {
  bulkSessions = sessions.map<BulkSession>((s) => ({
    session_id: s.session_id,
    doc_id: s.doc_id || "",
    source_filename: s.source_filename || s.session_id,
    approved: !!s.approved,
    payload: s,
    state: {
      removedIndices: new Set<number>((s.overrides?.remove as number[]) || []),
      addedEntities: ((s.overrides?.add || []) as AddedEntity[]).filter(
        (a) => a.start >= 0 && a.text,
      ),
    },
  }));
  currentBulkIdx = 0;
  ($("doc-tabs")).style.display = "flex";
  renderDocTabs();
  loadBulkDocument(0);
}

/** Render the tab strip with status icons + approved counter. */
function renderDocTabs(): void {
  const container = $("doc-tabs");
  if (bulkSessions.length === 0) {
    container.style.display = "none";
    return;
  }
  const approvedCount = bulkSessions.filter((s) => s.approved).length;
  let html = "";
  for (let i = 0; i < bulkSessions.length; i++) {
    const s = bulkSessions[i];
    const isActive = i === currentBulkIdx;
    const cls = `doc-tab ${isActive ? "active" : ""} ${s.approved ? "approved" : ""}`;
    const icon = s.approved ? "\u2705" : isActive ? "\u25CF" : "\u25CB";
    const name = s.source_filename;
    const short = name.length > 28 ? name.slice(0, 25) + "\u2026" : name;
    html +=
      `<div class="${cls}" data-idx="${i}" title="${escapeHtml(name)}">` +
      `<span class="status-icon">${icon}</span>` +
      `<span>${escapeHtml(short)}</span>` +
      `</div>`;
  }
  html +=
    `<div class="bulk-progress"><span class="count">${approvedCount}</span>/${bulkSessions.length} approved</div>`;
  container.innerHTML = html;
  for (const tab of Array.from(container.querySelectorAll<HTMLElement>(".doc-tab"))) {
    tab.addEventListener("click", () => {
      const idx = parseInt(tab.dataset.idx || "0", 10);
      switchDocument(idx);
    });
  }
}

/** Save the currently-loaded doc's in-flight user decisions back into bulkSessions. */
function saveCurrentBulkState(): void {
  if (!isBulkMode()) return;
  const s = bulkSessions[currentBulkIdx];
  if (!s) return;
  s.state = {
    removedIndices: new Set(removedIndices),
    addedEntities: addedEntities.slice(),
  };
}

/** Switch to doc at `idx` — saves current, loads target's cached payload + state. */
function switchDocument(idx: number): void {
  if (idx === currentBulkIdx || idx < 0 || idx >= bulkSessions.length) return;
  saveCurrentBulkState();
  currentBulkIdx = idx;
  loadBulkDocument(idx);
}

/** Load the bulk session at `idx` into the main panel. */
function loadBulkDocument(idx: number): void {
  const s = bulkSessions[idx];
  if (!s) return;
  // loadSession parses HTML + sets module state; then we overlay cached user decisions.
  loadSession(s.payload);
  removedIndices = new Set(s.state.removedIndices);
  addedEntities = s.state.addedEntities.slice();
  render();
  renderDocTabs();
}

/** Advance to the next unapproved doc (wraps around). No-op if all approved. */
function bulkAdvanceToNext(): void {
  for (let i = 1; i <= bulkSessions.length; i++) {
    const nextIdx = (currentBulkIdx + i) % bulkSessions.length;
    if (!bulkSessions[nextIdx].approved) {
      switchDocument(nextIdx);
      return;
    }
  }
}

// ── Cross-document entity propagation ───────────────────────────────────────
// When the user adds an entity in doc A, scan the text of all OTHER unapproved
// docs in bulkSessions and automatically add the same text→type decision
// everywhere it appears (word-boundary). Symmetric for remove: if the user
// removes entity "Acme LLC" from doc A, mark matching text in other docs as
// removed too. This gives the user the "unified decisions across a batch"
// behavior they expect.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract plain text from a session payload (for regex scanning). */
function sessionText(s: BulkSession): string {
  return s.payload.original_text || "";
}

/** Add entity text+type to all sibling (non-approved, non-current) sessions. */
function propagateAddToSiblings(searchText: string, type: string): void {
  if (!isBulkMode() || searchText.trim().length < 3) return;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegex(searchText)}(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  for (let i = 0; i < bulkSessions.length; i++) {
    if (i === currentBulkIdx) continue;
    const s = bulkSessions[i];
    if (s.approved) continue;
    const text = sessionText(s);
    if (!text) continue;
    let m: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(text)) !== null) {
      const newStart = m.index;
      const newEnd = newStart + m[0].length;
      const exists = s.state.addedEntities.some(
        (a) => a.start === newStart && a.end === newEnd,
      );
      if (!exists) {
        s.state.addedEntities.push({
          text: m[0],
          type,
          start: newStart,
          end: newEnd,
        });
      }
    }
  }
}

/** Mark all entities in sibling sessions with matching text+type as removed. */
function propagateRemoveToSiblings(searchText: string, type: string): void {
  if (!isBulkMode() || searchText.trim().length < 3) return;
  const norm = searchText.trim().toLowerCase();
  for (let i = 0; i < bulkSessions.length; i++) {
    if (i === currentBulkIdx) continue;
    const s = bulkSessions[i];
    if (s.approved) continue;
    const siblingEntities = s.payload.entities || [];
    for (let j = 0; j < siblingEntities.length; j++) {
      const e = siblingEntities[j];
      if (e.type === type && (e.text || "").trim().toLowerCase() === norm) {
        s.state.removedIndices.add(j);
      }
    }
  }
}

/** Undo propagateRemove: un-mark entities with matching text+type in siblings. */
function propagateRestoreToSiblings(searchText: string, type: string): void {
  if (!isBulkMode() || searchText.trim().length < 3) return;
  const norm = searchText.trim().toLowerCase();
  for (let i = 0; i < bulkSessions.length; i++) {
    if (i === currentBulkIdx) continue;
    const s = bulkSessions[i];
    if (s.approved) continue;
    const siblingEntities = s.payload.entities || [];
    for (let j = 0; j < siblingEntities.length; j++) {
      const e = siblingEntities[j];
      if (e.type === type && (e.text || "").trim().toLowerCase() === norm) {
        s.state.removedIndices.delete(j);
      }
    }
  }
}

// ── Payload intake ──────────────────────────────────────────────────────────

function loadSession(payload: SessionPayload): void {
  SESSION_ID = payload.session_id || "";
  DOC_ID = payload.doc_id || "";
  originalText = payload.original_text || "";
  originalHtml = payload.html_text || payload.original_html || "";
  anonymizedText = payload.anonymized_text || "";
  entities = (payload.entities || []).map((e, i) => ({
    ...e, idx: i, verified: true,
  }));
  removedIndices = new Set((payload.overrides?.remove as number[]) || []);
  addedEntities = (payload.overrides?.add || []).filter(a => a.start >= 0 && a.text) as AddedEntity[];
  formatRuns = [];
  blockMap = [];
  if (originalHtml) parseHtmlFormatting(originalHtml);

  const splitBtn = $("split-btn");
  splitBtn.style.display = anonymizedText ? "" : "none";

  if (payload.approved) {
    $("approved-overlay").classList.add("visible");
  }

  render();
}

// ── Sidebar resize (drag-handle between .doc-panel and .sidebar) ─────────────
// The MCP Apps iframe auto-sizes HEIGHT only; width is fixed by the host chat
// column. Inside the iframe we're free to change .sidebar width via the
// `--sidebar-w` CSS variable on .main without triggering any ext-apps resize
// protocol side effects. Persist the preferred width in localStorage so it
// sticks across sessions (same idiom as `pii-theme`).
function initSidebarResize(): void {
  const handle = document.getElementById("resize-handle");
  const main = document.getElementById("main-container");
  if (!handle || !main) return;

  const SIDEBAR_W_MIN = 180;
  const SIDEBAR_W_MAX_ABS = 500;
  const STORAGE_KEY = "pii-sidebar-w";

  // Restore saved width from prior session, if any.
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    const n = parseInt(saved, 10);
    if (Number.isFinite(n) && n >= SIDEBAR_W_MIN) {
      main.style.setProperty("--sidebar-w", `${n}px`);
    }
  }

  handle.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");

    const startX = e.clientX;
    const currentW = getComputedStyle(main).getPropertyValue("--sidebar-w").trim();
    const startW = parseInt(currentW, 10) || 240;
    const mainW = main.clientWidth;
    // Max = min(500px, half the main-container width). Keeps the doc-panel
    // from collapsing below 50% on narrow chat columns.
    const sidebarMax = Math.max(SIDEBAR_W_MIN, Math.min(SIDEBAR_W_MAX_ABS, Math.floor(mainW * 0.5)));

    const onMove = (ev: PointerEvent) => {
      // Handle is LEFT of sidebar; dragging LEFT (clientX ↓) widens sidebar.
      const delta = ev.clientX - startX;
      const newW = Math.max(SIDEBAR_W_MIN, Math.min(sidebarMax, startW - delta));
      main.style.setProperty("--sidebar-w", `${newW}px`);
    };
    const onUp = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      const finalW = getComputedStyle(main).getPropertyValue("--sidebar-w").trim();
      if (finalW) localStorage.setItem(STORAGE_KEY, finalW);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });
}

// ── Sidebar filter input (search across entity text) ─────────────────────────
// Live-updating substring filter over families + added entities. Triggered by
// user typing into `#filter-input` (see review.html .sidebar-filter block) or
// by the `/` keyboard shortcut (see keydown listener). renderSidebar() reads
// the module-scoped `sidebarFilter` and shows a "N of M" counter.
function initSidebarFilter(): void {
  const input = document.getElementById("filter-input") as HTMLInputElement | null;
  if (!input) return;
  input.addEventListener("input", () => {
    sidebarFilter = input.value.trim().toLowerCase();
    renderSidebar();
  });
  // Pressing Escape inside the filter clears it + blurs — a quick way out
  // without reaching for the mouse. Other Escape usage (focus clear, close
  // dropdowns) is handled by the outer keydown listener after blur.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (input.value !== "") {
        input.value = "";
        sidebarFilter = "";
        renderSidebar();
      } else {
        input.blur();
      }
      e.stopPropagation();
    }
  });
}

// ── Wire top-bar buttons and selection toolbar ──────────────────────────────

function wireStaticHandlers(): void {
  $("theme-btn").addEventListener("click", toggleTheme);
  $("split-btn").addEventListener("click", toggleSplitView);
  $("reset-btn").addEventListener("click", resetAll);
  $("approve-btn").addEventListener("click", () => { approve(); });
  // Bottom action bar — duplicates top Approve + offers "↑ To top" which
  // scrolls the host chat back to the panel header via scrollIntoView.
  const approveBottom = document.getElementById("approve-btn-bottom");
  if (approveBottom) approveBottom.addEventListener("click", () => { approve(); });
  const scrollTopBtn = document.getElementById("scroll-top-btn");
  if (scrollTopBtn) {
    scrollTopBtn.addEventListener("click", () => {
      const chromeEl = document.querySelector<HTMLElement>(".chrome");
      chromeEl?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  $("type-more-btn").addEventListener("click", (ev) => {
    ev.stopPropagation();
    $("type-dropdown").classList.toggle("visible");
  });
  for (const btn of Array.from(document.querySelectorAll<HTMLElement>(".selection-toolbar .type-btn[data-type]"))) {
    btn.addEventListener("click", () => addEntity(btn.dataset.type || "PERSON"));
  }
  for (const item of Array.from(document.querySelectorAll<HTMLElement>(".type-dropdown-item[data-type]"))) {
    item.addEventListener("click", () => addEntity(item.dataset.type || "PERSON"));
  }
}

// ── App class wiring ───────────────────────────────────────────────────────

const app = new App({ name: "pii-shield-review-ui", version: "2.0.0" });

app.ontoolresult = (result: CallToolResult) => {
  // v2.0.3 (issue #2): start_review returns metadata-only `sessions[]`. The
  // iframe pulls the unredacted payload for each session via the
  // model-invisible `get_review_payload` tool. This keeps raw PII out of the
  // host's tool-result channel and therefore out of Claude's context.
  //
  // Shape on the wire from start_review:
  //   structuredContent = { status: "review_ready", sessions: [
  //     { session_id, doc_id, source_filename, entity_count, approved, has_overrides },
  //     ...
  //   ], count, is_bulk }
  //
  // After pull, `payloads` holds the full SessionPayload objects the
  // initBulk / loadSession helpers already understand — no downstream
  // changes needed.
  const sc = (result as unknown as { structuredContent?: unknown }).structuredContent;
  if (!sc || typeof sc !== "object") return;
  const asContainer = sc as StartReviewStructuredContent;
  const metaList: SessionMetadata[] = Array.isArray(asContainer.sessions)
    ? asContainer.sessions
    : [];
  if (metaList.length === 0) {
    // Tolerate older servers that still inline the full payload on
    // structuredContent itself (single-session shape). After deploy this
    // branch is dead — kept until v2.0.3 ships to the field.
    const legacy = sc as SessionPayload;
    if (legacy && legacy.session_id) {
      bulkSessions = [];
      currentBulkIdx = 0;
      ($("doc-tabs")).style.display = "none";
      loadSession(legacy);
    }
    return;
  }

  // Fire-and-forget pull. ontoolresult itself stays sync (SDK signature) but
  // we kick off the async work below; the SDK does not require completion.
  void (async () => {
    const payloads: SessionPayload[] = [];
    for (const meta of metaList) {
      if (!meta || !meta.session_id) continue;
      try {
        const pull = await app.callServerTool({
          name: "get_review_payload",
          arguments: {
            session_id: meta.session_id,
            doc_id: meta.doc_id || "",
          },
        });
        const sc2 = (pull as unknown as { structuredContent?: unknown })
          .structuredContent;
        if (!sc2 || typeof sc2 !== "object") continue;
        const candidate = sc2 as SessionPayload & { error?: string };
        if (candidate.error || !candidate.session_id) continue;
        payloads.push(candidate);
      } catch (err) {
        console.error(
          "[review-app] get_review_payload failed for",
          meta.session_id,
          err,
        );
      }
    }
    if (payloads.length === 0) return;

    if (payloads.length >= 2) {
      initBulk(payloads);
      return;
    }
    const payload = payloads[0];
    bulkSessions = [];
    currentBulkIdx = 0;
    ($("doc-tabs")).style.display = "none";
    loadSession(payload);
  })();
};

app.onhostcontextchanged = (_ctx: McpUiHostContext) => {
  // Host-provided theme hints could be applied here via
  // applyHostStyleVariables — left as a future enhancement.
};

app.onerror = (err) => {
  console.error("[review-app] App error:", err);
};

// ── Boot ───────────────────────────────────────────────────────────────────

initTheme();
wireStaticHandlers();
initSidebarResize();
initSidebarFilter();

app.connect().catch((err: unknown) => {
  console.error("[review-app] app.connect() rejected:", err);
  $("doc-content").textContent =
    "Failed to connect to MCP host: " + (err instanceof Error ? err.message : String(err));
});
