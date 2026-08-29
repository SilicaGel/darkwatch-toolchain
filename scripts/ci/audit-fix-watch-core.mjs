/**
 * audit-fix-watch-core.mjs — #2391 Job C. Pure logic for the "did a fix ship
 * yet?" watcher.
 *
 * THE GAP THIS FILLS. Two mechanisms already push an allowlist entry towards
 * cleanup, and neither answers the question a maintainer actually has:
 *   - `expires` is a DEADLINE. It fires whether or not anything upstream moved.
 *   - the stale-entry NOTE fires only AFTER the tree has already left the
 *     advisory behind — it notices cleanup that already happened.
 * Neither can say "a fixed version exists, go upgrade" while the entry is still
 * suppressing. That is this watcher's only job.
 *
 * WHY NOT `fixAvailable`. npm's own `fixAvailable` reports DOWNGRADES as fixes:
 * for the whole @lhci/cli chain it offers `@lhci/cli@0.1.0`, flagged
 * `isSemVerMajor` — a 2019-era Lighthouse CI that would silence the advisory by
 * breaking the jobs. Three separate allowlist entries document that trap. So we
 * ask the npm REGISTRY what has been published for the package that actually
 * carries the GHSA, and only ever report a version strictly GREATER than what is
 * installed. A downgrade can therefore never be reported, by construction.
 *
 * DEPENDENTS, NOT JUST THE CARRIER (#2399). #2388 collapsed the extract-zip
 * chain's four allowlist entries (the carrier plus three padding entries
 * naming non-vulnerable packages) down to one honest entry for the carrier.
 * That was correct for the allowlist, but this watcher used to walk those
 * padding entries too, so their upgrades (puppeteer-core, @puppeteer/browsers,
 * lighthouse) were incidentally visible. extract-zip has no upstream fix and
 * likely never will — 2.0.1 (2023) is the latest release — so the one entry
 * that remains is exactly the one guaranteed to report nothing, forever, and
 * the chain's real remediation path (upgrade a dependent so it stops pulling
 * in the vulnerable version) went invisible.
 *
 * `dependentsOf` walks the SAME `via` graph `audit-gate-core.mjs`'s
 * `reachableCarriers` already walks, but in reverse: given a carrier's
 * package name, it returns every package whose `via` chain reaches that
 * carrier, directly or transitively. `audit-fix-watch.mjs` then re-runs the
 * exact same `findFix` logic against EACH dependent, using THAT dependent's
 * own `range` from `npm audit --json` — which is npm's own resolved
 * "which versions of me are vulnerable because of what I depend on" range,
 * not a guess. A dependent version outside that range has been verified (by
 * npm's own dependency resolution, not by this watcher) to no longer pull in
 * the vulnerable range of the carrier. That is what makes a dependent
 * upgrade reportable as actually clearing the chain, not merely a newer
 * version existing for its own sake — the same "no-downgrade-noise" and
 * "highest installed version" guarantees `findFix` already gives the carrier
 * case apply unchanged, because it is the same function.
 *
 * No I/O here — `audit-fix-watch.mjs` is the shell.
 */

import { viaNames } from "../audit-gate-core.mjs";

/** Parse a semver string. Returns null for anything non-numeric-triple. */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(v ?? "").trim(),
  );
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : [],
  };
}

function comparePre(a, b) {
  // No prerelease outranks a prerelease (1.0.0 > 1.0.0-rc.1).
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Standard semver ordering. Unparseable versions sort below everything. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (const k of ["major", "minor", "patch"]) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

/**
 * Does `version` fall inside an npm-advisory vulnerable range?
 *
 * npm normalises advisory ranges to comparator sets — `<=2.0.1`,
 * `>=1.0.0 <1.2.3`, `<1.2.3 || >=2.0.0 <2.1.0`, `*`, a bare pinned version, or
 * a hyphen range `19.8.4 - 24.43.1` (which npm emits for most GHSA advisories
 * that have both a floor and a ceiling — puppeteer-core and lighthouse both
 * carry one right now). That is the whole grammar handled here; anything else
 * returns `null`, which the caller treats as "cannot tell" and therefore
 * reports nothing. A watcher that guesses would spend its credibility on false
 * "a fix shipped!" comments.
 *
 * @returns {boolean|null} null when the range could not be understood
 */
export function satisfiesRange(version, range) {
  const raw = String(range ?? "").trim();
  if (!raw) return null;
  if (raw === "*") return true;
  if (!parseVersion(version)) return null;

  for (const alt of raw.split("||")) {
    // `X - Y` is inclusive on both ends; rewrite it into the comparator form
    // the loop below already understands.
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(alt.trim());
    const normalised = hyphen ? `>=${hyphen[1]} <=${hyphen[2]}` : alt.trim();
    const comparators = normalised.split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return null;
    let all = true;
    for (const c of comparators) {
      const m = /^(<=|>=|<|>|=)?\s*(.+)$/.exec(c);
      if (!m) return null;
      const op = m[1] ?? "=";
      if (!parseVersion(m[2])) return null;
      const cmp = compareVersions(version, m[2]);
      const ok =
        op === "<"
          ? cmp < 0
          : op === "<="
            ? cmp <= 0
            : op === ">"
              ? cmp > 0
              : op === ">="
                ? cmp >= 0
                : cmp === 0;
      if (!ok) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/**
 * The smallest published version that clears the advisory without going
 * backwards.
 *
 * @param {object} args
 * @param {string} args.installed the HIGHEST version of this package currently in the tree
 * @param {string[]} args.versions every version published to the registry
 * @param {string} args.range the advisory's vulnerable range, from `npm audit --json`
 * @returns {{version: string, installed: string, isMajor: boolean}|null}
 */
export function findFix({ installed, versions, range }) {
  const floor = parseVersion(installed);
  if (!floor) return null;
  // Unparseable or all-encompassing range: no honest answer, so say nothing.
  if (satisfiesRange(installed, range) !== true) return null;

  const candidates = (versions ?? [])
    .filter((v) => {
      const p = parseVersion(v);
      // Prereleases are never offered as "the fix shipped" — an rc is not a
      // release, and skipping them also keeps us out of npm's prerelease
      // range-matching corner cases entirely.
      if (!p || p.pre.length > 0) return false;
      // STRICTLY greater than what is installed. This is the whole
      // no-downgrade-noise guarantee: `@lhci/cli@0.1.0` against an installed
      // 0.15.1 can never survive this filter, so npm's "fix" can never be
      // echoed here.
      if (compareVersions(v, installed) <= 0) return false;
      return satisfiesRange(v, range) === false;
    })
    .sort(compareVersions);

  if (candidates.length === 0) return null;
  const version = candidates[0];
  return {
    version,
    installed,
    isMajor: parseVersion(version).major > floor.major,
  };
}

/**
 * Every package name in `vulnerabilities` whose `via` chain reaches
 * `carrierName`, directly or transitively (#2399).
 *
 * The reverse of `audit-gate-core.mjs`'s `reachableCarriers`: that walks DOWN
 * from a path node to the carriers it depends on; this walks UP from a
 * carrier to the packages that depend on it. Same graph, same `via[]` edges
 * (`viaNames` filters a node's `via` down to the plain-string package-name
 * entries — the advisory objects are not edges), opposite direction.
 *
 * Bounded by a fixed-point loop over `seen`, so a cyclic graph terminates.
 *
 * @param {string} carrierName
 * @param {Object<string, object>|Map<string, object>} vulnerabilities `npm audit --json`'s `.vulnerabilities`, or an equivalent Map
 * @returns {Set<string>} dependent package names (never includes `carrierName` itself)
 */
export function dependentsOf(carrierName, vulnerabilities) {
  const byName =
    vulnerabilities instanceof Map
      ? vulnerabilities
      : new Map(Object.entries(vulnerabilities ?? {}));
  const dependents = new Set();
  const seen = new Set([carrierName]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, vuln] of byName) {
      if (seen.has(name)) continue;
      if (viaNames(vuln).some((v) => seen.has(v))) {
        dependents.add(name);
        seen.add(name);
        grew = true;
      }
    }
  }
  return dependents;
}

/**
 * The idempotency marker for one piece of news.
 *
 * Keyed by (ghsa, reported package, fixed version) so the watcher stays quiet
 * run after run, but a LATER fix — a newer clearing release, or the same
 * entry after an upgrade — is still news and fires once more.
 *
 * `reportedPackage` defaults to `entry.package` (the carrier) — the shape
 * every caller used before #2399. Pass a dependent's name explicitly when the
 * news is "this DEPENDENT has a clearing upgrade", so a fix reported for
 * `lighthouse` and one later reported for `puppeteer-core` on the same entry
 * key separately and neither silences the other.
 */
export function fixCommentMarker(entry, fixVersion, reportedPackage = entry.package) {
  return `<!-- audit-fix-watch:${entry.ghsa}:${reportedPackage}:${fixVersion} -->`;
}

/**
 * Has this exact news already been posted?
 *
 * The marker must LEAD the comment body, never be matched as a substring: a
 * comment that quotes or documents the marker format contains it, and matching
 * on containment is how a reporter once overwrote the issue describing itself.
 */
export function alreadyReported(comments, marker) {
  return (comments ?? []).some((c) => (c?.body || "").trimStart().startsWith(marker));
}

/**
 * The comment posted on the entry's tracked issue. Always begins with the marker.
 *
 * `fix.package` names which package the reported upgrade is FOR. It defaults
 * to `entry.package` (the carrier itself has a fix). When it differs — the
 * carrier has no upstream fix, but a dependent in its `via` chain does
 * (#2399) — the copy explains the chain instead of implying the carrier was
 * upgraded.
 */
export function renderFixComment(entry, fix, meta = {}) {
  const reportedPackage = fix.package ?? entry.package;
  const isDependent = reportedPackage !== entry.package;
  const marker = fixCommentMarker(entry, fix.version, reportedPackage);
  const workspaceList = `workspace${entry.workspaces.length === 1 ? "" : "s"}: ${entry.workspaces.map((w) => `\`${w}\``).join(", ")}`;
  const lines = [
    marker,
    "",
    isDependent
      ? `🟢 **\`${entry.package}\` itself has no upstream fix, but a fixed version of its dependent \`${reportedPackage}\` has been published: \`${fix.version}\`.**`
      : `🟢 **A fixed version of \`${entry.package}\` has been published: \`${fix.version}\`.**`,
    "",
    `- Advisory: [${entry.ghsa}](https://github.com/advisories/${entry.ghsa})`,
    isDependent
      ? `- Currently in the tree: \`${reportedPackage}@${fix.installed}\` (${workspaceList}), which pulls in the vulnerable \`${entry.package}\``
      : `- Currently in the tree: \`${fix.installed}\` (${workspaceList})`,
    isDependent
      ? `- Lowest published release of \`${reportedPackage}\` that npm's own dependency resolution confirms clears the chain: \`${fix.version}\`${fix.isMajor ? " — **semver-major**, so the upgrade needs review, not just a bump" : ""}`
      : `- Lowest published release outside the vulnerable range: \`${fix.version}\`${fix.isMajor ? " — **semver-major**, so the upgrade needs review, not just a bump" : ""}`,
    "",
    `The \`scripts/audit-allowlist.json\` entry for this advisory is **still suppressing** (expires ${entry.expires}). Upgrading now lets the entry be deleted rather than renewed.`,
    "",
    "_Determined from the npm registry's published version list, not from `npm audit --fix-available`, which reports downgrades as fixes (the `@lhci/cli@0.1.0` trap). Only versions strictly newer than what is installed are ever reported here._",
    "",
    `_Auto-filed by \`.forgejo/workflows/audit-watch.yml\` → \`scripts/ci/audit-fix-watch.mjs\` (#2391${isDependent ? ", dependent walk added in #2399" : ""})${meta.runUrl ? ` — [run log](${meta.runUrl})` : ""}._`,
  ];
  return lines.join("\n");
}
