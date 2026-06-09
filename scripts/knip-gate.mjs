// knip-gate.mjs — diff-aware local dead-code gate for scripts/preflight.sh.
//
// WHY NOT a plain `knip total > 0` gate locally: knip run on a dev machine
// over-reports relative to CI's dead-code bot — it flags pre-existing items on
// a clean `main` (e.g. a devDependency that IS imported, but from a path
// outside knip's analysed `project` scope). A naive absolute gate would
// false-fail preflight on `main`, which is exactly the drift preflight exists
// to avoid.
//
// So we run knip ONCE, then keep only findings located in files THIS branch
// changed versus `main`. Pre-existing phantoms live in untouched files and drop
// out; only dead code the branch introduces is flagged. CI's absolute gate
// (dead-code.yml, `knip total > 0`) remains the full backstop on the PR.
//
// Reuses the CI bot's exact knip invocation + categorisation (runKnip +
// summarise from run-and-post.mjs) so what we flag lines up with how CI labels
// it. Infra failures (knip crash, missing git) are non-blocking — they exit 0,
// matching the bot's "never fail on infrastructure" rule.

import { execFileSync } from "node:child_process";
import { runKnip, summarise } from "./dead-code-comment/run-and-post.mjs";

const CATEGORIES = ["dependencies", "devDependencies", "unlisted", "exports", "types", "duplicates"];

// Pure: given knip's summarised output + the set of files the branch changed,
// return the offender strings located in changed files. Exported for testing.
export function selectNewOffenders({ files, issues, changedFiles }) {
  const changed = changedFiles instanceof Set ? changedFiles : new Set(changedFiles);
  const offenders = [];
  for (const f of files ?? []) {
    if (changed.has(f)) offenders.push(`unused file: ${f}`);
  }
  for (const group of issues ?? []) {
    if (!group || !changed.has(group.file)) continue;
    for (const cat of CATEGORIES) {
      for (const item of group[cat] ?? []) {
        const name = typeof item === "string" ? item : item.name;
        offenders.push(`${cat}: ${group.file}: ${name}`);
      }
    }
  }
  return offenders;
}

// Files this branch changed versus main: committed work since diverging from
// main (origin/main...HEAD), plus any staged/unstaged working-tree changes.
function changedFiles() {
  const set = new Set();
  const add = (out) =>
    out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((f) => set.add(f));
  const tryGit = (args) => {
    try {
      return execFileSync("git", args, { encoding: "utf8" });
    } catch {
      return "";
    }
  };
  // Prefer origin/main; fall back to local main. Three-dot = changes on the
  // HEAD side since the merge-base, so commits merged in from main don't count.
  let diffBase = "";
  if (tryGit(["rev-parse", "--verify", "origin/main"]).trim()) diffBase = "origin/main";
  else if (tryGit(["rev-parse", "--verify", "main"]).trim()) diffBase = "main";
  if (diffBase) add(tryGit(["diff", "--name-only", `${diffBase}...HEAD`]));
  add(tryGit(["diff", "--name-only", "HEAD"])); // unstaged
  add(tryGit(["diff", "--name-only", "--cached"])); // staged
  return set;
}

function main() {
  const report = runKnip(); // exits 0 on knip crash/parse-fail (non-blocking)
  const { files, issues } = summarise(report);
  const offenders = selectNewOffenders({ files, issues, changedFiles: changedFiles() });

  if (offenders.length === 0) {
    console.log("no new dead code in files this branch changed (vs main).");
    process.exit(0);
  }
  console.log(`knip: ${offenders.length} new unused item(s) introduced by this branch:`);
  for (const o of offenders) console.log(`  ${o}`);
  console.log(
    "\nRemove them, or make the symbol non-exported. CI's dead-code gate (knip) will block the PR otherwise.",
  );
  process.exit(1);
}

const invokedDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith("knip-gate.mjs") || process.argv[1].endsWith("knip-gate"));
if (invokedDirectly) main();
