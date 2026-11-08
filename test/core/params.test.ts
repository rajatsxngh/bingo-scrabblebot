import assert from "node:assert/strict";
import { test } from "node:test";
import { loadParams, parseParams, paramsFor } from "../../src/core/params.js";

test("config/params.json loads and has the PRD's values", () => {
  const p = loadParams();
  assert.deepEqual(p.evaluator.targetWeights, [1, 1, 1]);
  assert.equal(p.pacing.rampDownAuctions, 10);
  assert.equal(p.pacing.reserveLetters, 3);
  assert.equal(p.planner.endgameLookahead, 3);
  assert.equal(p.safety.fallbackMs, 150);
});

test("phase overrides merge over the base values", () => {
  const p = loadParams();
  const tuned = parseParams({
    ...p,
    phases: { ...p.phases, final: { pacing: { reserveLetters: 5 } } },
  });
  const final = paramsFor(tuned, "final");
  assert.equal(final.pacing.reserveLetters, 5);
  assert.equal(final.pacing.rampDownAuctions, 10);
  assert.equal(paramsFor(tuned, "swiss").pacing.reserveLetters, 3);
});

test("a malformed params file is rejected", () => {
  const p = loadParams();
  assert.throws(
    () => parseParams({ ...p, bidding: { minBid: 1 } }),
    /missing bidding\.firstPriceMargin/,
  );
  assert.throws(() => parseParams({ ...p, extra: {} }), /unknown key extra/);
  assert.throws(
    () => parseParams({ ...p, phases: { ...p.phases, final: { pacing: { reserveLetters: "3" } } } }),
    /must be a number/,
  );
  assert.throws(() => parseParams({ ...p, phases: { semis: {} } }), /unknown phase semis/);
});
