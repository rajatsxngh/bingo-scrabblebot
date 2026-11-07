// The simulator's command line.
//
//   npm run sim -- --table bingo,bron,k13,tileshark,starter,sim --matches 1000
//   npm run sim -- --table bingo,k13 --matches 1000          (head to head)
//   npm run sim -- --type first --seed 7 --workers 4 --json out.json
//
// Players: bingo (Bingo's best brain so far), fallback, starter, sim (one
// of the module's three sim bots at random), cheap, value, aggro (a specific
// sim bot), bron, k13, tileshark. Same seed, same results, whatever the
// number of workers.

import * as fs from "node:fs";
import * as os from "node:os";
import { Worker } from "node:worker_threads";
import type { AuctionType } from "../core/types.js";
import type { MatchResult, MatchSpec } from "./game.js";
import { PLAYER_TOKENS, isPlayerToken } from "./opponents.js";
import { formatSummary, summarize } from "./stats.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}

const table = arg("table", "bingo,bron,k13,tileshark,starter,sim").split(",").map((t) => t.trim());
for (const t of table) {
  if (!isPlayerToken(t)) {
    console.error(`unknown player '${t}'. Players: ${PLAYER_TOKENS.join(", ")}`);
    process.exit(1);
  }
}
const type = arg("type", "vickrey").toLowerCase();
const auctionType: AuctionType = type.startsWith("first") ? "FirstPrice" : "Vickrey";
const matches = Number(arg("matches", "1000"));
const seed = Number(arg("seed", "1"));
// Each worker holds its own word index (~50 MB), so don't take every core.
const workers = Math.max(1, Math.min(Number(arg("workers", String(Math.min(os.cpus().length - 2, 6)))), matches));
const spec: MatchSpec = {
  players: table,
  auctionType,
  rackSize: Number(arg("rack", "5")),
  slowStart: Number(arg("slow", "0.1")),
};
const jsonPath = arg("json", "");

async function main() {
  const t0 = performance.now();
  const shares: number[][] = Array.from({ length: workers }, () => []);
  for (let m = 0; m < matches; m++) shares[m % workers]!.push(m);
  let done = 0;
  const results: { match: number; result: MatchResult }[] = [];
  await Promise.all(
    shares.map(
      (share) =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(new URL("./worker.ts", import.meta.url), {
            workerData: { spec, seed, matches: share },
          });
          let last = 0;
          w.on("message", (msg: { progress?: number; done?: typeof results }) => {
            if (msg.progress !== undefined) {
              done += msg.progress - last;
              last = msg.progress;
              process.stderr.write(`\r${done}/${matches} matches`);
            }
            if (msg.done) {
              done += msg.done.length - last;
              results.push(...msg.done);
              resolve();
            }
          });
          w.on("error", reject);
          w.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited with ${code}`))));
        }),
    ),
  );
  process.stderr.write("\r");
  results.sort((a, b) => a.match - b.match);
  const summary = summarize(results.map((r) => r.result));
  const secs = (performance.now() - t0) / 1000;
  console.log(formatSummary(summary, `${table.join(" vs ")} (${auctionType}, seed ${seed})`));
  console.log(`${secs.toFixed(1)} s on ${workers} workers (${((secs * 1000) / matches).toFixed(0)} ms per match overall)`);
  if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify({ table, auctionType, seed, matches, summary }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
