/**
 * audit-gate-core.mjs — #2391 / #2388. Pure decision logic for the npm-audit gate.
 *
 * Everything here is a total function over plain data: no `execFileSync`, no
 * filesystem, no environment, no clock. `scripts/audit-gate.mjs` is the I/O
 * shell that gathers the `npm audit --json` report, the allowlist, the diff and
 * today's date, and hands them in. The split follows the house pattern
 * (tree-gate-core, workflow-hash-core, check-e2e-tiers-core) and exists so a
 * security gate's matching rules can be unit-tested against fixture payloads —
 * #2388 records that there was NO coverage of this logic at all, which is why
 * the one-hop `via` bug had to be worked around with padding allowlist entries
 * instead of fixed inline.
 */

/** Severities that gate CI. Moderate/low are tracked but never block (#413). */
export const GATING = new Set(["high", "critical"]);

/**
 * Files whose change can plausibly alter the installed dependency tree.
 *
 * Granularity is deliberately FILE-level, not field-level: editing root
 * `package.json`'s `scripts` block counts as a dependency change even though it
 * cannot move a single package. That is the safe error direction — it costs a
 * full gate run on a PR that did not need one, where the opposite mistake would
 * wave a real new advisory through. Do not add precision here.
 */
const DEP_FILE_RE = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json)$/;

/**
 * The gate's own configuration. A PR that EDITS the allowlist changes no
 * dependency, so pure dependency-delta logic would call the resulting block
 * "ambient" and warn it through — meaning a PR that REMOVES a suppression could
 * silently weaken the very gate it is editing. Treating the allowlist as part of
 * the delta closes that hole.
 */
const GATE_CONFIG_FILE_RE = /(^|\/)audit-allowlist\.json$/;

/**
 * Classify a changed-file list: can this diff have changed what is installed?
 *
 * @param {string[]} files paths relative to the repo root, as `git diff --name-only` prints them
 * @returns {{depsChanged: boolean, matched: string[]}}
 */
export function classifyDelta(files) {
  const matched = (files ?? [])
    .map((f) => String(f).trim())
    .filter((f) => f.length > 0)
    .filter((f) => DEP_FILE_RE.test(f) || GATE_CONFIG_FILE_RE.test(f));
  return { depsChanged: matched.length > 0, matched };
}

/**
 * Every GHSA id attached to a vulnerability entry. `via[]` mixes advisory
 * OBJECTS (this node carries the advisory) with plain STRINGS (this node is
 * only listed because it depends on the named package).
 */
export function advisoryIds(vuln) {
  const ids = new Set();
  for (const via of vuln?.via ?? []) {
    if (typeof via === "object" && via?.url) {
      const m = /(GHSA-[a-z0-9-]+)/i.exec(via.url);
      if (m) ids.add(m[1]);
    }
  }
  return ids;
}

/** The immediate package-name children of a node (the non-advisory `via` entries). */
export function viaNames(vuln) {
  return (vuln?.via ?? []).filter((v) => typeof v === "string");
}

/** Does this node carry an advisory of its own, or is it only a path to one? */
export function carriesAdvisory(vuln) {
  return advisoryIds(vuln).size > 0;
}

/**
 * Every advisory-CARRYING package reachable from `vuln` down its `via` chain,
 * however deep (#2388).
 *
 * The matcher used to look one hop only, so a five-node chain needed four
 * padding allowlist entries naming packages that carry no advisory at all —
 * `@lhci/cli -> @lhci/utils -> lighthouse -> puppeteer-core ->
 * @puppeteer/browsers -> extract-zip`, where only `extract-zip` has a GHSA.
 * An allowlist that names three non-vulnerable packages is not the accurate,
 * reviewable security record it is meant to be.
 *
 * Restricted to GATING carriers: a moderate advisory does not gate, so demanding
 * an entry for one would block on something the gate does not care about. The
 * walk still traverses non-gating nodes, since npm reports a parent at the max
 * severity of its children and a chain can pass through one.
 *
 * @param {object} vuln
 * @param {Map<string, object>} byName every vulnerability in the report, keyed by package name
 * @returns {Set<string>} carrier package names
 */
export function reachableCarriers(vuln, byName) {
  const carriers = new Set();
  const seen = new Set([vuln?.name]);
  const queue = [...viaNames(vuln)];
  // Bounded by `seen`, so a cyclic `via` graph terminates rather than hanging a
  // security gate.
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const node = byName.get(name);
    if (!node) continue;
    if (carriesAdvisory(node)) {
      if (GATING.has(node.severity)) carriers.add(name);
      // A carrier can itself depend on another vulnerable package, so keep
      // walking rather than stopping at the first advisory found.
    }
    queue.push(...viaNames(node));
  }
  return carriers;
}

/**
 * Evaluate one workspace's audit report against the allowlist.
 *
 * @param {object} args
 * @param {object} args.report parsed `npm audit --json` output
 * @param {{allow: object[]}} args.allowlist parsed scripts/audit-allowlist.json
 * @param {string} args.workspace workspace key as it appears in an entry's `workspaces`
 * @param {string} args.today ISO date (YYYY-MM-DD) used for expiry comparison
 * @param {boolean} [args.ambient] when true, findings are reported but do not fail
 * @returns {{gating: object[], blocked: object[], suppressed: object[], expired: object[], stale: object[], ambient: object[], failed: boolean}}
 */
export function evaluate({ report, allowlist, workspace, today, ambient = false }) {
  const entries = allowlist?.allow ?? [];
  const vulns = Object.values(report?.vulnerabilities ?? {});
  const gating = vulns.filter((v) => GATING.has(v?.severity));

  const blocked = [];
  const suppressed = [];
  const expired = [];
  const matchedEntries = new Set();

  const byName = new Map(vulns.filter((v) => v?.name).map((v) => [v.name, v]));
  const forWorkspace = entries.filter((a) => a.workspaces.includes(workspace));

  /** The entry covering a node in its own right, or null. */
  const directEntry = (vuln) => {
    const ids = [...advisoryIds(vuln)];
    // Note the ANY-match on ids: a package carrying several advisories is
    // suppressed when one of them is named. `tmp` reports two and only one is
    // allowlisted, so GHSA-ph9p-34f9-6g65 is currently riding in on its
    // neighbour's entry with no justification and no expiry. Tightening this to
    // ALL would red the build on landing, so it is a separate decision —
    // deliberately NOT folded into #2388, and filed as #2397.
    //
    // The `a.package === vuln.name` clause is load-bearing for the same reason:
    // the js-yaml entry names a GHSA the live feed no longer reports, and only
    // still works because the package name matches. #2397 covers both.
    return forWorkspace.find((a) => ids.includes(a.ghsa) || a.package === vuln.name) ?? null;
  };

  const record = (vuln, entry) => {
    matchedEntries.add(entry.ghsa);
    if (today > entry.expires) expired.push({ name: vuln.name, entry });
    else suppressed.push({ name: vuln.name, entry });
  };

  // ── Pass 1: nodes that CARRY an advisory ────────────────────────────────
  // These match on their own ids or their own name and nothing else. In
  // particular a carrier is NOT cleared because a sibling in its `via` chain is
  // allowlisted — a transitive walk widens the blast radius of every entry, and
  // this is the direction that must not widen (#2388, no-over-suppress).
  const carriers = gating.filter(carriesAdvisory);
  const clearedCarriers = new Set();
  for (const vuln of carriers) {
    const entry = directEntry(vuln);
    if (!entry) {
      blocked.push({ name: vuln.name, severity: vuln.severity, ids: [...advisoryIds(vuln)] });
      continue;
    }
    record(vuln, entry);
    // Only a LIVE entry clears a carrier. An expired one already fails the gate
    // on its own, and letting it clear the chain below it would quietly restore
    // the suppression the expiry exists to withdraw.
    if (today <= entry.expires) clearedCarriers.add(vuln.name);
  }

  // ── Pass 2: path nodes, which carry no advisory of their own ────────────
  // `npm audit` lists these purely because they depend on something vulnerable.
  // One honest entry naming the package that actually carries the GHSA clears
  // the whole chain, however deep.
  for (const vuln of gating) {
    if (carriesAdvisory(vuln)) continue;

    // A direct entry still works, so an existing allowlist that names a path
    // node keeps behaving exactly as it did.
    const entry = directEntry(vuln);
    if (entry) {
      record(vuln, entry);
      continue;
    }

    const reachable = reachableCarriers(vuln, byName);
    // EVERY reachable carrier must be cleared, not merely one: `@lhci/cli`
    // reaches extract-zip AND tmp, and it is reported for both. An un-cleared
    // carrier anywhere below means this node is still reported for a reason
    // nobody has justified. An EMPTY set fails closed too — a gating node with
    // no gating explanation is not something to wave through.
    const allCleared =
      reachable.size > 0 && [...reachable].every((name) => clearedCarriers.has(name));

    if (!allCleared) {
      blocked.push({ name: vuln.name, severity: vuln.severity, ids: [] });
      continue;
    }

    // Credit every entry that contributed, so none of them reads as stale.
    const contributing = [];
    for (const name of reachable) {
      const carrierEntry = directEntry(byName.get(name));
      if (carrierEntry) {
        matchedEntries.add(carrierEntry.ghsa);
        contributing.push(carrierEntry);
      }
    }
    suppressed.push({ name: vuln.name, entry: contributing[0], via: [...reachable] });
  }

  // The two passes emit carriers before path nodes; sort by name so the log
  // reads in the same stable order `npm audit` itself uses.
  const byPackageName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  blocked.sort(byPackageName);
  suppressed.sort(byPackageName);
  expired.sort(byPackageName);

  // Stale entries are a warning, not a failure: upstream shipping a fix should
  // not turn CI red. It should just prompt cleanup.
  const stale = entries.filter(
    (e) => e.workspaces.includes(workspace) && !matchedEntries.has(e.ghsa),
  );

  // Ambient mode (#2391): this diff cannot have changed the dependency tree, so
  // anything found here was equally true of the base branch. Report it LOUDLY
  // and do not fail — the scheduled whole-tree run against main is what turns an
  // ambient advisory into a ticket. Expired entries ride the same path: an
  // expiry firing part-way through an open PR is precisely the "the world moved,
  // the diff did not" case this ticket exists to take off the blocking path, and
  // any PR that TOUCHES the allowlist is already excluded from ambient mode by
  // classifyDelta above.
  if (ambient) {
    const carried = [
      ...blocked.map((b) => ({ ...b, kind: "blocked", entry: null })),
      ...expired.map((e) => ({
        name: e.name,
        severity: "expired-allowlist",
        ids: [e.entry.ghsa],
        kind: "expired",
        entry: e.entry,
      })),
    ];
    return {
      gating,
      blocked: [],
      suppressed,
      expired: [],
      stale,
      ambient: carried,
      failed: false,
    };
  }

  return {
    gating,
    blocked,
    suppressed,
    expired,
    stale,
    ambient: [],
    failed: blocked.length > 0 || expired.length > 0,
  };
}
