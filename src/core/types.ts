// Types shared by the live bot, the simulator and every brain.

/** Letter counts: 26 entries, index 0 = 'A'. */
export type Counts = Uint8Array;

/** A bot's id in the module (u64 there; ids stay far below 2^53). */
export type BotId = number;

export type AuctionType = "Vickrey" | "FirstPrice";

/** One match's settings, read from its match_state row, never assumed. */
export interface MatchSettings {
  auctionType: AuctionType;
  /** Bidding window per auction. */
  windowMs: number;
  /** Opening tiles dealt to each bot. */
  rackSize: number;
  numBots: number;
  /** 98 − rackSize × numBots: one auction per tile left after dealing. */
  totalAuctions: number;
  startingCoins: number;
}

/** What we know when a match starts. Mid-match rebuilds work this out from the tables. */
export interface MatchStart {
  settings: MatchSettings;
  me: BotId;
  /** Everyone in the match, us included. */
  bots: readonly BotId[];
  /** Our opening tiles. After a reconnect, see `deriveOpening`. */
  opening: Counts;
}

/**
 * Public events, plus our own rack and bids, in game order. The live bot
 * turns table changes into these; the simulator emits them directly.
 * When one server transaction both closes an auction and records a word
 * (a sim bot cashing the letter it just won), the close comes first.
 */
export type GameEvent =
  /** Our rack as the server sees it (my_rack). Always authoritative. */
  | { type: "rackChanged"; rack: Counts }
  | { type: "auctionOpened"; auctionId: number; letter: number }
  /** Our latest bid on an auction; a new bid replaces the old one. */
  | { type: "bidSent"; auctionId: number; amount: number }
  | {
      type: "auctionClosed";
      auctionId: number;
      letter: number;
      /** null when nobody bid; the letter is thrown away. */
      winner: BotId | null;
      paid: number;
    }
  /** `id` is the word_play row id, so replays don't count a word twice. */
  | { type: "wordPlayed"; id: number; bot: BotId; word: string; reward: number }
  | { type: "balanceChanged"; bot: BotId; coins: number; score: number }
  | { type: "matchEnded" };

export interface RivalState {
  readonly id: BotId;
  coins: number;
  score: number;
  /** Letters won at auction. */
  readonly won: Counts;
  /** Letters played in words. */
  readonly spent: Counts;
  /**
   * Opening tiles its words have revealed: the most it has ever played of a
   * letter beyond what it had won at the time. A lower bound on its opening rack.
   */
  readonly revealed: Counts;
  revealedTotal: number;
  lettersWon: number;
  wordsPlayed: number;
}

export interface AuctionRecord {
  auctionId: number;
  letter: number;
  winner: BotId | null;
  paid: number;
  /** Our last bid on it (0 if we didn't bid). */
  myBid: number;
}

export interface WordRecord {
  id: number;
  bot: BotId;
  word: string;
  reward: number;
}

export interface PriceStats {
  /** Moving average of the price paid for sold letters, by tier (see rules.ts TIER_OF). */
  readonly ema: Float64Array;
  /** Letters sold so far, by tier. */
  readonly count: Uint32Array;
  /** Total paid for them, by tier. */
  readonly sum: Float64Array;
}

/** Everything we know about a match. Built by the tracker; brains only read it. */
export interface GameState {
  readonly settings: MatchSettings;
  readonly me: BotId;
  /** Our rack, from the latest rackChanged event. */
  readonly rack: Counts;
  rackTiles: number;
  coins: number;
  score: number;
  readonly opening: Counts;
  /** Letters we've won at auction. */
  readonly won: Counts;
  /** Letters we've played in words. */
  readonly spent: Counts;
  /** Tiles we haven't seen: what's left in the bag plus rivals' unrevealed opening tiles. */
  readonly unseen: Counts;
  unseenTotal: number;
  /** The open auction, if any. Its letter already counts as seen. */
  current: { auctionId: number; letter: number } | null;
  auctionsClosed: number;
  /** Auctions not closed yet, the open one included. */
  auctionsLeft: number;
  /** Tiles not drawn yet: auctions still to open. */
  bagRemaining: number;
  readonly rivals: Map<BotId, RivalState>;
  readonly prices: PriceStats;
  /** Closed auctions we bid on, and how many of those we won. */
  myBids: number;
  myWins: number;
  readonly history: AuctionRecord[];
  readonly words: WordRecord[];
  ended: boolean;
}

/** Anything that bids and plays words: Bingo's brains and the simulator's opponents. */
export interface Brain {
  readonly name: string;
  /** A bid for each letter (index 0 = 'A'), so answering an auction is a lookup. */
  bidTable(s: Readonly<GameState>): Int32Array;
  /** Words to submit right now, possibly none. */
  planWords(s: Readonly<GameState>): string[];
}
