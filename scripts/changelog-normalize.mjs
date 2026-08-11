// CLI wrapper for scripts/changelog-normalize-core.mjs (#2165).
//
// `/ship`'s Step 2.5 runs this right after resolving a `git merge origin/main`
// conflict in docs/CHANGELOG.md — the human keeps both entries with ours on
// top, then this assigns the versions instead of anyone renumbering by hand.
//
// It is also safe to run when the merge reported NO conflict: it is a no-op
// (no diff) on an already-clean file, and running it unconditionally costs
// nothing. Cheap enough that Step 2.5 does exactly that, so a version problem
// arriving by some route other than a conflict still gets caught.
//
// Usage:
//   node scripts/changelog-normalize.mjs [path]           # fix in place
//   node scripts/changelog-normalize.mjs [path] --check    # exit 1 if a fix
//                                                            is needed, write
//                                                            nothing (CI use)
//
// Default path is docs/CHANGELOG.md at the repo root.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalize } from "./changelog-normalize-core.mjs";

function defaultChangelogPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../docs/CHANGELOG.md");
}

function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--check");
  const checkOnly = process.argv.includes("--check");
  const path = args[0] ?? defaultChangelogPath();

  const before = readFileSync(path, "utf8");
  const after = normalize(before);

  if (after === before) {
    console.log(`changelog-normalize: ${path} already clean — no changes.`);
    process.exit(0);
  }

  if (checkOnly) {
    console.error(
      `changelog-normalize: ${path} needs normalizing (spacing and/or a version collision). ` +
        `Run \`node scripts/changelog-normalize.mjs\` to fix it in place.`,
    );
    process.exit(1);
  }

  writeFileSync(path, after);
  console.log(`changelog-normalize: fixed ${path}.`);
}

const invokedDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith("changelog-normalize.mjs") ||
    process.argv[1].endsWith("changelog-normalize"));
if (invokedDirectly) main();
