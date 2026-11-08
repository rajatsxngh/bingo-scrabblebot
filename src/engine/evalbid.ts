// M5's check, not a contender: bid each letter's value v(L), capped at our
// coins, and play words like the fallback. If the values mean anything,
// this beats the fallback in the simulator. M6 replaces it with Bingo v1
// (pacing, a reserve, first-price shading and a real word planner).

import type { Params } from "../core/params.js";
import { NUM_LETTERS } from "../core/rules.js";
import type { Brain, GameState } from "../core/types.js";
import type { WordIndex } from "../core/words.js";
import { Evaluator, evalContext } from "./evaluator.js";
import { FallbackBrain } from "./fallback.js";

export class EvalBidBrain implements Brain {
  readonly name = "evalbid";
  private readonly ev: Evaluator;
  private readonly words: FallbackBrain;

  constructor(index: WordIndex, private readonly params: Params) {
    this.ev = new Evaluator(index, params.evaluator);
    this.words = new FallbackBrain(index);
  }

  bidTable(s: Readonly<GameState>): Int32Array {
    const t = new Int32Array(NUM_LETTERS);
    // Nothing to gain from the last letter: it can't be played.
    if (s.ended || s.coins < 1 || (s.current !== null && s.bagRemaining === 0)) return t;
    const ctx = evalContext(s, this.params.evaluator);
    const { values } = this.ev.letterValues(s.rack, ctx);
    // Values are in points; bids are in coins. A coin is worth what it can
    // buy (coinValue points early, fading to nothing as the bag empties), so
    // a letter is worth v / μ coins. A simple cap stops it burning its coins early.
    const mu = Math.max(0.05, this.params.evaluator.coinValue * ctx.fade);
    const cap = s.auctionsLeft <= 8 ? s.coins : Math.floor(s.coins * Math.min(1, 14 / s.auctionsLeft));
    for (let l = 0; l < NUM_LETTERS; l++) {
      t[l] = Math.max(0, Math.min(s.coins, cap, Math.round(values[l]! / mu)));
    }
    return t;
  }

  planWords(s: Readonly<GameState>): string[] {
    return this.words.planWords(s);
  }
}
