// The fallback brain: simple and safe. It plays live until Bingo v1 passes
// its gate (M6), and it's what the live bot falls back to if a smarter brain
// throws. Bids: face value plus a premium, scaled by how well the letter fits
// the rack. Words: any 7+ letter word at once, a cash-in when coins run low,
// and a greedy split of the whole rack during the last auction.

import { IS_VOWEL, LETTER_VALUES, NUM_LETTERS, TIER_OF, rackOf } from "../core/rules.js";
import type { Brain, Counts, GameState } from "../core/types.js";
import { LONG_MIN, bestWord, type WordIndex } from "../core/words.js";

const S = 18;
const E = 4;
const Q = 16;
const U = 20;
/** Letters that sit in the most 7-letter words. */
const FLEXIBLE = new Set([..."AEINRSTLD"].map((c) => c.charCodeAt(0) - 65));

/** Splits the rack into words greedily, best word first, until nothing more can be spelled. */
export function greedySplit(index: WordIndex, rack: Counts): string[] {
  const left = Uint8Array.from(rack);
  const words: string[] = [];
  for (;;) {
    const best = bestWord(index, left);
    if (!best) return words;
    words.push(best.word);
    const used = rackOf(best.word);
    for (let l = 0; l < NUM_LETTERS; l++) left[l] -= used[l]!;
  }
}

export class FallbackBrain implements Brain {
  readonly name = "fallback";
  constructor(private readonly index: WordIndex) {}

  bidTable(s: Readonly<GameState>): Int32Array {
    const table = new Int32Array(NUM_LETTERS);
    if (s.ended || s.auctionsLeft <= 1) return table;
    let vowels = 0;
    for (let l = 0; l < NUM_LETTERS; l++) if (IS_VOWEL[l]) vowels += s.rack[l]!;
    const tiles = s.rackTiles;
    const left = s.auctionsLeft;
    // Spread coins over the auctions left, loosening as the bag empties:
    // coins are worthless once the match ends. (Live: bidding ~5 against
    // prices of ~13 won 3 of 68 letters and ended with 116 coins unspent.)
    const cap = left <= 10 ? s.coins : Math.max(1, Math.floor(s.coins * Math.min(1, 14 / left)));
    for (let l = 0; l < NUM_LETTERS; l++) {
      let want = LETTER_VALUES[l]! + 2 + (FLEXIBLE.has(l) ? 2 : 0);
      // For letters we want anyway, follow what this tier has been selling for.
      const tier = TIER_OF[l]!;
      if ((FLEXIBLE.has(l) || IS_VOWEL[l]) && s.prices.count[tier]! > 0) {
        want = Math.max(want, s.prices.ema[tier]! * 0.9);
      }
      const have = s.rack[l]!;
      if (have >= 2 && l !== S && l !== E) want *= 0.3;
      else if (have === 1 && l !== S && l !== E) want *= 0.7;
      if (IS_VOWEL[l]) {
        if (vowels * 2 < tiles - 1) want *= 1.4;
        else if (vowels * 2 > tiles + 1) want *= 0.5;
      }
      if (l === Q && s.rack[U] === 0) want *= 0.3;
      table[l] = Math.max(1, Math.min(cap, Math.round(want)));
    }
    return table;
  }

  planWords(s: Readonly<GameState>): string[] {
    if (s.ended) return [];
    // The last auction is open: its letter can't be played, so play everything now.
    if (s.current !== null && s.bagRemaining === 0) return greedySplit(this.index, s.rack);
    const best = bestWord(this.index, s.rack);
    if (!best) return [];
    if (best.word.length >= LONG_MIN) return [best.word];
    // Short on coins: cash a decent word so we can keep bidding.
    if (s.coins < 15 && best.word.length >= 4) return [best.word];
    return [];
  }
}
