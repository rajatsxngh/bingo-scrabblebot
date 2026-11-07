// Bingo: live bot entry point (Milestone 1 baseline).
//
// This is the connection code from the clockworklabs ScrabbleBot starter kit
// (bot-starter/src/index.ts, MIT; see NOTICE.md), with these changes:
//   - The word list and token file are found from this file's location, so
//     they load on Windows too. The starter's URL.pathname version silently
//     loaded zero words there. The bot now exits if the word list is missing.
//   - It logs how long connecting and the first subscription take.
//   - On connect it prints the matchmaker settings and any tournaments.
//   - It saves its token only once the token is known to belong to a bot.
// Bidding and word choice are still the starter's (./strategy.ts).
// Milestone 3 replaces this file with the full live shell.
//
// First run, with a token from the Team page ("Generate token"):
//   bash:        BOT_TOKEN=<token> npm start
//   PowerShell:  $env:BOT_TOKEN="<token>"; npm start
// Or paste the token into a file named .token-bingo in the repo root.
// The bot keeps its token in .token-<BOT_NAME> (gitignored), so later runs
// need only `npm start`. BOT_NAME defaults to "bingo".
//
// To enter a tournament, run TOURNAMENT_ID=<id> npm start. The bot registers
// when it connects. Only the bot itself can register.

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chooseWord, decideBid } from "./strategy.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bingo";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;

// Repo root, found from this file so it works from any working directory
// (a process manager may start the bot elsewhere).
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TOKEN_PATH = path.join(ROOT, `.token-${BOT_NAME}`);
const WORDLIST_PATH = path.join(ROOT, "data", "wordlist.txt");
const EXPECTED_WORDS = 172_820;

const log = (msg: string) => console.log(`[${BOT_NAME}] ${msg}`);
const fail = (msg: string) => console.error(`[${BOT_NAME}] ${msg}`);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

// The module's word list (ENABLE), copied into data/.
const DICTIONARY = loadDictionary();

function loadDictionary(): string[] {
  let text: string;
  try {
    text = fs.readFileSync(WORDLIST_PATH, "utf8");
  } catch {
    fail(`can't read the word list at ${WORDLIST_PATH}`);
    process.exit(1);
  }
  const words = text
    .split("\n")
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l.length >= 2);
  if (words.length === 0) {
    fail(`the word list at ${WORDLIST_PATH} is empty`);
    process.exit(1);
  }
  words.sort((a, b) => b.length - a.length); // longest first for greedy pick
  const note =
    words.length === EXPECTED_WORDS ? "" : ` (expected ${EXPECTED_WORDS})`;
  log(`loaded ${words.length} words${note}`);
  return words;
}

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
let sessionToken: string | null = null;
const bidsByAuction = new Set<string>();
const lastWordAttemptByMatch = new Map<string, number>();
const WORD_RETRY_MS = 500;

// Timings that Milestone 3's reconnect design depends on.
let startedAt = 0;
let connectedAt = 0;
const since = (t: number) => `${Math.round(performance.now() - t)} ms`;

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function rackForMatch(
  conn: DbConnection,
  matchId: bigint,
): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  if (myBotId === null) return null;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId !== myBotId) continue;
    return { balance: Number(p.balance), score: Number(p.score) };
  }
  return null;
}

// A reducer call fails when the module refuses it, often for an expected
// reason: a word played just after its match ended, a bid that missed the
// auction's window. Log it and keep playing; an uncaught failure would stop
// the bot.
function logFailure(what: string) {
  return (err: unknown) =>
    console.warn(
      `[${BOT_NAME}] ${what} failed: ${err instanceof Error ? err.message : err}`,
    );
}

function tryBid(
  conn: DbConnection,
  auctionId: bigint,
  matchId: bigint,
  letter: string,
) {
  if (myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  if (bidsByAuction.has(key)) return;
  const participant = participantForMatch(conn, matchId);
  if (!participant) return;
  const amount = decideBid({
    letter,
    myBalance: participant.balance,
    myRack: rackForMatch(conn, matchId),
  });
  if (amount <= 0) return;
  conn.reducers
    .submitBid({ auctionId, amount: BigInt(amount) })
    .catch(logFailure(`bid on auction ${auctionId}`));
  bidsByAuction.add(key);
  log(`bid ${amount} on '${letter}' (match ${matchId}, auction ${auctionId})`);
}

function tryPlayWord(conn: DbConnection) {
  if (myBotId === null) return;
  // Only matches still being played. The bot keeps its letters from
  // matches that have ended, but can't play them.
  const matches = new Set<bigint>();
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = conn.db.matchState.id.find(p.matchId);
    if (m?.status.tag === "Running") matches.add(p.matchId);
  }
  const now = Date.now();
  for (const matchId of matches) {
    const key = String(matchId);
    if (now - (lastWordAttemptByMatch.get(key) ?? 0) < WORD_RETRY_MS) continue;
    lastWordAttemptByMatch.set(key, now);
    const word = chooseWord({
      myRack: rackForMatch(conn, matchId),
      dictionary: DICTIONARY,
    });
    if (!word) continue;
    log(`match ${matchId}: playing '${word}'`);
    conn.reducers
      .submitWord({ matchId, word })
      .catch(logFailure(`playing '${word}'`));
  }
}

// Settings the admin controls. Once tonight's tournament exists, its row
// shows the auction type, table size, Swiss rounds and how many advance.
function reportServerState(conn: DbConnection) {
  if (conn.db.matchmakerConfig.count() === 0n) {
    log("no matchmaker_config row, so the module's built-in defaults apply");
  }
  for (const c of conn.db.matchmakerConfig.iter()) {
    log(
      `matchmaker: ${c.startingRackSize}-tile opening racks, ` +
        `lobbies of up to ${c.lobbyMaxSize}, ${c.auctionDurationMs} ms auctions`,
    );
  }
  const tournaments = Array.from(conn.db.tournament.iter()).sort((a, b) =>
    a.id < b.id ? 1 : -1,
  );
  if (tournaments.length === 0) log("no tournaments on the server");
  for (const t of tournaments.slice(0, 5)) {
    log(
      `tournament ${t.id}: ${t.status.tag}, ${t.auctionType.tag}, ` +
        `tables of ${t.matchSize}, ${t.swissRoundsTotal} Swiss rounds, ` +
        `top ${t.topCut} advance, round ${t.currentRound}`,
    );
  }
  log(
    `subscription holds ${conn.db.matchState.count()} matches, ` +
      `${conn.db.auctionResult.count()} auction results, ` +
      `${conn.db.wordPlay.count()} word plays`,
  );
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  sessionToken = token;
  connectedAt = performance.now();
  log(`connected as ${identity.toHexString()} after ${since(startedAt)}`);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      log(`subscription applied ${since(connectedAt)} after connecting`);
      reportServerState(conn);

      // Resolve our bot id, possibly after claiming a nonce.
      myBotId = resolveMyBotId(conn);
      if (myBotId !== null) {
        startPlaying(conn);
        return;
      }
      if (!BOT_NONCE) {
        fail(
          "no BotCredential for this token. Set BOT_TOKEN (from the Team page) or BOT_NONCE and re-run.",
        );
        process.exit(1);
      }
      log("claiming credential with nonce…");
      conn.reducers
        .claimCredential({ code: BOT_NONCE })
        .catch(logFailure("claiming the credential"));
      // Wait briefly for the credential to land; check again.
      setTimeout(() => {
        myBotId = resolveMyBotId(conn);
        if (myBotId === null) {
          fail("couldn't claim credential. Bad / expired nonce?");
          process.exit(1);
        }
        startPlaying(conn);
      }, 1000);
    })
    .subscribeToAllTables();

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  });
  conn.db.myRack.onInsert(() => tryPlayWord(conn));
  conn.db.myRack.onUpdate(() => tryPlayWord(conn));
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (myBotId === null) return;
    const winner =
      r.winnerBotId !== undefined && r.winnerBotId !== null
        ? String(r.winnerBotId)
        : "no-bid";
    log(
      `match ${r.matchId} auction ${r.auctionId} '${r.letter}' → bot ${winner} paid ${r.paid}`,
    );
  });

  // When a match this bot was in ends, hop back into the lobby.
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = Array.from(conn.db.matchParticipant.iter()).some(
        (p) => p.matchId === neu.id && p.botId === myBotId,
      );
      if (wasIn) {
        log(`match ${neu.id} ended; rejoining lobby`);
        joinLobby(conn);
      }
    }
  });
}

// The token belongs to a bot, so it's worth keeping for later runs.
function startPlaying(conn: DbConnection) {
  if (sessionToken) saveToken(sessionToken);
  const bot = myBotId !== null ? conn.db.bot.id.find(myBotId) : undefined;
  log(`acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`);
  bootstrapActivity(conn);
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
  const inRunning = Array.from(conn.db.matchParticipant.iter()).some((p) => {
    if (p.botId !== myBotId) return false;
    const m = conn.db.matchState.id.find(p.matchId);
    return m?.status.tag === "Running";
  });
  if (inRunning) return;
  const openLobby = Array.from(conn.db.lobby.iter()).find(
    (l) => l.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.lobbyMember.iter()).some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId,
    );
  if (alreadyIn) return;
  log("joining lobby");
  conn.reducers.joinLobby({}).catch(logFailure("joining the lobby"));
}

function bootstrapActivity(conn: DbConnection) {
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() => log(`registered for tournament ${TOURNAMENT_ID}`))
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  joinLobby(conn);
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  }
  tryPlayWord(conn);
}

function main() {
  log(`connecting to ${DB_NAME} at ${HOST}`);
  startedAt = performance.now();
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) =>
      fail(`connect error: ${err.message}`),
    )
    .onDisconnect(() => log("disconnected"))
    .build();
}

main();
