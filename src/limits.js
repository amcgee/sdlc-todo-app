// ISSUE-35 — single source of truth for the list/item limit constants and their
// measurement rules (spec PART II §1). Like src/todos.js, this is native ESM with
// zero third-party dependencies and zero browser globals — it uses only
// TextEncoder, a Web platform primitive present in Bun, the Workers runtime, and
// browsers, so measurement is byte-identical across all three (INV-6). It is
// imported identically by the shared server handler, the client shell, and tests,
// so "32 / 128 / 10" and HOW they are measured are defined exactly once (no drift
// between runtimes or between client and server).

// --- fixed product constants (spec: Fixed constants table) --------------------
export const MAX_ITEM_CHARS = 32; // max code points in one item's text (binding guard)
export const MAX_ITEM_BYTES = 128; // max UTF-8 bytes (redundant-by-construction backstop)
export const MAX_LIST_ITEMS = 10; // product cap on new list growth

/**
 * Character count = number of Unicode CODE POINTS (spec Definitions). Uses
 * Array.from so astral characters (e.g. most emoji) count as one, NOT the two
 * UTF-16 code units String.prototype.length would report. Deterministic and
 * identical on Bun, Workers, and browsers with no Intl.Segmenter dependency.
 * @param {*} text
 * @returns {number}
 */
export function itemCharCount(text) {
  return Array.from(String(text)).length;
}

/**
 * Byte count = length of the UTF-8 encoding (spec Definitions). TextEncoder is a
 * Web platform primitive present in all three runtimes, so the result is
 * byte-identical everywhere.
 * @param {*} text
 * @returns {number}
 */
export function itemByteCount(text) {
  return new TextEncoder().encode(String(text)).length;
}

/**
 * True iff text is within BOTH per-item caps. Under code-point counting the byte
 * cap is redundant-by-construction (32 code points is always ≤ 128 UTF-8 bytes),
 * so it can never independently reject — it is retained as an explicit,
 * machine-checked storage-size backstop (spec: "byte cap is redundant-by-
 * construction"). Both checks are evaluated; only the char check can bind.
 * @param {*} text
 * @returns {boolean}
 */
export function isItemTextWithinLimits(text) {
  return itemCharCount(text) <= MAX_ITEM_CHARS && itemByteCount(text) <= MAX_ITEM_BYTES;
}

/**
 * The server's R6/R8 list rule as a pure predicate: a PUT would grow the list
 * past the cap IFF its length exceeds MAX_LIST_ITEMS AND it is longer than the
 * currently stored length. The second clause is what lets a legacy over-sized
 * list drain (delete/edit/toggle on a >10 list is accepted); a flat `> 10` reject
 * would permanently lock such a list out (R11/INV-5).
 * @param {number} newLen  length of the submitted list
 * @param {number} currentLen  length of the currently stored list
 * @returns {boolean}
 */
export function exceedsListGrowth(newLen, currentLen) {
  return newLen > MAX_LIST_ITEMS && newLen > currentLen;
}
