// The state tracker: turns public events (plus our own rack and bids) into
// everything we know about a match. It does no I/O, so the live bot and the
// simulator run exactly the same code. Applying an event twice is harmless,
// and after a reconnect the state is rebuilt by replaying the match's rows.

import { BAG_COUNTS, NUM_LETTERS, TIER_OF, rackOf, tileCount } from "./rules.js";
import type {
  BotId,
  Counts,
  GameEvent,
  GameState,
  MatchStart,
  RivalState,
} from "./types.js";

export interface TrackerOptions {
  /** Weight of the newest price in each tier's moving average (params.tracker.priceAlpha). */
  priceAlpha?: number;
}

function newRival(id: BotId, coins: number): RivalState {
  return {
    id,
    coins,
    score: 0,
    won: new Uint8Array(NUM_LETTERS),
    spent: new Uint8Array(NUM_LETTERS),
    revealed: new Uint8Array(NUM_LETTERS),
    revealedTotal: 0,
    lettersWon: 0,
    wordsPlayed: 0,
  };
}

export class Tracker {
  readonly state: GameState;
  private readonly alpha: number;
  /** Auctions whose letter we've seen (opened or closed). */
  private readonly seenAuctions = new Set<number>();
  private readonly closedAuctions = new Set<number>();
  private readonly seenWords = new Set<number>();
  /** Letters of every auction we've seen, sold or not. */
  private readonly auctioned = new Uint8Array(NUM_LETTERS);
  private readonly myBidByAuction = new Map<number, number>();

  constructor(start: MatchStart, opts: TrackerOptions = {}) {
    this.alpha = opts.priceAlpha ?? 0.25;
    const settings = { ...start.settings };
    if (start.bots.length !== settings.numBots) {
      throw new Error(
        `match lists ${start.bots.length} bots but settings say ${settings.numBots}`,
      );
    }
    const rivals = new Map<BotId, RivalState>();
    for (const id of start.bots) {
      if (id !== start.me) rivals.set(id, newRival(id, settings.startingCoins));
    }
    this.state = {
      settings,
      me: start.me,
      rack: Uint8Array.from(start.opening),
      rackTiles: tileCount(start.opening),
      coins: settings.startingCoins,
      score: 0,
      opening: Uint8Array.from(start.opening),
      won: new Uint8Array(NUM_LETTERS),
      spent: new Uint8Array(NUM_LETTERS),
      unseen: new Uint8Array(NUM_LETTERS),
      unseenTotal: 0,
      current: null,
      auctionsClosed: 0,
      auctionsLeft: settings.totalAuctions,
      bagRemaining: settings.totalAuctions,
      rivals,
      prices: {
        ema: new Float64Array(4),
        count: new Uint32Array(4),
        sum: new Float64Array(4),
      },
      myBids: 0,
      myWins: 0,
      history: [],
      words: [],
      ended: false,
    };
    this.recount();
  }

  apply(e: GameEvent): void {
    const s = this.state;
    switch (e.type) {
      case "rackChanged":
        s.rack.set(e.rack);
        s.rackTiles = tileCount(e.rack);
        return;

      case "auctionOpened":
        if (this.closedAuctions.has(e.auctionId)) return;
        this.see(e.auctionId, e.letter);
        s.current = { auctionId: e.auctionId, letter: e.letter };
        this.recount();
        return;

      case "bidSent":
        this.myBidByAuction.set(e.auctionId, e.amount);
        return;

      case "auctionClosed": {
        if (this.closedAuctions.has(e.auctionId)) return;
        this.closedAuctions.add(e.auctionId);
        this.see(e.auctionId, e.letter);
        const myBid = this.myBidByAuction.get(e.auctionId) ?? 0;
        this.myBidByAuction.delete(e.auctionId);
        if (myBid > 0) {
          s.myBids++;
          if (e.winner === s.me) s.myWins++;
        }
        if (e.winner !== null) {
          if (e.winner === s.me) {
            s.won[e.letter]++;
          } else {
            const r = this.rival(e.winner);
            r.won[e.letter]++;
            r.lettersWon++;
          }
          const t = TIER_OF[e.letter]!;
          const p = s.prices;
          p.count[t]++;
          p.sum[t] += e.paid;
          p.ema[t] =
            p.count[t] === 1 ? e.paid : p.ema[t]! + this.alpha * (e.paid - p.ema[t]!);
        }
        s.history.push({
          auctionId: e.auctionId,
          letter: e.letter,
          winner: e.winner,
          paid: e.paid,
          myBid,
        });
        if (s.current?.auctionId === e.auctionId) s.current = null;
        s.auctionsClosed = this.closedAuctions.size;
        this.recount();
        return;
      }

      case "wordPlayed": {
        if (this.seenWords.has(e.id)) return;
        this.seenWords.add(e.id);
        const letters = rackOf(e.word);
        s.words.push({ id: e.id, bot: e.bot, word: e.word, reward: e.reward });
        if (e.bot === s.me) {
          for (let l = 0; l < NUM_LETTERS; l++) s.spent[l] += letters[l]!;
          return;
        }
        const r = this.rival(e.bot);
        r.wordsPlayed++;
        for (let l = 0; l < NUM_LETTERS; l++) {
          if (letters[l] === 0) continue;
          r.spent[l] += letters[l]!;
          // Anything played beyond what it had won so far came from its
          // opening rack. Later wins don't un-reveal it.
          const fromOpening = r.spent[l]! - r.won[l]!;
          if (fromOpening > r.revealed[l]!) {
            r.revealedTotal += fromOpening - r.revealed[l]!;
            r.revealed[l] = fromOpening;
          }
        }
        this.recount();
        return;
      }

      case "balanceChanged":
        if (e.bot === s.me) {
          s.coins = e.coins;
          s.score = e.score;
        } else {
          const r = this.rival(e.bot);
          r.coins = e.coins;
          r.score = e.score;
        }
        return;

      case "matchEnded":
        s.ended = true;
        s.current = null;
        return;
    }
  }

  private see(auctionId: number, letter: number) {
    if (this.seenAuctions.has(auctionId)) return;
    this.seenAuctions.add(auctionId);
    this.auctioned[letter]++;
  }

  private rival(id: BotId): RivalState {
    let r = this.state.rivals.get(id);
    if (!r) {
      // Not in the starting roster; shouldn't happen, but don't lose the event.
      r = newRival(id, this.state.settings.startingCoins);
      this.state.rivals.set(id, r);
    }
    return r;
  }

  /** Unseen = the bag, minus our opening tiles, every auctioned letter and rivals' revealed tiles. */
  private recount() {
    const s = this.state;
    let total = 0;
    for (let l = 0; l < NUM_LETTERS; l++) {
      let n = BAG_COUNTS[l]! - s.opening[l]! - this.auctioned[l]!;
      for (const r of s.rivals.values()) n -= r.revealed[l]!;
      // Only out-of-order events could push this below 0.
      s.unseen[l] = n > 0 ? n : 0;
      total += s.unseen[l]!;
    }
    s.unseenTotal = total;
    s.bagRemaining = Math.max(0, s.settings.totalAuctions - this.seenAuctions.size);
    s.auctionsLeft = Math.max(0, s.settings.totalAuctions - this.closedAuctions.size);
  }
}

/** Rebuilds a match's state from its start and every event since. */
export function replay(
  start: MatchStart,
  events: Iterable<GameEvent>,
  opts?: TrackerOptions,
): GameState {
  const t = new Tracker(start, opts);
  for (const e of events) t.apply(e);
  return t.state;
}

/**
 * Our opening tiles, worked out mid-match (after a reconnect): the rack we
 * hold, plus letters we've played, minus letters we've won.
 */
export function deriveOpening(rack: Counts, won: Counts, spent: Counts): Counts {
  const out = new Uint8Array(NUM_LETTERS);
  for (let l = 0; l < NUM_LETTERS; l++) {
    const n = rack[l]! + spent[l]! - won[l]!;
    out[l] = n > 0 ? n : 0;
  }
  return out;
}

/** Letters we know a rival still holds: wins plus revealed opening tiles, minus letters played. */
export function knownHoldings(r: RivalState): Counts {
  const out = new Uint8Array(NUM_LETTERS);
  for (let l = 0; l < NUM_LETTERS; l++) {
    const n = r.won[l]! + r.revealed[l]! - r.spent[l]!;
    out[l] = n > 0 ? n : 0;
  }
  return out;
}

/** Opening tiles a rival hasn't revealed yet. */
export function hiddenTiles(r: RivalState, rackSize: number): number {
  return Math.max(0, rackSize - r.revealedTotal);
}
