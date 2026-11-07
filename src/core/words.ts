// The word list as two typed-array indexes built for fast rack queries:
// long words (7–10 letters) are the targets worth saving letters for, and
// short words (2–6 letters) are for cashing in and the endgame. Words of 11+
// letters are valid to play but too rare to plan for, so they only appear in
// the validity check.

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { NUM_LETTERS, reward as wordReward, tileCount } from "./rules.js";
import type { Counts } from "./types.js";

export const DEFAULT_WORDLIST_PATH = fileURLToPath(
  new URL("../../data/wordlist.txt", import.meta.url),
);

export const LONG_MIN = 7;
export const LONG_MAX = 10;
export const SHORT_MIN = 2;
export const SHORT_MAX = 6;

/**
 * A set of words stored as typed arrays, sorted by reward (highest first),
 * then by length (shortest first: same pay for fewer tiles), then A–Z.
 */
export interface WordSet {
  readonly size: number;
  readonly words: readonly string[];
  /** Dense letter counts: word i needs counts[i * 26 + l] of letter l. */
  readonly counts: Uint8Array;
  readonly reward: Uint16Array;
  readonly length: Uint8Array;
  /**
   * The same counts, sparse, for fast scans: word i's distinct letters are
   * letters[start[i] .. start[i + 1]), and it needs mult[p] of letters[p].
   */
  readonly start: Uint32Array;
  readonly letters: Uint8Array;
  readonly mult: Uint8Array;
}

export interface WordIndex {
  /** 7–10 letter words. */
  readonly long: WordSet;
  /** 2–6 letter words. */
  readonly short: WordSet;
  /** Every word in the list, any length. */
  readonly totalWords: number;
  /** Whether the module accepts `word`: 2+ letters and in the list (any case). */
  isWord(word: string): boolean;
}

function buildSet(words: readonly string[]): WordSet {
  const items = words.map((w) => ({ w, r: wordReward(w) }));
  items.sort(
    (a, b) =>
      b.r - a.r ||
      a.w.length - b.w.length ||
      (a.w < b.w ? -1 : a.w > b.w ? 1 : 0),
  );
  const size = items.length;
  const counts = new Uint8Array(size * NUM_LETTERS);
  const reward = new Uint16Array(size);
  const length = new Uint8Array(size);
  let distinct = 0;
  for (let i = 0; i < size; i++) {
    const { w, r } = items[i]!;
    const base = i * NUM_LETTERS;
    for (let k = 0; k < w.length; k++) {
      const l = base + w.charCodeAt(k) - 65;
      if (counts[l] === 0) distinct++;
      counts[l]++;
    }
    reward[i] = r;
    length[i] = w.length;
  }
  const start = new Uint32Array(size + 1);
  const letters = new Uint8Array(distinct);
  const mult = new Uint8Array(distinct);
  let p = 0;
  for (let i = 0; i < size; i++) {
    start[i] = p;
    const base = i * NUM_LETTERS;
    for (let l = 0; l < NUM_LETTERS; l++) {
      const c = counts[base + l]!;
      if (c > 0) {
        letters[p] = l;
        mult[p] = c;
        p++;
      }
    }
  }
  start[size] = p;
  const sorted = items.map((x) => x.w);
  return { size, words: sorted, counts, reward, length, start, letters, mult };
}

/** Builds the index from word-list lines (any case; blank lines ignored). */
export function buildWordIndex(lines: Iterable<string>): WordIndex {
  const all = new Set<string>();
  const long: string[] = [];
  const short: string[] = [];
  for (const line of lines) {
    const w = line.trim().toUpperCase();
    if (w.length < SHORT_MIN || !/^[A-Z]+$/.test(w) || all.has(w)) continue;
    all.add(w);
    if (w.length <= SHORT_MAX) short.push(w);
    else if (w.length <= LONG_MAX) long.push(w);
  }
  return {
    long: buildSet(long),
    short: buildSet(short),
    totalWords: all.size,
    isWord: (word) => all.has(word.toUpperCase()),
  };
}

export function loadWordIndex(path = DEFAULT_WORDLIST_PATH): WordIndex {
  return buildWordIndex(fs.readFileSync(path, "utf8").split("\n"));
}

let cached: WordIndex | undefined;

/** The index for data/wordlist.txt, loaded once per process. */
export function wordIndex(): WordIndex {
  return (cached ??= loadWordIndex());
}

/** Whether the rack holds every letter word i needs. */
export function canSpell(set: WordSet, i: number, rack: Counts): boolean {
  const { start, letters, mult } = set;
  for (let p = start[i]!, end = start[i + 1]!; p < end; p++) {
    if (mult[p]! > rack[letters[p]!]!) return false;
  }
  return true;
}

/** How many more tiles word i needs beyond the rack (0 = playable now). */
export function deficit(set: WordSet, i: number, rack: Counts): number {
  const { start, letters, mult } = set;
  let need = 0;
  for (let p = start[i]!, end = start[i + 1]!; p < end; p++) {
    const d = mult[p]! - rack[letters[p]!]!;
    if (d > 0) need += d;
  }
  return need;
}

/** Fills `out` (26 counts) with the letters word i still needs; returns how many. */
export function missingLetters(
  set: WordSet,
  i: number,
  rack: Counts,
  out: Counts,
): number {
  const { start, letters, mult } = set;
  out.fill(0);
  let need = 0;
  for (let p = start[i]!, end = start[i + 1]!; p < end; p++) {
    const l = letters[p]!;
    const d = mult[p]! - rack[l]!;
    if (d > 0) {
      out[l] = d;
      need += d;
    }
  }
  return need;
}

/** One pass over the whole set: out[i] = how many tiles word i still needs. */
export function deficits(set: WordSet, rack: Counts, out: Uint8Array): void {
  const { start, letters, mult } = set;
  let p = 0;
  for (let i = 0; i < set.size; i++) {
    const end = start[i + 1]!;
    let need = 0;
    for (; p < end; p++) {
      const d = mult[p]! - rack[letters[p]!]!;
      if (d > 0) need += d;
    }
    out[i] = need;
  }
}

/** Indices of the words the rack can spell, in the set's order (best reward first). */
export function playable(
  set: WordSet,
  rack: Counts,
  limit = Number.POSITIVE_INFINITY,
): number[] {
  const tiles = tileCount(rack);
  const out: number[] = [];
  for (let i = 0; i < set.size && out.length < limit; i++) {
    if (set.length[i]! <= tiles && canSpell(set, i, rack)) out.push(i);
  }
  return out;
}

/** The best-paying word the rack can spell (2–10 letters; fewer tiles on a tie), or null. */
export function bestWord(
  index: WordIndex,
  rack: Counts,
): { word: string; reward: number } | null {
  let best: { word: string; reward: number } | null = null;
  for (const set of [index.short, index.long]) {
    const [i] = playable(set, rack, 1);
    if (i === undefined) continue;
    const r = set.reward[i]!;
    if (best === null || r > best.reward) best = { word: set.words[i]!, reward: r };
  }
  return best;
}
