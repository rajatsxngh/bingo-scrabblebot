# Bingo build milestones

Source: [Bingo PRD](https://docs.google.com/document/d/1Hx_jjX084lfNBOT1NiZVSvgfkMq3p_71K1qadPhvZHA/edit) (Nov 7, 2026). Planned at 3:55pm on Saturday. The tournament starts at 10:45pm and code freezes at 10:00pm. All times are US Central.

Each milestone has enough detail to hand to a coding session on its own. The PRD explains why each rule is there.

## How the milestones are split

- **Dependencies only point backward.** A milestone uses what earlier ones built, never anything from a later one.
- **Each one ends with something that runs** and a pass/fail check, so it's always clear whether it's done.
- **A bot is online from M1 onward.** The live bot is only replaced by a version that passed its gate.
- **The riskiest integration comes first** (accounts, token, connection). Then come the shared foundation, the measuring stick, the brain, tuning, and finally operations.
- **The live bot and the simulator run the same core code** (rules, word index, state tracker, brain), so what the simulator measures is what plays tonight.

## At a glance

| # | Milestone | Depends on | Done by | Ends with |
|---|---|---|---|---|
| M1 | Accounts, repo, starter bot online | — | 4:30pm | Our bot playing live lobby matches from our repo |
| M2 | Game core: rules, word index, state tracker | M1 | 5:00pm | Pure core code, tests passing |
| M3 | Live bot shell with a fallback brain | M1, M2 | 5:50pm | Tonight's bot minus the smart brain, live, clean logs |
| M4 | Simulator and opponent pool | M2 | 6:35pm | 1,000 local matches with stats, checked against live |
| M5 | Rack evaluator (letter values) | M2 | 7:15pm | All 26 letter values in under 50 ms |
| M6 | Bingo v1 passes its gate and goes live | M3, M4, M5 | 8:00pm | v1 live in lobby matches |
| M7 | Tuning for Swiss, bracket and final | M6 | 9:15pm | Tuned params live, phase switching |
| M8 | Rival model and first-price shading | M6 | only if first-price | Shaded first-price bids |
| M9 | Reliability drills, live check, freeze | M6 (+ M7, M8 if done) | 10:00pm | Frozen, tagged build on the final host |
| M10 | Register, go idle, play | M9 | idle by 10:30pm | Registered, idle, playing |

**Must-have:** M1–M6, M9 and M10. **Next most valuable:** M7. **Only if tonight is first-price:** M8.

```
M1 ──► M2 ──┬──► M3 ──┐
            ├──► M4 ──┼──► M6 ──┬──► M7 ──┬──► M9 ──► M10
            └──► M5 ──┘         └──► M8 ──┘
```

M3, M4 and M5 each need only M1 and M2. With teammates or parallel sessions they can be built at the same time, and v1 lands at about 6:40pm instead of 8:00pm. M7 and M8 don't depend on each other either. M9 can follow M6 directly if time runs out.

## Changes from the PRD's build plan

- **The live shell gets its own milestone (M3).** The PRD's time blocks never schedule sync, the state tracker or the bid sender, but going live depends on all three. Reconnect, state rebuild, the watchdog fallback and logs move here as well, since they protect every hour of live play. The drills and the standby machine stay late (M9).
- **The simulator comes before the engine (M4 before M5 and M6).** That way every engine change is measured as soon as it's written, and the simulator is checked against live data before anything is tuned on it.
- **The state tracker is shared, pure code (M2).** The simulator feeds it the same public events the live bot gets, so the simulator tests the exact code that plays.
- **The gates are split in two.** v1 goes live once it beats the starter mix with zero rule violations (M6). The 35% and 90% win-rate targets then decide which params get frozen (M7). This keeps a smarter bot live while tuning runs.
- **A control file replaces restarts.** Lobby on/off, tournament registration and brain or params switching are read from `control.json`, so none of tonight's changes drop the connection.

## Repo layout

```
config/params.json   every tunable, in one file (as the PRD says)
data/wordlist.txt    the module's word list (172,820 words)
src/core/            pure and shared: rules, word index, types, state tracker
src/engine/          brains: fallback, evaluator, pacing, bidding, word planner
src/bot/             live: connection, adapter, senders, control, logs, bindings
src/sim/             simulator, opponents, runner, tuner
test/
logs/                gitignored
```

Everything shares one interface, in `src/core/types.ts`:

```ts
interface Brain {
  bidTable(s: GameState): Int32Array; // 26 bids, index 0 = 'A'
  planWords(s: GameState): string[];  // words to submit now, maybe none
}
```

---

## M1 — Accounts, repo, and the starter bot online

**Goal:** our bot connects under our team and plays lobby matches from our own repo. Everything later builds on this connection.

**By hand, right now (these can hold everything up):**
- Link the spacetimedb.com account on the Account page and create or join the team. Then go to the Team page and click Generate token. The token is shown only once, so save it somewhere outside the repo.
- Ask the booth the questions at the end of this file.
- Pick tonight's host. A small cloud server is safest. A laptop also works if it stays plugged in, has sleep turned off and is on the steadiest network available.

**Build:**
- Start from the upstream `bot-starter/` (TypeScript, ESM, `tsx`, SDK `spacetimedb` ^2.12). Node 22 is installed on this machine. Create the folders above and copy `spacetimedb/wordlist.txt` to `data/`.
- Get the bindings. The `spacetime` CLI isn't installed here, so `npm run generate` won't work. Either install the CLI, or copy the pre-generated `src/module_bindings/` from the upstream repo root (it's the same module) and check that it compiles.
- Fix the word-list path. The starter builds it from `new URL(import.meta.url).pathname`, which breaks on Windows: the list silently loads empty and the bot never plays a word. Use `fileURLToPath` instead, and log the word count at startup.
- Add a `.gitignore` covering `.token-*` (the starter saves the token to `.token-<BOT_NAME>`), `node_modules/`, `logs/` and `.env`.
- Write a README stub that credits the clockworklabs starter kit and names the AI coding tools used, as the MLH rules require.
- Create the GitHub repo (`gh` is installed) and push. It has to be public to qualify. Whether it has to be public before tonight is a question for the booth. If it doesn't, keeping it private until registration stops rivals from reading the strategy.
- On connect, print `matchmaker_config` (rack size, lobby size, auction window) and any `tournament` rows (status, `auctionType`, `matchSize`, `swissRoundsTotal`, `topCut`). Once tonight's tournament exists, this answers most of the booth questions by itself.

**Done when:**
- Our bot plays at least one full lobby match that shows up on the matches page, and it plays words in that match. The startup log shows 172,820 words.
- `git ls-files` shows no token, and the repo is on GitHub.
- We've noted how long it takes from connecting to "subscription applied". M3's reconnect design depends on that number.

## M2 — Game core: rules, word index, state tracker

**Goal:** one pure, tested module that knows the rules, the dictionary and everything public about a match. The live bot and the simulator both use it.

**Depends on:** M1's repo setup only, not the token. Start it while waiting on the booth.

**Build (`src/core`):**
- `rules.ts`:
  - Letter values.
  - Bag counts: 98 tiles, no blanks (E12 A9 I9 O8 N6 R6 T6 L4 S4 U4 D4 G3 B2 C2 F2 H2 M2 P2 V2 W2 Y2 J1 K1 Q1 X1 Z1).
  - Reward: the letter sum × 1, 1.5, 2, 2.5 or 3 for words of ≤3, 4, 5, 6 or 7+ letters, rounded down. Copy the multiplier from the module's `letters.ts`, which stores it as a numerator and denominator and applies it with integer division.
- `words.ts`: a long index (7–10 letters) and a short index (2–6 letters), each a typed array. Every word gets 26 letter counts in a `Uint8Array`, plus its reward and length. A `Set` handles validity checks. Queries: the playable words for a rack, a word's missing letters given a rack, and the best single word.
- `types.ts`: `MatchSettings` (auctionType, windowMs, rackSize, numBots, totalAuctions), `GameState`, `RivalState`, the public event types and `Brain`.
- `tracker.ts`: a pure function that turns events into `GameState`.
  - Events in: match started, rack changed, auction opened, auction closed (letter, winner, price), word played, balance changed, our own bid sent, match ended.
  - State out:
    - Unseen letter counts: 98, minus our opening tiles, minus every auctioned letter (sold or not), minus the rivals' opening tiles that their words have revealed.
    - Auctions left.
    - For each rival: coins, score, letters won, letters spent and revealed tiles.
    - Recent prices by letter tier, and our win rate on contested letters.
  - After a reconnect, state is rebuilt by replaying the match's rows through this function.
- `config/params.json`, with every tunable named. The values get filled in during M5–M7.

**Done when (`npm test` passes):**
- RETAINS scores 21, and RAIN + SET scores 9.
- The list has 172,820 words: 23,109 of 7 letters, 96,702 of 7–10 letters and 28,839 of 2–6 letters. All of these were checked against the module's list today.
- AEINST makes a 7-letter word with 23 different seventh letters, and AEERST and EGINRS with 20 each.
- In a scripted 6-bot match, the unseen total always equals the tiles left in the bag plus the rivals' unrevealed opening tiles. When a rival plays a letter it never won, the tracker records it as a revealed opening tile.
- The index loads in under 1 s, and one pass over the long index for a rack takes under 5 ms.

## M3 — Live bot shell with a fallback brain

**Goal:** tonight's bot from end to end, with everything except the smart brain, playing live with a simple, safe brain. From here on, the live bot is only replaced by a version that passed its gate.

**Depends on:** M1 and M2.

**Build:**
- `src/bot/connection.ts`:
  - Loads the token from `.token-<name>`.
  - On a dropped connection, reconnects after 1, 2 and 4 s, then every 10 s. It then re-subscribes and rebuilds state by replaying the current match's rows through the tracker. No state lives only in memory.
  - `subscribeToAllTables` also downloads every past match. M1 measured this: the subscription took 38 s to apply (25,729 matches, 1.75M auction results and 404k word plays). A reconnect like that would miss more than half a match, so subscribe only to the current match and the small tables. It also slows every lookup the starter does, because each one scans all ~150k `match_participant` rows.
- `src/bot/adapter.ts`: turns Spacetime rows into tracker events. Settings come from each `match_state` row (`auctionType`, `auctionDurationMs`, `startingRackSize`, `bagTotal`), never from constants. The `auction` and `my_rack` tables cover all our matches, so the adapter acts only on the current one.
- `src/bot/sender.ts`:
  - When an auction opens, it sends `bidTable[letter]` within 5 ms, never above the confirmed balance.
  - Sending never waits on the brain. It uses the latest table, and the brain recomputes after the send (or in a worker thread). If the recomputed bid differs while the window is still open, the sender resends it; a new bid replaces the old one.
  - A 150 ms watchdog sends the fallback bid if no table exists.
  - It never bids on the last auction.
  - Before calling `submit_word`, it checks each word against the dictionary and the rack. It skips a word already sent for the same rack, though the same word may legally be played twice.
- `src/engine/fallback.ts`: the fallback brain. It bids face value, scaled by how well the letter fits the rack. It plays any 7+ letter word right away, and during the last auction it plays a greedy best split of the rack. It's also what the watchdog falls back to.
- `src/bot/control.ts`: re-reads `control.json` every few seconds. It holds four settings:
  - `lobby`: off means finish the current match, then stay connected and idle.
  - `tournamentId`: register or unregister.
  - `brain`: `fallback` or `v1`.
  - `params`: the params file path.

  Brain and params only switch between matches.
- `src/bot/log.ts`: writes JSONL.
  - One line per auction: letter, our value, our bid, winner, price and decision time in ms.
  - One line per match: score, place, coins left, letters won, words, missed auctions and rejected calls.
  - Flags missed auctions, rejected calls (over balance, invalid word, window closed) and decisions slower than 300 ms.
- Only player calls, per the PRD's fair-play rules: `join_lobby`, `submit_bid`, `submit_word`, `register_for_tournament` and `unregister_from_tournament`.
- Run the bot under a process manager on the host picked in M1, with sleep off. Use pm2 (`npm i -g pm2`; it isn't installed yet), or systemd on a Linux server.

**Done when:**
- It plays 3+ live lobby matches with 0 missed auctions, 0 rejected calls and a p99 send time under 150 ms, according to the logs.
- After every auction, the tracker's count of tiles left matches `bagTotal`, the server's count of tiles left in the bag.
- If the network is pulled mid-match, it reconnects, rebuilds and is bidding again within seconds. If the process is killed, the process manager restarts it and it rejoins.
- With `lobby: off`, it stays connected and idle.

## M4 — Simulator and opponent pool

**Goal:** a local copy of the game that follows the module's code rule for rule, plus copies of the strategies we'll face. Everything after this is measured with it.

**Depends on:** M2. It can be built alongside M3 and M5.

**Build (`src/sim`):**
- `game.ts` copies these rules exactly:
  - The bag counts, and `rackSize` tiles dealt to each bot.
  - A random draw for each auction.
  - One standing bid per bot, where the latest counts, with random tie-breaks.
  - Vickrey: the winner pays the runner-up's bid, or 1 if nobody else bid. First-price: the winner pays its own bid.
  - Unsold letters are discarded, and bids are checked against balances.
  - The same word list and reward rounding.
  - The match ends when the last auction closes, and later words are refused.

  Take the starting coins (100) and the sim bots' logic from `game.ts` instead of assuming them. Each bot sees only the public events and its own rack, through the M2 tracker. A slow-bot model lets some bots miss the first auction.
- The order within each auction is: open, bids, close and price, then each bot may play words. Rewards land before the next auction. Endgame words go in during the last auction's window.
- `opponents/`:
  - The module's three sim bots: they bid face value −1, face value, or face value +2 (+4 for vowels), with ±2 noise, and play the longest 3+ letter word they can after every win.
  - The starter: bids face value +2 for a new letter and plays the longest word on every rack change.
  - A value saver like Bron: 7–15 on 1-point letters and 17–22 on 3–4 point letters; saves for 7+ letter words and cashes one early word.
  - A bot like K-13 that bids on everything: about 30 early on, then 10–25.
  - A selective bidder like TileShark: skips most letters and pays heavily for a few.
  - Any `Brain` plus params file, as a Bingo variant.

  Each copy's prices are drawn from a range, so tuning doesn't fit one fixed opponent.
- `run.ts`: `--table bingo,bron,k13,starter,sim,sim --matches 1000 --type vickrey|first --seed 1 --workers auto`, with worker threads on every core.
  - Reports average score, win rate and average place.
  - Reports share of auctions won, average price by letter tier, coins left and 7+ letter words per match.
  - Reports head-to-head win rate and margin, and decision time.
  - Counts violations: invalid words and bids over balance.

**Done when:**
- The same seed gives the same results.
- 1,000 six-bot matches run in a few minutes. Bingo's time per auction sets this, so budget about 5 ms.
- It matches live play: sim bots average 3–23, as on the leaderboard. A table of top-bot copies prices 1-point letters near the 9–12 coins seen in match #42697. Our starter scores about what it did live in M1.
- If M3 is done, the fallback brain's numbers are recorded as the baseline.

**Result (Nov 7, ~7pm):** [docs/sim-baseline.md](docs/sim-baseline.md). Prices match live within about 10% for letters worth up to 5 points, and 8–10 point letters sell at 74% of the live price. The simulator is easier than the live field for the fallback (about 2× its live score), so compare brains against each other in the same table. Head to head, the fallback loses to the k13 copy 24–481, so the final needs its own mode (M7). The starter wasn't run live long enough to compare.

## M5 — Rack evaluator: what each letter is worth

**Goal:** v(L) = V(R ∪ {L}) − V(R) for all 26 letters, fast and sensible. Every bid and word decision is built on this.

**Depends on:** M2. Measure it in M4's simulator once that exists.

**Build (`src/engine/evaluator.ts`):**
- V(R) adds up the 7–10 letter target words. Each target counts as its reward times the chance of getting its missing letters in time. The top three targets count with weights 1, 0.5 and 0.25, so flexible racks like AEINST score higher than racks that fit one word.
- How to compute that chance: the rest of the bag is a random subset of every tile we haven't seen, including the rivals' hidden tiles. So the odds that the needed copies of a letter come up follow a hypergeometric distribution over the unseen pool and the auctions left. Scale that down by our win rate on contested letters. Treat each letter as independent, and precompute the tables.
- Add small penalties for duplicates (except S and E) and for lopsided vowel counts. If L completes a word right now, add that word's reward.
- V(R) never drops below what the rack would score if played right now (its best word, or a greedy split into words). That keeps late-match values consistent with the endgame.
- Speed: work out each target's missing letters once per rack change, then derive all 26 letter values in one pass. Skip targets missing more letters than can still arrive, or more than a cap set in params.
- Weights, penalties and caps all come from `config/params.json`.

**Done when:**
- On a balanced rack, S is worth more than Q.
- On AEINST, each of the 23 letters that complete a 7-letter word is worth more than J, Q and Y, the only three that don't.
- On the second-to-last auction (the last letter can't be played), a letter is worth exactly how much it raises the rack's best score if played now. For example, S on RETAIN is worth 6, because RETAINS scores 21 and RETAIN scores 15.
- All 26 values take under 50 ms in the worst case (aim for 10 ms typically) for racks of 0–20 letters.
- If M4 is done, a throwaway brain that bids v(L), capped at its coins, beats the fallback brain in the simulator.

**Result (Nov 7, ~8pm):**
- **Passed:** speed (10–15 ms typical, 24 ms worst); S on RETAIN worth exactly 6 at the second-to-last auction; distinct-letter-set targets (87,962).
- **Changed from the PRD:**
  - The fixed 1 / 0.5 / 0.25 weights became a cascade. They over-counted overlapping targets: AEINST was worth 32 and its completers about 2.
  - Missing letters are costed at recent prices times a fading `coinValue`.
  - A bid is v ÷ μ, where μ is what a coin is worth in points (fading to 0). The PRD's v ÷ (1 + λ) assumes leftover money has value, and here it has none.
- **The PRD's two Scrabble checks don't hold here.** Q, Z, X and J make big words (AEINST + Q is one U from ANTIQUES, 51 points), and live prices agree (about 27 for those, 10 for 1-point letters).
- **The sim check failed:** evalbid scored 47–49 against the fallback's 66–69 in live-like tables. The evaluator values a letter by the current rack's targets, so it misses the volume value of cheap common letters (the fallback wins 18% of auctions and plays about 3 words a match). M6 therefore bids max(the fallback's market-following bid, v ÷ μ).

## M6 — Bingo v1 passes its gate and goes live

**Goal:** the full v1 brain, built on the evaluator, proven in the simulator and then playing live.

**Depends on:** M3, M4 and M5.

**Build (`src/engine`):**
- `pacing.ts`: λ rises when coins run low compared with the auctions left and recent prices for contested letters. It falls to 0 over the last ~10 auctions. A reserve floor keeps enough coins for about 3 contested letters and shrinks to 0 near the end.
- `bidding.ts`:
  - Vickrey bid = min(coins − reserve, v ÷ (1 + λ)).
  - First-price uses the same formula until M8, capped at both the richest interested rival's coins + 1 and the recent price for that letter tier + 1.
  - Bid at least 1 on any letter with value.
  - Bid immediately on the first auction. Nobody bid on it in either match we checked, so a fast bid usually gets it for 1 coin.
  - Never bid on the last letter. Bids are whole coins and never above the confirmed balance.
- `bidtable.ts`: rebuilds the 26 bids within 50 ms of any change (rack, coins, rival coins, an auction closing).
- `planner.ts`:
  - Play a word when its reward plus V(rack after) beats V(rack now). This is Maven's rule. Coins count for more when λ is high.
  - 7+ letter words go out as soon as no longer word is likely in time. Shorter words go out only when coins are below the reserve and the word doesn't break a nearly complete long word, like Bron's AGREED.
  - Endgame: from 3 auctions out, keep the highest-scoring split of the rack into words ready, searching both indexes. Send all of it in the first few hundred ms of the last auction. If the search runs long, fall back to greedy.
- `brainV1.ts` implements `Brain`, and every number lives in `config/params.json`.
- Shadow mode while building: the live bot plays the fallback brain and logs v1's bid next to it. That catches crashes and slow decisions on real auctions before the gate.

**Gate (simulator, 1,000+ matches):**
- At least double the starter's average score in mixed Vickrey tables.
- Zero invalid words and zero bids over balance.
- Beats the fallback brain.
- First-price tables run without violations, even if v1 isn't strong there yet.

**Done when:** the gate passes, `control.json` is switched to `brain: v1`, and v1 has played 3+ live lobby matches with clean logs.

**Result (Nov 7, ~8:30pm):**
- **v1 as built:** it bids whichever is larger, the fallback's market-following bid or v ÷ μ under a pacing cap, and uses the PRD's safe rule in first-price auctions. It plays words like the fallback, plus a better endgame split (the top 25 opening words, each finished greedily).
- **Gate:** passed, with 0 violations in 2,100 matches.
  - Mixed Vickrey: **131.2** against the starter's 10.1, and v1 wins 79%.
  - Live-like with the fallback at the table: **89.8** against 44.2.
  - First-price: 75.8, clean.
- **Head to head vs k13:** 163–313, and v1 wins 23% (the fallback won 0.2%). That's M7's job.
- **Live:** v1 went live at 8:25pm. Match 45063 scored 51 (5th), match 45069 scored 94 (2nd, 11 coins left, p99 22 ms), and match 45075 scored 78 (3rd). That averages 74; the fallback averaged 31 live. All had 0 missed auctions, and no rejected calls since the fix below.
- **Fixed during go-live:** no bid updates in the last 150 ms of a window. One arrived after the close and was refused.

Details are in [docs/sim-baseline.md](docs/sim-baseline.md).

## M7 — Tuning for Swiss, bracket and final

**Goal:** params tuned for how tonight is actually played: 6-bot Swiss tables, the bracket where last place is knocked out, and the 3-game head-to-head final.

**Depends on:** M6.

**Build:**
- Calibrate first. Compare v1's live average over 10+ lobby matches with the simulator's prediction for similar tables. A gap over 15% means the simulator is wrong about something, so fix it before tuning anything.
- `src/sim/tune.ts`: sweeps about 8 params (target weights, pacing schedule, reserve size and cash-a-word threshold; the first-price margin belongs to M8). Screen candidates on 200 matches and confirm the best three on 1,000+, across every core. Use the same seeds for every candidate: comparing them on identical matches cuts the noise a lot. Writes params files and a results CSV.
- Swiss params: 6-bot Vickrey tables, against the mixed pool with its randomized opponents.
- Final params: 2 bots, 88 auctions.
  - Keep more coins than the rival, because once it runs dry every letter costs 1.
  - Contest every useful letter, and plan for many long words (K-13 played 11 in one game).
  - Tune against each copy.
- Bracket tweak: late in a match and near the bottom, cash safer words. When well clear of last place, play for score.
- Phase switching: look the match up in `tournament_match` to get its `phase` (Swiss, Bracket or Final), check the participant count, and load that phase's params. Lobby matches use the Swiss params.

**Done when:**
- Results are recorded against the PRD's targets: 35%+ wins in 6-bot tables against the top-bot copies (2,000 matches), and 90%+ head-to-head against each copy (1,000 each). Adopt the best params even if a target is missed.
- Phase switching is unit-tested with fake tournament rows.
- The tuned params are live in lobby matches with clean logs.

**Result (Nov 7, ~9:10pm), cut to the final, as the "what to drop" rules allow:**
- **New knobs:** `pacing.spreadOver` and `bidding.contestFloor`. v1 picks params by phase: the live tournament_match phase if there is one, otherwise a 2-bot table is played as the final.
- **Final head to head**, 150 matches each, same seeds:

  | Variant | vs k13 | vs bron | vs tileshark |
  |---|---|---|---|
  | Before | wins 20% (−148) | 27% (−132) | 100% |
  | **f2: spreadOver 30, contestFloor 1.0** | **48% (−45)** | **51% (−40)** | 100% |

  Cheaper coins (coinValue 0.3–0.4) collapsed it to 4–19%, from overpaying. f2 is now `phases.final`.
- **Swiss (sweep at ~7pm, once the real time was known):** six variants at 200 matches, then the best confirmed on new seeds. The new defaults are spreadOver 20 and contestFloor 0.8:

  | Table | Before | New defaults |
  |---|---|---|
  | Live-like, 800 matches | 87.5, wins 67% | **91.4, wins 75%** |
  | Mixed, 400 matches | 129.2, wins 77% | **134.5, wins 82.5%** |

  Changing coinValue alone (0.5 or 0.8) did nothing useful. In the final, contesting at 1.5–2× the price dropped wins to 5–23%, so f2 stays. **Not done:** the bracket tweak (bracket matches use the Swiss params).
- **From the live logs (~7:30pm):** v1 won only 9–11% of 4–10 point letters, losing them by 8–12 coins, though its best games were built on them.
  - **Fix 1, `tournament-3`:** `pacing.tierAllowance` [1, 1.2, 1.6, 2.4] lets pricier letters take a bigger share of the cap. Live-like tables, 600 fresh matches: 92.0 and 72% wins, against 90.3 and 69%. Neutral head to head, so the final keeps a flat allowance.
  - **Fix 2, `tournament-4`:** `pacing.slackShare` spends down excess coins. It was flat or slightly worse in 6-bot tables, so it's off there. In the final, which is decided by total score, 400 fresh matches gave margins of −31.8 against −35.3 vs k13 and −34.4 against −51.9 vs bron, so it's on for the final only.

## M8 — Rival model and first-price shading (only if tonight is first-price)

**Goal:** stop overpaying when the winner pays its own bid.

**Depends on:** M6. Check the `tournament` row's `auctionType` as soon as the row exists. If it's Vickrey, skip M8. If it's FirstPrice, do M8 before M7.

**Build:**
- Rival model:
  - From the tracked letters, flag any rival that's one letter short of a long word, and expect it to bid high on that letter.
  - Build a bid model for each bot from `auction_top_bid_archive` (published after each match) and from Vickrey prices, which equal the runner-up's bid (a price of 1 can also mean nobody else bid). Carry it across Swiss rounds.
- First-price bid = min(v ÷ (1 + λ), predicted top rival bid + 1, richest interested rival's coins + 1).
- Tune the first-price margin in first-price simulator tables.

**Done when:** in first-price tables, Bingo pays less per letter than with M6's version and wins at least as often. Vickrey results are unchanged.

## M9 — Reliability drills, live check, freeze (by 10:00pm)

**Goal:** the frozen version is the one that runs, and it survives anything short of losing the host machine.

**Depends on:** M6, plus M7 and M8 if they're done.

**Build and do:**
- The final host runs the bot under the process manager. A standby machine has the same build and its own token, and stays stopped until it's needed: two live copies would both bid and play words.
- Run these drills, each in the middle of a match: kill the process; drop the network for about 10 s; restart during the last auction (the endgame fallback must still play the rack). Each should cost at most the auction that was in progress.
- Check 30+ live matches for:
  - An average score of 130+ (the PRD's target).
  - 0 missed auctions and 0 rejected calls.
  - A p99 decision time under 150 ms.
  - Live results within 15% of the simulator's prediction.
- Freeze at 10:00pm: tag the commit, commit the params file and run only that build. Finish the README: how Bingo works, credit for the starter kit, and the AI tools used.

**Done when:** the drills pass, the tag is pushed, and the standby starts and connects in under a minute.

## M10 — Register, go idle, play the tournament

**Depends on:** M9.

- Make the repo public first. It's private until then so rivals can't read the plan, but it has to be public to qualify. Run `gh repo edit rajatsxngh/bingo-scrabblebot --visibility public --accept-visibility-change-consequences`. If the booth says it must be public sooner, do it then.
- When tonight's `tournament` row shows the Registration status, set `tournamentId` in `control.json`. Confirm the bot appears on the tournament page and in `tournament_entry`.
- By 10:30pm, set `lobby: off`. The bot finishes its current match, then stays connected and idle. The admin can't start the tournament while a registered bot is mid-match.
- During play, watch the logs for phase switches (Swiss, then Bracket, then Final params), missed auctions and reconnects. Touch only the frozen build: restart it, or switch to the standby.
- The Devpost draft deadline (11:00–11:15pm) falls during the tournament. One person submits the draft with the repo link while another watches the bot.

**Done when:** the bot is registered and idle by 10:30pm, and the tournament plays out with 0 missed auctions.

---

## What to drop when behind

- A version that passed its gate always beats one that hasn't been tested. If v1 hasn't passed its gate by about 8:30pm, the fallback brain plays tonight and M7 shrinks to Swiss params only.
- Do M8 only if tonight is first-price.
- No new features after 9:30pm. From then on, work only on M9 and M10.
- To trim M7, drop the bracket tweak first, then shrink the sweep sizes. Keep the final's params.

## Where each PRD target is checked

| PRD target | Checked in |
|---|---|
| Zero invalid words and zero bids over balance in 1,000 simulated matches; double the starter's score | M6 gate |
| 35%+ wins in simulated 6-bot tables against the top-bot copies | M7 |
| 90%+ wins head-to-head | M7 |
| Bids decided in under 150 ms for 99% of auctions | M3, M5, M6, M9 |
| Zero missed auctions while online | M3, M9, M10 |
| Live average of 130+ over 30+ matches | M9 |
| Registered and idle by 10:30pm | M10 |

## Booth questions

These come from the PRD, plus one new question at the end:

- What is the tournament ID, and when does registration open?
- Which auction type, match size, auction window and opening rack size will tonight use? (These can also be read from the `tournament` row once it exists.)
- How many Swiss rounds will there be, and how many bots make the cut?
- Can bots from earlier events (K-13, LUCENT, Bron and others) enter?
- Does the bot need its own Devpost entry, and can one team win both Spacetime tracks?
- What is the booth access code for?
- New: does the repo have to be public before the tournament, or only at submission?
