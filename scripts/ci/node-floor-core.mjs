/**
 * node-floor-core.mjs — #2586. Pure logic for "which Node does this repo
 * require, and does everything actually agree with that."
 *
 * THE GAP THIS FILLS. Three places independently decided which Node this
 * project runs on — the CI image's floating `node:22-bookworm` tag, CI's
 * floating `setup-node: "22"`, and whatever a developer happened to have
 * installed — and nothing reconciled them, and nothing declared a minimum.
 * #2585 (jsdom 29 -> 30) raised jsdom's own floor from `^22.13.0` to
 * `^22.22.2`; CI stayed green because both its paths resolve a recent 22.x
 * on their own, but a developer machine below that floor gets `EBADENGINE`
 * from npm and a jsdom that may rely on a 22.22-only API failing silently in
 * every client unit test. `scripts/preflight.sh`'s existing
 * `check_workflow_node_versions` looks like it would catch this and does
 * not — it asserts every workflow SPELLS the same node-version string
 * ("22"), never the resolved patch, never a developer's Node, and has no
 * concept of a floor a dependency requires.
 *
 * TWO SEPARATE QUESTIONS, TWO FUNCTIONS.
 *   - `checkFloor` — is the Node THIS SCRIPT IS RUNNING ON new enough to
 *     satisfy the repo's declared minimum? Answers "will this fail on MY
 *     machine right now."
 *   - `checkEnginesAgainstFloor` — does the declared minimum actually
 *     satisfy every dependency's own `engines.node`, as recorded in the
 *     workspace lockfiles? Answers "did a dependency quietly raise the
 *     floor out from under the declared minimum." This is what makes a
 *     jsdom-style bump REPORTED rather than discovered on someone's laptop —
 *     the lockfile already carries the exact data (`packages.<pkg>.engines`
 *     in a lockfileVersion 3 file, populated from the published package's
 *     own package.json), so no registry call is needed.
 *
 * `satisfiesEngineRange` implements the subset of node-semver's range
 * grammar that actually appears across this repo's four lockfiles (root,
 * server, client, tests) as of 2026-08-28 — bare/partial versions (X-ranges,
 * caret-equivalent), `^`/`~`, `>=`/`<=`/`>`/`<`/`=`, `||` alternation, and
 * space-separated AND within one alternative. `semver` the npm package is
 * NOT used here deliberately: it is only a transitive devDependency in this
 * tree (pulled in by lint-staged et al, not declared by any workspace's own
 * package.json), and this project's worktree/CI discipline is "never `npm
 * install`, even to add one line to a manifest" — depending on an
 * undeclared transitive package would work today and silently break the
 * moment that transitive chain shifts. A range this project doesn't parse
 * correctly reports `null` ("cannot tell") rather than guessing, same
 * discipline as `audit-fix-watch-core.mjs`'s `satisfiesRange`.
 *
 * No I/O here — `node-floor.mjs` is the shell (reads .nvmrc, process.version,
 * the four lockfiles).
 */

/** Parse a concrete X.Y.Z version (optionally `v`-prefixed). Null if not that shape. */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Standard numeric major.minor.patch ordering (no prerelease handling — Node releases don't carry one here). */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (const k of ["major", "minor", "patch"]) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  return 0;
}

/**
 * Parse a possibly-partial version fragment as it appears inside a range
 * comparator: `10`, `10.2`, `10.x`, `10.X`, `*`, `v12.22.7`. Missing or `x`
 * components are `null`. Returns null only when the fragment isn't even
 * this shape (an unparseable range).
 */
function parseFragment(s) {
  const raw = String(s ?? "")
    .trim()
    .replace(/^v/i, "");
  if (raw === "" || raw === "*") return { major: null, minor: null, patch: null };
  const m = /^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(raw);
  if (!m) return null;
  const part = (x) => (x === undefined || /^[xX*]$/.test(x) ? null : Number(x));
  return { major: part(m[1]), minor: part(m[2]), patch: part(m[3]) };
}

/** Fill a partial fragment's missing components with 0, for use as a lower bound. */
function floorOf(frag) {
  return {
    major: frag.major ?? 0,
    minor: frag.minor ?? 0,
    patch: frag.patch ?? 0,
  };
}

function cmp(a, b) {
  for (const k of ["major", "minor", "patch"]) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  return 0;
}

/**
 * One `[min, max)` bound — `max: null` means unbounded above. Both ends are
 * plain `{major,minor,patch}` objects; `min` is always inclusive, `max`
 * (when present) is always exclusive, so every comparator form normalises to
 * the same shape before the caller checks containment.
 */
function boundFromToken(token) {
  const m = /^(>=|<=|>|<|\^|~|=)?\s*(.+)$/.exec(token.trim());
  if (!m) return null;
  const op = m[1] ?? "";
  const frag = parseFragment(m[2]);
  if (!frag) return null;

  // A true wildcard ("*", or "x", or "" after an operator like ">=*" —
  // pathological but harmless to accept) means "no constraint at all", not
  // "major 0.x.x". Every other branch below treats a null major as "fill
  // with 0", which is right for a genuinely PARTIAL fragment ("18" → an
  // 18.x.y) but wrong for an outright wildcard — this must come before that
  // logic runs, or "*" narrows to "0.x.x only" and a package declaring
  // `engines.node: "*"` (meaning "I don't care") wrongly fails every check.
  if (frag.major === null && frag.minor === null && frag.patch === null) {
    return { min: { major: 0, minor: 0, patch: 0 }, max: null };
  }

  if (op === ">=") {
    // A REAL >= comparator is always a pure lower bound, unbounded above,
    // regardless of whether the fragment is partial ("18", "0.10") or full
    // ("18.2.3") — missing components fill with 0. This is deliberately NOT
    // the same as the bare-no-operator case below: ">=18" means "18 or
    // newer, forever"; bare "18" means "an 18.x.y, but not 19+".
    return { min: floorOf(frag), max: null };
  }
  if (op === "") {
    // A bare (no-operator) fragment is an X-range: "18" / "6.*" / "10.x"
    // means "any 18.x.y" — the caret-equivalent bound — UNLESS it's a full
    // concrete triple (18.2.3), which means exactly that version.
    const min = floorOf(frag);
    if (frag.major !== null && frag.minor !== null && frag.patch !== null) {
      return { min, max: { major: min.major, minor: min.minor, patch: min.patch + 1 } };
    }
    if (frag.minor === null) return { min, max: { major: min.major + 1, minor: 0, patch: 0 } };
    return { min, max: { major: min.major, minor: min.minor + 1, patch: 0 } };
  }
  if (op === "<=") {
    // Only observed as a full triple in this repo's lockfiles; treat a
    // partial <= the same shape as >= would (fill with 0) for consistency.
    return { min: { major: 0, minor: 0, patch: 0 }, max: null, inclusiveMax: floorOf(frag) };
  }
  if (op === ">") {
    const f = floorOf(frag);
    return { min: { ...f, patch: f.patch + 1 }, max: null };
  }
  if (op === "<") {
    return { min: { major: 0, minor: 0, patch: 0 }, max: floorOf(frag) };
  }
  if (op === "=") {
    const v = floorOf(frag);
    return { min: v, max: { major: v.major, minor: v.minor, patch: v.patch + 1 } };
  }
  if (op === "^") {
    const v = floorOf(frag);
    let max;
    if (v.major > 0 || frag.major === null) max = { major: v.major + 1, minor: 0, patch: 0 };
    else if (v.minor > 0 || frag.minor === null) max = { major: 0, minor: v.minor + 1, patch: 0 };
    else max = { major: 0, minor: 0, patch: v.patch + 1 };
    return { min: v, max };
  }
  if (op === "~") {
    const v = floorOf(frag);
    const max =
      frag.minor === null
        ? { major: v.major + 1, minor: 0, patch: 0 }
        : { major: v.major, minor: v.minor + 1, patch: 0 };
    return { min: v, max };
  }
  return null;
}

/** Does `candidate` (a concrete X.Y.Z) fall inside a `[min, max)` (or `<= inclusiveMax`) bound? */
function inBound(candidate, bound) {
  if (cmp(candidate, bound.min) < 0) return false;
  if (bound.max && cmp(candidate, bound.max) >= 0) return false;
  if (bound.inclusiveMax && cmp(candidate, bound.inclusiveMax) > 0) return false;
  return true;
}

/**
 * Does `version` (a concrete X.Y.Z) satisfy an `engines.node`-style range?
 *
 * Handles `||` alternation and space-separated AND within one alternative.
 * See the module header for exactly which comparator forms are covered —
 * this is deliberately the subset this repo's lockfiles actually use, not a
 * general node-semver reimplementation.
 *
 * @returns {boolean|null} null when the range could not be understood —
 *   the caller must treat that as "cannot tell", never as a guess.
 */
export function satisfiesEngineRange(version, range) {
  const candidate = parseVersion(version);
  if (!candidate) return null;
  const raw = String(range ?? "").trim();
  if (!raw) return null;

  for (const alt of raw.split("||")) {
    // Collapse a space BETWEEN an operator and its version (">= 4", "> = 0.6")
    // before splitting on whitespace, or the split below tears one comparator
    // into two unparseable fragments (">=", "4"). A real AND-conjunction
    // ("space-separated comparators", e.g. ">=8.10.0 <9.0.0") only ever has
    // whitespace BETWEEN two already-complete comparators, never inside one,
    // so this collapse cannot merge two real comparators together.
    const collapsed = alt.replace(/(>=|<=|>|<|\^|~|=)\s+/g, "$1");
    const tokens = collapsed.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    const bounds = tokens.map(boundFromToken);
    if (bounds.some((b) => b === null)) return null;
    if (bounds.every((b) => inBound(candidate, b))) return true;
  }
  return false;
}

/**
 * Is the Node this process is running on new enough for the repo's declared
 * minimum? The "will this fail on MY machine" check.
 *
 * @returns {{ok: boolean, running: string, minimum: string}}
 */
export function checkFloor(runningVersion, minimum) {
  const cmpResult = compareVersions(runningVersion, minimum);
  return { ok: cmpResult !== null && cmpResult >= 0, running: runningVersion, minimum };
}

/**
 * Does the declared minimum satisfy every dependency's own `engines.node`?
 *
 * @param {string} minimum the repo's declared minimum (a concrete X.Y.Z)
 * @param {{name: string, range: string}[]} entries every package + its
 *   engines.node, e.g. read from a workspace's package-lock.json `packages`
 * @returns {{ok: boolean, violations: {name: string, range: string}[], unparseable: {name: string, range: string}[]}}
 */
export function checkEnginesAgainstFloor(minimum, entries) {
  const violations = [];
  const unparseable = [];
  for (const { name, range } of entries ?? []) {
    const result = satisfiesEngineRange(minimum, range);
    if (result === null) unparseable.push({ name, range });
    else if (result === false) violations.push({ name, range });
  }
  return { ok: violations.length === 0, violations, unparseable };
}
