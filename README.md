# Bingo

Bingo is our bot for the [ScrabbleBot](https://scrabblebot.spacetimedb.com) tournament at HackUTD 2026 (Spacetime challenge). In the game, bots bid coins in sealed auctions for one letter at a time and score by playing words. Long words pay up to 3×.

**Status:** Milestone 3. The live bot runs on our own connection layer with a simple fallback brain. It subscribes only to its own match, reconnects and rebuilds after a drop, and logs every auction. [MILESTONES.md](MILESTONES.md) has the full plan.

## Run it

You need Node 20 or later.

```bash
npm install
npm test
```

For the first run, generate a token on the site's Team page ("Generate token"), then:

```bash
BOT_TOKEN=<token> npm start
```

In PowerShell, use `$env:BOT_TOKEN="<token>"; npm start`. You can also paste the token into a file named `.token-bingo` in the repo root.

The bot keeps its token in `.token-<BOT_NAME>`, which git ignores. `BOT_NAME` defaults to `bingo`, so later runs need only `npm start`. The token is the long one shown under "Token — save this", not the 64-character identity above it.

### Switches

While the bot runs, edit `control.json` (created on first run, and ignored by git). Changes take effect within 2 seconds, without a restart:

```json
{ "lobby": true, "tournamentId": null, "brain": "fallback", "params": "config/params.json" }
```

- `lobby: false`: the bot finishes its current match, then stays connected and idle.
- `tournamentId`: the bot registers for that tournament. Set it back to `null` to unregister.
- `brain` and `params`: these switch between matches.

### Logs

`logs/bingo-<date>.jsonl` has a line per auction (letter, our bid, winner, price) and a summary per match (score, place, coins left, missed auctions, rejected calls, p99 decision time). Anything that needs a look is written as a `flag` line.

## Layout

- `src/core/`: the game rules, word index and state tracker, shared by the bot and the simulator
- `src/bot/`: the live bot: connection, the match session (event ordering, bids, words), control file, logs, and the generated SpacetimeDB bindings
- `src/engine/`: brains. So far only the fallback; the evaluator and Bingo v1 come in M5–M6.
- `src/sim/`: the simulator (M4)
- `config/params.json`: every tunable
- `data/wordlist.txt`: the module's word list (172,820 words)
- `test/`: tests

## Credits

- Built on the [ScrabbleBot starter kit](https://github.com/clockworklabs/scrabblebot) by Clockwork Labs (MIT). The connection code, the generated bindings and the word list come from it. See [NOTICE.md](NOTICE.md).
- AI coding tools used: Claude Code (Anthropic).
