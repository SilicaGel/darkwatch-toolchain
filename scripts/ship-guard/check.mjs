// ship-guard/check.mjs — #1116 blocking guard for PRs that resolve issues but
// skip the ship housekeeping (changelog fragment + `## Test plans` block).
//
// The contract this enforces is the locked format produced by the `/ship`
// skill (`.claude/skills/ship/SKILL.md`) and consumed by `qa-check`:
//   - each resolved issue gets a standalone `Ready #N` line in the PR body;
//   - ONLY a release PR (title `release: …`) may touch docs/CHANGELOG.md
//     (#2364) — every other PR that resolves an issue instead adds a fragment
//     under docs/changelog.d/, unless its title carries [no-changelog];
//   - the PR body has a `## Test plans` section with a `### #N` block per Ready.
//   - a release PR's collated changelog top entry is a NEWER version than
//     origin/main's top entry, and its headings are strictly descending
//     (#2165) — the mechanical proof that the collate/normalize step ran
//     against CURRENT main, not a stale local copy.
//
// If those line up, the PR is ship-clean. This is a DUMB presence/order
// check, not a semantic review — whether the changelog wording is good, or
// the test plan is reachable, stays a human / qa-check concern (the issue's
// explicit scope boundary). Keep the matchers string/regex based and in sync
// with the skill, so the guard never drifts from what `/ship` actually writes.
//
// #2165 background: two branches that each add a new top entry to
// docs/CHANGELOG.md will both guess the same next version. #2364 mostly
// retires this exposure for feature PRs (they no longer touch the file at
// all), but a release PR still collates fragments into a new top entry, so
// the same version-collision risk applies there — see changelogVersionAdvanced
// and firstDescendingViolation below. It is deliberately a second, independent
// layer rather than a substitute for the local `changelog-collate.mjs` /
// `changelog-normalize.mjs` run — see parseChangelogVersion / parseHeading,
// reused unmodified from scripts/app-version.mjs so there's exactly one
// "what version is this changelog heading" parser.
//
// The runner (below `decide`) reads the PR body/title from the Forgejo event
// payload via env (PR_BODY / PR_TITLE), and the changed-file list from
// `git diff --name-only origin/main...HEAD`. `decide` itself is pure and fully
// tested — the runner is a thin wrapper around it, mirroring the
// coverage-comment / dead-code-comment script style (Node built-ins only).

import { execFileSync } from "node:child_process";
import { parseChangelogVersion, parseHeading } from "../app-version.mjs";

export const CHANGELOG_PATH = "docs/CHANGELOG.md";

// Escape hatch: a `[skip-ship-guard]` token anywhere in the PR TITLE passes the
// guard. Mirrors the repo's other gates ([allow-dead-code], [allow-deps]).
export const SKIP_MARKER = "[skip-ship-guard]";

// #2364 — feature PRs write a fragment instead of editing docs/CHANGELOG.md.
export const FRAGMENT_DIR = "docs/changelog.d/";

// Exemption for a PR that genuinely warrants no changelog entry. A TITLE token,
// not a body marker, and deliberately so: a PR body that DOCUMENTS the marker
// contains it — at line start, inside a code fence — so even an anchored body
// match would exempt the PR that documents it. This repo has shipped that bug
// three times. Matches the repo's other title tokens ([allow-dead-code] etc).
export const NO_CHANGELOG_MARKER = "[no-changelog]";

// Release PRs are the ONLY ones allowed to touch docs/CHANGELOG.md. Detected
// from the title prefix `/release` writes — NOT from head.ref, which reads as
// `refs/pull/<n>/head` most of the time (#2084).
export const RELEASE_TITLE_RE = /^\s*release:\s/i;

/** True when the PR title marks this as a release PR. */
export function isReleasePr(title) {
  return typeof title === "string" && RELEASE_TITLE_RE.test(title);
}

// A standalone `Ready #N` line. `/ship` writes these one-per-line in the PR
// body (NOT `Closes`, intentionally — see the skill). Anchored to line start
// (after optional list markup / whitespace) so a `Ready #5` buried mid-sentence
// in prose doesn't accidentally trip the guard, while the canonical
// `Ready #694` line that /ship emits matches. Case-insensitive on "Ready" only.
const READY_LINE = /^[\s>*-]*Ready\s+#(\d+)\s*$/gim;

// A `### #N` Test-plan block header — the locked format `qa-check` parses:
//   `### #694 — <issue title>`
// We only assert the `### #N` prefix exists (presence check); the trailing
// `— title` is free text and not required to match. `###` at line start,
// optional space, then `#<number>`.
const TEST_PLAN_BLOCK = /^###\s+#(\d+)\b/gim;

// The `## Test plans` section header (locked). Must be present for any Ready PR.
const TEST_PLANS_HEADER = /^##\s+Test plans\s*$/im;

/** Collect the unique issue numbers from `Ready #N` lines in the PR body. */
export function parseReadyNumbers(body) {
  const out = new Set();
  if (typeof body !== "string") return out;
  for (const m of body.matchAll(READY_LINE)) out.add(m[1]);
  return out;
}

/** Collect the unique issue numbers that have a `### #N` test-plan block. */
export function parseTestPlanNumbers(body) {
  const out = new Set();
  if (typeof body !== "string") return out;
  // Only count `### #N` blocks that live under a `## Test plans` section — a
  // stray `### #N` elsewhere shouldn't satisfy the requirement. We slice the
  // body from the `## Test plans` header to the next `## ` header (or EOF).
  const headerMatch = body.match(TEST_PLANS_HEADER);
  if (!headerMatch) return out;
  const start = headerMatch.index + headerMatch[0].length;
  const rest = body.slice(start);
  const nextSection = rest.search(/^##\s+(?!#)/m); // next `## ` that isn't `### `
  const section = nextSection === -1 ? rest : rest.slice(0, nextSection);
  for (const m of section.matchAll(TEST_PLAN_BLOCK)) out.add(m[1]);
  return out;
}

/**
 * The changelog fragments this PR ADDED (`.gitkeep` doesn't count). Only a
 * file directly inside `docs/changelog.d/` counts — a further `/` after the
 * prefix means a subdirectory, and `readFragments` in
 * scripts/changelog-collate.mjs uses a non-recursive `readdirSync`, so a
 * subdirectory fragment is never read there. This function and that one must
 * agree on what a fragment is, or a fragment can pass this check and then be
 * silently dropped at collation with no warning anywhere.
 *
 * #2410(a) — `addedFiles` MUST be an added-only list (the runner's
 * `git diff --diff-filter=A`), a deliberately SEPARATE input from the plain
 * `changedFiles` list `changelogTouched` reads below. Before this fix, both
 * checks shared one unfiltered list, so a PR that DELETED someone else's
 * still-pending fragment satisfied "this PR adds a fragment" just because the
 * deleted path showed up in a plain `git diff --name-only` — check (a) never
 * distinguished "added" from "removed". `changelogTouched` must keep reading
 * the FULL unfiltered list, though: docs/CHANGELOG.md is always MODIFIED,
 * never ADDED, so if it read an added-only list too, that check would never
 * fire and silently disable the #2364 CHANGELOG-edit guard. Do not collapse
 * these two inputs back into one list.
 *
 * `addedFiles` absent/undefined (an older caller, or the runner choosing not
 * to compute it) is treated as "nothing was added" — see the `?? []` below —
 * NOT as "fall back to changedFiles". That's a deliberate fail-CLOSED choice:
 * falling back would silently resurrect the exact deletion exploit this fix
 * closes, for any caller that simply forgot to pass the new argument. Failing
 * closed instead means a Ready PR just blocks (loudly, in CI) until the
 * caller supplies it — never a silent re-opening of the hole. This is safe
 * for the real runner because it either supplies a real added-only list or
 * skips the WHOLE guard open on a git failure (see gitAddedFiles/main below),
 * matching how gitChangedFiles failures are already handled.
 */
export function fragmentsAdded(addedFiles) {
  const list = addedFiles instanceof Set ? [...addedFiles] : (addedFiles ?? []);
  return list.filter((f) => {
    if (typeof f !== "string") return false;
    const trimmed = f.trim();
    if (!trimmed.startsWith(FRAGMENT_DIR) || !trimmed.endsWith(".md")) return false;
    return !trimmed.slice(FRAGMENT_DIR.length).includes("/");
  });
}

/** Did the PR add/modify the changelog? */
export function changelogTouched(changedFiles) {
  const list = changedFiles instanceof Set ? [...changedFiles] : (changedFiles ?? []);
  return list.some((f) => typeof f === "string" && f.trim() === CHANGELOG_PATH);
}

/** Compare two bare "x.y.z" version strings. Returns <0 / 0 / >0. */
export function compareBareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * Whether the TOP TWO headings in a changelog are out of order — i.e. the top
 * one is not strictly newer than the one directly below it. Returns
 * `{ above, below }` on a violation, null when the top pair is fine (or there
 * are fewer than two headings to compare).
 *
 * DELIBERATELY the top pair ONLY — this is an explicit comparison of
 * `versions[0]` and `versions[1]`, not a scan of the file. A release PR can
 * only ever have made ONE heading newly wrong: the one it just collated at
 * the top. Everything below that is settled history from a previous,
 * already-accepted release, and is not this function's to re-litigate.
 * docs/CHANGELOG.md has a real, permanent, pre-#2364 anomaly proving why that
 * matters: two `v0.20.0` headings at 2026-04-18 (lines ~8674/8683), deep in
 * settled history, which `fixVersionCollisions` in
 * scripts/changelog-normalize-core.mjs also documents by name and refuses to
 * touch. Compare more than the top pair and this function would trip on that
 * anomaly on EVERY future release PR forever, with no fix possible
 * (`changelog-normalize.mjs` won't touch that zone either) short of
 * `[skip-ship-guard]` — which also disables check (0). See the "does not flag
 * a deep pre-existing anomaly" test below; that's the whole point of the
 * bound, unproven without it. Do not "fix" this into a loop over every pair —
 * that reads as more thorough but silently restores the unbounded scan this
 * comment exists to warn against.
 *
 * Deliberately built from `parseHeading` (already imported from
 * app-version.mjs) and this file's own `compareBareVersions`, NOT from
 * changelog-normalize-core.mjs — see the sparse-checkout note in
 * .forgejo/workflows/ship-guard.yml. Only the version ORDER is checked here;
 * blank-line spacing is cosmetic and stays the local
 * `changelog-normalize.mjs` run's job.
 */
export function firstDescendingViolation(contents) {
  if (typeof contents !== "string") return null;
  const versions = contents
    .split("\n")
    .map((line) => parseHeading(line))
    .filter(Boolean)
    .map((h) => h.version.join("."));
  if (versions.length < 2) return null;
  const [top, next] = versions;
  return compareBareVersions(top, next) <= 0 ? { above: top, below: next } : null;
}

/**
 * #2165 — the PR's changelog top entry must be a strictly newer version than
 * origin/main's top entry. `prContents`/`mainContents` are the raw file text
 * of docs/CHANGELOG.md on each side (undefined/null means "couldn't read it",
 * which fails OPEN — an infra hiccup shouldn't block a PR, mirroring the rest
 * of this runner's git-failure handling).
 */
export function changelogVersionAdvanced({ prContents, mainContents }) {
  if (typeof prContents !== "string" || typeof mainContents !== "string") {
    return { ok: true, prVersion: null, mainVersion: null }; // couldn't tell — don't block
  }
  const prVersion = parseChangelogVersion(prContents);
  const mainVersion = parseChangelogVersion(mainContents);
  return { ok: compareBareVersions(prVersion, mainVersion) > 0, prVersion, mainVersion };
}

/**
 * Pure decision. Returns { ok, reasons } where `reasons` is a list of
 * human-readable failures (empty when ok). Exported for exhaustive testing.
 */
export function decide({ body, title, changedFiles, addedFiles, changelogVersions }) {
  // Escape hatch — title token bypasses everything.
  if (typeof title === "string" && title.includes(SKIP_MARKER)) {
    return { ok: true, reasons: [], skipped: true, ready: [] };
  }

  const release = isReleasePr(title);
  const reasons = [];

  // (0) #2364 — only a release PR may touch docs/CHANGELOG.md. This is the
  // check that keeps two PRs from colliding on the file's top anchor, so it
  // applies to EVERY PR, Ready lines or not.
  if (!release && changelogTouched(changedFiles)) {
    reasons.push(
      `This PR edits ${CHANGELOG_PATH}, which only a release PR may do (#2364). ` +
        `Add a fragment in ${FRAGMENT_DIR} instead — see the update-changelog skill.`,
    );
  }

  // (c) #2165, now a RELEASE-PR check: the collated entry must be newer than
  // main's top entry, and the file must still normalize clean. Feature PRs no
  // longer set versions, so neither can apply to them. Runs BEFORE the
  // chore-PR early return, because a release PR has no `Ready #N` lines.
  if (release && changelogVersions) {
    const { ok: advanced, prVersion, mainVersion } = changelogVersionAdvanced(changelogVersions);
    if (!advanced) {
      reasons.push(
        `docs/CHANGELOG.md's top entry (v${prVersion}) is not newer than origin/main's (v${mainVersion}) — ` +
          `merge origin/main and re-run \`node scripts/changelog-collate.mjs\`, then re-push.`,
      );
    }
    const outOfOrder = firstDescendingViolation(changelogVersions.prContents);
    if (outOfOrder) {
      reasons.push(
        `docs/CHANGELOG.md's headings are not strictly descending — v${outOfOrder.above} sits above ` +
          `v${outOfOrder.below}. Run \`node scripts/changelog-normalize.mjs\` and re-push.`,
      );
    }
  }

  const ready = [...parseReadyNumbers(body)];

  // No `Ready #N` lines → pure-chore PR, nothing further to enforce.
  if (ready.length === 0) {
    return { ok: reasons.length === 0, reasons, skipped: false, ready: [] };
  }

  // (a) #2364 — a Ready PR must add a fragment, unless it's a release PR or
  // carries the title exemption. Replaces the old "must touch CHANGELOG" rule.
  // #2410(a) — reads `addedFiles` (added-only), NOT `changedFiles` — see
  // fragmentsAdded's doc comment for why the two lists must stay separate.
  if (
    !release &&
    !(typeof title === "string" && title.includes(NO_CHANGELOG_MARKER)) &&
    fragmentsAdded(addedFiles).length === 0
  ) {
    reasons.push(
      `PR has Ready line(s) (${ready.map((n) => `#${n}`).join(", ")}) but adds no fragment in ` +
        `${FRAGMENT_DIR} — add one, or put ${NO_CHANGELOG_MARKER} in the PR title.`,
    );
  }

  // (b) every Ready #N needs a `### #N` test-plan block under `## Test plans`.
  const planned = parseTestPlanNumbers(body);
  const missing = ready.filter((n) => !planned.has(n));
  if (missing.length > 0) {
    reasons.push(
      `Missing a \`### #N\` Test-plan block for: ${missing.map((n) => `#${n}`).join(", ")} (need a \`## Test plans\` section with one \`### #N\` block per Ready line).`,
    );
  }

  return { ok: reasons.length === 0, reasons, skipped: false, ready };
}

// ---------------------------------------------------------------------------
// Thin runner — reads PR body/title from env (set from the event payload) and
// the changed-file list from git, then prints the verdict and exits 0/1.
// ---------------------------------------------------------------------------

// maxBuffer: docs/CHANGELOG.md is >1MB (over a million bytes as of #2364) and
// `git show HEAD:docs/CHANGELOG.md` returns the WHOLE file on stdout. Node's
// execFileSync default maxBuffer is 1MiB, so without this the read throws
// ENOBUFS — which the try/catch below silently swallows into `null`, which
// `gitChangelogVersions` turns into `changelogVersions: undefined`, which
// makes decide()'s `release && changelogVersions` guard false — i.e. check
// (c) silently NEVER RUNS in production, no matter how broken a release PR's
// changelog is. Matches the other 64MB call sites in this repo (e.g.
// scripts/audit-gate.mjs, scripts/coverage-comment/build-comment.mjs). Do not
// "tidy" this away — it is load-bearing, see check.test.mjs's >1MiB fixture.
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function tryGit(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER });
  } catch {
    return null;
  }
}

/** "origin/main" if fetched, else local "main", else null (no usable ref). */
function resolveMainRef() {
  if (tryGit(["rev-parse", "--verify", "origin/main"])) return "origin/main";
  if (tryGit(["rev-parse", "--verify", "main"])) return "main";
  return null;
}

function gitChangedFiles(base) {
  // `origin/main...HEAD` = files changed on the HEAD side since the merge-base,
  // so commits merged in from main don't count as "this PR's changes". Returns
  // null on any git failure — the runner treats that as "can't tell", see main().
  const out = tryGit(["diff", "--name-only", `${base}...HEAD`]);
  if (out === null) return null;
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * #2410(a) — the added-only counterpart to gitChangedFiles, for check (a)'s
 * `addedFiles`. Same `base...HEAD` range, plus `--diff-filter=A` so a deleted
 * or modified path (e.g. someone else's still-pending fragment) never appears
 * here. Returns null on any git failure, same fail-open contract as
 * gitChangedFiles — main() skips the WHOLE guard rather than let decide()'s
 * fail-closed default (see fragmentsAdded's doc comment) block a legitimate
 * PR on an infra hiccup.
 *
 * `--no-renames` is REQUIRED, not cosmetic: git's porcelain rename detection
 * (`diff.renames`) defaults to on for git >= 2.9, so a fragment added via a
 * rename-shaped diff (e.g. `git mv` an unrelated file onto a fragment path,
 * or a big enough content match) can be reported as status `R` instead of
 * `A` — and `--diff-filter=A` would then silently MISS it, fragmentsAdded
 * would treat it as not-added, and a genuinely fine PR would get blocked.
 * That fails in the SAFE direction (a false block, never a false pass), but
 * it would still make this guard's behaviour depend on the runner's git
 * config/version rather than being deterministic. `--no-renames` makes the
 * result independent of `diff.renames` either way.
 */
function gitAddedFiles(base) {
  const out = tryGit(["diff", "--name-only", "--no-renames", "--diff-filter=A", `${base}...HEAD`]);
  if (out === null) return null;
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * #2165 — read docs/CHANGELOG.md as it stands on HEAD (the PR) and on `base`
 * (main), for the version-advanced check. null on any git failure (missing
 * file on one side reads as "" via `git show`, which is fine — it just
 * parses to version "0.0.0").
 */
function gitChangelogVersions(base) {
  const prContents = tryGit(["show", `HEAD:${CHANGELOG_PATH}`]);
  const mainContents = tryGit(["show", `${base}:${CHANGELOG_PATH}`]);
  if (prContents === null || mainContents === null) return null;
  return { prContents, mainContents };
}

function main() {
  const body = process.env.PR_BODY ?? "";
  const title = process.env.PR_TITLE ?? "";
  const base = resolveMainRef();

  if (base === null) {
    // Couldn't resolve a main ref (git missing / no fetch). Fail open with a
    // notice rather than blocking — an infra problem shouldn't wedge a PR.
    console.log("ship-guard: could not compute changed files vs main — skipping (non-blocking).");
    process.exit(0);
  }

  const changedFiles = gitChangedFiles(base);
  if (changedFiles === null) {
    console.log("ship-guard: could not compute changed files vs main — skipping (non-blocking).");
    process.exit(0);
  }

  // #2410(a) — a SEPARATE, added-only list for check (a); see
  // fragmentsAdded's doc comment for why it must not be merged with
  // changedFiles. Fails the WHOLE guard open on a git error, same as
  // gitChangedFiles above — decide()'s own fail-closed default for a missing
  // addedFiles exists for callers that skip this computation entirely, not
  // for this runner to lean on when git itself is broken.
  const addedFiles = gitAddedFiles(base);
  if (addedFiles === null) {
    console.log("ship-guard: could not compute added files vs main — skipping (non-blocking).");
    process.exit(0);
  }

  // #2410(b) — fails open to undefined on any git error, same as every other
  // fail-open branch in this runner, but (unlike before) NEVER silently: a
  // notice prints so a broken/oversized read doesn't look identical to a
  // clean pass. This is exactly the shape of bug C1 (see the GIT_MAX_BUFFER
  // comment above) — decide() then skips check (c) rather than blocking on
  // an infra hiccup, but now that skip is visible in the log.
  const changelogVersionsRaw = gitChangelogVersions(base);
  if (changelogVersionsRaw === null) {
    console.log(
      `ship-guard: could not read ${CHANGELOG_PATH} on one side (PR or main) — skipping check (c) (non-blocking).`,
    );
  }
  const changelogVersions = changelogVersionsRaw ?? undefined;

  const result = decide({ body, title, changedFiles, addedFiles, changelogVersions });

  if (result.skipped) {
    console.log(`ship-guard: ${SKIP_MARKER} present in PR title — skipped.`);
    process.exit(0);
  }

  // #2364 — checks (0)/(c) can fail a PR with NO `Ready #N` lines at all (a
  // non-release PR that edits docs/CHANGELOG.md directly, or — the common
  // case — a release PR itself, which by design carries no Ready line and
  // whose only exposure IS check (c)). So `result.ok` must be tested before
  // `result.ready.length === 0`, not after: the old order let a failing
  // Ready-less PR print "OK" and exit 0, silently disabling both checks.
  if (!result.ok) {
    console.error("ship-guard: FAIL.\n");
    for (const r of result.reasons) console.error(`  • ${r}`);
    // M1 — the remedy differs by PR shape: a release PR's failures are
    // release-collation problems (each reason already names the exact
    // command to re-run), never a `/ship`-skill problem, since `/ship` never
    // touches a release PR. Telling every failing PR to run `/ship` was
    // actively wrong for that case.
    if (isReleasePr(title)) {
      console.error(
        "\nRelease-PR housekeeping: merge current origin/main, re-run\n" +
          "`node scripts/changelog-collate.mjs` and `node scripts/changelog-normalize.mjs`, then re-push.\n" +
          `Escape hatch for the rare legitimate case: put ${SKIP_MARKER} in the PR title.`,
      );
    } else {
      console.error(
        "\nRun the `/ship` skill (.claude/skills/ship/SKILL.md): it writes the changelog fragment and\n" +
          "the `## Test plans` block (one `### #N` per `Ready #N`) that this guard checks for.\n" +
          `Escape hatch for the rare legitimate case: put ${SKIP_MARKER} in the PR title.`,
      );
    }
    process.exit(1);
  }

  if (result.ready.length === 0) {
    console.log("ship-guard: no `Ready #N` lines — pure-chore PR, nothing to enforce. OK.");
    process.exit(0);
  }

  console.log(
    `ship-guard: OK — Ready ${result.ready.map((n) => `#${n}`).join(", ")} each adds a changelog fragment + \`### #N\` test plan.`,
  );
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith("check.mjs") || process.argv[1].endsWith("ship-guard/check"));
if (invokedDirectly) main();
