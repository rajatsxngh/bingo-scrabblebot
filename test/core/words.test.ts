import assert from "node:assert/strict";
import { test } from "node:test";
import { ALPHABET, letterIndex, rackOf } from "../../src/core/rules.js";
import {
  bestWord,
  canSpell,
  deficit,
  deficits,
  loadWordIndex,
  missingLetters,
  playable,
  wordIndex,
} from "../../src/core/words.js";

const index = wordIndex();

test("word counts match the module's list", () => {
  assert.equal(index.totalWords, 172_820);
  assert.equal(index.long.size, 96_702);
  assert.equal(index.short.size, 28_839);
  let sevens = 0;
  for (let i = 0; i < index.long.size; i++) if (index.long.length[i] === 7) sevens++;
  assert.equal(sevens, 23_109);
});

test("validity matches the module's check", () => {
  assert.ok(index.isWord("RETAINS"));
  assert.ok(index.isWord("retains"));
  assert.ok(index.isWord("QAT"));
  assert.ok(!index.isWord("QI")); // not in ENABLE
  assert.ok(!index.isWord("A")); // one letter
  // Words of 11+ letters are playable but not in either index.
  assert.ok(index.isWord("INTERNATIONAL"));
  assert.ok(!index.long.words.includes("INTERNATIONAL"));
});

/** Letters that, added to `stem`, make some 7-letter word. */
function seventhLetters(stem: string): string {
  const { long } = index;
  let out = "";
  for (const c of ALPHABET) {
    const rack = rackOf(stem + c);
    for (let i = 0; i < long.size; i++) {
      if (long.length[i] === 7 && canSpell(long, i, rack)) {
        out += c;
        break;
      }
    }
  }
  return out;
}

test("flexible stems: AEINST takes 23 seventh letters, AEERST and EGINRS 20", () => {
  const aeinst = seventhLetters("AEINST");
  assert.equal(aeinst.length, 23);
  assert.equal([...ALPHABET].filter((c) => !aeinst.includes(c)).join(""), "JQY");
  assert.equal(seventhLetters("AEERST").length, 20);
  assert.equal(seventhLetters("EGINRS").length, 20);
});

test("rack queries", () => {
  const { long, short } = index;
  const retain = rackOf("RETAIN");
  const i = long.words.indexOf("RETAINS");
  assert.equal(deficit(long, i, retain), 1);
  const missing = new Uint8Array(26);
  assert.equal(missingLetters(long, i, retain, missing), 1);
  assert.equal(missing[letterIndex("S")], 1);
  assert.ok(canSpell(long, i, rackOf("RETAINS")));
  assert.ok(!canSpell(long, i, retain));

  // The one-pass scan agrees with the per-word check.
  const all = new Uint8Array(long.size);
  deficits(long, retain, all);
  for (const j of [0, i, 500, long.size - 1]) assert.equal(all[j], deficit(long, j, retain));

  assert.equal(bestWord(index, rackOf("RETAINS"))?.reward, 21);
  assert.equal(bestWord(index, retain)?.reward, 15);
  assert.equal(bestWord(index, rackOf("QXZ")), null);

  const cat = playable(short, rackOf("CAT")).map((j) => short.words[j]);
  for (const w of ["CAT", "ACT", "AT", "TA"]) assert.ok(cat.includes(w), w);
  // Best reward first.
  const rewards = playable(short, rackOf("CATS")).map((j) => short.reward[j]!);
  assert.deepEqual(rewards, [...rewards].sort((a, b) => b - a));
});

test("the index loads in under 1 s, and a pass over the long words takes under 5 ms", () => {
  const t0 = performance.now();
  loadWordIndex();
  const loadMs = performance.now() - t0;
  assert.ok(loadMs < 1000, `loading took ${loadMs.toFixed(0)} ms`);

  const out = new Uint8Array(index.long.size);
  const rack = rackOf("AEINRSTLDG");
  for (let k = 0; k < 5; k++) deficits(index.long, rack, out); // warm up
  const times: number[] = [];
  for (let k = 0; k < 21; k++) {
    const t = performance.now();
    deficits(index.long, rack, out);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const median = times[10]!;
  assert.ok(median < 5, `a pass took ${median.toFixed(2)} ms`);
});
