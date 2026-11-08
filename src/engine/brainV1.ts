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

import { paramsFor, type Params, type Phase } from "../core/params.js";
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
  private readonly byPhase = new Map<Phase, Params>();

  /**
   * `phase` comes from the live tournament (tournament_match). Without it,
   * a 2-bot table is played as the final and anything else as Swiss.
   */
  constructor(
    private readonly index: WordIndex,
    private readonly params: Params,
    private readonly phase?: Phase,
  ) {
    this.ev = new Evaluator(index, params.evaluator);
    this.fallback = new FallbackBrain(index);
  }

  /** The params for this match's phase (public for tests). */
  phaseParams(s: Readonly<GameState>): Params {
    const phase = this.phase ?? (s.settings.numBots === 2 ? "final" : "swiss");
    let p = this.byPhase.get(phase);
    if (!p) {
      p = paramsFor(this.params, phase);
      this.byPhase.set(phase, p);
    }
    return p;
  }

  bidTable(s: Readonly<GameState>): Int32Array {
    const t = new Int32Array(NUM_LETTERS);
    // The last letter can't be played; a broke bot can't bid.
    if (s.ended || s.coins < 1 || (s.current !== null && s.bagRemaining === 0)) return t;

    const p = this.phaseParams(s);
    const base = this.fallback.bidTable(s);
    const ctx = evalContext(s, p.evaluator);
    const { values } = this.ev.letterValues(s.rack, ctx);
    const mu = Math.max(0.05, p.evaluator.coinValue * ctx.fade);
    const left = s.auctionsLeft;
    // Spread coins over what's left; everything goes in the last few auctions.
    const cap =
      left <= p.pacing.rampDownAuctions ? s.coins : Math.floor(s.coins * Math.min(1, p.pacing.spreadOver / left));

    let firstPriceCap = Number.POSITIVE_INFINITY;
    if (s.settings.auctionType === "FirstPrice") {
      let richest = 0;
      for (const r of s.rivals.values()) richest = Math.max(richest, r.coins);
      firstPriceCap = richest + p.bidding.firstPriceMargin;
    }

    for (let l = 0; l < NUM_LETTERS; l++) {
      const tier = TIER_OF[l]!;
      const recent = s.prices.count[tier]! >= 3 ? s.prices.ema[tier]! : 0;
      const fromValue = Math.min(cap, Math.round(values[l]! / mu));
      let bid = Math.max(base[l]!, fromValue);
      // Contest anything worth having at a fair share of the going price.
      if (p.bidding.contestFloor > 0 && values[l]! > 0) {
        bid = Math.max(bid, Math.min(cap, Math.round(recent * p.bidding.contestFloor)));
      }
      if (s.settings.auctionType === "FirstPrice") {
        // Paying our own bid: never more than needed to beat everyone who could bid.
        const ceiling = recent > 0 ? recent + p.bidding.firstPriceMargin : bid;
        bid = Math.min(bid, firstPriceCap, Math.round(ceiling));
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
