// Game rules, copied from the ScrabbleBot module (spacetimedb/src/letters.ts
// and game.ts at upstream commit b5ccb36). Everything in the core indexes
// letters 0–25, with 'A' = 0.

import type { AuctionType, Counts, MatchSettings } from "./types.js";

export const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const NUM_LETTERS = 26;
const CODE_A = 65;

/** Standard Scrabble letter values (letters.ts `letterValue`). */
// prettier-ignore
export const LETTER_VALUES: readonly number[] = [
  // A  B  C  D  E  F  G  H  I  J  K  L  M  N  O  P  Q   R  S  T  U  V  W  X  Y  Z
     1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
];

/** Tiles of each letter in a fresh bag, no blanks (letters.ts `DEFAULT_BAG`). */
// prettier-ignore
export const BAG_COUNTS: readonly number[] = [
  // A  B  C  D  E   F  G  H  I  J  K  L  M  N  O  P  Q  R  S  T  U  V  W  X  Y  Z
     9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
];
export const BAG_SIZE = 98;

/** game.ts STARTING_BALANCE: every bot starts each match with 100 coins. */
export const STARTING_COINS = 100;
/** game.ts STARTING_RACK_SIZE: opening tiles dealt to each bot (admin can change it). */
export const DEFAULT_RACK_SIZE = 5;
/** game.ts AUCTION_DURATION_MS: the bidding window (admin can change it). */
export const DEFAULT_WINDOW_MS = 1000;
/** game.ts AUCTION_RESERVE: in a Vickrey auction a lone bidder pays this. */
export const LONE_BIDDER_PRICE = 1;

export const IS_VOWEL: readonly boolean[] = Array.from(ALPHABET, (c) =>
  "AEIOU".includes(c),
);

/**
 * Price tiers the PRD tracks prices by: 0 = 1-point letters, 1 = 2–3 points,
 * 2 = 4–5 points, 3 = 8–10 points (J, Q, X, Z).
 */
export const NUM_TIERS = 4;
export const TIER_OF: readonly number[] = LETTER_VALUES.map((v) =>
  v <= 1 ? 0 : v <= 3 ? 1 : v <= 5 ? 2 : 3,
);

/** Index of an uppercase letter ('A' = 0), or -1 if `ch` isn't one letter A–Z. */
export function letterIndex(ch: string): number {
  if (ch.length !== 1) return -1;
  const i = ch.charCodeAt(0) - CODE_A;
  return i >= 0 && i < NUM_LETTERS ? i : -1;
}

/** Letter counts for a word or rack written as letters, e.g. "AEINST". */
export function rackOf(letters: string): Counts {
  const counts = new Uint8Array(NUM_LETTERS);
  for (let k = 0; k < letters.length; k++) {
    const i = letters.charCodeAt(k) - CODE_A;
    if (i < 0 || i >= NUM_LETTERS) {
      throw new Error(`not an uppercase letter: '${letters[k]}' in '${letters}'`);
    }
    counts[i]++;
  }
  return counts;
}

/** The letters in `counts`, in alphabetical order, e.g. "AEINST". */
export function rackToString(counts: Counts): string {
  let s = "";
  for (let i = 0; i < NUM_LETTERS; i++) s += ALPHABET[i]!.repeat(counts[i]!);
  return s;
}

/** Total tiles in `counts`. */
export function tileCount(counts: Counts): number {
  let n = 0;
  for (let i = 0; i < NUM_LETTERS; i++) n += counts[i]!;
  return n;
}

/** Length multiplier as [numerator, denominator] (letters.ts `lengthMultiplier`). */
export function lengthMultiplier(len: number): [number, number] {
  if (len <= 3) return [1, 1];
  if (len === 4) return [3, 2];
  if (len === 5) return [2, 1];
  if (len === 6) return [5, 2];
  return [3, 1];
}

/** Sum of the word's letter values. */
export function baseScore(word: string): number {
  let sum = 0;
  for (let k = 0; k < word.length; k++) {
    sum += LETTER_VALUES[word.charCodeAt(k) - CODE_A] ?? 0;
  }
  return sum;
}

/**
 * What a word pays, added to both coins and score: letter sum × length
 * multiplier, rounded down (game.ts `playWord` uses integer division).
 */
export function reward(word: string): number {
  const [num, den] = lengthMultiplier(word.length);
  return Math.floor((baseScore(word) * num) / den);
}

/** Auctions in a match: what's left of the bag after every bot is dealt its opening rack. */
export function totalAuctions(numBots: number, rackSize: number): number {
  return Math.max(0, BAG_SIZE - numBots * rackSize);
}

/** Match settings with the derived fields filled in. */
export function matchSettings(opts: {
  auctionType: AuctionType;
  numBots: number;
  rackSize?: number;
  windowMs?: number;
  startingCoins?: number;
}): MatchSettings {
  const rackSize = opts.rackSize ?? DEFAULT_RACK_SIZE;
  return {
    auctionType: opts.auctionType,
    numBots: opts.numBots,
    rackSize,
    windowMs: opts.windowMs ?? DEFAULT_WINDOW_MS,
    startingCoins: opts.startingCoins ?? STARTING_COINS,
    totalAuctions: totalAuctions(opts.numBots, rackSize),
  };
}
