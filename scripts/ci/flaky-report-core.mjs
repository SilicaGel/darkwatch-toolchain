// #2303 — pure logic for the e2e-full flaky-spec dashboard (no fs, no HTTP).
// Same core/shell split as tree-gate-core.mjs and check-wt-filter-parity-core.mjs.
//
// WHY THIS EXISTS
//   A spec that FAILS then PASSES on retry leaves no trace a human will see.
//   `notify-failure` only fires when the run fails, so a green-with-flaky run
//   files nothing. Worse, the existing walk in that job keys on `spec.ok` — and
//   Playwright sets `ok: true` for a flaky spec, because it did eventually pass.
//   So even on a red run, the flaky ones are invisible by construction.
//
//   Verified against the real artifacts from run 9170 (2026-08-10, GREEN):
//   `1834-wt-attack-ack-dice-gate` (timedOut → passed) and `1886-wt-pc-dice-gate`
//   (failed → passed) both flaky, `stats.flaky: 2`, and nothing anywhere said so.
//   Those two have now been flaky on 6 of 6 observed runs — a permanently
//   failing pair wearing `retries: 1` as a disguise — and `combat-monsters`
//   joined them that night without anyone noticing, which is the whole point.
//
// THE STREAK IS THE SIGNAL
//   "flaky once" and "flaky 6 runs running" need completely different responses.
//   Only the second means a test is broken rather than the infrastructure being
//   busy. State lives in the dashboard issue's own body (a machine-readable
//   comment), so there is no new storage and no dependency on the Actions API —
//   which is the one that times out under CI load (#2315), i.e. exactly when a
//   reliability report is most likely to be needed.

/** Marker identifying the dashboard issue. Mirrors `<!-- ci-main-red -->`. */
export const MARKER = "<!-- e2e-full-flaky -->";

/** Machine-readable state line inside the issue body. */
const STATE_OPEN = "<!-- flaky-state: ";
const STATE_CLOSE = " -->";

/** Drop a spec from the dashboard after this many consecutive clean runs. */
export const FORGET_AFTER_RUNS = 14;

/**
 * A stable identity for a flaky test. `file` is a bare spec filename in
 * Playwright's JSON (`1834-wt-attack-ack-dice-gate.spec.ts`, not `e2e/...`),
 * and one file can hold several tests, so the title has to be part of the key.
 *
 * @param {{file: string, title: string}} spec
 */
export function keyFor(spec) {
  return `${spec.file ?? "?"} › ${spec.title ?? "?"}`;
}

/**
 * Walk one Playwright JSON report and pull out every flaky test.
 *
 * Keyed on `tests[].status === "flaky"`, NOT on `spec.ok` — a flaky spec has
 * `ok: true` (confirmed on the real artifacts), which is precisely why the
 * existing suspect-list walk in notify-failure cannot see these.
 *
 * @param {object} report parsed results-shard-N.json
 * @returns {{specs: Array<{file: string, title: string, line: number|null, attempts: number, outcomes: string[]}>, statsFlaky: number|null}}
 */
export function collectFromReport(report) {
  const specs = [];
  const walk = (suite) => {
    for (const spec of suite?.specs ?? []) {
      for (const test of spec?.tests ?? []) {
        if (test?.status !== "flaky") continue;
        const outcomes = (test.results ?? []).map((r) => r?.status ?? "?");
        specs.push({
          file: spec.file ?? "?",
          title: spec.title ?? "?",
          line: spec.line ?? null,
          attempts: outcomes.length,
          outcomes,
        });
      }
    }
    for (const child of suite?.suites ?? []) walk(child);
  };
  for (const suite of report?.suites ?? []) walk(suite);

  const statsFlaky = typeof report?.stats?.flaky === "number" ? report.stats.flaky : null;
  return { specs, statsFlaky };
}

/**
 * Collect across every shard, and cross-check the walk against Playwright's own
 * `stats.flaky` total.
 *
 * The cross-check is the guard that matters. If Playwright ever moves `status`
 * or renames `flaky`, this walk quietly returns [] and the dashboard reports
 * "all clear" forever — a silent false-green, which is the same class of bug
 * this whole ticket exists to fix. A mismatch is reported so the run says so
 * out loud instead.
 *
 * @param {object[]} reports parsed shard reports
 * @returns {{specs: Array, statsTotal: number|null, walkedTotal: number, mismatch: string|null}}
 */
export function collectFlaky(reports) {
  const all = [];
  let statsTotal = null;
  for (const report of reports ?? []) {
    const { specs, statsFlaky } = collectFromReport(report);
    all.push(...specs);
    if (statsFlaky !== null) statsTotal = (statsTotal ?? 0) + statsFlaky;
  }

  const walkedTotal = all.length;
  let mismatch = null;
  if (statsTotal !== null && statsTotal !== walkedTotal) {
    mismatch =
      `Playwright reported stats.flaky=${statsTotal} across the shards but this walk found ` +
      `${walkedTotal}. The JSON shape may have changed — treat this run's flaky list as ` +
      `incomplete rather than as an all-clear (scripts/ci/flaky-report-core.mjs).`;
  }
  return { specs: all, statsTotal, walkedTotal, mismatch };
}

/**
 * Pick the dashboard issue out of the accumulated issue pages.
 *
 * ⚠️ The caller MUST paginate. This repo carries ~150 open issues and the API
 * returns 50 per page, so a single-page search finds the dashboard only while
 * it is among the 50 newest. Miss it and the script files a *second* dashboard
 * every night, each starting from an empty state — which destroys the streak
 * history that permanently-open exists to preserve. The same 50-row ceiling has
 * already bitten this repo twice on commit statuses (67 and 62 rows on ordinary
 * PR heads).
 *
 * If several carry the marker — i.e. a duplicate already happened — take the
 * LOWEST number: the original, which holds the longest history. Reporting the
 * extras is the caller's job.
 *
 * ⚠️⚠️ THE MARKER MUST BE THE FIRST THING IN THE BODY. A substring test is not
 * enough, and this is not hypothetical: the first live run of this script
 * matched `#2303` — the ticket that ASKED for this feature — because its body
 * proposes the marker and quotes it inside backticks. The script then PATCHed
 * the ticket, replacing its text and acceptance checklist with a dashboard.
 *
 * Any issue *discussing* a marker contains it; only an issue that IS the
 * dashboard starts with it (renderBody always emits it as line 1). This is the
 * same defect as #2320 (a parser following an example of itself in prose) and
 * #2297's `stripFences` bug, both found the same way — by the tool meeting its
 * own documentation.
 *
 * @param {Array<{number: number, body?: string}>} issues every page, concatenated
 * @returns {{issue: object|null, duplicates: number[]}}
 */
export function pickDashboard(issues) {
  const hits = (issues ?? [])
    .filter((i) => (i?.body || "").trimStart().startsWith(MARKER))
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  return { issue: hits[0] ?? null, duplicates: hits.slice(1).map((i) => i.number) };
}

/**
 * Read the machine-readable state out of the dashboard issue's body.
 * Anything unparseable yields empty state — a corrupted block costs history,
 * never the current run's report.
 *
 * @param {string} body
 * @returns {{runs: number, specs: Record<string, {streak: number, total: number, lastRun: string|null, cleanRuns: number}>}}
 */
export function parseState(body) {
  const empty = { runs: 0, specs: {} };
  const text = body ?? "";
  const start = text.indexOf(STATE_OPEN);
  if (start === -1) return empty;
  const end = text.indexOf(STATE_CLOSE, start + STATE_OPEN.length);
  if (end === -1) return empty;
  try {
    const parsed = JSON.parse(text.slice(start + STATE_OPEN.length, end));
    if (!parsed || typeof parsed !== "object" || typeof parsed.specs !== "object") return empty;
    return { runs: Number(parsed.runs) || 0, specs: parsed.specs ?? {} };
  } catch {
    return empty;
  }
}

/**
 * Fold this run's flaky list into the previous state.
 *
 * - seen this run  → streak + 1, cleanRuns reset to 0
 * - not seen       → streak reset to 0, cleanRuns + 1 (history kept)
 * - clean for FORGET_AFTER_RUNS consecutive runs → dropped entirely
 *
 * A run with NO flaky specs therefore zeroes every streak — that is the
 * self-clearing behaviour, and it is why the title flips rather than the issue
 * being closed: a closed issue would take the streak history with it.
 *
 * @param {ReturnType<typeof parseState>} prev
 * @param {Array<{file: string, title: string, attempts: number, outcomes: string[]}>} current
 * @param {string} runLabel identifier for this run (used in the log/UI only)
 */
export function nextState(prev, current, runLabel) {
  const seen = new Map();
  for (const spec of current ?? []) seen.set(keyFor(spec), spec);

  const specs = {};
  for (const [key, entry] of Object.entries(prev?.specs ?? {})) {
    if (seen.has(key)) continue; // handled below
    const cleanRuns = (Number(entry.cleanRuns) || 0) + 1;
    if (cleanRuns >= FORGET_AFTER_RUNS) continue; // forget it
    specs[key] = {
      streak: 0,
      total: Number(entry.total) || 0,
      lastRun: entry.lastRun ?? null,
      cleanRuns,
    };
  }

  for (const [key, spec] of seen) {
    const before = prev?.specs?.[key];
    specs[key] = {
      streak: (Number(before?.streak) || 0) + 1,
      total: (Number(before?.total) || 0) + 1,
      lastRun: runLabel,
      cleanRuns: 0,
      attempts: spec.attempts,
      outcomes: spec.outcomes,
    };
  }

  return { runs: (Number(prev?.runs) || 0) + 1, specs };
}

/** Active offenders (flaky in the run just observed), worst streak first. */
export function activeSpecs(state) {
  return Object.entries(state?.specs ?? {})
    .filter(([, v]) => (Number(v.streak) || 0) > 0)
    .sort((a, b) => b[1].streak - a[1].streak || a[0].localeCompare(b[0]));
}

/** Specs that have gone quiet but are still remembered. */
export function quietSpecs(state) {
  return Object.entries(state?.specs ?? {})
    .filter(([, v]) => (Number(v.streak) || 0) === 0)
    .sort((a, b) => (a[1].cleanRuns || 0) - (b[1].cleanRuns || 0) || a[0].localeCompare(b[0]));
}

/**
 * Issue title. Carries the state so the issue LIST is the dashboard — a glance
 * says whether anything is wrong without opening anything.
 */
export function renderTitle(state) {
  const active = activeSpecs(state);
  if (active.length === 0) return "✅ e2e-full: no specs passing only on retry";
  const worst = active[0][1].streak;
  return `⚠️ e2e-full: ${active.length} spec${active.length === 1 ? "" : "s"} passing only on retry (worst streak ${worst})`;
}

/**
 * @param {ReturnType<typeof nextState>} state
 * @param {{runLabel: string, runUrl?: string|null, mismatch?: string|null}} meta
 */
export function renderBody(state, meta) {
  const active = activeSpecs(state);
  const quiet = quietSpecs(state);
  const runRef = meta?.runUrl
    ? `[${meta.runLabel}](${meta.runUrl})`
    : `\`${meta?.runLabel ?? "?"}\``;

  const lines = [MARKER, ""];

  if (meta?.mismatch) {
    lines.push(`> ⚠️ **${meta.mismatch}**`, "");
  }

  if (active.length === 0) {
    lines.push(
      `**No specs passed only on retry in run ${runRef}.**`,
      "",
      "This issue stays open as the standing readout — an empty list here means the last suite was genuinely clean, not that nobody looked.",
      "",
    );
  } else {
    lines.push(
      `**${active.length} spec${active.length === 1 ? "" : "s"} failed the first attempt and passed on retry** in run ${runRef}.`,
      "",
      "A high streak is the signal: a spec flaky on *every* run is not intermittent — it is a failing test wearing `retries: 1` as a disguise, and it spends the retry budget that genuine transients need.",
      "",
      "| spec | streak | seen | first attempt |",
      "|---|---|---|---|",
    );
    for (const [key, v] of active) {
      const first = (v.outcomes ?? [])[0] ?? "?";
      lines.push(`| \`${key}\` | **${v.streak}** consecutive | ${v.total} total | \`${first}\` |`);
    }
    lines.push("");
  }

  if (quiet.length > 0) {
    lines.push(
      "<details><summary>Recently quiet (still remembered)</summary>",
      "",
      "| spec | clean runs | total flakes | last flaky |",
      "|---|---|---|---|",
    );
    for (const [key, v] of quiet) {
      lines.push(`| \`${key}\` | ${v.cleanRuns} | ${v.total} | \`${v.lastRun ?? "?"}\` |`);
    }
    lines.push(
      "",
      `Dropped from this list after ${FORGET_AFTER_RUNS} consecutive clean runs.`,
      "",
      "</details>",
      "",
    );
  }

  lines.push(
    "---",
    "",
    "_Rewritten on every non-PR `e2e-full` run by `notify-failure` (#2303). Reads the `results-shard-*.json` artifacts the suite already uploads on green runs — no spec or Playwright-config changes. Root causes for the current regulars: #1881 (dice-reveal unassertable under `--disable-webgl`), #1780 / #1446 (ws-proxy, maps contention)._",
    "",
    `${STATE_OPEN}${JSON.stringify(state)}${STATE_CLOSE}`,
  );

  return lines.join("\n");
}
