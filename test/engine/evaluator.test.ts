import assert from "node:assert/strict";
import { test } from "node:test";
import { loadParams } from "../../src/core/params.js";
import { BAG_COUNTS, NUM_LETTERS, letterIndex, rackOf } from "../../src/core/rules.js";
import { Rng } from "../../src/core/rng.js";
import { wordIndex } from "../../src/core/words.js";
import { Evaluator, chanceTable, makeContext, targetSet } from "../../src/engine/evaluator.js";

const index = wordIndex();
const params = loadParams().evaluator;
const ev = new Evaluator(index, params);
const L = letterIndex;
/** The unseen pool at the start of a match: the bag minus our rack. */
const unseenFor = (rack: Uint8Array) => Uint8Array.from(BAG_COUNTS, (n, l) => n - rack[l]!);
const values = (letters: string, future: number, winRate = 0.3, coinValue = 0.6) => {
  const rack = rackOf(letters);
  return ev.letterValues(rack, makeContext(unseenFor(rack), future, winRate, coinValue));
};

test("targets are distinct letter sets: RETAINS and its 7 anagrams are one target", () => {
  const t = targetSet(index);
  assert.ok(t.size < index.long.size);
  const anagrams = ["ANESTRI", "NASTIER", "RATINES", "RETAINS", "RETINAS", "RETSINA", "STAINER", "STEARIN"];
  assert.equal(anagrams.filter((w) => t.words.includes(w)).length, 1);
});

test("second-to-last auction: a letter is worth exactly what it adds to the rack's best play now", () => {
  // The last letter can't be played, so no future letters count: S turns RETAIN (15) into RETAINS (21).
  const r = values("RETAIN", 0);
  assert.equal(r.base, 15);
  assert.equal(r.values[L("S")], 6);
});

test("a letter that completes a 7-letter word is worth at least that word minus the rack's value", () => {
  const r = values("RETAIN", 30);
  assert.ok(r.values[L("S")]! >= 21 - r.base - 1e-9, `S is worth ${r.values[L("S")]}, V = ${r.base}`);
});

test("points count: on AEINST, Z (a 48-point word now) is worth more than another E", () => {
  // The PRD expected the 23 seventh letters to beat J, Q and Y. In this game
  // Q and J are one U away from ANTIQUES and JAUNTIES (51 and 45 points), and
  // the live market agrees: Q, Z and X sold for ~27, 1-point letters for ~10.
  const r = values("AEINST", 60);
  assert.ok(r.values[L("Z")]! > r.values[L("E")]!);
  assert.ok(r.values[L("Q")]! > r.values[L("E")]!);
});

test("the chance table behaves", () => {
  const unseen = Uint8Array.from(BAG_COUNTS);
  const total = 98;
  const p = (future: number, w: number, l: string, m: number) => chanceTable(unseen, total, future, w)[L(l) * 5 + m]!;
  assert.ok(p(60, 0.3, "E", 1) > p(10, 0.3, "E", 1), "more auctions, better odds");
  assert.ok(p(30, 0.6, "E", 1) > p(30, 0.3, "E", 1), "a better win rate, better odds");
  assert.ok(p(30, 0.3, "E", 1) >= p(30, 0.3, "E", 2), "needing two is harder than one");
  assert.ok(p(30, 0.3, "E", 1) > p(30, 0.3, "Q", 1), "12 Es, 1 Q");
  assert.equal(p(0, 0.3, "E", 1), 0);
  assert.equal(p(30, 0.3, "E", 0), 1);
  const noQ = Uint8Array.from(BAG_COUNTS);
  noQ[L("Q")] = 0;
  assert.equal(chanceTable(noQ, 97, 30, 0.3)[L("Q") * 5 + 1], 0);
});

test("costlier letters make unfinished racks worth less", () => {
  assert.ok(values("AEIRT", 60, 0.7, 0).base >= values("AEIRT", 60, 0.7, 1).base);
});

test("all 26 values in under 50 ms for racks of 0 to 20 letters", () => {
  const rng = new Rng(3);
  const bag: number[] = [];
  BAG_COUNTS.forEach((n, l) => {
    for (let k = 0; k < n; k++) bag.push(l);
  });
  let worst = 0;
  for (const size of [0, 5, 10, 15, 20]) {
    for (const future of [60, 10]) {
      for (let k = 0; k < 4; k++) {
        const rack = new Uint8Array(NUM_LETTERS);
        for (const l of rng.shuffle([...bag]).slice(0, size)) rack[l]++;
        const ctx = makeContext(unseenFor(rack), future, 0.3);
        const t0 = performance.now();
        ev.letterValues(rack, ctx);
        worst = Math.max(worst, performance.now() - t0);
      }
    }
  }
  assert.ok(worst < 50, `worst ${worst.toFixed(1)} ms`);
});

test("rackValue agrees with letterValues' V(R)", () => {
  const rack = rackOf("AEINRTS");
  const ctx = makeContext(unseenFor(rack), 40, 0.5);
  assert.ok(Math.abs(ev.rackValue(rack, ctx) - ev.letterValues(rack, ctx).base) < 1e-9);
});
