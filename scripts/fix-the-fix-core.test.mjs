import { test } from "node:test";
import assert from "node:assert/strict";
import { pairCloseReopen, summarize } from "./fix-the-fix-core.mjs";

const day = 24 * 60 * 60 * 1000;
const base = Date.parse("2026-06-01T00:00:00Z");
const at = (offsetDays) => new Date(base + offsetDays * day).toISOString();

test("detects a reopen within the window", () => {
  const events = [
    { type: "close", created_at: at(0) },
    { type: "reopen", created_at: at(3) },
  ];
  const pair = pairCloseReopen(events, 7);
  assert.ok(pair);
  assert.equal(pair.daysToReopen, 3);
});

test("ignores a reopen outside the window", () => {
  const events = [
    { type: "close", created_at: at(0) },
    { type: "reopen", created_at: at(10) },
  ];
  assert.equal(pairCloseReopen(events, 7), null);
});

test("boundary: reopen exactly at the window edge counts", () => {
  const events = [
    { type: "close", created_at: at(0) },
    { type: "reopen", created_at: at(7) },
  ];
  assert.ok(pairCloseReopen(events, 7));
});

test("a clean closed issue (no reopen) is null", () => {
  const events = [
    { type: "label", created_at: at(0) },
    { type: "close", created_at: at(1) },
  ];
  assert.equal(pairCloseReopen(events, 7), null);
});

test("close→far-reopen→close→near-reopen catches the second loop", () => {
  const events = [
    { type: "close", created_at: at(0) },
    { type: "reopen", created_at: at(20) }, // outside window, resets
    { type: "close", created_at: at(25) },
    { type: "reopen", created_at: at(27) }, // 2d — inside window
  ];
  const pair = pairCloseReopen(events, 7);
  assert.ok(pair);
  assert.equal(pair.daysToReopen, 2);
});

test("unsorted events are handled (sorts by time)", () => {
  const events = [
    { type: "reopen", created_at: at(2) },
    { type: "close", created_at: at(0) },
  ];
  const pair = pairCloseReopen(events, 7);
  assert.ok(pair);
  assert.equal(pair.daysToReopen, 2);
});

test("ignores non-close/reopen event types and malformed entries", () => {
  const events = [
    null,
    { type: "comment", created_at: at(0) },
    { type: "close" }, // no date
    { type: "close", created_at: at(1) },
    { type: "reopen", created_at: at(2) },
  ];
  assert.ok(pairCloseReopen(events, 7));
});

test("summarize with no hits reports the all-clear", () => {
  const r = summarize([], { days: 7, since: "2026-03-01" });
  assert.equal(r.count, 0);
  assert.match(r.text, /No tight close/);
});

test("summarize sorts hits by daysToReopen ascending", () => {
  const r = summarize(
    [
      { number: 1, title: "a", daysToReopen: 5 },
      { number: 2, title: "b", daysToReopen: 1 },
    ],
    { days: 7, since: "2026-03-01" },
  );
  assert.equal(r.hits[0].number, 2);
  assert.equal(r.count, 2);
  assert.match(r.text, /#2/);
});
