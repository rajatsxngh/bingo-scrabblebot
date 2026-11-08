// The endgame split: during the last auction (whose letter can't be
// played), turn the whole rack into the highest-scoring set of words.
// Greedy (best word first, repeat) can waste letters; this tries each of the
// best few opening words, finishes greedily, and keeps the best total.

import { NUM_LETTERS, rackOf, reward } from "../core/rules.js";
import type { Counts } from "../core/types.js";
import { playable, type WordIndex } from "../core/words.js";
import { greedySplit } from "./fallback.js";

function minus(rack: Counts, word: string): Uint8Array {
  const left = Uint8Array.from(rack);
  const used = rackOf(word);
  for (let l = 0; l < NUM_LETTERS; l++) left[l] -= used[l]!;
  return left;
}

const total = (words: readonly string[]) => words.reduce((s, w) => s + reward(w), 0);

/** The best split found by trying the top `tries` opening words, each finished greedily. */
export function bestSplit(index: WordIndex, rack: Counts, tries = 25): string[] {
  let best = greedySplit(index, rack);
  let bestScore = total(best);
  // Candidate openers: the best-paying playable words of either length band.
  const openers = [
    ...playable(index.long, rack, tries).map((i) => index.long.words[i]!),
    ...playable(index.short, rack, tries).map((i) => index.short.words[i]!),
  ]
    .sort((a, b) => reward(b) - reward(a))
    .slice(0, tries);
  for (const first of openers) {
    const words = [first, ...greedySplit(index, minus(rack, first))];
    const score = total(words);
    if (score > bestScore) {
      best = words;
      bestScore = score;
    }
  }
  return best;
}
