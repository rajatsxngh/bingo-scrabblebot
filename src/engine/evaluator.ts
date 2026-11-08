// The rack evaluator: what each letter is worth to us.
//
//   v(L) = V(R ∪ {L}) − V(R)
//
// V(R) is built from the rack's best 7–10 letter targets. Each is worth
// P × (reward − cost of its missing letters at recent prices), where P is the
// chance of getting those letters in time: the rest of the bag is a random
// subset of every tile we haven't seen (rivals' hidden tiles included), so
// the copies of a letter that come up follow a hypergeometric distribution
// over (unseen pool, auctions left), and we win each one with our contested
// win rate. Letters are treated as independent.
//
// The best few targets combine as a cascade: the second counts only if the
// first fails, and so on. So a flexible rack is worth more than a one-word
// rack, but never more than one word pays. (The PRD's fixed 1 / 0.5 / 0.25
// weights added up overlapping chances: AEINST came out worth 32, more than
// any one of its 7-letter words, so a letter that completed one was valued
// at about 2.) params.evaluator.targetWeights scales each cascade step.
//
// V(R) never drops below what the rack would score if played now (its
// floor), so late in the match values agree with the endgame. Small
// penalties for duplicates and lopsided vowels fade out as the match ends.
//
// All 26 values come from one pass over the targets: each target's chance is
// worked out once, then improved for each letter it's missing.

import type { Params } from "../core/params.js";
import { IS_VOWEL, NUM_LETTERS, TIER_OF, rackOf, reward } from "../core/rules.js";
import type { Counts, GameState } from "../core/types.js";
import { buildWordSet, deficits, type WordIndex, type WordSet } from "../core/words.js";
import { greedySplit } from "./fallback.js";

/** Most copies of one letter a target may still need. */
const MAXM = 4;
const M1 = MAXM + 1;
const S = 18;
const E = 4;
/** Below this many future auctions the floor includes a greedy split of the whole rack, not just the best word. */
const FULL_FLOOR_BELOW = 25;
/** Penalties fade to 0 over the last this-many auctions. */
const FADE_OVER = 20;

const LOGF = new Float64Array(99);
for (let i = 1; i <= 98; i++) LOGF[i] = LOGF[i - 1]! + Math.log(i);
const logC = (n: number, k: number) => (k < 0 || k > n ? -Infinity : LOGF[n]! - LOGF[k]! - LOGF[n - k]!);

const targetCache = new WeakMap<WordIndex, WordSet>();

/** One 7–10 letter word per distinct letter set: anagrams share letters and reward, so they're one target. */
export function targetSet(index: WordIndex): WordSet {
  let t = targetCache.get(index);
  if (!t) {
    const seen = new Set<string>();
    const reps: string[] = [];
    for (const w of index.long.words) {
      const key = [...w].sort().join("");
      if (!seen.has(key)) {
        seen.add(key);
        reps.push(w);
      }
    }
    t = buildWordSet(reps, "reward");
    targetCache.set(index, t);
  }
  return t;
}

/** Live prices by tier (1-point, 2–3, 4–5, 8–10), for before a match has prices of its own. */
export const DEFAULT_TIER_PRICES = [10.4, 13.4, 17.3, 28.8];

/** What each letter is expected to cost at auction, from prices by tier. */
export function letterCosts(tierPrices: readonly number[]): Float64Array {
  return Float64Array.from({ length: NUM_LETTERS }, (_, l) => tierPrices[TIER_OF[l]!]!);
}

export interface EvalContext {
  /** probs[l * 5 + m]: the chance we get m more copies of letter l in time (m = 0 is 1). */
  readonly probs: Float64Array;
  /** Expected price of each letter at auction. */
  readonly cost: Float64Array;
  /** Auctions after the one being valued whose letters can still be played. */
  readonly future: number;
  /** Penalty weight: 1 most of the match, falling to 0 at the end. */
  readonly fade: number;
  readonly winRate: number;
}

/** P(Binomial(k, w) ≥ m). */
function binomTail(k: number, w: number, m: number): number {
  let below = 0;
  for (let j = 0; j < m; j++) below += Math.exp(logC(k, j)) * w ** j * (1 - w) ** (k - j);
  return Math.max(0, 1 - below);
}

/** The chance table: per letter, P(we end up with m more copies) for m = 0..4. */
export function chanceTable(unseen: Counts, unseenTotal: number, future: number, winRate: number): Float64Array {
  const out = new Float64Array(NUM_LETTERS * M1);
  const draws = Math.min(future, unseenTotal);
  for (let l = 0; l < NUM_LETTERS; l++) {
    out[l * M1] = 1;
    const K = unseen[l]!;
    if (draws <= 0 || K === 0) continue;
    const kmax = Math.min(K, draws);
    const denom = logC(unseenTotal, draws);
    const hg = new Float64Array(kmax + 1);
    for (let k = 0; k <= kmax; k++) hg[k] = Math.exp(logC(K, k) + logC(unseenTotal - K, draws - k) - denom);
    for (let m = 1; m <= MAXM; m++) {
      let p = 0;
      for (let k = m; k <= kmax; k++) p += hg[k]! * binomTail(k, winRate, m);
      out[l * M1 + m] = p;
    }
  }
  return out;
}

/** A context from explicit numbers (tests, and the planner valuing hypothetical racks). */
export function makeContext(
  unseen: Counts,
  future: number,
  winRate: number,
  coinValue = 0.6,
  tierPrices: readonly number[] = DEFAULT_TIER_PRICES,
): EvalContext {
  let total = 0;
  for (let l = 0; l < NUM_LETTERS; l++) total += unseen[l]!;
  const fade = Math.min(1, future / FADE_OVER);
  return {
    probs: chanceTable(unseen, total, future, winRate),
    cost: letterCosts(tierPrices).map((c) => c * coinValue * fade),
    future,
    fade,
    winRate,
  };
}

/** The context for valuing the open auction's letter (or the next one) from a game state. */
export function evalContext(s: Readonly<GameState>, p: Params["evaluator"]): EvalContext {
  const future = Math.max(0, s.bagRemaining - (s.current ? 1 : 2));
  const winRate = (s.myWins + p.winRatePrior * p.winRatePriorWeight) / (s.myBids + p.winRatePriorWeight);
  // This match's prices once it has a few, live defaults until then.
  const prices = DEFAULT_TIER_PRICES.map((d, t) => {
    const n = s.prices.count[t]!;
    return n >= 3 ? s.prices.ema[t]! : d;
  });
  const fade = Math.min(1, future / FADE_OVER);
  return {
    probs: chanceTable(s.unseen, s.unseenTotal, future, winRate),
    // Coins are only worth the letters they buy, and nothing once the bag is empty.
    cost: letterCosts(prices).map((c) => c * p.coinValue * fade),
    future,
    fade,
    winRate,
  };
}

export interface LetterValues {
  /** V(R). */
  base: number;
  /** v(L) = V(R ∪ {L}) − V(R), index 0 = 'A'. Can be negative (a duplicate that only adds a penalty). */
  values: Float64Array;
  /** What the rack scores if played now. */
  floor: number;
  /** The best target's chance-weighted value, for logs. */
  bestTarget: number;
}

/** Keeps the k best (value, chance, id) triples in descending order of value, in place. */
function insertTop(
  vals: Float64Array,
  ps: Float64Array,
  ids: Int32Array,
  off: number,
  k: number,
  v: number,
  p: number,
  id: number,
) {
  if (v <= vals[off + k - 1]!) return;
  let j = k - 1;
  while (j > 0 && vals[off + j - 1]! < v) {
    vals[off + j] = vals[off + j - 1]!;
    ps[off + j] = ps[off + j - 1]!;
    ids[off + j] = ids[off + j - 1]!;
    j--;
  }
  vals[off + j] = v;
  ps[off + j] = p;
  ids[off + j] = id;
}

/** The cascade: each target counts only if the ones above it fail. */
function cascade(vals: ArrayLike<number>, ps: ArrayLike<number>, n: number, weights: readonly number[]): number {
  let total = 0;
  let allFailed = 1;
  for (let j = 0; j < n; j++) {
    if (!(vals[j]! > 0)) break;
    total += (weights[j] ?? 0) * vals[j]! * allFailed;
    allFailed *= 1 - ps[j]!;
  }
  return total;
}

export class Evaluator {
  readonly targets: WordSet;
  private readonly dT: Uint8Array;
  private readonly dS: Uint8Array;

  constructor(
    private readonly index: WordIndex,
    private readonly p: Params["evaluator"],
  ) {
    this.targets = targetSet(index);
    this.dT = new Uint8Array(this.targets.size);
    this.dS = new Uint8Array(index.short.size);
  }

  /** Small penalty for duplicates (S and E excepted) and for straying from ~40% vowels. */
  penalty(rack: Counts): number {
    let dups = 0;
    let vowels = 0;
    let tiles = 0;
    for (let l = 0; l < NUM_LETTERS; l++) {
      const n = rack[l]!;
      tiles += n;
      if (IS_VOWEL[l]) vowels += n;
      if (n > 1 && l !== S && l !== E) dups += n - 1;
    }
    const off = Math.max(0, Math.abs(vowels - 0.4 * tiles) - 1);
    return this.p.duplicatePenalty * dups + this.p.vowelPenalty * off;
  }

  /**
   * The best word the rack can play now, and with each letter added, from
   * deficit passes over the short words and the targets. Late in the match,
   * also a greedy split of the whole rack (plus a word the new letter makes
   * from the leftovers).
   */
  private floors(rack: Counts, ctx: EvalContext, dTready: boolean): { now: number; withL: Float64Array } {
    const withL = new Float64Array(NUM_LETTERS);
    let now = 0;
    const scan = (set: WordSet, buf: Uint8Array, r: Counts, into: Float64Array | null, nowCb: (v: number) => void) => {
      const { start, letters, mult, reward } = set;
      for (let i = 0; i < set.size; i++) {
        const d = buf[i]!;
        if (d > 1) continue;
        const v = reward[i]!;
        if (d === 0) {
          nowCb(v);
        } else if (into) {
          for (let q = start[i]!, e = start[i + 1]!; q < e; q++) {
            if (mult[q]! > r[letters[q]!]!) {
              const l = letters[q]!;
              if (v > into[l]!) into[l] = v;
              break;
            }
          }
        }
      }
    };
    if (!dTready) deficits(this.targets, rack, this.dT);
    deficits(this.index.short, rack, this.dS);
    const setNow = (v: number) => {
      if (v > now) now = v;
    };
    scan(this.targets, this.dT, rack, withL, setNow);
    scan(this.index.short, this.dS, rack, withL, setNow);

    if (ctx.future < FULL_FLOOR_BELOW) {
      const words = greedySplit(this.index, rack);
      let split = 0;
      const left = Uint8Array.from(rack);
      for (const w of words) {
        const used = rackOf(w);
        for (let l = 0; l < NUM_LETTERS; l++) left[l] -= used[l]!;
        split += reward(w);
      }
      if (split > now) now = split;
      // A new letter might make a word from what the split leaves over.
      const fromLeft = new Float64Array(NUM_LETTERS);
      const dTl = new Uint8Array(this.targets.size);
      const dSl = new Uint8Array(this.index.short.size);
      deficits(this.targets, left, dTl);
      deficits(this.index.short, left, dSl);
      scan(this.targets, dTl, left, fromLeft, () => {});
      scan(this.index.short, dSl, left, fromLeft, () => {});
      for (let l = 0; l < NUM_LETTERS; l++) {
        if (split + fromLeft[l]! > withL[l]!) withL[l] = split + fromLeft[l]!;
      }
    }
    for (let l = 0; l < NUM_LETTERS; l++) if (now > withL[l]!) withL[l] = now;
    return { now, withL };
  }

  /** v(L) for every letter, plus V(R), in one pass over the targets. */
  letterValues(rack: Counts, ctx: EvalContext): LetterValues {
    const T = this.targets;
    const W = this.p.targetWeights;
    const k = W.length;
    const K = k + 3;
    const cap = Math.min(this.p.maxDeficit, ctx.future);
    deficits(T, rack, this.dT);

    const baseV = new Float64Array(K).fill(-1);
    const baseP = new Float64Array(K);
    const baseI = new Int32Array(K).fill(-1);
    const impV = new Float64Array(NUM_LETTERS * k).fill(-1);
    const impP = new Float64Array(NUM_LETTERS * k);
    const impI = new Int32Array(NUM_LETTERS * k).fill(-1);
    const { start, letters, mult, reward } = T;
    const { probs, cost } = ctx;
    const need = new Int8Array(16);
    const lets = new Uint8Array(16);

    for (let i = 0; i < T.size; i++) {
      const d = this.dT[i]!;
      if (d > cap + 1) continue;
      // This target's missing letters, their expected cost, and its chance.
      let nm = 0;
      let ok = true;
      let spend = 0;
      for (let q = start[i]!, e = start[i + 1]!; q < e; q++) {
        const l = letters[q]!;
        const n = mult[q]! - rack[l]!;
        if (n > 0) {
          if (n > MAXM) {
            ok = false;
            break;
          }
          lets[nm] = l;
          need[nm] = n;
          spend += n * cost[l]!;
          nm++;
        }
      }
      if (!ok) continue;
      const r = reward[i]!;
      if (d <= cap && r > spend) {
        let pb = 1;
        for (let a = 0; a < nm; a++) pb *= probs[lets[a]! * M1 + need[a]!]!;
        insertTop(baseV, baseP, baseI, 0, K, pb * (r - spend), pb, i);
      }
      if (d - 1 > cap) continue;
      // With one more of each missing letter: one less to buy, a better chance.
      for (let a = 0; a < nm; a++) {
        const net = r - spend + cost[lets[a]!]!;
        if (net <= 0) continue;
        let pi = probs[lets[a]! * M1 + need[a]! - 1]!;
        for (let b = 0; b < nm; b++) if (b !== a) pi *= probs[lets[b]! * M1 + need[b]!]!;
        insertTop(impV, impP, impI, lets[a]! * k, k, pi * net, pi, i);
      }
    }

    const tBase = cascade(baseV, baseP, k, W);

    const { now, withL } = this.floors(rack, ctx, true);
    const penR = this.penalty(rack) * ctx.fade;
    const base = Math.max(now, tBase) - penR;

    const values = new Float64Array(NUM_LETTERS);
    const topV = new Float64Array(k);
    const topP = new Float64Array(k);
    const plus = Uint8Array.from(rack);
    for (let l = 0; l < NUM_LETTERS; l++) {
      // Top k for R + l: this letter's improved targets, then the base list without them.
      topV.fill(0);
      topP.fill(0);
      let filled = 0;
      let bi = 0;
      let ii = 0;
      const off = l * k;
      while (filled < k) {
        while (bi < K && baseI[bi]! >= 0 && this.inList(impI, off, k, baseI[bi]!)) bi++;
        const bv = bi < K && baseI[bi]! >= 0 ? baseV[bi]! : 0;
        const iv = ii < k && impI[off + ii]! >= 0 ? impV[off + ii]! : 0;
        if (bv <= 0 && iv <= 0) break;
        if (iv >= bv) {
          topV[filled] = iv;
          topP[filled++] = impP[off + ii]!;
          ii++;
        } else {
          topV[filled] = bv;
          topP[filled++] = baseP[bi]!;
          bi++;
        }
      }
      const tPlus = cascade(topV, topP, filled, W);
      plus[l]++;
      const penPlus = this.penalty(plus) * ctx.fade;
      plus[l]--;
      values[l] = Math.max(withL[l]!, tPlus) - penPlus - base;
    }
    return { base, values, floor: now, bestTarget: baseV[0]! > 0 ? baseV[0]! : 0 };
  }

  private inList(ids: Int32Array, off: number, k: number, id: number): boolean {
    for (let j = 0; j < k; j++) if (ids[off + j] === id) return true;
    return false;
  }

  /** V(R) for any rack: the planner compares the rack before and after a word. */
  rackValue(rack: Counts, ctx: EvalContext): number {
    const T = this.targets;
    const W = this.p.targetWeights;
    const cap = Math.min(this.p.maxDeficit, ctx.future);
    deficits(T, rack, this.dT);
    const vals = new Float64Array(W.length).fill(-1);
    const ps = new Float64Array(W.length);
    const ids = new Int32Array(W.length).fill(-1);
    const { start, letters, mult, reward } = T;
    for (let i = 0; i < T.size; i++) {
      if (this.dT[i]! > cap) continue;
      let pb = 1;
      let spend = 0;
      for (let q = start[i]!, e = start[i + 1]!; q < e && pb > 0; q++) {
        const l = letters[q]!;
        const n = mult[q]! - rack[l]!;
        if (n > 0) {
          pb *= n > MAXM ? 0 : ctx.probs[l * M1 + n]!;
          spend += n * ctx.cost[l]!;
        }
      }
      const net = reward[i]! - spend;
      if (net > 0) insertTop(vals, ps, ids, 0, W.length, pb * net, pb, i);
    }
    const t = cascade(vals, ps, W.length, W);
    const { now } = this.floors(rack, ctx, true);
    return Math.max(now, t) - this.penalty(rack) * ctx.fade;
  }
}
