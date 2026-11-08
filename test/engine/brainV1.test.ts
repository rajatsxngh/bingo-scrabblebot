import assert from "node:assert/strict";
import { test } from "node:test";
import { loadParams } from "../../src/core/params.js";
import { NUM_LETTERS, letterIndex, matchSettings, rackOf, reward } from "../../src/core/rules.js";
import { Tracker } from "../../src/core/tracker.js";
import { wordIndex } from "../../src/core/words.js";
import { BingoV1 } from "../../src/engine/brainV1.js";
import { greedySplit } from "../../src/engine/fallback.js";
import { bestSplit } from "../../src/engine/planner.js";

const index = wordIndex();
const params = loadParams();
const v1 = new BingoV1(index, params);
const L = letterIndex;

/** A 6-bot match with `k` auctions already closed (won by a rival for 10), and auction k+1 open. */
function stateAfter(k: number, opening = "AEIRT", coins = 100, type: "Vickrey" | "FirstPrice" = "Vickrey") {
  const settings = matchSettings({ auctionType: type, numBots: 6 });
  const t = new Tracker({ settings, me: 1, bots: [1, 2, 3, 4, 5, 6], opening: rackOf(opening) });
  for (let a = 1; a <= k; a++) {
    t.apply({ type: "auctionOpened", auctionId: a, letter: L("E") });
    t.apply({ type: "auctionClosed", auctionId: a, letter: L("E"), winner: 2, paid: 10 });
  }
  t.apply({ type: "auctionOpened", auctionId: k + 1, letter: L("S") });
  t.apply({ type: "balanceChanged", bot: 1, coins, score: 0 });
  return t.state;
}

test("bids are whole coins within the balance", () => {
  for (const coins of [0, 1, 7, 100]) {
    const table = v1.bidTable(stateAfter(10, "AEIRT", coins));
    for (let l = 0; l < NUM_LETTERS; l++) {
      assert.ok(Number.isInteger(table[l]) && table[l]! >= 0 && table[l]! <= coins, `coins ${coins}, ${l}: ${table[l]}`);
    }
  }
});

test("never bids on the last letter", () => {
  const s = stateAfter(67);
  assert.equal(s.bagRemaining, 0);
  assert.ok(v1.bidTable(s).every((b) => b === 0));
});

test("bids at least what the fallback would, and more for big-word letters", () => {
  const s = stateAfter(5, "AEINST");
  const table = v1.bidTable(s);
  assert.ok(table[L("Z")]! >= 15, `Z ${table[L("Z")]}`); // AEINST + Z is a 48-point word
  assert.ok(table[L("E")]! >= 1);
});

test("first-price: never more than one coin above the richest rival", () => {
  const s = stateAfter(10, "AEINST", 100, "FirstPrice");
  for (const r of s.rivals.values()) r.coins = 6;
  assert.ok(v1.bidTable(s).every((b) => b <= 7));
});

test("the endgame split is never worse than greedy", () => {
  for (const letters of ["RETAINSCATDOGLIEMPUB", "QUIZJAXEROTSNLDAEI", "EEEEAAIIOOUURRSSTT", "RETAINS"]) {
    const rack = rackOf(letters);
    const total = (ws: string[]) => ws.reduce((s, w) => s + reward(w), 0);
    const best = bestSplit(index, rack);
    assert.ok(total(best) >= total(greedySplit(index, rack)), letters);
    // And it only uses letters in the rack.
    const used = new Uint8Array(NUM_LETTERS);
    for (const w of best) for (const c of w) used[L(c)]++;
    for (let l = 0; l < NUM_LETTERS; l++) assert.ok(used[l]! <= rack[l]!);
  }
});

test("plays the whole rack during the last auction", () => {
  const s = stateAfter(67, "RETAINS");
  assert.deepEqual(v1.planWords(s).map((w) => w.length), [7]);
});
