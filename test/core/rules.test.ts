import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BAG_COUNTS,
  BAG_SIZE,
  LETTER_VALUES,
  TIER_OF,
  letterIndex,
  matchSettings,
  rackOf,
  rackToString,
  reward,
  totalAuctions,
} from "../../src/core/rules.js";

test("bag and letter values match the module", () => {
  assert.equal(BAG_SIZE, 98);
  assert.equal(BAG_COUNTS.reduce((a, b) => a + b, 0), BAG_SIZE);
  // Face value of the whole bag: a standard Scrabble set without blanks.
  const faceValue = BAG_COUNTS.reduce((sum, n, i) => sum + n * LETTER_VALUES[i]!, 0);
  assert.equal(faceValue, 187);
  const value = (c: string) => LETTER_VALUES[letterIndex(c)];
  assert.deepEqual(
    ["A", "D", "B", "F", "K", "J", "X", "Q", "Z"].map(value),
    [1, 2, 3, 4, 5, 8, 8, 10, 10],
  );
  const count = (c: string) => BAG_COUNTS[letterIndex(c)];
  assert.deepEqual(
    ["E", "A", "I", "O", "S", "Q", "Z"].map(count),
    [12, 9, 9, 8, 4, 1, 1],
  );
});

test("rewards use the module's multipliers, rounded down", () => {
  assert.equal(reward("RETAINS"), 21);
  assert.equal(reward("RAIN") + reward("SET"), 9);
  // Words from the PRD's live matches.
  assert.equal(reward("AGREED"), 20);
  assert.equal(reward("BIGHORN"), 39);
  assert.equal(reward("JOYSTICK"), 72);
  assert.equal(reward("QAT"), 12);
  // Rounded down: DATE is 5 × 1.5 = 7.5 and DETAIN is 7 × 2.5 = 17.5.
  assert.equal(reward("DATE"), 7);
  assert.equal(reward("DETAIN"), 17);
});

test("auction counts and price tiers", () => {
  assert.equal(totalAuctions(6, 5), 68);
  assert.equal(totalAuctions(2, 5), 88);
  assert.equal(totalAuctions(6, 20), 0);
  const s = matchSettings({ auctionType: "Vickrey", numBots: 6 });
  assert.equal(s.totalAuctions, 68);
  assert.equal(s.startingCoins, 100);
  const tier = (c: string) => TIER_OF[letterIndex(c)];
  assert.deepEqual(
    ["E", "S", "D", "B", "M", "F", "K", "J", "Q", "X", "Z"].map(tier),
    [0, 0, 1, 1, 1, 2, 2, 3, 3, 3, 3],
  );
});

test("racks convert to counts and back", () => {
  assert.equal(rackToString(rackOf("TSENIA")), "AEINST");
  assert.equal(letterIndex("a"), -1);
  assert.throws(() => rackOf("ab"));
});
