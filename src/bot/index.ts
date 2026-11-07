// Bingo: the live bot (Milestone 3 shell).
//
// Connects with the token in .token-<BOT_NAME>, subscribes only to what it
// needs (the full history takes ~38 s to download), turns table changes into
// tracker events, and sends the brain's bids and words. Built on the
// clockworklabs starter kit's connection code (MIT; see NOTICE.md).
//
// First run, with a token from the Team page ("Generate token"):
//   bash:        BOT_TOKEN=<token> npm start
//   PowerShell:  $env:BOT_TOKEN="<token>"; npm start
// or save the token in .token-bingo in the repo root. BOT_NAME defaults to
// "bingo". Tonight's switches (lobby, tournament, brain) live in control.json.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Identity } from "spacetimedb";
import { loadParams } from "../core/params.js";
import { NUM_LETTERS, letterIndex, matchSettings } from "../core/rules.js";
import { deriveOpening } from "../core/tracker.js";
import type { Brain, GameEvent } from "../core/types.js";
import { wordIndex } from "../core/words.js";
import { FallbackBrain } from "../engine/fallback.js";
import { Control, type ControlSettings } from "./control.js";
import { Log } from "./log.js";
import { DbConnection, type ErrorContext } from "./module_bindings/index.js";
import { Session } from "./session.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bingo";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TOKEN_PATH = path.join(ROOT, `.token-${BOT_NAME}`);
const CONTROL_PATH = path.join(ROOT, process.env.CONTROL ?? "control.json");

const log = new Log(path.join(ROOT, "logs"), BOT_NAME);
const index = wordIndex();
log.info(`loaded ${index.totalWords} words`);
const fallback = new FallbackBrain(index);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function makeBrain(name: string): Brain {
  if (name !== "fallback") log.flag("unknown brain, using fallback", { brain: name });
  return fallback;
}

// ---------- State ----------

let conn: DbConnection | null = null;
let myIdentity: Identity | null = null;
let me: bigint | null = null;
let sessionToken: string | null = null;
let control: Control;
let registeredFor: string | null = null;

interface Live {
  matchId: bigint;
  session: Session | null; // null until the match subscription is applied
  unsubscribe: () => void;
  isTournament: boolean;
}
let live: Live | null = null;
let flushScheduled = false;
let rackDirty = false;
/** Auctions we answered (or decided not to), across reconnect rebuilds. */
const handled = new Set<number>();
const stats = { missed: 0, rejected: 0, bids: 0, slow: 0, decisionMs: [] as number[] };

const num = (x: bigint) => Number(x);
/**
 * When this process started (before loading anything), to tell auctions we
 * missed from ones before our time. Gaps between a crash and the restart are
 * invisible to it; M9 adds a heartbeat file for that.
 */
const processStartedAt = Math.floor(performance.timeOrigin);
/** Tournaments that existed when we connected, so only new ones are announced. */
const knownTournaments = new Set<bigint>();
let startedAt = 0;
const since = (t: number) => `${Math.round(performance.now() - t)} ms`;

// ---------- Reducer calls ----------

function call(what: string, p: Promise<unknown>) {
  p.catch((err: unknown) => {
    stats.rejected++;
    log.flag("rejected call", { what, error: err instanceof Error ? err.message : String(err) });
  });
}

// ---------- Matches ----------

/** Follow our newest match: subscribe to its tables only. */
function openMatch(matchId: bigint) {
  if (!conn || me === null) return;
  if (live && live.matchId >= matchId) return;
  live?.unsubscribe();
  const id = String(matchId);
  const handle = conn
    .subscriptionBuilder()
    .onApplied(() => rebuild(matchId))
    .onError((_ctx: ErrorContext) => log.flag("match subscription failed", { matchId: id }))
    .subscribe([
      `SELECT * FROM match_state WHERE id = ${id}`,
      `SELECT * FROM match_participant WHERE match_id = ${id}`,
      `SELECT * FROM auction WHERE match_id = ${id}`,
      `SELECT * FROM auction_result WHERE match_id = ${id}`,
      `SELECT * FROM word_play WHERE match_id = ${id}`,
      `SELECT * FROM tournament_match WHERE match_id = ${id}`,
    ]);
  live = {
    matchId,
    session: null,
    isTournament: false,
    unsubscribe: () => {
      try {
        handle.unsubscribe();
      } catch {
        /* already gone */
      }
    },
  };
}

/** Build the session from the subscribed rows; runs on first apply and after every reconnect. */
function rebuild(matchId: bigint) {
  if (!conn || me === null || !live || live.matchId !== matchId) return;
  const db = conn.db;
  const m = db.matchState.id.find(matchId);
  if (!m || m.status.tag !== "Running") {
    live.unsubscribe();
    live = null;
    maybeJoinLobby();
    return;
  }
  const participants = [...db.matchParticipant.iter()].filter((p) => p.matchId === matchId);
  const settings = matchSettings({
    auctionType: m.auctionType.tag,
    numBots: participants.length,
    rackSize: m.startingRackSize,
    windowMs: Number(m.auctionDurationMs),
  });

  const rack = rackFor(matchId);
  const won = new Uint8Array(NUM_LETTERS);
  const spent = new Uint8Array(NUM_LETTERS);
  const results = [...db.auctionResult.iter()].filter((r) => r.matchId === matchId);
  const words = [...db.wordPlay.iter()].filter((w) => w.matchId === matchId);
  for (const r of results) if (r.winnerBotId === me) won[letterIndex(r.letter)]++;
  for (const w of words) {
    if (w.botId !== me) continue;
    for (const c of w.word) spent[letterIndex(c)]++;
  }

  const params = loadParams(path.join(ROOT, control.current.params));
  const session = new Session(
    {
      settings,
      me: num(me),
      bots: participants.map((p) => num(p.botId)),
      opening: deriveOpening(rack, won, spent),
    },
    makeBrain(control.current.brain),
    fallback,
    index,
    params.tracker.priceAlpha,
  );

  // Replay in game order: closes before words that share a timestamp.
  type Timed = { at: bigint; rank: number; e: GameEvent };
  const timed: Timed[] = [
    ...results.map((r) => ({ at: r.closedAt.microsSinceUnixEpoch, rank: 0, e: closedEvent(r) })),
    ...words.map((w) => ({ at: w.playedAt.microsSinceUnixEpoch, rank: 1, e: wordEvent(w) })),
  ];
  timed.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.rank - b.rank));
  let missedNow = 0;
  for (const t of timed) {
    session.push(t.e);
    if (t.e.type !== "auctionClosed" || handled.has(t.e.auctionId)) continue;
    // Closed while this process was up but before we could answer: a miss
    // (a dropped connection or a restart). Earlier closes are just history.
    if (Number(t.at / 1000n) >= processStartedAt) missedNow++;
    handled.add(t.e.auctionId);
  }
  if (missedNow > 0) {
    stats.missed += missedNow;
    log.flag("missed auctions while rejoining", { matchId, missed: missedNow });
  }
  for (const p of participants) session.push(balanceEvent(p));
  session.push({ type: "rackChanged", rack });
  for (const a of db.auction.iter()) {
    if (a.matchId === matchId && a.status.tag === "Open") {
      session.push({ type: "auctionOpened", auctionId: num(a.id), letter: letterIndex(a.letter) });
    }
  }
  const tm = [...db.tournamentMatch.iter()].find((t) => t.matchId === matchId);
  live.isTournament = tm !== undefined;
  live.session = session;
  log.record(
    "match",
    {
      matchId,
      bots: participants.length,
      auctionType: settings.auctionType,
      windowMs: settings.windowMs,
      rackSize: settings.rackSize,
      phase: tm?.phase.tag ?? "lobby",
      auctionsClosed: results.length,
    },
    `match ${matchId}: ${participants.length} bots, ${settings.auctionType}, ` +
      `${tm ? `tournament ${tm.phase.tag}` : "lobby"}` +
      (results.length ? ` (rejoined after ${results.length} auctions)` : ""),
  );
  flush();
}

function rackFor(matchId: bigint): Uint8Array {
  const rack = new Uint8Array(NUM_LETTERS);
  if (!conn) return rack;
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId === matchId) rack[letterIndex(h.letter)] += h.count;
  }
  return rack;
}

type ResultRow = { auctionId: bigint; letter: string; winnerBotId: bigint | undefined; paid: bigint };
type WordRow = { id: bigint; botId: bigint; word: string; totalReward: bigint };
type ParticipantRow = { botId: bigint; balance: bigint; score: bigint };

function closedEvent(r: ResultRow): GameEvent {
  return {
    type: "auctionClosed",
    auctionId: num(r.auctionId),
    letter: letterIndex(r.letter),
    winner: r.winnerBotId === undefined || r.winnerBotId === null ? null : num(r.winnerBotId),
    paid: num(r.paid),
  };
}
function wordEvent(w: WordRow): GameEvent {
  return { type: "wordPlayed", id: num(w.id), bot: num(w.botId), word: w.word, reward: num(w.totalReward) };
}
function balanceEvent(p: ParticipantRow): GameEvent {
  return { type: "balanceChanged", bot: num(p.botId), coins: num(p.balance), score: num(p.score) };
}

/** Queue an event for our live match and flush once this transaction's callbacks are done. */
function push(matchId: bigint, e: GameEvent | null) {
  if (!live?.session || live.matchId !== matchId) return;
  if (e) live.session.push(e);
  if (!flushScheduled) {
    flushScheduled = true;
    queueMicrotask(flush);
  }
}

function flush() {
  flushScheduled = false;
  if (!conn || !live?.session) return;
  const { session, matchId } = live;
  if (rackDirty) {
    rackDirty = false;
    session.push({ type: "rackChanged", rack: rackFor(matchId) });
  }
  const d = session.flush();
  const s = session.state;

  // The tracker's tiles-left must agree with the server's bag count.
  const m = conn.db.matchState.id.find(matchId);
  if (m && m.status.tag === "Running" && m.bagTotal !== s.bagRemaining) {
    log.flag("tiles left disagree with the server", { matchId, tracker: s.bagRemaining, server: m.bagTotal });
  }

  for (const b of d.bids) {
    handled.add(b.auctionId);
    stats.bids++;
    stats.decisionMs.push(b.decisionMs);
    if (b.decisionMs > 300) {
      stats.slow++;
      log.flag("slow decision", { auctionId: b.auctionId, ms: b.decisionMs });
    }
    call(`bid ${b.amount} on auction ${b.auctionId}`, conn.reducers.submitBid({ auctionId: BigInt(b.auctionId), amount: BigInt(b.amount) }));
  }
  if (s.current) handled.add(s.current.auctionId); // decided, even if the decision was 0
  for (const w of d.words) {
    log.record("word", { matchId, word: w }, `playing ${w}`);
    conn.reducers.submitWord({ matchId, word: w }).catch((err: unknown) => {
      stats.rejected++;
      log.flag("rejected call", { what: `word ${w}`, error: err instanceof Error ? err.message : String(err) });
      session.wordRejected(w); // its letters are free again
    });
  }
  if (d.brainError) log.flag("brain threw, fallback answered", { error: d.brainError });

  for (const c of d.closed) {
    const missed = !handled.has(c.auctionId);
    if (missed) {
      stats.missed++;
      log.flag("missed auction", { matchId, auctionId: c.auctionId });
    }
    const rec = s.history.find((h) => h.auctionId === c.auctionId);
    log.record("auction", {
      matchId,
      auctionId: c.auctionId,
      letter: String.fromCharCode(65 + c.letter),
      myBid: rec?.myBid ?? 0,
      winner: c.winner,
      won: c.winner === s.me,
      paid: c.paid,
      coins: s.coins,
    });
  }

  if (d.ended) endMatch();
}

function endMatch() {
  if (!live?.session) return;
  lastJoinError = ""; // log the next lobby join
  const s = live.session.state;
  const scores = [{ id: s.me, score: s.score }, ...[...s.rivals.values()].map((r) => ({ id: r.id, score: r.score }))];
  const place = 1 + scores.filter((x) => x.score > s.score).length;
  const times = [...stats.decisionMs].sort((a, b) => a - b);
  const p99 = times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.99))]! : 0;
  log.record(
    "matchSummary",
    {
      matchId: live.matchId,
      score: s.score,
      place,
      bots: scores.length,
      coinsLeft: s.coins,
      lettersWon: s.history.filter((h) => h.winner === s.me).length,
      words: s.words.filter((w) => w.bot === s.me).map((w) => w.word),
      missed: stats.missed,
      rejected: stats.rejected,
      p99DecisionMs: Math.round(p99 * 10) / 10,
      tournament: live.isTournament,
    },
    `match ${live.matchId} over: ${s.score} points, place ${place}/${scores.length}, ` +
      `${s.coins} coins left, missed ${stats.missed}, rejected ${stats.rejected}, p99 ${p99.toFixed(1)} ms`,
  );
  stats.missed = 0;
  stats.rejected = 0;
  stats.decisionMs = [];
  live.unsubscribe();
  live = null;
  maybeJoinLobby();
}

// ---------- Lobby and tournament ----------

let lastJoin = 0;
let lastJoinError = "";
function maybeJoinLobby() {
  if (!conn || me === null || !control.current.lobby || live) return;
  if (Date.now() - lastJoin < 10_000) return;
  lastJoin = Date.now();
  conn.reducers
    .joinLobby({})
    .then(() => {
      if (lastJoinError !== "joined") log.info("in the lobby, waiting for a match");
      lastJoinError = "joined";
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== lastJoinError) log.info(`lobby: ${msg}`);
      lastJoinError = msg;
    });
}

function applyControl(next: ControlSettings, prev: ControlSettings) {
  log.record("control", { ...next }, `control: lobby ${next.lobby ? "on" : "off"}, tournament ${next.tournamentId ?? "none"}, brain ${next.brain}`);
  if (!conn || me === null) return;
  syncTournament();
  if (next.lobby && !prev.lobby) maybeJoinLobby();
}

function syncTournament() {
  if (!conn || me === null) return;
  const want = control.current.tournamentId;
  if (want === registeredFor) return;
  if (registeredFor !== null) {
    const old = registeredFor;
    conn.reducers
      .unregisterFromTournament({ tournamentId: BigInt(old) })
      .then(() => log.info(`unregistered from tournament ${old}`))
      .catch((e: unknown) => log.flag("unregister failed", { tournament: old, error: String(e) }));
  }
  registeredFor = want;
  if (want !== null) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(want) })
      .then(() => log.info(`registered for tournament ${want}`))
      .catch((e: unknown) => {
        registeredFor = null;
        log.flag("register failed", { tournament: want, error: e instanceof Error ? e.message : String(e) });
      });
  }
}

// ---------- Connection ----------

function onConnect(c: DbConnection, identity: Identity, token: string) {
  conn = c;
  myIdentity = identity;
  sessionToken = token;
  log.info(`connected as ${identity.toHexString().slice(0, 16)}… after ${since(startedAt)}`);
  const t = performance.now();
  c.subscriptionBuilder()
    .onApplied(() => {
      log.info(`base subscription applied in ${since(t)}`);
      onBaseApplied();
    })
    .onError(() => log.flag("base subscription failed"))
    .subscribe(["SELECT * FROM bot_credential", "SELECT * FROM bot", "SELECT * FROM tournament"]);

  c.db.auction.onInsert((_ctx, a) => {
    if (a.status.tag === "Open") push(a.matchId, { type: "auctionOpened", auctionId: num(a.id), letter: letterIndex(a.letter) });
  });
  c.db.auctionResult.onInsert((_ctx, r) => push(r.matchId, closedEvent(r)));
  c.db.wordPlay.onInsert((_ctx, w) => push(w.matchId, wordEvent(w)));
  c.db.matchParticipant.onInsert((_ctx, p) => {
    if (me !== null && p.botId === me && (!live || p.matchId > live.matchId)) openMatch(p.matchId);
    push(p.matchId, balanceEvent(p));
  });
  c.db.matchParticipant.onUpdate((_ctx, _old, p) => push(p.matchId, balanceEvent(p)));
  const rackChanged = (h: { matchId: bigint }) => {
    rackDirty = true;
    push(h.matchId, null);
  };
  c.db.myRack.onInsert((_ctx, h) => rackChanged(h));
  c.db.myRack.onUpdate((_ctx, _old, h) => rackChanged(h));
  c.db.myRack.onDelete((_ctx, h) => rackChanged(h));
  c.db.matchState.onUpdate((_ctx, old, m) => {
    if (old.status.tag !== "Ended" && m.status.tag === "Ended") push(m.id, { type: "matchEnded" });
  });
  c.db.tournament.onInsert((_ctx, t) => {
    if (me === null || knownTournaments.has(t.id)) return; // from the first sync
    knownTournaments.add(t.id);
    log.info(`tournament ${t.id} created: ${t.status.tag}, ${t.auctionType.tag}, tables of ${t.matchSize}, ${t.swissRoundsTotal} rounds, top ${t.topCut}`);
  });
  c.db.tournament.onUpdate((_ctx, o, t) => {
    if (o.status.tag !== t.status.tag) log.info(`tournament ${t.id}: ${o.status.tag} → ${t.status.tag}`);
  });
}

function onBaseApplied() {
  if (!conn || !myIdentity) return;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  if (!cred) {
    log.flag("no bot for this token: generate one on the Team page and save it in .token-" + BOT_NAME);
    process.exit(1);
  }
  if (me === null) {
    me = cred.botId;
    if (sessionToken) fs.writeFileSync(TOKEN_PATH, sessionToken);
    const bot = conn.db.bot.id.find(me);
    log.info(`acting as bot '${bot?.name ?? "?"}' (id ${me})`);
    for (const t of conn.db.tournament.iter()) {
      knownTournaments.add(t.id);
      if (t.status.tag === "Registration") log.info(`tournament ${t.id} is open for registration (${t.auctionType.tag}, tables of ${t.matchSize})`);
    }
  }
  const t = performance.now();
  const id = String(me);
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      log.info(`bot subscription applied in ${since(t)}`);
      const mine = [...conn!.db.matchParticipant.iter()].filter((p) => p.botId === me);
      const newest = mine.reduce<bigint | null>((a, p) => (a === null || p.matchId > a ? p.matchId : a), null);
      if (newest !== null) openMatch(newest);
      else maybeJoinLobby();
      syncTournament();
    })
    .onError(() => log.flag("bot subscription failed"))
    .subscribe([
      `SELECT * FROM match_participant WHERE bot_id = ${id}`,
      "SELECT * FROM my_rack",
      `SELECT * FROM tournament_entry WHERE bot_id = ${id}`,
    ]);
}

function main() {
  control = new Control(CONTROL_PATH, applyControl, (msg) => log.flag(msg));
  const token = process.env.BOT_TOKEN ?? loadToken();
  // PROBE=1 connects anonymously to time the subscriptions, then exits.
  if (!token && !process.env.PROBE) {
    log.flag(`no token: set BOT_TOKEN or save it in ${TOKEN_PATH}`);
    process.exit(1);
  }
  if (token && /^[0-9a-f]{64}$/i.test(token)) {
    log.flag(
      "that's a 64-character identity, not a bot token. Click Generate token on the Team page " +
        "and save the long token it shows (it has two dots in it).",
    );
    process.exit(1);
  }
  log.info(`connecting to ${DB_NAME} at ${HOST}`);
  startedAt = performance.now();
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(token)
    .withAutomaticReconnect({ minDelayMs: 1000, maxDelayMs: 10_000 })
    .onConnect(onConnect)
    .onAutomaticReconnect((_c, identity) => log.info(`reconnected as ${identity.toHexString().slice(0, 16)}…`))
    .onConnectError((_ctx: ErrorContext, err: Error) => {
      log.flag("connect error", { error: err.message });
      // The SDK doesn't retry a failed first connection. Exit, and let the
      // process manager restart us; a rejected token needs a person anyway.
      if (/401|verify token/i.test(err.message)) {
        log.flag("the server rejected the token: generate a new one on the Team page");
      }
      setTimeout(() => process.exit(1), 500);
    })
    .onDisconnect((_ctx, err?: Error) => log.flag("disconnected", { error: err?.message }))
    .build();
  setInterval(maybeJoinLobby, 5000).unref();
  setInterval(() => {}, 1 << 30); // keep the process alive between matches
}

main();
