// Every tunable lives in config/params.json, so simulator results drop in
// without code changes (PRD). This file documents each one and checks the
// file's shape when it's loaded. Values marked "placeholder" get tuned in
// M5–M7.

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

export interface Params {
  tracker: {
    /** Weight of the newest price in each tier's moving average. */
    priceAlpha: number;
  };
  evaluator: {
    /** Weight of each step in the cascade of best targets (each counts only if the ones above fail). The PRD had fixed 1, 0.5, 0.25 on a plain sum; see evaluator.ts. */
    targetWeights: number[];
    /** Skip targets missing more tiles than this. Placeholder. */
    maxDeficit: number;
    /** Penalty per duplicate letter other than S and E. Placeholder. */
    duplicatePenalty: number;
    /** Penalty per vowel away from a balanced rack. Placeholder. */
    vowelPenalty: number;
    /** Our assumed win rate on contested letters before we have data. Placeholder. */
    winRatePrior: number;
    /** How many auctions' worth of weight the prior carries. Placeholder. */
    winRatePriorWeight: number;
    /**
     * Points a coin is worth when a target's missing letters are costed at
     * recent prices (it fades to 0 as the match ends: leftover coins are
     * worthless). 1 = full price, 0 = letters are free. Placeholder.
     */
    coinValue: number;
  };
  pacing: {
    /** Largest pacing factor λ, used when coins are scarcest. Placeholder. */
    lambdaMax: number;
    /** λ and the reserve fall to 0 over this many final auctions (PRD: ~10). */
    rampDownAuctions: number;
    /** Reserve floor, in contested letters' worth of coins (PRD: ~3). */
    reserveLetters: number;
    /** Most v1 pays for one letter: coins × min(1, spreadOver / auctions left), until the ramp-down. */
    spreadOver: number;
  };
  bidding: {
    /** Least bid on any letter with value (unsold letters vanish). */
    minBid: number;
    /** First-price: bid this much above the predicted top rival bid (PRD: 1). */
    firstPriceMargin: number;
    /**
     * Bid at least this fraction of the recent price for its tier on any
     * letter worth something (0 = off). Head to head, a skipped letter goes
     * to the rival for 1 coin, and a high losing bid drains the rival's coins.
     */
    contestFloor: number;
  };
  planner: {
    /** Extra value a word must show over holding its letters before we cash it. Placeholder. */
    cashThreshold: number;
    /** Have the endgame split ready this many auctions before the end (PRD: 3). */
    endgameLookahead: number;
  };
  safety: {
    /** Send the fallback bid if no bid is ready this long after an auction opens. */
    fallbackMs: number;
    /** Log a warning for decisions slower than this. */
    slowDecisionMs: number;
  };
  /** Per-phase overrides, merged over the values above (tuned in M7). */
  phases: Record<Phase, DeepPartial<Omit<Params, "phases">>>;
}

export type Phase = "swiss" | "bracket" | "final";
const PHASES: readonly Phase[] = ["swiss", "bracket", "final"];

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export const DEFAULT_PARAMS_PATH = fileURLToPath(
  new URL("../../config/params.json", import.meta.url),
);

type Leaf = "number" | "numbers";
type Shape = { [key: string]: Leaf | Shape };

// The expected keys and types. Must match the Params interface above.
const SHAPE: Shape = {
  tracker: { priceAlpha: "number" },
  evaluator: {
    targetWeights: "numbers",
    maxDeficit: "number",
    duplicatePenalty: "number",
    vowelPenalty: "number",
    winRatePrior: "number",
    winRatePriorWeight: "number",
    coinValue: "number",
  },
  pacing: { lambdaMax: "number", rampDownAuctions: "number", reserveLetters: "number", spreadOver: "number" },
  bidding: { minBid: "number", firstPriceMargin: "number", contestFloor: "number" },
  planner: { cashThreshold: "number", endgameLookahead: "number" },
  safety: { fallbackMs: "number", slowDecisionMs: "number" },
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Checks `value` against `shape`; with `partial`, missing keys are fine. */
function check(value: unknown, shape: Shape, path: string, partial: boolean) {
  if (!isObject(value)) throw new Error(`params: ${path || "file"} must be an object`);
  for (const key of Object.keys(value)) {
    if (!(key in shape)) throw new Error(`params: unknown key ${path}${key}`);
  }
  for (const [key, want] of Object.entries(shape)) {
    const v = value[key];
    const where = `${path}${key}`;
    if (v === undefined) {
      if (partial) continue;
      throw new Error(`params: missing ${where}`);
    }
    if (want === "number") {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`params: ${where} must be a number`);
      }
    } else if (want === "numbers") {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
        throw new Error(`params: ${where} must be a list of numbers`);
      }
    } else {
      check(v, want, `${where}.`, partial);
    }
  }
}

/** Validates parsed params JSON and returns it typed. */
export function parseParams(json: unknown): Params {
  if (!isObject(json)) throw new Error("params: file must be an object");
  const { phases, ...base } = json;
  check(base, SHAPE, "", false);
  if (!isObject(phases)) throw new Error("params: missing phases");
  for (const key of Object.keys(phases)) {
    if (!PHASES.includes(key as Phase)) throw new Error(`params: unknown phase ${key}`);
  }
  for (const phase of PHASES) {
    check(phases[phase] ?? {}, SHAPE, `phases.${phase}.`, true);
  }
  return json as unknown as Params;
}

export function loadParams(path = DEFAULT_PARAMS_PATH): Params {
  return parseParams(JSON.parse(fs.readFileSync(path, "utf8")));
}

function merge<T>(base: T, over: unknown): T {
  if (!isObject(over) || !isObject(base)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v);
  return out as T;
}

/** The params to use in a tournament phase: the base values with that phase's overrides. */
export function paramsFor(p: Params, phase: Phase): Params {
  return merge(p, p.phases[phase]);
}
