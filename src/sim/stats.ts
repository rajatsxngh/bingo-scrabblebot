// Totals across many simulated matches, per seat, and the report the runner prints.

import { NUM_TIERS } from "../core/rules.js";
import { HIST_BUCKETS, HIST_STEP_MS, type MatchResult } from "./game.js";

export interface SeatStats {
  name: string;
  matches: number;
  avgScore: number;
  winRate: number;
  avgPlace: number;
  /** Share of all auctions this seat won. */
  auctionShare: number;
  avgPaidByTier: (number | null)[];
  avgCoinsLeft: number;
  longWordsPerMatch: number;
  wordsPerMatch: number;
  p50Ms: number;
  p99Ms: number;
  overBalance: number;
  invalidWords: number;
  lastLetterBids: number;
}

export interface Summary {
  matches: number;
  seats: SeatStats[];
  marketAvgByTier: (number | null)[];
  unsoldPerMatch: number;
  firstUnsoldRate: number;
  /** Two-seat tables: seat 1's win rate and average margin over seat 2. */
  headToHead?: { winRate: number; avgMargin: number };
}

function percentile(hist: Uint32Array, q: number): number {
  let total = 0;
  for (const c of hist) total += c;
  if (total === 0) return 0;
  const target = q * total;
  let seen = 0;
  for (let b = 0; b < HIST_BUCKETS; b++) {
    seen += hist[b]!;
    if (seen >= target) return (b + 1) * HIST_STEP_MS;
  }
  return HIST_BUCKETS * HIST_STEP_MS;
}

export function summarize(results: readonly MatchResult[]): Summary {
  const n = results.length;
  const seatCount = results[0]?.seats.length ?? 0;
  const seats: SeatStats[] = [];
  for (let i = 0; i < seatCount; i++) {
    const rows = results.map((r) => r.seats[i]!);
    const hist = new Uint32Array(HIST_BUCKETS);
    for (const row of rows) for (let b = 0; b < HIST_BUCKETS; b++) hist[b] += row.decisionHist[b]!;
    const paid = new Array(NUM_TIERS).fill(0);
    const won = new Array(NUM_TIERS).fill(0);
    for (const row of rows) {
      for (let t = 0; t < NUM_TIERS; t++) {
        paid[t] += row.paidByTier[t]!;
        won[t] += row.wonByTier[t]!;
      }
    }
    const sum = (f: (row: (typeof rows)[number]) => number) => rows.reduce((s, row) => s + f(row), 0);
    const auctions = results.reduce((s, r) => s + r.auctions, 0);
    seats.push({
      name: rows[0]!.name,
      matches: n,
      avgScore: sum((r) => r.score) / n,
      winRate: sum((r) => (r.place === 1 ? 1 : 0)) / n,
      avgPlace: sum((r) => r.place) / n,
      auctionShare: sum((r) => r.lettersWon) / auctions,
      avgPaidByTier: paid.map((p, t) => (won[t] ? p / won[t] : null)),
      avgCoinsLeft: sum((r) => r.coins) / n,
      longWordsPerMatch: sum((r) => r.longWords) / n,
      wordsPerMatch: sum((r) => r.words) / n,
      p50Ms: percentile(hist, 0.5),
      p99Ms: percentile(hist, 0.99),
      overBalance: sum((r) => r.overBalance),
      invalidWords: sum((r) => r.invalidWords),
      lastLetterBids: sum((r) => r.lastLetterBids),
    });
  }
  const count = new Array(NUM_TIERS).fill(0);
  const total = new Array(NUM_TIERS).fill(0);
  for (const r of results) {
    for (let t = 0; t < NUM_TIERS; t++) {
      count[t] += r.marketCount[t]!;
      total[t] += r.marketSum[t]!;
    }
  }
  const summary: Summary = {
    matches: n,
    seats,
    marketAvgByTier: total.map((s, t) => (count[t] ? s / count[t] : null)),
    unsoldPerMatch: results.reduce((s, r) => s + r.unsold, 0) / n,
    firstUnsoldRate: results.filter((r) => r.firstUnsold).length / n,
  };
  if (seatCount === 2) {
    summary.headToHead = {
      winRate: results.filter((r) => r.seats[0]!.score > r.seats[1]!.score).length / n,
      avgMargin: results.reduce((s, r) => s + r.seats[0]!.score - r.seats[1]!.score, 0) / n,
    };
  }
  return summary;
}

const f1 = (x: number | null) => (x === null ? "  -" : x.toFixed(1));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Live prices from our own lobby matches (logs, 9 full matches, Nov 7 ~5:30pm). */
export const LIVE_PRICES = [10.4, 13.4, 17.3, 28.8];

export function formatSummary(s: Summary, title: string): string {
  const lines: string[] = [];
  lines.push(`${title}: ${s.matches} matches`);
  lines.push(
    "seat  player      avg score  win%    place  won%   coins left  words  7+ words  ms p50/p99  violations",
  );
  s.seats.forEach((x, i) => {
    const v = x.overBalance + x.invalidWords;
    const last = x.lastLetterBids ? `  (${x.lastLetterBids} last-letter bids)` : "";
    lines.push(
      `${String(i + 1).padEnd(6)}${x.name.padEnd(12)}${f1(x.avgScore).padStart(9)}  ${pct(x.winRate).padStart(6)}  ` +
        `${x.avgPlace.toFixed(2).padStart(5)}  ${pct(x.auctionShare).padStart(5)}  ${f1(x.avgCoinsLeft).padStart(10)}  ` +
        `${x.wordsPerMatch.toFixed(1).padStart(5)}  ${x.longWordsPerMatch.toFixed(2).padStart(8)}  ` +
        `${`${x.p50Ms.toFixed(2)}/${x.p99Ms.toFixed(2)}`.padStart(11)}  ${v === 0 ? "0" : `${v} (bal ${x.overBalance}, words ${x.invalidWords})`}${last}`,
    );
  });
  lines.push(
    `market price by tier (1pt / 2-3 / 4-5 / 8-10): ${s.marketAvgByTier.map(f1).join(" / ")}` +
      `   live: ${LIVE_PRICES.join(" / ")}`,
  );
  lines.push(`unsold letters per match: ${s.unsoldPerMatch.toFixed(2)}, first auction unsold: ${pct(s.firstUnsoldRate)}`);
  if (s.headToHead) {
    lines.push(
      `head to head: seat 1 wins ${pct(s.headToHead.winRate)}, average margin ${s.headToHead.avgMargin.toFixed(1)}`,
    );
  }
  return lines.join("\n");
}
