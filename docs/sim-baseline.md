# Simulator calibration and baseline (M4)

Recorded Sat Nov 7, ~7pm CT, at the M4 commit. "bingo" here is the **fallback brain**, which is what plays live until v1 passes its gate in M6. Every number below comes from 1,000 matches with seed 1, and can be reproduced:

```bash
npm run sim -- --table bingo,bron,k13,tileshark,starter,sim --matches 1000
npm run sim -- --table bingo,bron,bron,k13,k13,tileshark --matches 1000
npm run sim -- --table bingo,k13 --matches 1000
npm run sim -- --table bingo,bron,k13,tileshark,starter,sim --type first --matches 1000
```

The same seed gives the same results whatever the number of workers. Checked: 1 worker and 4 workers give identical game numbers. Only the wall-clock decision times differ. A 1,000-match run takes about 60–80 s on 4 workers, roughly 60–80 ms per match.

## Calibration against live play

Live numbers come from our own lobby matches on Nov 7 (15+ matches as bot1717, from `logs/`) and the public page for match 43025. Our live lobby tables were six real bots, with no sim bots.

| | Live | Sim, live-like table (2 bron, 2 k13, tileshark) |
|---|---|---|
| Price, 1-point letters | 10.4 (quartiles 9 / 10 / 12) | 10.1 |
| Price, 2–3 point letters | 13.4 | 12.6 |
| Price, 4–5 point letters | 17.3 | 15.6 |
| Price, 8–10 point letters | 28.8 | 21.5 |
| First auction unsold | 0 of 12 matches | 0% |
| Fallback: average score | **31** (place 5.7 of 6) | **63.2** |
| Fallback: letters won per match | **4.2** | 10.9 |
| Fallback: coins left | 93 | 79 |
| Field: scores | 111, 110, 69, 39, 38 (match 43025) | 48–64 |

**Known gaps.**
- **The simulator is easier than the live field for the fallback**: about 2× its live score. The copies run short of coins in the second half, so a hoarder picks up late letters cheaply. Live top bots get far more per word (about 37 points against the copies' 17), so they keep their coins up.
- **8–10 point letters sell for less** than live: 21.5 against 28.8.

So compare brains **relative to each other in the same table**, and don't read the absolute levels as live predictions. M7's first step compares v1's live average with the simulator's prediction and fixes any gap over 15% before tuning.

**Also learned.**
- The PRD's "free first tile" doesn't happen in today's lobby: the first auction sold every time, for 10–21 coins.
- Bots skip the last letter. In match 43025 it drew no bids at all.
- The match pages list auctions newest first, with each winner's bid next to the price paid.

## Baseline: the fallback brain

| Table (1,000 matches) | Fallback score | Field | Notes |
|---|---|---|---|
| Mixed, Vickrey (bron, k13, tileshark, starter, sim) | **74.8**, win 19.6%, place 2.59 | k13 98.1, bron 91.1, tileshark 55.1, starter 11.8, sim 10.5 | 6.3× the starter. Ends with 86 coins unspent. |
| Live-like, Vickrey | **63.2**, win 28.0%, place 3.05 | k13 64.0, bron 56.3, tileshark 48.4 | Best win rate at the table, but this field is weaker than the live one (see above). |
| Head to head vs k13, Vickrey | **24.4**, win 0.2% | k13 **481.0**, 96% of letters, 11 seven-plus words per match | Like the PRD's Tournament #1 final (K-13 429–89). The final is a different game. |
| Mixed, first-price | **74.9**, win 37.7%, place 2.06 | k13 73.1, bron 66.0, tileshark 45.2, starter 26.0, sim 17.2 | Paying its own bids, it spends down to 6 coins. It made 0 bids over the balance after this commit's fix (3,256 before). |

What M5–M7 have to beat:
- **Coins.** The fallback finishes Vickrey matches with 80+ coins unspent, and those are worthless at the end.
- **Head to head.** Against a bid-on-everything rival, every letter it skips goes to the rival cheaply. M7's final mode has to contest them.
- **Gate (M6).** v1 needs at least 2× the starter's score in mixed tables, zero invalid words and zero bids over the balance, and must beat the fallback. Before the fix in this commit, the fallback itself bid over its balance whenever it was broke.
