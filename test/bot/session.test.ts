import assert from "node:assert/strict";
import { test } from "node:test";
import { parseControl, DEFAULT_CONTROL } from "../../src/bot/control.js";
import { Session } from "../../src/bot/session.js";
import { letterIndex, matchSettings, rackOf, tileCount } from "../../src/core/rules.js";
import type { Brain, GameState } from "../../src/core/types.js";
import { wordIndex } from "../../src/core/words.js";
import { FallbackBrain, greedySplit } from "../../src/engine/fallback.js";

const index = wordIndex();
const fallback = new FallbackBrain(index);
const L = letterIndex;

// 4 bots with 20-tile racks leave 18 auctions: short enough to play out.
const settings = matchSettings({ auctionType: "Vickrey", numBots: 4, rackSize: 20 });
const opening = rackOf("RETAINSCATDOGLIEMPUB");

function newSession(brain: Brain = fallback) {
  return new Session({ settings, me: 1, bots: [1, 2, 3, 4], opening }, brain, fallback, index);
}

test("answers a new auction with a bid within its coins", () => {
  const s = newSession();
  s.push({ type: "auctionOpened", auctionId: 1, letter: L("E") });
  const d = s.flush();
  assert.equal(d.bids.length, 1);
  assert.equal(d.bids[0]!.auctionId, 1);
  assert.ok(d.bids[0]!.amount >= 1 && d.bids[0]!.amount <= 100);
  // Nothing changed, so a second flush sends nothing.
  assert.equal(s.flush().bids.length, 0);
});

test("applies a close before the next open in the same transaction", () => {
  const s = newSession();
  s.push({ type: "auctionOpened", auctionId: 1, letter: L("E") });
  s.flush();
  s.push({ type: "auctionOpened", auctionId: 2, letter: L("S") });
  s.push({ type: "auctionClosed", auctionId: 1, letter: L("E"), winner: 2, paid: 5 });
  const d = s.flush();
  assert.equal(d.closed.length, 1);
  assert.equal(s.state.current?.auctionId, 2);
  assert.deepEqual(d.bids.map((b) => b.auctionId), [2]);
});

test("never bids above its coins, and never on the last letter", () => {
  const s = newSession();
  s.push({ type: "balanceChanged", bot: 1, coins: 0, score: 0 });
  s.push({ type: "auctionOpened", auctionId: 1, letter: L("E") });
  assert.equal(s.flush().bids.length, 0);

  const t = newSession();
  for (let k = 1; k < settings.totalAuctions; k++) {
    t.push({ type: "auctionOpened", auctionId: k, letter: L("E") });
    t.push({ type: "auctionClosed", auctionId: k, letter: L("E"), winner: 2, paid: 1 });
  }
  t.flush();
  t.push({ type: "auctionOpened", auctionId: 99, letter: L("S") });
  const d = t.flush();
  assert.equal(t.state.bagRemaining, 0);
  assert.equal(d.bids.length, 0);
  // Last auction: dump the rack as words (greedy for now; M6 finds the best split).
  assert.ok(d.words.length > 0);
  for (const w of d.words) assert.ok(index.isWord(w), w);
  const used = d.words.reduce((n, w) => n + w.length, 0);
  assert.ok(used >= 7 && used <= tileCount(opening), `used ${used} tiles`);
});

test("only sends real words the rack can spell, once per rack", () => {
  const picky: Brain = {
    name: "picky",
    bidTable: () => new Int32Array(26),
    planWords: () => ["ZZZQ", "CAT", "QUIZ", "cat"],
  };
  const s = newSession(picky);
  // ZZZQ isn't a word, the rack has one C (so one CAT), and no Q for QUIZ.
  const d = s.flush();
  assert.deepEqual(d.words, ["CAT"]);
  assert.deepEqual(s.flush().words, [], "the same word from the same rack isn't sent twice");
});

test("letters of a word in flight stay reserved until the server applies it", () => {
  // Seen live: after one endgame word landed, a re-plan sent "OR" a second time.
  const brain: Brain = { name: "or", bidTable: () => new Int32Array(26), planWords: () => ["OR"] };
  const s = new Session(
    { settings, me: 1, bots: [1, 2, 3, 4], opening: rackOf("ORTAINSCAEDUGLIEMPBY") },
    brain,
    fallback,
    index,
  );
  assert.deepEqual(s.flush().words, ["OR"]);
  // Some other rack change arrives first; OR hasn't been applied yet.
  s.push({ type: "rackChanged", rack: rackOf("ORTAINSCAEDUGLIEMPB") });
  assert.deepEqual(s.flush().words, [], "OR is still in flight");
  // The server applies it: the word shows up and the rack loses O and R.
  s.push({ type: "wordPlayed", id: 1, bot: 1, word: "OR", reward: 2 });
  s.push({ type: "rackChanged", rack: rackOf("TAINSCAEDUGLIEMPB") });
  assert.deepEqual(s.flush().words, [], "no O left, so no second OR");
});

test("a rejected word frees its letters", () => {
  const brain: Brain = { name: "or", bidTable: () => new Int32Array(26), planWords: () => ["OR"] };
  const s = newSession(brain);
  assert.deepEqual(s.flush().words, ["OR"]);
  assert.deepEqual(s.flush().words, []);
  s.wordRejected("OR");
  assert.deepEqual(s.flush().words, ["OR"]);
});

test("falls back when the brain throws", () => {
  const broken: Brain = {
    name: "broken",
    bidTable: () => {
      throw new Error("boom");
    },
    planWords: () => [],
  };
  const s = newSession(broken);
  s.push({ type: "auctionOpened", auctionId: 1, letter: L("E") });
  const d = s.flush();
  assert.equal(d.brainError, "boom");
  assert.equal(d.bids.length, 1);
});

test("fallback brain: sane bids and a greedy split", () => {
  const s = newSession().state as GameState;
  const table = fallback.bidTable(s);
  for (const b of table) assert.ok(b >= 1 && b <= 100);
  // The rack has two As and one O: duplicates of ordinary letters are discounted.
  assert.ok(table[L("A")]! < table[L("O")]! || table[L("A")]! <= 2);
  const words = greedySplit(index, rackOf("RETAINSCAT"));
  assert.ok(words.includes("RETAINS") || words[0]!.length >= 7, words.join(" "));
});

test("control.json parsing", () => {
  assert.deepEqual(parseControl({}), DEFAULT_CONTROL);
  assert.deepEqual(parseControl({ lobby: false, tournamentId: 7, brain: "v1" }), {
    ...DEFAULT_CONTROL,
    lobby: false,
    tournamentId: "7",
    brain: "v1",
  });
  assert.equal(parseControl({ lobby: "no" }).lobby, true);
});
