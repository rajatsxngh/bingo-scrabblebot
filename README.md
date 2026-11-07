# Bingo

Bingo is our bot for the [ScrabbleBot](https://scrabblebot.spacetimedb.com) tournament at HackUTD 2026 (Spacetime challenge). In the game, bots bid coins in sealed auctions for one letter at a time and score by playing words. Long words pay up to 3×.

**Status:** Milestone 1. The bot runs the starter kit's strategy from this repo. [MILESTONES.md](MILESTONES.md) has the full plan.

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

The bot keeps its token in `.token-<BOT_NAME>`, which git ignores. `BOT_NAME` defaults to `bingo`, so later runs need only `npm start`. To enter a tournament, add `TOURNAMENT_ID=<id>`.

## Layout

- `src/bot/`: the live bot, with its connection code and the generated SpacetimeDB bindings
- `src/core/`, `src/engine/`, `src/sim/`: game core, strategy engine and simulator, which arrive in later milestones
- `data/wordlist.txt`: the module's word list (172,820 words)
- `test/`: tests

## Credits

- Built on the [ScrabbleBot starter kit](https://github.com/clockworklabs/scrabblebot) by Clockwork Labs (MIT). The connection code, the generated bindings and the word list come from it. See [NOTICE.md](NOTICE.md).
- AI coding tools used: Claude Code (Anthropic).
