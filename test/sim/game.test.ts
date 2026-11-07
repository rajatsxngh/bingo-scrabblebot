import assert from "node:assert/strict";
import { test } from "node:test";
import { BAG_COUNTS, IS_VOWEL, LETTER_VALUES, NUM_LETTERS, letterIndex, rackOf } from "../../src/core/rules.js";
import { Rng } from "../../src/core/rng.js";
import type { GameEvent, GameState } from "../../src/core/types.js";
import { wordIndex } from "../../src/core/words.js";
import { matchSeed, runMatch, type MatchSpec } from "../../src/sim/game.js";
import { ModuleSimBot, longestWord, type SimBrain } from "../../src/sim/opponents.js";
import { summarize } from "../../src/sim/stats.js";

const index = wordIndex();

/** Bids a fixed amount on every letter and never plays a word. */
function fixed(name: string, amount: number, opts: Partial<SimBrain> = {}): SimBrain {
  return {
    name,
    fastStart: true,
    bidTable: () => new Int32Array(NUM_LETTERS).fill(amount),
    planWords: () => [],
    ...opts,
  };
}

const table: MatchSpec = { players: ["bingo", "bron", "k13", "tileshark", "starter", "sim"], auctionType: "Vickrey" };

/** A match result without the decision timings, which are wall-clock measurements. */
const untimed = (r: ReturnType<typeof runMatch>) => ({
  ...r,
  seats: r.seats.map(({ decisionHist: _, ...rest }) => rest),
});

test("same seed, same match", () => {
  assert.deepEqual(untimed(runMatch(table, index, 42)), untimed(runMatch(table, index, 42)));
  assert.notDeepEqual(runMatch(table, index, 42).seats.map((s) => s.score), runMatch(table, index, 43).seats.map((s) => s.score));
});

test("every tile is accounted for: racks + played words + unsold letters = the bag", () => {
  for (const seed of [1, 2, 3]) {
    const events: GameEvent[] = [];
    const racks: Uint8Array[] = [];
    const r = runMatch(table, index, seed, { onEvent: (e) => events.push(e), finalRacks: racks });
    const seen = new Uint8Array(NUM_LETTERS);
    for (const rack of racks) for (let l = 0; l < NUM_LETTERS; l++) seen[l] += rack[l]!;
    for (const e of events) {
      if (e.type === "wordPlayed") {
        const used = rackOf(e.word);
        for (let l = 0; l < NUM_LETTERS; l++) seen[l] += used[l]!;
      }
      if (e.type === "auctionClosed" && e.winner === null) seen[e.letter]++;
    }
    assert.deepEqual([...seen], BAG_COUNTS);
    assert.equal(r.auctions, 68);
  }
});

test("Vickrey: the top bid wins and pays the runner-up's bid; a lone bidder pays 1", () => {
  const closes: Extract<GameEvent, { type: "auctionClosed" }>[] = [];
  runMatch({ players: [fixed("ten", 10), fixed("seven", 7), fixed("zero", 0)], auctionType: "Vickrey" }, index, 5, {
    onEvent: (e) => e.type === "auctionClosed" && closes.push(e),
  });
  // "ten" wins at 7 for 13 letters. Then it has 9 coins, so its bid of 10 is
  // refused (a bid must fit the balance, not just the price), and "seven"
  // wins alone for 1.
  assert.deepEqual(closes.slice(0, 13).map((c) => [c.winner, c.paid]), Array(13).fill([1, 7]));
  assert.deepEqual([closes[13]!.winner, closes[13]!.paid], [2, 1]);

  const lone: number[] = [];
  runMatch({ players: [fixed("ten", 10), fixed("zero", 0)], auctionType: "Vickrey" }, index, 5, {
    onEvent: (e) => e.type === "auctionClosed" && lone.push(e.paid),
  });
  assert.ok(lone.slice(0, 20).every((p) => p === 1));
});

test("first-price: the winner pays its own bid", () => {
  const paid: number[] = [];
  runMatch({ players: [fixed("ten", 10), fixed("seven", 7)], auctionType: "FirstPrice" }, index, 5, {
    onEvent: (e) => e.type === "auctionClosed" && paid.push(e.paid),
  });
  assert.deepEqual(paid.slice(0, 10), Array(10).fill(10));
});

test("ties go to a random bidder", () => {
  const wins = new Map<number | null, number>();
  runMatch({ players: [fixed("a", 1), fixed("b", 1), fixed("c", 1)], auctionType: "Vickrey" }, index, 9, {
    onEvent: (e) => e.type === "auctionClosed" && wins.set(e.winner, (wins.get(e.winner) ?? 0) + 1),
  });
  for (const id of [1, 2, 3]) assert.ok((wins.get(id) ?? 0) > 10, `bot ${id} won ${wins.get(id)} of 83`);
});

test("refused: bids above the balance and words not in the list or rack", () => {
  const greedy = fixed("greedy", 1000);
  const liar = fixed("liar", 0, { planWords: () => ["QZXQ", "RETAINS"] });
  const r = runMatch({ players: [greedy, liar, fixed("one", 1)], auctionType: "Vickrey" }, index, 3);
  assert.equal(r.seats[0]!.overBalance, r.auctions);
  assert.equal(r.seats[0]!.lettersWon, 0);
  assert.ok(r.seats[1]!.invalidWords > 0);
  assert.equal(r.seats[1]!.score, 0);
});

test("unsold letters are thrown away, and bids on the last letter are counted", () => {
  const r = runMatch({ players: [fixed("none", 0), fixed("none2", 0)], auctionType: "Vickrey" }, index, 1);
  assert.equal(r.unsold, 88);
  const s = runMatch({ players: [fixed("all", 1), fixed("none", 0)], auctionType: "Vickrey" }, index, 1);
  assert.equal(s.seats[0]!.lastLetterBids, 1);
});

test("every bot's tracker agrees with the true game", () => {
  let checked = 0;
  const watcher: SimBrain = {
    name: "watcher",
    fastStart: true,
    bidTable: (st: Readonly<GameState>) => {
      // 68 auctions: after k closes, k+1 letters are seen (the open one too).
      assert.equal(st.bagRemaining, 68 - st.auctionsClosed - 1);
      assert.equal(st.unseenTotal >= st.bagRemaining, true);
      checked++;
      return new Int32Array(NUM_LETTERS).fill(5);
    },
    planWords: () => [],
  };
  runMatch({ players: [watcher, "bron", "k13", "sim", "starter", "tileshark"], auctionType: "Vickrey" }, index, 11);
  assert.equal(checked, 68);
});

test("the module's sim bots bid as game.ts decideBid does", () => {
  const rng = new Rng(1);
  const st = { coins: 100 } as GameState;
  for (const strategy of ["Cheapskate", "ValueBidder", "Aggressive"] as const) {
    const bot = new ModuleSimBot(strategy, index, rng);
    for (let k = 0; k < 50; k++) {
      const t = bot.bidTable(st);
      for (let l = 0; l < NUM_LETTERS; l++) {
        const v = LETTER_VALUES[l]!;
        const base = strategy === "Cheapskate" ? v - 1 : strategy === "ValueBidder" ? v : v + (IS_VOWEL[l] ? 4 : 2);
        assert.ok(t[l]! >= Math.max(1, base - 2) && t[l]! <= base + 2, `${strategy} ${l}: ${t[l]}`);
      }
    }
  }
  // Capped at the balance.
  assert.ok(new ModuleSimBot("Aggressive", index, rng).bidTable({ coins: 3 } as GameState).every((b) => b <= 3));
});

test("longest word, as the module's findBestPlayable picks it", () => {
  assert.equal(longestWord(index, rackOf("RETAINS"), 3), "ANESTRI"); // first of 8 anagrams, A to Z
  assert.equal(longestWord(index, rackOf("CAT"), 3), "ACT");
  assert.equal(longestWord(index, rackOf("CAT"), 4), null);
  assert.equal(longestWord(index, rackOf("INTERNATIONALS"), 2), "INTERNATIONALS");
});

test("match seeds don't depend on how matches are split", () => {
  assert.equal(matchSeed(1, 5), matchSeed(1, 5));
  assert.notEqual(matchSeed(1, 5), matchSeed(1, 6));
  assert.notEqual(matchSeed(1, 5), matchSeed(2, 5));
});

test("summary: head-to-head stats for two-bot tables", () => {
  const results = [1, 2, 3, 4].map((seed) => runMatch({ players: ["bingo", "starter"], auctionType: "Vickrey" }, index, seed));
  const s = summarize(results);
  assert.ok(s.headToHead);
  assert.equal(s.seats.length, 2);
  assert.equal(s.matches, 4);
  void letterIndex;
});
