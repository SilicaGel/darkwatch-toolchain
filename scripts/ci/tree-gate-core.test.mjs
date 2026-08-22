import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parsePrNumber,
  latestStatusByContext,
  decide,
  REQUIRED_CONTEXTS,
} from "./tree-gate-core.mjs";

const TREE = "5d7581b0aa11bb22cc33dd44ee55ff6600112233";
const OTHER_TREE = "3191b577534230a93ce8f7c786c456b74d3c763a";

/** Green statuses for every required context, newest-first like the real API. */
const greenStatuses = (extra = []) => [
  ...extra,
  ...REQUIRED_CONTEXTS.map((context, i) => ({
    context,
    status: "success",
    created_at: `2026-08-09T23:5${i}:00-04:00`,
  })),
];

const input = (over = {}) => ({
  headSubject: "Some shipped thing (#2318)",
  headTree: TREE,
  prTree: TREE,
  statuses: greenStatuses(),
  enforce: true,
  ...over,
});

// --- parsePrNumber -----------------------------------------------------------
test("parsePrNumber reads the trailing (#N) Forgejo appends when squashing", () => {
  assert.equal(
    parsePrNumber(
      "Luck transfers stop 500ing under contention; graceful container shutdown + unhandledRejection backstop (#2329)",
    ),
    2329,
  );
  assert.equal(parsePrNumber("Route WT specs for components/map changes (#2318)"), 2318);
  assert.equal(parsePrNumber("Trailing whitespace tolerated (#7)  "), 7);
});

test("parsePrNumber returns null when there is no PR to inherit from", () => {
  assert.equal(parsePrNumber("hotfix: bump the thing"), null);
  assert.equal(parsePrNumber("mentions (#123) but not at the end"), null);
  assert.equal(parsePrNumber(""), null);
  assert.equal(parsePrNumber(undefined), null);
});

// --- latestStatusByContext ---------------------------------------------------
test("latestStatusByContext takes the newest row per context, not the first seen", () => {
  // The shape from PR #2318's head: a cancelled/failed wave, then a green re-run.
  const statuses = [
    {
      context: "CI / test (pull_request)",
      status: "success",
      created_at: "2026-08-09T23:48:26-04:00",
    },
    {
      context: "CI / test (pull_request)",
      status: "failure",
      created_at: "2026-08-09T23:41:31-04:00",
    },
  ];
  assert.equal(latestStatusByContext(statuses).get("CI / test (pull_request)").status, "success");
  // …and the same list in the opposite order must reach the same conclusion.
  assert.equal(
    latestStatusByContext([...statuses].reverse()).get("CI / test (pull_request)").status,
    "success",
  );
});

test("latestStatusByContext breaks created_at ties on API order (newest first)", () => {
  const t = "2026-08-09T23:52:40-04:00";
  const latest = latestStatusByContext([
    { context: "CI / test (pull_request)", status: "success", created_at: t },
    { context: "CI / test (pull_request)", status: "failure", created_at: t },
  ]);
  assert.equal(latest.get("CI / test (pull_request)").status, "success");
});

test("latestStatusByContext survives malformed rows", () => {
  const latest = latestStatusByContext([
    { context: "CI / test (pull_request)", status: "success", created_at: "not-a-date" },
    { status: "success" },
    null,
  ]);
  assert.equal(latest.get("CI / test (pull_request)").status, "success");
  assert.equal(latest.size, 1);
});

// --- decide: the one path that skips ----------------------------------------
test("decide skips when the trees are identical and every required context is green", () => {
  const r = decide(input());
  assert.equal(r.skip, true);
  assert.equal(r.wouldSkip, true);
  assert.equal(r.prNumber, 2318);
  assert.match(r.reason, /^SKIP — /);
});

test("decide ignores unrelated contexts on the same commit", () => {
  const r = decide(
    input({
      statuses: greenStatuses([
        {
          context: "Lighthouse CI / lighthouse (pull_request)",
          status: "failure",
          created_at: "2026-08-09T23:59:00-04:00",
        },
        { context: "coverage-bot", status: "pending", created_at: "2026-08-09T23:59:00-04:00" },
      ]),
    }),
  );
  assert.equal(r.skip, true);
});

// --- decide: fail-open, one case per unknown --------------------------------
test("decide runs when the merge subject carries no PR number", () => {
  const r = decide(input({ headSubject: "manual hotfix on main" }));
  assert.equal(r.skip, false);
  assert.equal(r.wouldSkip, false);
  assert.match(r.reason, /no `\(#N\)`/);
});

test("decide runs when the merge tree could not be resolved", () => {
  const r = decide(input({ headTree: null }));
  assert.equal(r.skip, false);
  assert.match(r.reason, /merge commit's tree/);
});

test("decide runs when the PR head ref could not be fetched", () => {
  const r = decide(input({ prTree: null }));
  assert.equal(r.skip, false);
  assert.match(r.reason, /refs\/pull\/2318\/head/);
});

test("decide runs when main advanced — the trees differ", () => {
  const r = decide(input({ prTree: OTHER_TREE }));
  assert.equal(r.skip, false);
  assert.equal(r.wouldSkip, false);
  assert.match(r.reason, /main advanced/);
});

test("decide runs when the statuses API did not return a list", () => {
  for (const statuses of [null, undefined, {}, "[]"]) {
    const r = decide(input({ statuses }));
    assert.equal(r.skip, false, `statuses=${JSON.stringify(statuses)} must not skip`);
    assert.match(r.reason, /could not read commit statuses/);
  }
});

test("decide runs — naming the context — when a required status is absent", () => {
  for (const missing of REQUIRED_CONTEXTS) {
    const r = decide(input({ statuses: greenStatuses().filter((s) => s.context !== missing) }));
    assert.equal(r.skip, false);
    assert.ok(r.reason.includes(missing), `reason must name "${missing}", got: ${r.reason}`);
  }
});

test("decide runs when a required status's latest state is not success", () => {
  for (const state of ["failure", "pending", "error", "warning"]) {
    const statuses = greenStatuses().map((s) =>
      s.context === "CI / test (pull_request)"
        ? { ...s, status: state, created_at: "2026-08-09T23:59:00-04:00" }
        : s,
    );
    const r = decide(input({ statuses }));
    assert.equal(r.skip, false, `${state} must not skip`);
    assert.match(r.reason, /CI \/ test \(pull_request\)/);
  }
});

test("decide is not fooled by an older green status under a newer red one", () => {
  const statuses = greenStatuses([
    {
      context: "CI / test (pull_request)",
      status: "failure",
      created_at: "2026-08-10T00:10:00-04:00",
    },
  ]);
  const r = decide(input({ statuses }));
  assert.equal(r.skip, false);
  assert.match(r.reason, /CI \/ test \(pull_request\)" is failure/);
});

// --- warn-first rollout ------------------------------------------------------
test("warn-first: a skippable merge still runs, and says it would have skipped", () => {
  const r = decide(input({ enforce: false }));
  assert.equal(r.skip, false);
  assert.equal(r.wouldSkip, true);
  assert.match(r.reason, /^WOULD SKIP \(warn-first; set TREE_GATE_ENFORCE=1 to enforce\)/);
});

test("warn-first never turns a run-reason into a would-skip", () => {
  const r = decide(input({ enforce: false, prTree: OTHER_TREE }));
  assert.equal(r.skip, false);
  assert.equal(r.wouldSkip, false);
});

// --- the contract the ci.yml `if:` depends on --------------------------------
// #2533 — this list must name exactly the jobs that STILL POST a status on a PR.
// A context no job posts can never be found green, so the gate would fail its
// proof on every merge and run the full main gate forever — fail-open, but the
// ~92.5% skip silently gone with "CI got slower" as the only symptom. `smoke`
// was removed here when phase 3 retired that job.
test("REQUIRED_CONTEXTS names the push-to-main gate jobs that still exist, PR-scoped", () => {
  assert.deepEqual(REQUIRED_CONTEXTS, [
    "CI / lint-typecheck (pull_request)",
    "CI / test (pull_request)",
  ]);
});

// The failure this guards against is a name in this list that nothing posts, so
// pin it to the jobs ci.yml actually defines rather than to a copy of the list.
test("every REQUIRED_CONTEXTS entry corresponds to a job defined in ci.yml", () => {
  const ci = readFileSync(".forgejo/workflows/ci.yml", "utf8");
  for (const ctx of REQUIRED_CONTEXTS) {
    const job = ctx.replace(/^CI \/ /, "").replace(/ \(pull_request\)$/, "");
    assert.match(
      ci,
      new RegExp(`^  ${job}:`, "m"),
      `REQUIRED_CONTEXTS names "${ctx}" but ci.yml defines no \`${job}\` job — ` +
        `nothing will ever post that status and the gate can never skip.`,
    );
  }
});
