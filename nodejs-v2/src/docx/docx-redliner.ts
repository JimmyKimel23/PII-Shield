/**
 * PII Shield v2 — DOCX Tracked Changes (REDLINE mode)
 *
 * Uses @adeu/core — a TypeScript engine purpose-built for LLM-driven contract
 * redlining. Emits native w:ins/w:del revisions with proper w:id/w:author/
 * w:date/w16du:dateUtc, runs atomic batch validation, and covers main body +
 * headers/footers/footnotes automatically via DocumentMapper.
 *
 * Accept/reject of existing revisions stays in pure @xmldom/xmldom — adeu only
 * exposes per-id accept and accept_all_revisions, not bulk reject.
 */
import path from "node:path";
import fs from "node:fs";
import type JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { Document, Element } from "@xmldom/xmldom";
import { DocumentObject, RedlineEngine, BatchValidationError } from "@adeu/core";
import { loadDocx, saveDocx } from "./docx-reader.js";

const WNS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

interface TrackedChange {
  /** Text to find in the document */
  oldText: string;
  /** Replacement text (empty string = pure deletion) */
  newText: string;
}

interface RedlineOptions {
  author?: string;
  date?: string;
}

/**
 * Apply tracked changes to a DOCX file.
 * Each change wraps old text in w:del and adds new text in w:ins.
 * The result is a .docx that shows revision marks in Microsoft Word.
 *
 * Changes are applied one at a time so a single failed or ambiguous target
 * does not abort the whole batch — adeu's process_batch is atomic and throws
 * BatchValidationError when any edit cannot be uniquely matched.
 *
 * @param docxPath Path to the input .docx file
 * @param changes Array of {oldText, newText} changes to apply
 * @param options Author and date for revision marks
 * @returns Path to the output .docx file with tracked changes
 */
export async function applyTrackedChanges(
  docxPath: string,
  changes: TrackedChange[],
  options: RedlineOptions = {},
): Promise<string> {
  const author = options.author || "PII Shield";

  // Sort changes by length descending so longer matches win over prefixes —
  // if "Acme Corporation" and "Acme" are both targets, apply the longer one
  // while it still exists in the document.
  const sortedChanges = [...changes].sort((a, b) => b.oldText.length - a.oldText.length);

  const buf = fs.readFileSync(docxPath);
  const doc = await DocumentObject.load(buf);
  const engine = new RedlineEngine(doc, author);
  // Engine stamps w:date / w16du:dateUtc from engine.timestamp (public field,
  // ISO-8601). Override if the caller pinned a date for reproducible output.
  if (options.date) {
    (engine as { timestamp: string }).timestamp = options.date;
  }

  let applied = 0;
  for (const change of sortedChanges) {
    if (!change.oldText) continue;
    try {
      const result = engine.process_batch([
        { type: "modify", target_text: change.oldText, new_text: change.newText },
      ]) as { edits_applied?: number; skipped_details?: string[] };
      const editsApplied = typeof result?.edits_applied === "number" ? result.edits_applied : 1;
      applied += editsApplied;
    } catch (e: unknown) {
      const reason = e instanceof BatchValidationError ? "rejected" : "failed";
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[REDLINE] change ${reason} for "${change.oldText.slice(0, 40)}": ${msg}`);
    }
  }
  console.error(`[REDLINE] applied ${applied} tracked change(s) across ${docxPath}`);

  const outBuf = await doc.save();
  const dir = path.dirname(docxPath);
  const stem = path.basename(docxPath, path.extname(docxPath));
  const outPath = path.join(dir, `${stem}_tracked_changes.docx`);
  fs.writeFileSync(outPath, outBuf);
  return outPath;
}

/**
 * Apply a per-Document transform to each header/footer part, serialising the
 * result back into the zip. headerXmls / footerXmls come as raw XML strings
 * (loadDocx does not parse them), so we parse-transform-serialise here.
 */
function applyToHeaderFooterParts(
  model: { zip: JSZip; headerXmls: Map<string, string>; footerXmls: Map<string, string> },
  transform: (doc: Document) => void,
): void {
  const serializer = new XMLSerializer();
  for (const [partPath, xml] of [...model.headerXmls.entries(), ...model.footerXmls.entries()]) {
    if (!xml) continue;
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    transform(doc);
    model.zip.file(partPath, serializer.serializeToString(doc));
  }
}

/**
 * Accept all tracked changes in a DOCX:
 * - Remove w:del elements entirely (deleted text disappears)
 * - Unwrap w:ins elements (inserted text becomes permanent)
 *
 * Covers main document + all headers/footers (parity with the Python sidecar
 * that v2.0.0 replaced).
 */
export async function acceptAllTrackedChanges(docxPath: string): Promise<string> {
  const model = await loadDocx(docxPath);
  acceptInDoc(model.mainDoc);
  applyToHeaderFooterParts(model, acceptInDoc);

  const dir = path.dirname(docxPath);
  const stem = path.basename(docxPath, path.extname(docxPath));
  const outPath = path.join(dir, `${stem}_accepted.docx`);
  await saveDocx(model, outPath);
  return outPath;
}

/**
 * Reject all tracked changes in a DOCX:
 * - Remove w:ins elements entirely (inserted text disappears)
 * - Unwrap w:del elements (deleted text is restored)
 * - Convert w:delText back to w:t
 *
 * Covers main document + all headers/footers (parity with the Python sidecar
 * that v2.0.0 replaced).
 */
export async function rejectAllTrackedChanges(docxPath: string): Promise<string> {
  const model = await loadDocx(docxPath);
  rejectInDoc(model.mainDoc);
  applyToHeaderFooterParts(model, rejectInDoc);

  const dir = path.dirname(docxPath);
  const stem = path.basename(docxPath, path.extname(docxPath));
  const outPath = path.join(dir, `${stem}_rejected.docx`);
  await saveDocx(model, outPath);
  return outPath;
}

function acceptInDoc(doc: Document): void {
  // Unwrap insertions (keep content)
  const insElements = doc.getElementsByTagNameNS(WNS, "ins");
  const insArr: Element[] = [];
  for (let i = 0; i < insElements.length; i++) insArr.push(insElements[i]);
  for (const ins of insArr) {
    const parent = ins.parentNode;
    if (!parent) continue;
    while (ins.firstChild) {
      parent.insertBefore(ins.firstChild, ins);
    }
    parent.removeChild(ins);
  }

  // Remove deletions entirely
  const delElements = doc.getElementsByTagNameNS(WNS, "del");
  const delArr: Element[] = [];
  for (let i = 0; i < delElements.length; i++) delArr.push(delElements[i]);
  for (const del of delArr) {
    const parent = del.parentNode;
    if (parent) parent.removeChild(del);
  }
}

function rejectInDoc(doc: Document): void {
  // Remove insertions
  const insElements = doc.getElementsByTagNameNS(WNS, "ins");
  const insArr: Element[] = [];
  for (let i = 0; i < insElements.length; i++) insArr.push(insElements[i]);
  for (const ins of insArr) {
    const parent = ins.parentNode;
    if (parent) parent.removeChild(ins);
  }

  // Unwrap deletions — convert w:delText back to w:t and keep content
  const delElements = doc.getElementsByTagNameNS(WNS, "del");
  const delArr: Element[] = [];
  for (let i = 0; i < delElements.length; i++) delArr.push(delElements[i]);
  for (const del of delArr) {
    const parent = del.parentNode;
    if (!parent) continue;

    const delTexts = del.getElementsByTagNameNS(WNS, "delText");
    const dtArr: Element[] = [];
    for (let i = 0; i < delTexts.length; i++) dtArr.push(delTexts[i]);
    for (const dt of dtArr) {
      const t = doc.createElementNS(WNS, "w:t");
      t.setAttribute("xml:space", "preserve");
      t.textContent = dt.textContent || "";
      dt.parentNode?.replaceChild(t, dt);
    }

    while (del.firstChild) {
      parent.insertBefore(del.firstChild, del);
    }
    parent.removeChild(del);
  }
}
