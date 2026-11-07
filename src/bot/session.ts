// One live match: queues the events from each server transaction, applies
// them in game order, and decides what to send. It does no I/O, so it can be
// tested offline; index.ts turns its decisions into reducer calls.

import { NUM_LETTERS, rackOf } from "../core/rules.js";
import { Tracker } from "../core/tracker.js";
import type { Brain, GameEvent, GameState, MatchStart } from "../core/types.js";
import type { WordIndex } from "../core/words.js";

/** Within one transaction: closes first, then words, money, racks, and the next auction. */
const ORDER: Record<GameEvent["type"], number> = {
  auctionClosed: 0,
  wordPlayed: 1,
  balanceChanged: 2,
  rackChanged: 3,
  bidSent: 4,
  auctionOpened: 5,
  matchEnded: 6,
};

export interface BidOrder {
  auctionId: number;
  letter: number;
  amount: number;
  /** ms from the flush starting to this decision. */
  decisionMs: number;
  /** "first" is the instant answer from the last table; "update" replaces it. */
  kind: "first" | "update";
}

export interface Decision {
  bids: BidOrder[];
  words: string[];
  closed: Extract<GameEvent, { type: "auctionClosed" }>[];
  ended: boolean;
  /** Set if the brain threw and the fallback answered instead. */
  brainError?: string;
  brainMs: number;
}

export class Session {
  readonly tracker: Tracker;
  private queue: GameEvent[] = [];
  private table: Int32Array | null = null;
  private readonly lastBid = new Map<number, number>();
  /**
   * Words sent but not yet seen in word_play. Their letters are still in our
   * rack on the server's side until it applies them, so they're reserved:
   * planning from the raw rack would send them twice (seen live: "OR" was
   * sent again after a rack update, and the server refused it).
   */
  private pending: { word: string; at: number }[] = [];

  constructor(
    start: MatchStart,
    private readonly brain: Brain,
    private readonly fallback: Brain,
    private readonly index: WordIndex,
    priceAlpha?: number,
  ) {
    this.tracker = new Tracker(start, { priceAlpha });
  }

  get state(): Readonly<GameState> {
    return this.tracker.state;
  }

  push(e: GameEvent) {
    this.queue.push(e);
  }

  flush(now: () => number = performance.now.bind(performance)): Decision {
    const t0 = now();
    const events = this.queue.sort((a, b) => ORDER[a.type] - ORDER[b.type]);
    this.queue = [];
    const closed: Decision["closed"] = [];
    for (const e of events) {
      this.tracker.apply(e);
      if (e.type === "auctionClosed") closed.push(e);
      if (e.type === "wordPlayed" && e.bot === this.tracker.state.me) this.release(e.word);
    }
    const s = this.tracker.state;
    const bids: BidOrder[] = [];
    const cur = s.current;

    // Answer a new auction at once from the table we already have.
    if (cur && !s.ended && !this.lastBid.has(cur.auctionId) && this.table) {
      this.bid(bids, cur.auctionId, cur.letter, this.table[cur.letter]!, now() - t0, "first");
    }

    const decision = this.recompute(now);
    if (cur && !s.ended) {
      const amount = this.table![cur.letter]!;
      const sent = this.lastBid.get(cur.auctionId);
      if (sent === undefined) {
        this.bid(bids, cur.auctionId, cur.letter, amount, now() - t0, "first");
      } else if (this.clamp(amount) !== sent) {
        this.bid(bids, cur.auctionId, cur.letter, amount, now() - t0, "update");
      }
    }

    return {
      bids,
      words: s.ended ? [] : this.words(now()),
      closed,
      ended: s.ended,
      ...decision,
    };
  }

  /** The server refused a word we sent: its letters are free again. */
  wordRejected(word: string) {
    this.release(word);
  }

  private release(word: string) {
    const i = this.pending.findIndex((p) => p.word === word);
    if (i >= 0) this.pending.splice(i, 1);
  }

  /** Our bid, never above the confirmed balance and never on the last letter (it can't be played). */
  private clamp(amount: number): number {
    const s = this.tracker.state;
    if (s.bagRemaining === 0) return 0;
    return Math.max(0, Math.min(Math.floor(amount), s.coins));
  }

  private bid(out: BidOrder[], auctionId: number, letter: number, raw: number, ms: number, kind: BidOrder["kind"]) {
    const amount = this.clamp(raw);
    const sent = this.lastBid.get(auctionId);
    if (sent === undefined && amount === 0) {
      this.lastBid.set(auctionId, 0); // nothing to send; a 0 bid is the same as no bid
      return;
    }
    if (sent === amount) return;
    this.lastBid.set(auctionId, amount);
    this.tracker.apply({ type: "bidSent", auctionId, amount });
    out.push({ auctionId, letter, amount, decisionMs: ms, kind });
  }

  private recompute(now: () => number): { brainMs: number; brainError?: string } {
    const t = now();
    try {
      this.table = this.brain.bidTable(this.tracker.state);
      return { brainMs: now() - t };
    } catch (err) {
      this.table = this.fallback.bidTable(this.tracker.state);
      return { brainMs: now() - t, brainError: err instanceof Error ? err.message : String(err) };
    }
  }

  /** The brain's words that are real and spellable from the rack, minus letters of words still in flight. */
  private words(now: number): string[] {
    const s = this.tracker.state;
    // A word the server never answered for 3 s isn't coming; free its letters.
    this.pending = this.pending.filter((p) => now - p.at < 3000);
    const left = Uint8Array.from(s.rack);
    for (const p of this.pending) {
      const used = rackOf(p.word);
      for (let l = 0; l < NUM_LETTERS; l++) left[l] = Math.max(0, left[l]! - used[l]!);
    }
    let planned: string[];
    try {
      planned = this.brain.planWords(s);
    } catch {
      planned = this.fallback.planWords(s);
    }
    const out: string[] = [];
    for (const raw of planned) {
      const word = raw.toUpperCase();
      if (!this.index.isWord(word)) continue;
      let used: Uint8Array;
      try {
        used = rackOf(word);
      } catch {
        continue;
      }
      let ok = true;
      for (let l = 0; l < NUM_LETTERS; l++) if (used[l]! > left[l]!) ok = false;
      if (!ok) continue;
      for (let l = 0; l < NUM_LETTERS; l++) left[l] -= used[l]!;
      out.push(word);
      this.pending.push({ word, at: now });
    }
    return out;
  }
}
