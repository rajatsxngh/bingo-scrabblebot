// Worker thread: plays its share of the matches and posts the results back.

import { parentPort, workerData } from "node:worker_threads";
import { wordIndex } from "../core/words.js";
import { matchSeed, runMatch, type MatchSpec } from "./game.js";

interface Job {
  spec: MatchSpec;
  seed: number;
  matches: number[];
}

const job = workerData as Job;
const index = wordIndex();
const out = [];
for (const m of job.matches) {
  out.push({ match: m, result: runMatch(job.spec, index, matchSeed(job.seed, m)) });
  if (out.length % 50 === 0) parentPort!.postMessage({ progress: out.length });
}
parentPort!.postMessage({ done: out });
