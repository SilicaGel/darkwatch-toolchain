// Lockfile-based "genuinely added" package set (#723 follow-up).
//
// The Socket scan-diff keys off the package.json *manifests*, where `^`/`~`
// ranges re-resolve non-deterministically between the base and head scans — so
// dependencies that are UNCHANGED in the lockfile keep surfacing as "added",
// blocking PRs over pre-existing pins (playwright-core@1.60.0 in #1156,
// @puppeteer/browsers / lodash-es / binding-wasm32-wasi in #1150). Routine
// [allow-deps] overrides train people to ignore the gate.
//
// To gate only on what a PR ACTUALLY introduces, diff the PINNED lockfiles and
// keep only the Socket alerts whose `pkg@version` was genuinely added head-vs-base.
//
// FAIL SAFE: if the lockfiles can't be read at all, callers keep ALL alerts
// (conservative over-block). A parser bug must never silently disable the gate.

import { readFileSync } from "node:fs";
import { join } from "node:path";

// The lockfiles that pair with the scanned manifests (see run-and-post MANIFESTS).
export const LOCKFILES = [
  "package-lock.json",
  "client/package-lock.json",
  "server/package-lock.json",
  "tests/package-lock.json",
  "site/package-lock.json",
];

// Parse one npm lockfile's JSON text → array of `name@version` strings.
// Handles lockfileVersion 2/3 (`.packages` — the modern format this repo uses)
// and falls back to v1 (`.dependencies`, nested) for robustness. Returns null
// only on a JSON parse error (so the caller can treat it as "couldn't read").
export function parseLockfilePackages(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const out = [];

  // lockfileVersion 2/3: flat `.packages` map keyed by install path.
  if (data && typeof data.packages === "object" && data.packages) {
    for (const [key, entry] of Object.entries(data.packages)) {
      if (!key.startsWith("node_modules/")) continue; // skip "" root + workspace links
      const version = entry && entry.version;
      if (typeof version !== "string") continue;
      // Name is the segment after the LAST `node_modules/` — handles nesting
      // (`a/node_modules/b` → `b`) and scopes (`node_modules/@scope/x` → `@scope/x`).
      const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      if (name) out.push(`${name}@${version}`);
    }
    return out;
  }

  // lockfileVersion 1 fallback: recursively walk nested `.dependencies`.
  if (data && typeof data.dependencies === "object" && data.dependencies) {
    const walk = (deps) => {
      for (const [name, entry] of Object.entries(deps)) {
        if (entry && typeof entry.version === "string") out.push(`${name}@${entry.version}`);
        if (entry && typeof entry.dependencies === "object") walk(entry.dependencies);
      }
    };
    walk(data.dependencies);
    return out;
  }

  return []; // a lockfile with neither shape simply contributes nothing.
}

// Read every lockfile under `dir` → Set of `name@version`. Returns null if NO
// lockfile could be read at all — the fail-safe signal that means "don't filter".
export function collectLockfilePackages(dir, lockfiles = LOCKFILES) {
  const set = new Set();
  let readAny = false;
  for (const rel of lockfiles) {
    let text;
    try {
      text = readFileSync(join(dir, rel), "utf8");
    } catch {
      continue; // missing lockfile — fine, others may exist
    }
    const pkgs = parseLockfilePackages(text);
    if (pkgs === null) continue; // JSON parse error on this one — skip it
    readAny = true;
    for (const p of pkgs) set.add(p);
  }
  return readAny ? set : null;
}

// head − base: the `pkg@version` strings genuinely introduced by the PR.
export function lockfileAddedSet(baseSet, headSet) {
  const added = new Set();
  for (const p of headSet) if (!baseSet.has(p)) added.add(p);
  return added;
}

// Keep only the alerts whose `pkg@version` is in `addedSet`. Alerts use the
// normalized shape `{ pkg, version, type, ... }`.
export function filterAlertsToAdded(alerts, addedSet) {
  return alerts.filter((a) => addedSet.has(`${a.pkg}@${a.version}`));
}
