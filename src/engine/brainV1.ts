// Bingo v1. Built on what M4–M5 proved in the simulator:
//
// Bids: the larger of the fallback's market-following bid (which wins by
// volume: cheap common letters near the going price) and the evaluator's
// v / μ (which sees what the fallback can't: high-value letters that make
// big words, letters that complete a target, the exact endgame). μ is what a
// coin is worth in points; it fades to 0 as the bag empties, since leftover
// coins are worthless. A pacing cap spreads coins over the auctions left.
// First-price uses the PRD's safe rule until M8: never more than one coin
// above the richest rival, nor than the recent price for that tier.
//
// Words: the fallback's rules (7+ letter words at once, cash in when short
// of coins), plus a better endgame split during the last auction.

import type { Params } from "../core/params.js";
import { NUM_LETTERS, TIER_OF } from "../core/rules.js";
import type { Brain, GameState } from "../core/types.js";
import type { WordIndex } from "../core/words.js";
import { Evaluator, evalContext } from "./evaluator.js";
import { FallbackBrain } from "./fallback.js";
import { bestSplit } from "./planner.js";

export class BingoV1 implements Brain {
  readonly name = "v1";
  private readonly ev: Evaluator;
  private readonly fallback: FallbackBrain;

  constructor(
    private readonly index: WordIndex,
    private readonly params: Params,
  ) {
    this.ev = new Evaluator(index, params.evaluator);
    this.fallback = new FallbackBrain(index);
  }

  bidTable(s: Readonly<GameState>): Int32Array {
    const t = new Int32Array(NUM_LETTERS);
    // The last letter can't be played; a broke bot can't bid.
    if (s.ended || s.coins < 1 || (s.current !== null && s.bagRemaining === 0)) return t;

    const base = this.fallback.bidTable(s);
    const ctx = evalContext(s, this.params.evaluator);
    const { values } = this.ev.letterValues(s.rack, ctx);
    const mu = Math.max(0.05, this.params.evaluator.coinValue * ctx.fade);
    const left = s.auctionsLeft;
    const ramp = this.params.pacing.rampDownAuctions;
    // Spread coins over what's left; everything goes in the last few auctions.
    const cap = left <= ramp ? s.coins : Math.floor(s.coins * Math.min(1, 14 / left));

    let firstPriceCap = Number.POSITIVE_INFINITY;
    if (s.settings.auctionType === "FirstPrice") {
      let richest = 0;
      for (const r of s.rivals.values()) richest = Math.max(richest, r.coins);
      firstPriceCap = richest + this.params.bidding.firstPriceMargin;
    }

    for (let l = 0; l < NUM_LETTERS; l++) {
      const fromValue = Math.min(cap, Math.round(values[l]! / mu));
      let bid = Math.max(base[l]!, fromValue);
      if (s.settings.auctionType === "FirstPrice") {
        // Paying our own bid: never more than needed to beat everyone who could bid.
        const tier = TIER_OF[l]!;
        const recent = s.prices.count[tier]! >= 3 ? s.prices.ema[tier]! : bid;
        bid = Math.min(bid, firstPriceCap, Math.round(recent + this.params.bidding.firstPriceMargin));
      }
      t[l] = Math.max(0, Math.min(s.coins, bid));
    }
    return t;
  }

  planWords(s: Readonly<GameState>): string[] {
    if (s.ended) return [];
    // Last auction: its letter can't be played, so play the whole rack as well as we can.
    if (s.current !== null && s.bagRemaining === 0) return bestSplit(this.index, s.rack);
    return this.fallback.planWords(s);
  }
}
