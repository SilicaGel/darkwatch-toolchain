import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateStaleness } from "./check-roadmap-staleness-core.mjs";

const now = new Date("2026-06-27T12:00:00Z");

test("fresh review is not stale", () => {
  const r = evaluateStaleness("**Last reviewed:** 2026-06-20", { weeks: 5, now });
  assert.equal(r.found, true);
  assert.equal(r.lastReviewed, "2026-06-20");
  assert.equal(r.daysOld, 7);
  assert.equal(r.stale, false);
});

test("review older than the threshold is stale", () => {
  const r = evaluateStaleness("**Last reviewed:** 2026-04-01", { weeks: 5, now });
  assert.equal(r.stale, true);
  assert.ok(r.daysOld > 35);
});

test("exactly at the threshold is NOT stale (boundary)", () => {
  // 5 weeks = 35 days before now (2026-05-23)
  const r = evaluateStaleness("**Last reviewed:** 2026-05-23", { weeks: 5, now });
  assert.equal(r.daysOld, 35);
  assert.equal(r.stale, false);
});

test("one day past the threshold is stale", () => {
  const r = evaluateStaleness("**Last reviewed:** 2026-05-22", { weeks: 5, now });
  assert.equal(r.daysOld, 36);
  assert.equal(r.stale, true);
});

test("missing line reports not found", () => {
  const r = evaluateStaleness("# Roadmap\n\n**Last updated:** 2026-06-26", { weeks: 5, now });
  assert.equal(r.found, false);
});

test("malformed date reports not found", () => {
  const r = evaluateStaleness("**Last reviewed:** yesterday", { weeks: 5, now });
  assert.equal(r.found, false);
});

test("case-insensitive match", () => {
  const r = evaluateStaleness("**last REVIEWED:** 2026-06-20", { weeks: 5, now });
  assert.equal(r.found, true);
});

test("empty/undefined text is not found", () => {
  assert.equal(evaluateStaleness("", { weeks: 5, now }).found, false);
  assert.equal(evaluateStaleness(undefined, { weeks: 5, now }).found, false);
});
