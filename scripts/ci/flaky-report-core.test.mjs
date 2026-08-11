import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MARKER,
  FORGET_AFTER_RUNS,
  keyFor,
  collectFromReport,
  collectFlaky,
  parseState,
  nextState,
  activeSpecs,
  quietSpecs,
  renderTitle,
  renderBody,
  pickDashboard,
} from "./flaky-report-core.mjs";

/**
 * The real shape, transcribed from run 9170's `results-shard-1.json`: a flaky
 * spec carries `ok: true` and the flag lives on `tests[].status`. Kept as a
 * literal so these tests describe the CONTRACT rather than re-reading a file.
 */
const report = ({ flaky = [], failed = [], statsFlaky = undefined } = {}) => ({
  stats: statsFlaky === undefined ? undefined : { expected: 128, unexpected: 0, flaky: statsFlaky },
  suites: [
    {
      specs: [
        ...flaky.map((f) => ({
          file: f.file,
          title: f.title,
          line: f.line ?? 1,
          ok: true, // ← the trap: flaky specs are "ok"
          tests: [
            {
              status: "flaky",
              results: (f.outcomes ?? ["failed", "passed"]).map((s) => ({ status: s })),
            },
          ],
        })),
        ...failed.map((f) => ({
          file: f.file,
          title: f.title,
          ok: false,
          tests: [{ status: "unexpected", results: [{ status: "failed" }] }],
        })),
      ],
      suites: [],
    },
  ],
});

const F1 = {
  file: "1834-wt-attack-ack-dice-gate.spec.ts",
  title: "#1834 — dice gate",
  outcomes: ["timedOut", "passed"],
};
const F2 = {
  file: "1886-wt-pc-dice-gate.spec.ts",
  title: "#1886 — pc dice gate",
  outcomes: ["failed", "passed"],
};

// --- collectFromReport --------------------------------------------------------
test("collectFromReport finds flaky tests even though their spec is ok:true", () => {
  const { specs } = collectFromReport(report({ flaky: [F1] }));
  assert.equal(specs.length, 1);
  assert.equal(specs[0].file, F1.file);
  assert.deepEqual(specs[0].outcomes, ["timedOut", "passed"]);
  assert.equal(specs[0].attempts, 2);
});

test("collectFromReport ignores plainly failed and plainly passed specs", () => {
  const { specs } = collectFromReport(report({ failed: [{ file: "a.spec.ts", title: "boom" }] }));
  assert.deepEqual(specs, []);
});

test("collectFromReport recurses into nested suites", () => {
  const nested = { suites: [{ specs: [], suites: [report({ flaky: [F1] }).suites[0]] }] };
  assert.equal(collectFromReport(nested).specs.length, 1);
});

test("collectFromReport survives a malformed report", () => {
  for (const bad of [null, undefined, {}, { suites: null }, { suites: [{}] }]) {
    assert.deepEqual(collectFromReport(bad).specs, [], `bad input ${JSON.stringify(bad)}`);
  }
});

// --- the cross-check that stops a silent false-green --------------------------
test("collectFlaky sums shards and agrees with Playwright's own stats.flaky", () => {
  const got = collectFlaky([
    report({ flaky: [F1], statsFlaky: 1 }),
    report({ flaky: [F2], statsFlaky: 1 }),
  ]);
  assert.equal(got.walkedTotal, 2);
  assert.equal(got.statsTotal, 2);
  assert.equal(got.mismatch, null);
});

test("collectFlaky REPORTS a mismatch when the walk finds fewer than stats claims", () => {
  // Simulates Playwright moving `status` — the walk silently returns nothing.
  const broken = { stats: { flaky: 3 }, suites: [{ specs: [], suites: [] }] };
  const got = collectFlaky([broken]);
  assert.equal(got.walkedTotal, 0);
  assert.equal(got.statsTotal, 3);
  assert.match(got.mismatch, /stats\.flaky=3/);
  assert.match(got.mismatch, /incomplete rather than as an all-clear/);
});

test("collectFlaky tolerates reports with no stats block", () => {
  const got = collectFlaky([report({ flaky: [F1] })]);
  assert.equal(got.statsTotal, null);
  assert.equal(got.mismatch, null, "absent stats is not a mismatch");
});

// --- state round-trip ---------------------------------------------------------
test("parseState reads back what renderBody wrote", () => {
  const state = nextState(
    { runs: 0, specs: {} },
    collectFlaky([report({ flaky: [F1, F2] })]).specs,
    "run-1",
  );
  const round = parseState(renderBody(state, { runLabel: "run-1" }));
  assert.equal(round.runs, state.runs);
  assert.deepEqual(Object.keys(round.specs).sort(), Object.keys(state.specs).sort());
});

test("parseState returns empty state for anything unreadable", () => {
  for (const body of [
    "",
    "no marker here",
    "<!-- flaky-state: {oops -->",
    "<!-- flaky-state: [] -->",
    null,
  ]) {
    assert.deepEqual(parseState(body), { runs: 0, specs: {} }, `body=${JSON.stringify(body)}`);
  }
});

// --- streaks ------------------------------------------------------------------
test("a spec flaky on consecutive runs accumulates a streak", () => {
  let s = { runs: 0, specs: {} };
  const current = collectFlaky([report({ flaky: [F1] })]).specs;
  for (let i = 1; i <= 6; i++) s = nextState(s, current, `run-${i}`);
  const entry = s.specs[keyFor(F1)];
  assert.equal(entry.streak, 6);
  assert.equal(entry.total, 6);
  assert.equal(entry.lastRun, "run-6");
  assert.equal(s.runs, 6);
});

test("a clean run zeroes the streak but keeps the history", () => {
  let s = nextState({ runs: 0, specs: {} }, collectFlaky([report({ flaky: [F1] })]).specs, "run-1");
  s = nextState(s, [], "run-2");
  const entry = s.specs[keyFor(F1)];
  assert.equal(entry.streak, 0);
  assert.equal(entry.total, 1, "total is history, not a streak");
  assert.equal(entry.cleanRuns, 1);
  assert.equal(entry.lastRun, "run-1", "last flaky run is preserved");
});

test("a spec is forgotten after FORGET_AFTER_RUNS consecutive clean runs", () => {
  let s = nextState({ runs: 0, specs: {} }, collectFlaky([report({ flaky: [F1] })]).specs, "run-1");
  for (let i = 0; i < FORGET_AFTER_RUNS - 1; i++) s = nextState(s, [], `clean-${i}`);
  assert.ok(s.specs[keyFor(F1)], "still remembered one run before the cutoff");
  s = nextState(s, [], "clean-final");
  assert.equal(s.specs[keyFor(F1)], undefined, "dropped at the cutoff");
});

test("a returning spec restarts its streak from 1 but keeps its total", () => {
  let s = nextState({ runs: 0, specs: {} }, collectFlaky([report({ flaky: [F1] })]).specs, "run-1");
  s = nextState(s, [], "run-2");
  s = nextState(s, collectFlaky([report({ flaky: [F1] })]).specs, "run-3");
  assert.equal(s.specs[keyFor(F1)].streak, 1);
  assert.equal(s.specs[keyFor(F1)].total, 2);
  assert.equal(s.specs[keyFor(F1)].cleanRuns, 0);
});

test("activeSpecs sorts worst streak first; quietSpecs holds the rest", () => {
  let s = nextState(
    { runs: 0, specs: {} },
    collectFlaky([report({ flaky: [F1, F2] })]).specs,
    "run-1",
  );
  s = nextState(s, collectFlaky([report({ flaky: [F2] })]).specs, "run-2");
  const active = activeSpecs(s);
  assert.equal(active.length, 1);
  assert.equal(active[0][0], keyFor(F2));
  assert.deepEqual(
    quietSpecs(s).map(([k]) => k),
    [keyFor(F1)],
  );
});

// --- self-clearing ------------------------------------------------------------
test("the title carries the state so the issue LIST is the dashboard", () => {
  const flaky = nextState(
    { runs: 0, specs: {} },
    collectFlaky([report({ flaky: [F1, F2] })]).specs,
    "run-1",
  );
  assert.match(
    renderTitle(flaky),
    /^⚠️ e2e-full: 2 specs passing only on retry \(worst streak 1\)$/,
  );
  const clean = nextState(flaky, [], "run-2");
  assert.match(renderTitle(clean), /^✅ e2e-full: no specs passing only on retry$/);
});

test("a clean run's body says so explicitly instead of leaving a stale warning", () => {
  const flaky = nextState(
    { runs: 0, specs: {} },
    collectFlaky([report({ flaky: [F1] })]).specs,
    "run-1",
  );
  const body = renderBody(nextState(flaky, [], "run-2"), { runLabel: "run-2" });
  assert.match(body, /No specs passed only on retry/);
  assert.doesNotMatch(body, /failed the first attempt and passed on retry/);
  assert.ok(body.includes(MARKER));
});

test("renderBody surfaces a stats mismatch as a visible warning", () => {
  const body = renderBody({ runs: 1, specs: {} }, { runLabel: "run-1", mismatch: "shape changed" });
  assert.match(body, /⚠️ \*\*shape changed\*\*/);
});

test("renderBody shows the first-attempt outcome, which separates a timeout from a real failure", () => {
  const s = nextState(
    { runs: 0, specs: {} },
    collectFlaky([report({ flaky: [F1] })]).specs,
    "run-1",
  );
  const body = renderBody(s, { runLabel: "run-1" });
  assert.match(body, /`timedOut`/);
});

// --- dashboard selection (the duplicate-dashboard guard) ----------------------
test("pickDashboard finds the dashboard anywhere in the accumulated PAGES", () => {
  // "anywhere in the pages" — not "anywhere in the body". The marker must lead
  // the body (see the note on pickDashboard); paging is the caller's job and is
  // what this covers.
  const issues = [
    { number: 9, body: "unrelated" },
    { number: 12, body: `${MARKER}\n\nsome dashboard content` },
    { number: 30, body: "" },
  ];
  const { issue, duplicates } = pickDashboard(issues);
  assert.equal(issue.number, 12);
  assert.deepEqual(duplicates, []);
});

test("pickDashboard takes the OLDEST duplicate — it holds the longest history", () => {
  const { issue, duplicates } = pickDashboard([
    { number: 88, body: MARKER },
    { number: 41, body: MARKER },
    { number: 90, body: MARKER },
  ]);
  assert.equal(issue.number, 41);
  assert.deepEqual(duplicates, [88, 90]);
});

test("pickDashboard returns null rather than guessing when nothing is marked", () => {
  for (const input of [[], null, undefined, [{ number: 1 }], [{ number: 1, body: null }]]) {
    assert.equal(pickDashboard(input).issue, null, `input=${JSON.stringify(input)}`);
  }
});

test("pickDashboard IGNORES an issue that merely quotes the marker in prose", () => {
  // Verbatim shape of #2303's own body, which the first live run matched and
  // then overwrote. A ticket proposing the marker contains it; only the
  // dashboard STARTS with it.
  const ticket = {
    number: 2303,
    body: [
      "## Suggested shape",
      "",
      "1. **A single reused marker issue**, same pattern as the `<!-- e2e-full-red -->`",
      `   marker — e.g. \`${MARKER}\` "⚠️ specs passing only on retry", rewritten each run.`,
    ].join("\n"),
  };
  assert.equal(pickDashboard([ticket]).issue, null);
});

test("pickDashboard accepts a real dashboard body, including leading whitespace", () => {
  const real = renderBody({ runs: 1, specs: {} }, { runLabel: "run-1" });
  assert.equal(pickDashboard([{ number: 7, body: real }]).issue.number, 7);
  assert.equal(pickDashboard([{ number: 8, body: `\n\n${real}` }]).issue.number, 8);
});

test("pickDashboard prefers the real dashboard over a ticket that quotes the marker", () => {
  const quoting = { number: 10, body: `see \`${MARKER}\` for the shape` };
  const real = { number: 99, body: renderBody({ runs: 1, specs: {} }, { runLabel: "r" }) };
  const { issue, duplicates } = pickDashboard([quoting, real]);
  assert.equal(issue.number, 99, "a lower number must not win if it is only prose");
  assert.deepEqual(duplicates, []);
});
