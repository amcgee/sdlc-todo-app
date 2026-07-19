// @vitest-environment node
//
// ISSUE-35 — proving tests for src/limits.js, the single source of truth for the
// list/item limit constants and their measurement rules (spec PART II §1). These
// pin the spec's core measurement requirements so a drift in the constants or the
// counting rule is caught: code-point (not UTF-16 unit) char counting, the 32/128/10
// fixed constants, the within-limits predicate boundary, and the R6 growth rule that
// lets a legacy over-sized list drain.
//
// Each case is written to FAIL against a plausibly-broken implementation (e.g. one
// that uses String.length for char count, a flat `> 10` growth reject, or an off-by-
// one boundary) and PASS against the shipped code.

import { describe, it, expect } from 'vitest';

import {
  MAX_ITEM_CHARS,
  MAX_ITEM_BYTES,
  MAX_LIST_ITEMS,
  itemCharCount,
  itemByteCount,
  isItemTextWithinLimits,
  exceedsListGrowth,
} from '../src/limits.js';

describe('fixed constants (spec: Fixed constants table)', () => {
  it('are exactly 32 / 128 / 10', () => {
    expect(MAX_ITEM_CHARS).toBe(32);
    expect(MAX_ITEM_BYTES).toBe(128);
    expect(MAX_LIST_ITEMS).toBe(10);
  });
});

describe('itemCharCount — Unicode CODE POINTS, not UTF-16 units', () => {
  it('counts plain ASCII by length', () => {
    expect(itemCharCount('')).toBe(0);
    expect(itemCharCount('abc')).toBe(3);
    expect(itemCharCount('a'.repeat(32))).toBe(32);
  });

  it('counts an astral char as ONE code point (String.length would report 2)', () => {
    // '😀' is a single code point but has String length 2 (surrogate pair). A
    // String.length-based implementation would report 2 and fail this.
    expect('😀'.length).toBe(2);
    expect(itemCharCount('😀')).toBe(1);
    // 32 astral emoji = 32 code points (exactly the char cap) but 64 UTF-16 units.
    expect(itemCharCount('😀'.repeat(32))).toBe(32);
  });

  it('coerces non-strings via String() (never throws)', () => {
    expect(itemCharCount(null)).toBe(itemCharCount('null'));
    expect(itemCharCount(12345)).toBe(5);
  });
});

describe('itemByteCount — UTF-8 byte length', () => {
  it('ASCII is one byte per char', () => {
    expect(itemByteCount('a'.repeat(10))).toBe(10);
  });

  it('an emoji is 4 UTF-8 bytes', () => {
    expect(itemByteCount('😀')).toBe(4);
    // 32 emoji = 128 bytes, exactly the byte cap.
    expect(itemByteCount('😀'.repeat(32))).toBe(128);
  });
});

describe('isItemTextWithinLimits — char cap boundary (measurement correctness)', () => {
  it('accepts exactly 32 chars and rejects 33 (off-by-one guard)', () => {
    expect(isItemTextWithinLimits('a'.repeat(32))).toBe(true);
    expect(isItemTextWithinLimits('a'.repeat(33))).toBe(false);
  });

  it('accepts the empty string', () => {
    expect(isItemTextWithinLimits('')).toBe(true);
  });

  it('measures astral text by code point, so 32 emoji (128 bytes) is within both caps', () => {
    // 32 code points AND 128 bytes: both caps are exactly met. A UTF-16-unit char
    // measure (64) would wrongly reject this.
    expect(isItemTextWithinLimits('😀'.repeat(32))).toBe(true);
    // 33 emoji: over the char cap (and the byte cap) -> rejected.
    expect(isItemTextWithinLimits('😀'.repeat(33))).toBe(false);
  });
});

describe('exceedsListGrowth — R6/R8 growth rule (grandfathered drain)', () => {
  it('rejects genuine growth past the cap (11 new items on a 10-item list)', () => {
    expect(exceedsListGrowth(11, 10)).toBe(true);
  });

  it('accepts a PUT that does not grow at/under the cap', () => {
    expect(exceedsListGrowth(10, 10)).toBe(false);
    expect(exceedsListGrowth(5, 4)).toBe(false);
    expect(exceedsListGrowth(0, 0)).toBe(false);
  });

  it('accepts DRAINING a legacy over-sized list (R8): a flat `>10` reject would lock it out', () => {
    // Stored length 12 (legacy > cap); PUT 11 (deleted one). newLen 11 > 10 but
    // 11 is NOT > 12, so it is not growth -> allowed. This is INV-5/R11.
    expect(exceedsListGrowth(11, 12)).toBe(false);
    // Even staying flat at 12 (a toggle/edit on the legacy list) is allowed.
    expect(exceedsListGrowth(12, 12)).toBe(false);
  });

  it('rejects growing a legacy over-sized list further (13 on a 12-item list)', () => {
    expect(exceedsListGrowth(13, 12)).toBe(true);
  });
});
