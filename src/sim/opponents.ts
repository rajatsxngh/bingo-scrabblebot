// The opponents Bingo is tested against. The module's own sim bots and the
// starter kit are copied exactly; the three top-bot styles are modelled on
// what the PRD saw in live matches, with each copy's prices drawn from a
// range so tuning doesn't fit one fixed opponent.

import { BAG_COUNTS, BAG_SIZE, IS_VOWEL, LETTER_VALUES, NUM_LETTERS, TIER_OF, tileCount } from "../core/rules.js";
import type { Rng } from "../core/rng.js";
import type { Brain, Counts, GameState } from "../core/types.js";
import { bestWord, buildWordSet, canSpell, type WordIndex, type WordSet } from "../core/words.js";
import { loadParams, type Params } from "../core/params.js";
import { BingoV1 } from "../engine/brainV1.js";
import { EvalBidBrain } from "../engine/evalbid.js";
import { FallbackBrain, greedySplit } from "../engine/fallback.js";

let cachedParams: Params | undefined;

/** Bingo's params for this run: run.ts --params sets BINGO_PARAMS, and workers inherit it. */
function bingoParams(): Params {
  return (cachedParams ??= process.env.BINGO_PARAMS ? loadParams(process.env.BINGO_PARAMS) : loadParams());
}

/** A brain plus the two things only the simulator needs to know about it. */
export interface SimBrain extends Brain {
  /** Words played the instant this bot wins a letter (the module's own sim bots do this). */
  afterWin?(s: Readonly<GameState>): string[];
  /** Bids on the first auction without fail. Others may react too late (see `slowStart`). */
  readonly fastStart?: boolean;
}

const S = 18;
const E = 4;
const Q = 16;
const U = 20;

// ---------- Shared helpers ----------

const byLengthCache = new WeakMap<WordIndex, WordSet>();

/**
 * The module's findBestPlayable (dictionary.ts): the longest word the rack can
 * spell, alphabetically first among equals, with at least `minLen` letters.
 * Unlike our indexes it includes 11+ letter words.
 */
export function longestWord(index: WordIndex, rack: Counts, minLen: number): string | null {
  let set = byLengthCache.get(index);
  if (!set) {
    set = buildWordSet(index.allWords, "length");
    byLengthCache.set(index, set);
  }
  const total = tileCount(rack);
  if (total < minLen) return null;
  for (let i = 0; i < set.size; i++) {
    const len = set.length[i]!;
    if (len < minLen) break;
    if (len > total) continue;
    if (canSpell(set, i, rack)) return set.words[i]!;
  }
  return null;
}

const affinityCache = new WeakMap<WordIndex, Float64Array>();

/**
 * How much more often each letter appears in 7-letter words than in the bag
 * (S is about 2.3). The cheap "is this letter useful" signal the copies use.
 */
export function bingoAffinity(index: WordIndex): Float64Array {
  let a = affinityCache.get(index);
  if (a) return a;
  const counts = new Float64Array(NUM_LETTERS);
  let letters = 0;
  const { long } = index;
  for (let i = 0; i < long.size; i++) {
    if (long.length[i] !== 7) continue;
    for (let l = 0; l < NUM_LETTERS; l++) counts[l] += long.counts[i * NUM_LETTERS + l]!;
    letters += 7;
  }
  a = new Float64Array(NUM_LETTERS);
  for (let l = 0; l < NUM_LETTERS; l++) a[l] = counts[l]! / letters / (BAG_COUNTS[l]! / BAG_SIZE);
  affinityCache.set(index, a);
  return a;
}

/** How well letter `l` fits the rack: its affinity, cut for duplicates, lopsided vowels and a Q without U. */
export function fit(rack: Counts, l: number, affinity: Float64Array): number {
  let f = affinity[l]!;
  const have = rack[l]!;
  if (have > 0 && l !== S && l !== E) f *= have >= 2 ? 0.25 : 0.6;
  let vowels = 0;
  let tiles = 0;
  for (let k = 0; k < NUM_LETTERS; k++) {
    tiles += rack[k]!;
    if (IS_VOWEL[k]) vowels += rack[k]!;
  }
  if (IS_VOWEL[l]) {
    if (vowels * 2 > tiles + 1) f *= 0.5;
    else if (vowels * 2 < tiles - 1) f *= 1.4;
  } else if (vowels * 2 < tiles - 1) {
    f *= 0.7;
  }
  if (l === Q && rack[U] === 0) f *= 0.3;
  return f;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * How keen a top bot is on a letter, 0–1. The live field pays for points as
 * well as fit (Z, Q and X sold near 27, Y for 28), so letters worth 4+ points
 * stay wanted even when they're rare in 7-letter words.
 */
function keenness(rack: Counts, l: number, affinity: Float64Array): number {
  const f = fit(rack, l, affinity);
  return TIER_OF[l]! >= 2 ? clamp(0.6 + 0.4 * f, 0.7, 1) : clamp(f / 1.6, 0, 1);
}
const isLastAuction = (s: Readonly<GameState>) => s.current !== null && s.bagRemaining === 0;

/**
 * Most a top bot will pay for one letter: its coins spread over what's left,
 * loosening to everything over the last 8 auctions. Without pacing the copies
 * burned their coins early, then couldn't bid while a hoarder took the late
 * letters cheaply; live winners end with a few coins, not none.
 */
function pacedCap(s: Readonly<GameState>, l: number): number {
  if (s.auctionsLeft <= 8) return s.coins;
  // Valuable letters get a bigger share: the live field paid ~27 for Z, Q and X even early.
  const allowance = [1, 1.2, 1.6, 2.4][TIER_OF[l]!]!;
  return Math.min(s.coins, Math.floor(s.coins * Math.min(1, (12 * allowance) / s.auctionsLeft)));
}

// ---------- The module's sim bots (game.ts decideBid / simulateWordPlay) ----------

export type SimStrategy = "Cheapskate" | "ValueBidder" | "Aggressive";

export class ModuleSimBot implements SimBrain {
  readonly name: string;
  readonly fastStart = true; // they bid inside the transaction that opens the auction

  constructor(
    private readonly strategy: SimStrategy,
    private readonly index: WordIndex,
    private readonly rng: Rng,
  ) {
    this.name = `sim-${strategy}`;
  }

  /** One jitter in −2..2 per auction, as simulateBids draws it. */
  bidTable(s: Readonly<GameState>): Int32Array {
    const t = new Int32Array(NUM_LETTERS);
    const jitter = this.rng.int(-2, 2);
    for (let l = 0; l < NUM_LETTERS; l++) {
      const value = LETTER_VALUES[l]!;
      const base =
        this.strategy === "Cheapskate" ? value - 1 : this.strategy === "ValueBidder" ? value : value + (IS_VOWEL[l] ? 4 : 2);
      t[l] = Math.max(Math.min(Math.max(base + jitter, 1), s.coins), 0);
    }
    return t;
  }

  planWords(): string[] {
    return [];
  }

  /** The longest 3+ letter word, right after each win. */
  afterWin(s: Readonly<GameState>): string[] {
    const w = longestWord(this.index, s.rack, 3);
    return w ? [w] : [];
  }
}

// ---------- The starter kit (bot-starter/src/strategy.ts) ----------

export class StarterBot implements SimBrain {
  readonly name = "starter";
  constructor(private readonly index: WordIndex) {}

  /** Face value + 2 for a letter it doesn't have yet, face value otherwise. */
  bidTable(s: Readonly<GameState>): Int32Array {
    const t = new Int32Array(NUM_LETTERS);
    for (let l = 0; l < NUM_LETTERS; l++) {
      const value = LETTER_VALUES[l]!;
      const want = s.rack[l] === 0 ? value + 2 : Math.max(1, value);
      t[l] = Math.min(want, Math.max(0, s.coins));
    }
    return t;
  }

  /** The longest word it can spell, on every rack change (even 2-letter words). */
  planWords(s: Readonly<GameState>): string[] {
    const w = longestWord(this.index, s.rack, 2);
    return w ? [w] : [];
  }
}

// ---------- Top-bot styles, from the PRD's live matches ----------

/**
 * Shared word play for the saving styles: long words at once, the whole rack
 * at the end, and a cash-in whenever coins run low. Live top bots keep their
 * coins up this way (RackMaw: HOSED, SWAYED, then JANIFORM for 60); without
 * it the copies went broke and stopped bidding late.
 */
function saverWords(index: WordIndex, s: Readonly<GameState>, cashBelow: number): string[] {
  if (isLastAuction(s)) return greedySplit(index, s.rack);
  const best = bestWord(index, s.rack);
  if (!best) return [];
  if (best.word.length >= 7) return [best.word];
  if (s.coins < cashBelow && best.word.length >= 5) return [best.word];
  if (s.coins < cashBelow / 2 && best.word.length >= 4) return [best.word];
  return [];
}

/**
 * Like Bron: saves for 7+ letter words, pays about 7–15 for 1-point letters
 * and 17–22 for 3–4 point ones depending on fit, keeps a small reserve, and
 * cashes one 5–6 letter word early to fund its buying.
 */
export class ValueSaverBot implements SimBrain {
  readonly name = "bron";
  private readonly bands: [number, number][];
  private cashedEarly = false;
  private readonly affinity: Float64Array;

  constructor(private readonly index: WordIndex, rng: Rng) {
    this.affinity = bingoAffinity(index);
    // Live, 1-point letters sold for 9+ three times in four, and the winning
    // bid often sat far above the price (top bids of 19–28 on 1-point letters
    // in match 43025), so the bands are wide at the top.
    this.bands = [
      [rng.int(8, 10), rng.int(16, 21)],
      [rng.int(10, 12), rng.int(19, 24)],
      [rng.int(13, 15), rng.int(22, 28)],
      [rng.int(20, 24), rng.int(32, 38)],
    ];
  }

  bidTable(s: Readonly<GameState>): Int32Array {
    const t = new Int32Array(NUM_LETTERS);
    if (s.auctionsLeft <= 1) return t;
    const budget = s.coins;
    for (let l = 0; l < NUM_LETTERS; l++) {
      const k = keenness(s.rack, l, this.affinity);
      const [lo, hi] = this.bands[TIER_OF[l]!]!;
      t[l] = Math.min(Math.round(lo + (hi - lo) * k), budget, pacedCap(s, l));
    }
    return t;
  }

  planWords(s: Readonly<GameState>): string[] {
    if (!this.cashedEarly && !isLastAuction(s) && s.auctionsClosed >= 6) {
      const best = bestWord(this.index, s.rack);
      if (best && best.word.length >= 5 && best.word.length <= 6) {
        this.cashedEarly = true;
        return [best.word];
      }
    }
    return saverWords(this.index, s, 20);
  }
}

/**
 * Like K-13: bids on nearly every letter (flat and high for the first dozen
 * auctions, then 10–25 by fit, more for high-value letters) and plays long words.
 * Its "30 early" was in a head-to-head final; in 6-bot tables it's toned down.
 */
export class BidsEverythingBot implements SimBrain {
  readonly name = "k13";
  private readonly early: number;
  private readonly lateLo: number;
  private readonly lateHi: number;
  private readonly affinity: Float64Array;

  constructor(private readonly index: WordIndex, rng: Rng) {
    this.affinity = bingoAffinity(index);
    this.early = rng.int(14, 22);
    this.lateLo = rng.int(9, 12);
    this.lateHi = rng.int(22, 28);
  }

  bidTable(s: Readonly<GameState>): Int32Array {
    const t = new Int32Array(NUM_LETTERS);
    if (s.auctionsLeft <= 1 || s.coins < 1) return t;
    const cap = s.coins;
    const tierBoost = [1, 1.2, 1.4, 2];
    for (let l = 0; l < NUM_LETTERS; l++) {
      const k = keenness(s.rack, l, this.affinity);
      let bid = s.auctionsClosed < 12 ? this.early : this.lateLo + (this.lateHi - this.lateLo) * k;
      bid *= tierBoost[TIER_OF[l]!]!;
      t[l] = Math.min(Math.max(1, Math.round(bid)), cap, Math.max(1, pacedCap(s, l)));
    }
    return t;
  }

  planWords(s: Readonly<GameState>): string[] {
    return saverWords(this.index, s, 25);
  }
}

/**
 * Like TileShark: skips most letters and pays heavily (24–36) for the few it
 * wants most. In the PRD's final it paid 36 for a W, 31 for a V and 28 for a
 * Y, so points count as well as fit.
 */
export class SelectiveBot implements SimBrain {
  readonly name = "tileshark";
  private readonly hi: number;
  private readonly topK: number;
  private readonly affinity: Float64Array;

  constructor(private readonly index: WordIndex, rng: Rng) {
    this.affinity = bingoAffinity(index);
    this.hi = rng.int(24, 36);
    this.topK = rng.int(3, 5);
  }

  bidTable(s: Readonly<GameState>): Int32Array {
    const t = new Int32Array(NUM_LETTERS);
    if (s.auctionsLeft <= 1) return t;
    const want = Array.from(
      { length: NUM_LETTERS },
      (_, l) => fit(s.rack, l, this.affinity) * Math.sqrt(LETTER_VALUES[l]!),
    );
    const threshold = [...want].sort((a, b) => b - a)[this.topK - 1]!;
    for (let l = 0; l < NUM_LETTERS; l++) {
      if (want[l]! < threshold || want[l]! < 1.1) continue;
      // It saves for these few, so it may spend up to half its coins on one.
      t[l] = Math.min(Math.round(this.hi * clamp(want[l]! / 3, 0.6, 1)), Math.max(pacedCap(s, l), Math.floor(s.coins / 2)));
    }
    return t;
  }

  planWords(s: Readonly<GameState>): string[] {
    return saverWords(this.index, s, 25);
  }
}

// ---------- Registry ----------

export const PLAYER_TOKENS = [
  "bingo",
  "fallback",
  "evalbid",
  "v1",
  "starter",
  "sim",
  "cheap",
  "value",
  "aggro",
  "bron",
  "k13",
  "tileshark",
] as const;
export type PlayerToken = (typeof PLAYER_TOKENS)[number];

export function isPlayerToken(t: string): t is PlayerToken {
  return (PLAYER_TOKENS as readonly string[]).includes(t);
}

/** Builds a fresh player for one match. "bingo" is Bingo's best brain so far (v1 since M6). */
export function makePlayer(token: PlayerToken, index: WordIndex, rng: Rng): SimBrain {
  switch (token) {
    case "fallback":
      return Object.assign(new FallbackBrain(index), { fastStart: true });
    case "evalbid":
      return Object.assign(new EvalBidBrain(index, bingoParams()), { fastStart: true });
    case "bingo": // Bingo's best brain so far: v1 since it passed M6's gate
    case "v1":
      return Object.assign(new BingoV1(index, bingoParams()), { fastStart: true });
    case "starter":
      return new StarterBot(index);
    case "sim":
      return new ModuleSimBot(rng.pick(["Cheapskate", "ValueBidder", "Aggressive"] as const), index, rng);
    case "cheap":
      return new ModuleSimBot("Cheapskate", index, rng);
    case "value":
      return new ModuleSimBot("ValueBidder", index, rng);
    case "aggro":
      return new ModuleSimBot("Aggressive", index, rng);
    case "bron":
      return new ValueSaverBot(index, rng);
    case "k13":
      return new BidsEverythingBot(index, rng);
    case "tileshark":
      return new SelectiveBot(index, rng);
  }
}
