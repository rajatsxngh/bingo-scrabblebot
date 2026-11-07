import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALPHABET,
  BAG_COUNTS,
  NUM_LETTERS,
  letterIndex,
  matchSettings,
  rackOf,
} from "../../src/core/rules.js";
import { Rng } from "../../src/core/rng.js";
import {
  Tracker,
  deriveOpening,
  hiddenTiles,
  knownHoldings,
  replay,
} from "../../src/core/tracker.js";
import type { BotId, Counts, GameEvent, MatchStart } from "../../src/core/types.js";
import { bestWord, wordIndex } from "../../src/core/words.js";

const index = wordIndex();
const L = letterIndex;

/**
 * Plays a whole 6-bot match with random winners and real words, keeping the
 * true bag and racks alongside, and checks the tracker against them after
 * every event.
 */
function scriptedMatch(seed: number) {
  const rng = new Rng(seed);
  const bots: BotId[] = [11, 12, 13, 14, 15, 16];
  const me = 11;
  const settings = matchSettings({ auctionType: "Vickrey", numBots: bots.length });

  const bag: number[] = [];
  BAG_COUNTS.forEach((n, l) => {
    for (let k = 0; k < n; k++) bag.push(l);
  });
  rng.shuffle(bag);

  const racks = new Map<BotId, Counts>();
  const openings = new Map<BotId, Counts>();
  const coins = new Map<BotId, number>();
  const scores = new Map<BotId, number>();
  for (const b of bots) {
    const r = new Uint8Array(NUM_LETTERS);
    for (let k = 0; k < settings.rackSize; k++) r[bag.pop()!]++;
    racks.set(b, r);
    openings.set(b, Uint8Array.from(r));
    coins.set(b, settings.startingCoins);
    scores.set(b, 0);
  }

  const start: MatchStart = { settings, me, bots, opening: Uint8Array.from(openings.get(me)!) };
  const tracker = new Tracker(start);
  const events: GameEvent[] = [];

  const check = () => {
    const s = tracker.state;
    const trueBag = new Uint8Array(NUM_LETTERS);
    for (const l of bag) trueBag[l]++;
    for (let l = 0; l < NUM_LETTERS; l++) {
      // Unseen = what's really left in the bag + rivals' unrevealed opening tiles.
      let expected = trueBag[l]!;
      for (const [b, r] of s.rivals) {
        const opening = openings.get(b)![l]!;
        assert.ok(r.revealed[l]! <= opening, `revealed ${ALPHABET[l]} is more than bot ${b} was dealt`);
        expected += opening - r.revealed[l]!;
      }
      assert.equal(s.unseen[l], expected, `unseen ${ALPHABET[l]}`);
    }
    let hidden = 0;
    for (const r of s.rivals.values()) hidden += hiddenTiles(r, settings.rackSize);
    assert.equal(s.unseenTotal, s.bagRemaining + hidden);
    assert.equal(s.bagRemaining, bag.length);
  };
  const emit = (e: GameEvent) => {
    events.push(e);
    tracker.apply(e);
    check();
  };
  const money = (b: BotId, delta: number, scored: number) => {
    coins.set(b, coins.get(b)! + delta);
    scores.set(b, scores.get(b)! + scored);
    emit({ type: "balanceChanged", bot: b, coins: coins.get(b)!, score: scores.get(b)! });
  };

  check();
  let wordId = 1;
  for (let k = 0; k < settings.totalAuctions; k++) {
    const auctionId = 1000 + k;
    const letter = bag.pop()!;
    emit({ type: "auctionOpened", auctionId, letter });
    if (rng.chance(0.6)) emit({ type: "bidSent", auctionId, amount: rng.int(1, 15) });

    const winner = rng.chance(0.1) ? null : rng.pick(bots);
    const paid = winner === null ? 0 : Math.min(rng.int(1, 20), coins.get(winner)!);
    if (winner !== null) racks.get(winner)![letter]++;
    emit({ type: "auctionClosed", auctionId, letter, winner, paid });
    if (winner !== null) money(winner, -paid, 0);
    if (winner === me) emit({ type: "rackChanged", rack: Uint8Array.from(racks.get(me)!) });

    for (const b of bots) {
      if (!rng.chance(0.15)) continue;
      const rack = racks.get(b)!;
      const best = bestWord(index, rack);
      if (!best || best.word.length < 3) continue;
      const used = rackOf(best.word);
      for (let l = 0; l < NUM_LETTERS; l++) rack[l] -= used[l]!;
      emit({ type: "wordPlayed", id: wordId++, bot: b, word: best.word, reward: best.reward });
      money(b, best.reward, best.reward);
      if (b === me) emit({ type: "rackChanged", rack: Uint8Array.from(rack) });
    }
  }
  emit({ type: "matchEnded" });
  return { start, events, tracker, racks, openings, wordsPlayed: wordId - 1 };
}

test("a scripted 6-bot match: unseen tiles always match the truth", () => {
  for (const seed of [1, 2, 3]) {
    const { tracker, racks, openings, start, wordsPlayed } = scriptedMatch(seed);
    const s = tracker.state;
    assert.ok(wordsPlayed > 10, "the script should play some words");
    assert.equal(s.auctionsClosed, 68);
    assert.equal(s.auctionsLeft, 0);
    assert.equal(s.bagRemaining, 0);
    assert.ok(s.ended);
    assert.deepEqual(s.rack, racks.get(start.me));
    assert.deepEqual(deriveOpening(s.rack, s.won, s.spent), openings.get(start.me));
    // Some rivals must have revealed opening tiles for the check to mean much.
    let revealed = 0;
    for (const r of s.rivals.values()) revealed += r.revealedTotal;
    assert.ok(revealed > 0);
  }
});

test("a rival playing a letter it never won reveals an opening tile", () => {
  const settings = matchSettings({ auctionType: "Vickrey", numBots: 2 });
  const t = new Tracker({ settings, me: 1, bots: [1, 2], opening: rackOf("AEIOU") });
  t.apply({ type: "auctionOpened", auctionId: 1, letter: L("T") });
  t.apply({ type: "auctionClosed", auctionId: 1, letter: L("T"), winner: 2, paid: 3 });
  t.apply({ type: "wordPlayed", id: 1, bot: 2, word: "CAT", reward: 5 });
  const r = t.state.rivals.get(2)!;
  // It won the T; the C and A came from its opening rack.
  assert.deepEqual(r.revealed, rackOf("AC"));
  assert.equal(hiddenTiles(r, settings.rackSize), 3);
  // Winning an A later doesn't un-reveal the one it already played.
  t.apply({ type: "auctionOpened", auctionId: 2, letter: L("A") });
  t.apply({ type: "auctionClosed", auctionId: 2, letter: L("A"), winner: 2, paid: 2 });
  assert.deepEqual(r.revealed, rackOf("AC"));
  assert.deepEqual(knownHoldings(r), rackOf("A"));
  // A: 9 in the bag, 1 in our opening rack, 1 auctioned, 1 revealed.
  assert.equal(t.state.unseen[L("A")], 6);
});

test("prices and our win count", () => {
  const settings = matchSettings({ auctionType: "Vickrey", numBots: 2 });
  const t = new Tracker(
    { settings, me: 1, bots: [1, 2], opening: rackOf("AEIOU") },
    { priceAlpha: 0.25 },
  );
  const auction = (id: number, letter: string, winner: BotId | null, paid: number, myBid: number) => {
    t.apply({ type: "auctionOpened", auctionId: id, letter: L(letter) });
    if (myBid > 0) t.apply({ type: "bidSent", auctionId: id, amount: myBid });
    t.apply({ type: "auctionClosed", auctionId: id, letter: L(letter), winner, paid });
  };
  auction(1, "E", 1, 10, 12); // we bid and won
  auction(2, "S", 2, 20, 8); // we bid and lost
  auction(3, "Q", null, 0, 0); // nobody bid
  const s = t.state;
  assert.equal(s.myBids, 2);
  assert.equal(s.myWins, 1);
  assert.equal(s.prices.count[0], 2);
  assert.equal(s.prices.sum[0], 30);
  assert.equal(s.prices.ema[0], 12.5); // 10, then 10 + 0.25 × (20 − 10)
  assert.equal(s.prices.count[3], 0); // the unsold Q isn't a price
  assert.equal(s.history.length, 3);
  assert.deepEqual(s.won, rackOf("E"));
});

test("applying every event twice changes nothing", () => {
  const { start, events } = scriptedMatch(7);
  assert.deepEqual(replay(start, events.flatMap((e) => [e, e])), replay(start, events));
});

test("a mid-match rebuild from the tables matches the live tracker", () => {
  const { start, events } = scriptedMatch(9);
  const cut = Math.floor(events.length / 2);
  const live = replay(start, events.slice(0, cut));

  // What a reconnect sees: the rows in the tables (no record of our bids),
  // with our opening tiles worked out from the rack and our wins and words.
  const rows = events.slice(0, cut).filter((e) => e.type !== "bidSent");
  const won = new Uint8Array(NUM_LETTERS);
  const spent = new Uint8Array(NUM_LETTERS);
  let rack: Counts = start.opening;
  for (const e of rows) {
    if (e.type === "auctionClosed" && e.winner === start.me) won[e.letter]++;
    if (e.type === "wordPlayed" && e.bot === start.me) {
      const used = rackOf(e.word);
      for (let l = 0; l < NUM_LETTERS; l++) spent[l] += used[l]!;
    }
    if (e.type === "rackChanged") rack = e.rack;
  }
  const opening = deriveOpening(rack, won, spent);
  assert.deepEqual(opening, start.opening);
  const rebuilt = replay({ ...start, opening }, rows);

  assert.deepEqual(rebuilt.unseen, live.unseen);
  assert.equal(rebuilt.bagRemaining, live.bagRemaining);
  assert.equal(rebuilt.auctionsLeft, live.auctionsLeft);
  assert.deepEqual(rebuilt.rack, live.rack);
  assert.deepEqual(rebuilt.prices, live.prices);
  assert.deepEqual(rebuilt.rivals, live.rivals);
  assert.equal(rebuilt.coins, live.coins);
});
