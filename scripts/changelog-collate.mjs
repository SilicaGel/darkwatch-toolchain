// CLI wrapper for scripts/changelog-collate-core.mjs (#2364).
//
// Run by the `/release` skill. Reads every fragment in docs/changelog.d/,
// orders them by MERGE order, collates them into one release entry at the top
// of docs/CHANGELOG.md, and deletes the fragments — all in one reviewable diff.
//
// Ordering is merge order (when the file was ADDED to the branch), not filename
// order, so the entry reads in the order the work actually landed. Order is
// presentation, not integrity: `/release` may reorder sub-entries in the PR
// without breaking the byte-equality guarantee the core module holds.
//
// FAILURE IS ALL-OR-NOTHING. A malformed fragment aborts before anything is
// written or deleted. This file is a record; a partial write is worse than no
// write, because it looks like a complete one.
//
// Usage:
//   node scripts/changelog-collate.mjs --title "…" [--lead "…"]
//                                      [--date YYYY-MM-DD] [--dry-run]

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseFragment, collate } from "./changelog-collate-core.mjs";
import { formatVersion } from "./changelog-normalize-core.mjs";

export const FRAGMENT_DIR = "docs/changelog.d";
export const CHANGELOG_PATH = "docs/CHANGELOG.md";

/** Repo root: the git toplevel of cwd, so the CLI works from any subdirectory. */
function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

/**
 * Read + parse every *.md fragment. Throws on the first malformed one — and
 * throws naming the offending entry for anything in `docs/changelog.d/` that
 * isn't a top-level `*.md` file or `.gitkeep`: a subdirectory, or a stray
 * file with another extension. `readdirSync` here is non-recursive, so a
 * subdirectory's contents would otherwise be silently skipped — the exact
 * failure the review found: a fragment nested one level down passed
 * ship-guard's `fragmentsAdded`, was never read here, and the release
 * collated one fragment short with no warning anywhere. Refusing loudly beats
 * reading nothing quietly.
 */
export function readFragments(root) {
  const dir = join(root, FRAGMENT_DIR);
  const entries = readdirSync(dir, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (entry.name === ".gitkeep") continue;
    if (entry.isDirectory()) {
      throw new Error(
        `${FRAGMENT_DIR}/${entry.name}: a subdirectory inside ${FRAGMENT_DIR} is never read ` +
          `(readdirSync here is non-recursive) — move its fragment(s) directly into ${FRAGMENT_DIR}, ` +
          `or remove it.`,
      );
    }
    if (!entry.name.endsWith(".md")) {
      throw new Error(
        `${FRAGMENT_DIR}/${entry.name}: not a *.md fragment — remove it, or rename it to end in .md.`,
      );
    }
    names.push(entry.name);
  }
  names.sort(); // stable fallback; merge order is applied next
  return names.map((name) => {
    const path = join(dir, name);
    return { path, name, ...parseFragment(readFileSync(path, "utf8"), `${FRAGMENT_DIR}/${name}`) };
  });
}

/**
 * Sort by the commit that ADDED each fragment. `--diff-filter=A --reverse`
 * gives the add-commit first; its position in the full first-parent log is the
 * sort key. A fragment with no commit yet (staged/untracked, the /release
 * author's own) sorts last — it is the newest thing by definition.
 */
export function orderByMergeOrder(entries, root) {
  const keyed = entries.map((e) => {
    const sha = execFileSync(
      "git",
      ["log", "--diff-filter=A", "--reverse", "--format=%H", "--", `${FRAGMENT_DIR}/${e.name}`],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")[0]
      .trim();
    if (!sha) return { ...e, order: Number.MAX_SAFE_INTEGER };
    const count = execFileSync("git", ["rev-list", "--count", sha], {
      cwd: root,
      encoding: "utf8",
    });
    return { ...e, order: Number(count.trim()) };
  });
  // Stable tie-break on filename so a same-commit pair is deterministic.
  return keyed.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") out.dryRun = true;
    else if (argv[i] === "--title") out.title = argv[++i];
    else if (argv[i] === "--lead") out.lead = argv[++i];
    else if (argv[i] === "--date") out.date = argv[++i];
    else throw new Error(`changelog-collate: unknown argument ${JSON.stringify(argv[i])}`);
  }
  if (!out.title) throw new Error("changelog-collate: --title is required.");
  if (!out.date) out.date = new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date)) {
    throw new Error(
      `changelog-collate: --date must be YYYY-MM-DD, got ${JSON.stringify(out.date)}`,
    );
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const changelog = join(root, CHANGELOG_PATH);

  // Everything that can throw runs BEFORE the first write.
  const fragments = orderByMergeOrder(readFragments(root), root);
  const { version, entry, contents } = collate({
    changelogContents: readFileSync(changelog, "utf8"),
    fragments,
    date: args.date,
    title: args.title,
    lead: args.lead,
  });

  if (args.dryRun) {
    process.stdout.write(entry);
    console.error(
      `changelog-collate: --dry-run — would release v${formatVersion(version)}, nothing written.`,
    );
    return;
  }

  writeFileSync(changelog, contents);

  // The changelog write above already succeeded — the release is recorded
  // and cannot be un-recorded. From here, deleting fragments is best-effort
  // cleanup, not part of the release itself, so one rmSync failure must not
  // abort the rest (a lock on one file shouldn't strand every fragment), and
  // the failure must not look to an operator like "the release failed": a
  // reasonable response to that reading is to re-run the CLI, which would
  // collate the survivors AGAIN into a second, duplicate release entry. So:
  // delete what we can, collect what we can't, and if anything survives, say
  // plainly what already happened and what not to do next.
  const undeleted = [];
  for (const f of fragments) {
    try {
      rmSync(f.path);
    } catch (err) {
      undeleted.push({ path: f.path, message: err.message });
    }
  }

  if (undeleted.length > 0) {
    const lines = [
      `the changelog write SUCCEEDED — v${formatVersion(version)} is recorded in ${CHANGELOG_PATH}.`,
      `${undeleted.length} fragment file(s) could NOT be deleted and must be removed by hand:`,
      ...undeleted.map((u) => `  - ${u.path} (${u.message})`),
      `DO NOT re-run this CLI until they are removed — it would collate them again into a duplicate release entry.`,
    ];
    throw new Error(lines.join("\n"));
  }

  console.log(
    `changelog-collate: released v${formatVersion(version)} from ${fragments.length} fragment(s).`,
  );
}

const invokedDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith("changelog-collate.mjs") ||
    process.argv[1].endsWith("changelog-collate"));
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error(`changelog-collate: ${err.message}`);
    process.exit(1);
  }
}
