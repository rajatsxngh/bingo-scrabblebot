// One match, played rule for rule as the module does it (game.ts at
// upstream b5ccb36): deal from a 98-tile bag, one sealed-bid auction per
// remaining tile, highest bid wins with random tie-breaks, Vickrey pays the
// runner-up's bid (1 for a lone bidder) and first-price pays its own bid,
// unsold letters are thrown away, and the match ends the moment the last
// auction closes. Every bot sees only public events and its own rack,
// through its own copy of the M2 tracker, exactly as the live bot does.
//
// Timing model (the module has no turns; this is the closest fixed order):
// each auction opens, every bot may play words during its window (so coins
// from words land before that auction's bids; the last window is the
// endgame), then bots bid, then it closes. The module's own sim bots play
// their word inside the close, as the module does.

import { BAG_COUNTS, NUM_LETTERS, NUM_TIERS, TIER_OF, matchSettings, rackOf, reward } from "../core/rules.js";
import { Rng } from "../core/rng.js";
import { Tracker } from "../core/tracker.js";
import type { AuctionType, GameEvent } from "../core/types.js";
import type { WordIndex } from "../core/words.js";
import { isPlayerToken, makePlayer, type SimBrain } from "./opponents.js";

export interface MatchSpec {
  /** One entry per seat: a player token, or (in tests) a brain instance. */
  players: readonly (string | SimBrain)[];
  auctionType: AuctionType;
  rackSize?: number;
  /** Chance a bot that isn't `fastStart` misses the first auction (live today: it always sells). */
  slowStart?: number;
}

/** Decision-time histogram: 0.05 ms buckets up to 100 ms, then one overflow bucket. */
export const HIST_BUCKETS = 2001;
export const HIST_STEP_MS = 0.05;

export interface SeatResult {
  name: string;
  score: number;
  coins: number;
  /** 1 + bots that scored strictly more (tied bots share the higher place). */
  place: number;
  lettersWon: number;
  paidByTier: number[];
  wonByTier: number[];
  words: number;
  longWords: number;
  /** Bids refused for being above the balance. */
  overBalance: number;
  /** Words refused (not in the list, or not in the rack). */
  invalidWords: number;
  /** Bids on the last letter, which can't be played. */
  lastLetterBids: number;
  decisionHist: Uint32Array;
}

export interface MatchResult {
  seats: SeatResult[];
  auctions: number;
  unsold: number;
  firstUnsold: boolean;
  /** Prices paid for sold letters, by tier. */
  marketCount: number[];
  marketSum: number[];
}

export interface RunOptions {
  /** Called with every event, in order, as every bot's tracker sees it. */
  onEvent?: (e: GameEvent) => void;
  /** Racks left at the end, by seat (for tests). */
  finalRacks?: Uint8Array[];
}

interface Seat {
  id: number;
  brain: SimBrain;
  rack: Uint8Array;
  coins: number;
  score: number;
  tracker: Tracker;
  r: SeatResult;
}

export function runMatch(spec: MatchSpec, index: WordIndex, seed: number, opts: RunOptions = {}): MatchResult {
  const rng = new Rng(seed);
  const n = spec.players.length;
  const settings = matchSettings({ auctionType: spec.auctionType, numBots: n, rackSize: spec.rackSize });
  const slowStart = spec.slowStart ?? 0.1;

  // The module draws a uniformly random remaining tile each time: the same as
  // drawing from a shuffled bag.
  const bag: number[] = [];
  BAG_COUNTS.forEach((c, l) => {
    for (let k = 0; k < c; k++) bag.push(l);
  });
  rng.shuffle(bag);

  const ids = Array.from({ length: n }, (_, i) => i + 1);
  const seats: Seat[] = spec.players.map((p, i) => {
    const brainRng = new Rng(rng.int(0, 2 ** 31 - 1));
    let brain: SimBrain;
    if (typeof p === "string") {
      if (!isPlayerToken(p)) throw new Error(`unknown player '${p}'`);
      brain = makePlayer(p, index, brainRng);
    } else {
      brain = p;
    }
    return {
      id: ids[i]!,
      brain,
      rack: new Uint8Array(NUM_LETTERS),
      coins: settings.startingCoins,
      score: 0,
      tracker: undefined as unknown as Tracker,
      r: {
        name: typeof p === "string" ? p : brain.name,
        score: 0,
        coins: 0,
        place: 0,
        lettersWon: 0,
        paidByTier: new Array(NUM_TIERS).fill(0),
        wonByTier: new Array(NUM_TIERS).fill(0),
        words: 0,
        longWords: 0,
        overBalance: 0,
        invalidWords: 0,
        lastLetterBids: 0,
        decisionHist: new Uint32Array(HIST_BUCKETS),
      },
    };
  });

  // Deal in seat order, as startMatchWith does.
  for (const s of seats) {
    for (let k = 0; k < settings.rackSize && bag.length > 0; k++) s.rack[bag.pop()!]++;
  }
  for (const s of seats) {
    s.tracker = new Tracker({ settings, me: s.id, bots: ids, opening: Uint8Array.from(s.rack) });
  }

  const emit = (e: GameEvent) => {
    for (const s of seats) s.tracker.apply(e);
    opts.onEvent?.(e);
  };
  const money = (s: Seat) => emit({ type: "balanceChanged", bot: s.id, coins: s.coins, score: s.score });
  const rackEvent = (s: Seat) => s.tracker.apply({ type: "rackChanged", rack: s.rack });
  const timed = <T>(s: Seat, f: () => T): T => {
    const t0 = performance.now();
    const out = f();
    const b = Math.min(HIST_BUCKETS - 1, Math.floor((performance.now() - t0) / HIST_STEP_MS));
    s.r.decisionHist[b]++;
    return out;
  };

  let wordId = 1;
  const play = (s: Seat, raw: string) => {
    const word = raw.toUpperCase();
    if (!index.isWord(word)) {
      s.r.invalidWords++;
      return;
    }
    const used = rackOf(word);
    for (let l = 0; l < NUM_LETTERS; l++) {
      if (used[l]! > s.rack[l]!) {
        s.r.invalidWords++;
        return;
      }
    }
    for (let l = 0; l < NUM_LETTERS; l++) s.rack[l] -= used[l]!;
    const r = reward(word);
    s.coins += r;
    s.score += r;
    s.r.words++;
    if (word.length >= 7) s.r.longWords++;
    emit({ type: "wordPlayed", id: wordId++, bot: s.id, word, reward: r });
    money(s);
    rackEvent(s);
  };

  const result: MatchResult = {
    seats: [],
    auctions: 0,
    unsold: 0,
    firstUnsold: false,
    marketCount: new Array(NUM_TIERS).fill(0),
    marketSum: new Array(NUM_TIERS).fill(0),
  };

  for (let k = 0; bag.length > 0; k++) {
    const auctionId = k + 1;
    const letter = bag.pop()!;
    const last = bag.length === 0;
    result.auctions++;
    emit({ type: "auctionOpened", auctionId, letter });

    // The window is open: anyone may play words (the last window is the endgame).
    for (const s of rng.shuffle([...seats])) {
      for (const w of timed(s, () => s.brain.planWords(s.tracker.state))) play(s, w);
    }

    const bids: { s: Seat; amount: number }[] = [];
    for (const s of seats) {
      if (k === 0 && !s.brain.fastStart && rng.chance(slowStart)) continue;
      const table = timed(s, () => s.brain.bidTable(s.tracker.state));
      const amount = Math.max(0, Math.floor(table[letter] ?? 0));
      if (amount === 0) continue;
      if (amount > s.coins) {
        s.r.overBalance++; // the module refuses it: "Insufficient balance"
        continue;
      }
      if (last) s.r.lastLetterBids++;
      bids.push({ s, amount });
      s.tracker.apply({ type: "bidSent", auctionId, amount });
    }

    // closeAuction: shuffle, then a stable sort by amount, so ties are random.
    rng.shuffle(bids);
    bids.sort((a, b) => b.amount - a.amount);
    const top = bids[0];
    let winner: Seat | null = null;
    let paid = 0;
    if (top) {
      winner = top.s;
      paid =
        spec.auctionType === "FirstPrice" ? top.amount : bids[1] ? bids[1].amount : Math.min(1, top.amount);
      if (winner.coins >= paid) {
        winner.coins -= paid;
        winner.rack[letter]++;
        winner.r.lettersWon++;
        winner.r.paidByTier[TIER_OF[letter]!] += paid;
        winner.r.wonByTier[TIER_OF[letter]!]++;
        result.marketCount[TIER_OF[letter]!]++;
        result.marketSum[TIER_OF[letter]!] += paid;
      }
    } else {
      result.unsold++;
      if (k === 0) result.firstUnsold = true;
    }
    emit({ type: "auctionClosed", auctionId, letter, winner: winner?.id ?? null, paid });
    if (winner) {
      money(winner);
      rackEvent(winner);
      // The module's own sim bots cash a word inside the close, even off the last letter.
      if (winner.brain.afterWin) for (const w of winner.brain.afterWin(winner.tracker.state)) play(winner, w);
    }
  }
  emit({ type: "matchEnded" });

  for (const s of seats) {
    s.r.score = s.score;
    s.r.coins = s.coins;
    s.r.place = 1 + seats.filter((o) => o.score > s.score).length;
    result.seats.push(s.r);
  }
  if (opts.finalRacks) for (const s of seats) opts.finalRacks.push(Uint8Array.from(s.rack));
  return result;
}

/** A per-match seed from the run seed and the match number, independent of how matches are split across workers. */
export function matchSeed(seed: number, match: number): number {
  let x = (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(match + 1, 0xc2b2ae35)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}
