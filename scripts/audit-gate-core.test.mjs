import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  advisoryIds,
  carriesAdvisory,
  classifyDelta,
  evaluate,
  reachableCarriers,
  viaNames,
} from "./audit-gate-core.mjs";

const TODAY = "2026-08-14";

/** An advisory-carrying `via` object, as npm audit emits it. */
const adv = (ghsa) => ({
  source: 1,
  name: "x",
  url: `https://github.com/advisories/${ghsa}`,
  severity: "high",
});

/**
 * A fixture modelled on the REAL root-workspace `npm audit --json` output
 * (captured 2026-08-14), not an idealised one. The extract-zip chain is the
 * case from #2388:
 *
 *   @lhci/cli -> @lhci/utils -> lighthouse -> puppeteer-core
 *             -> @puppeteer/browsers -> extract-zip   (the only GHSA carrier)
 *
 * plus `tmp`, which carries TWO advisories and is reachable directly from
 * @lhci/cli, and `js-yaml`, which carries advisories but is reported with no
 * effects (nothing lists it in a `via`).
 */
function lhciReport() {
  return {
    vulnerabilities: {
      "@lhci/cli": {
        name: "@lhci/cli",
        severity: "high",
        via: ["@lhci/utils", "lighthouse", "uuid"],
        effects: [],
      },
      "@lhci/utils": {
        name: "@lhci/utils",
        severity: "high",
        via: ["lighthouse"],
        effects: ["@lhci/cli"],
      },
      lighthouse: {
        name: "lighthouse",
        severity: "high",
        via: ["puppeteer-core"],
        effects: ["@lhci/cli", "@lhci/utils"],
      },
      "puppeteer-core": {
        name: "puppeteer-core",
        severity: "high",
        via: ["@puppeteer/browsers"],
        effects: ["lighthouse"],
      },
      "@puppeteer/browsers": {
        name: "@puppeteer/browsers",
        severity: "high",
        via: ["extract-zip"],
        effects: ["puppeteer-core"],
      },
      "extract-zip": {
        name: "extract-zip",
        severity: "high",
        via: [adv("GHSA-jmr9-qjv8-65gv")],
        effects: ["@puppeteer/browsers"],
      },
      uuid: { name: "uuid", severity: "moderate", via: [adv("GHSA-uuid-moderate")], effects: [] },
    },
  };
}

/**
 * The SAME tree as it stood before #2397, when `tmp` and `js-yaml` were still
 * vulnerable and allowlisted. Kept deliberately rather than deleted: it is the
 * only fixture where a node carries two advisories and where `@lhci/cli`
 * reaches two independent carriers, so it pins both the #2397 strictness rules
 * and #2388's "every reachable carrier must be cleared".
 *
 * Its shape is real, not invented:
 *   tmp     — GHSA-52f5-9888-hmc6 (LOW) + GHSA-ph9p-34f9-6g65 (HIGH). Only the
 *             LOW one was ever allowlisted, and only high/critical gate — so the
 *             suppression rested entirely on an entry for the advisory that
 *             wasn't the problem.
 *   js-yaml — the allowlist named GHSA-8cvf-q4jm-h6q8, which the live feed had
 *             stopped reporting; the entry survived only on the package-name
 *             fallback, silently covering three advisories nobody had reviewed.
 */
function lhciReportBefore2397() {
  const r = lhciReport();
  r.vulnerabilities["@lhci/cli"].via = ["@lhci/utils", "inquirer", "lighthouse", "tmp", "uuid"];
  r.vulnerabilities.inquirer = {
    name: "inquirer",
    severity: "moderate",
    via: ["external-editor"],
    effects: [],
  };
  r.vulnerabilities.tmp = {
    name: "tmp",
    severity: "high",
    via: [adv("GHSA-52f5-9888-hmc6"), adv("GHSA-ph9p-34f9-6g65")],
    effects: ["@lhci/cli", "external-editor"],
  };
  r.vulnerabilities["js-yaml"] = {
    name: "js-yaml",
    severity: "high",
    via: [adv("GHSA-h67p-54hq-rp68")],
    effects: [],
  };
  return r;
}

const entry = (ghsa, pkg, over = {}) => ({
  ghsa,
  package: pkg,
  workspaces: ["."],
  issue: 2159,
  expires: "2026-11-30",
  reason: "test fixture",
  ...over,
});

describe("advisoryIds / viaNames — the two halves of a `via` array", () => {
  test("advisoryIds reads GHSA ids out of the advisory OBJECTS only", () => {
    const v = { via: [adv("GHSA-aaaa-bbbb-cccc"), "some-package"] };
    assert.deepEqual([...advisoryIds(v)], ["GHSA-aaaa-bbbb-cccc"]);
  });

  test("viaNames reads the package-name STRINGS only", () => {
    const v = { via: [adv("GHSA-aaaa-bbbb-cccc"), "some-package"] };
    assert.deepEqual(viaNames(v), ["some-package"]);
  });

  test("a missing via array is not an error", () => {
    assert.deepEqual([...advisoryIds({})], []);
    assert.deepEqual(viaNames({}), []);
  });
});

describe("classifyDelta — can this diff have moved the dependency tree? (#2391)", () => {
  test("a diff of source files only is NOT a dependency change", () => {
    const { depsChanged, matched } = classifyDelta([
      "server/src/routes/auth.ts",
      "client/src/pages/help/index.tsx",
      "tests/e2e/login.spec.ts",
      "docs/CHANGELOG.md",
    ]);
    assert.equal(depsChanged, false);
    assert.deepEqual(matched, []);
  });

  test("a lockfile in any workspace counts", () => {
    for (const f of [
      "package-lock.json",
      "server/package-lock.json",
      "client/package-lock.json",
      "tests/package-lock.json",
      "npm-shrinkwrap.json",
    ]) {
      assert.equal(classifyDelta(["docs/CHANGELOG.md", f]).depsChanged, true, f);
    }
  });

  test("a package.json in any workspace counts, whatever field moved", () => {
    // Field-level precision is deliberately NOT attempted: a `scripts` edit
    // reads as a dependency change, which costs a full gate run and nothing else.
    assert.equal(classifyDelta(["package.json"]).depsChanged, true);
    assert.equal(classifyDelta(["server/package.json"]).depsChanged, true);
  });

  test("editing the allowlist counts — a PR that REMOVES a suppression must get the full gate", () => {
    const { depsChanged, matched } = classifyDelta([
      "scripts/audit-allowlist.json",
      "docs/CHANGELOG.md",
    ]);
    assert.equal(depsChanged, true);
    assert.deepEqual(matched, ["scripts/audit-allowlist.json"]);
  });

  test("names that merely CONTAIN a dep filename do not count", () => {
    assert.equal(
      classifyDelta(["docs/package.json.md", "src/package-lock.json.bak"]).depsChanged,
      false,
    );
  });

  test("an empty or absent file list is not a dependency change", () => {
    assert.equal(classifyDelta([]).depsChanged, false);
    assert.equal(classifyDelta(undefined).depsChanged, false);
    assert.equal(classifyDelta(["", "  "]).depsChanged, false);
  });
});

describe("evaluate — blocking mode (today's behaviour, unchanged)", () => {
  test("an un-allowlisted high advisory blocks", () => {
    const r = evaluate({
      report: { vulnerabilities: { foo: { name: "foo", severity: "high", via: [adv("GHSA-x")] } } },
      allowlist: { allow: [] },
      workspace: ".",
      today: TODAY,
    });
    assert.equal(r.failed, true);
    assert.deepEqual(
      r.blocked.map((b) => b.name),
      ["foo"],
    );
  });

  test("moderate and low advisories never gate", () => {
    const r = evaluate({
      report: {
        vulnerabilities: {
          m: { name: "m", severity: "moderate", via: [adv("GHSA-m")] },
          l: { name: "l", severity: "low", via: [adv("GHSA-l")] },
        },
      },
      allowlist: { allow: [] },
      workspace: ".",
      today: TODAY,
    });
    assert.equal(r.failed, false);
    assert.equal(r.gating.length, 0);
  });

  test("an entry only suppresses in the workspaces it names", () => {
    const report = {
      vulnerabilities: { foo: { name: "foo", severity: "high", via: [adv("GHSA-x")] } },
    };
    const allowlist = { allow: [entry("GHSA-x", "foo", { workspaces: ["server"] })] };
    assert.equal(evaluate({ report, allowlist, workspace: "server", today: TODAY }).failed, false);
    assert.equal(evaluate({ report, allowlist, workspace: ".", today: TODAY }).failed, true);
  });

  test("past its expiry an entry stops suppressing and the gate reds", () => {
    const r = evaluate({
      report: { vulnerabilities: { foo: { name: "foo", severity: "high", via: [adv("GHSA-x")] } } },
      allowlist: { allow: [entry("GHSA-x", "foo", { expires: "2026-01-01" })] },
      workspace: ".",
      today: TODAY,
    });
    assert.equal(r.failed, true);
    assert.equal(r.expired.length, 1);
    assert.equal(r.blocked.length, 0);
  });

  test("an entry matching nothing is reported stale, and does not fail the gate", () => {
    const r = evaluate({
      report: { vulnerabilities: {} },
      allowlist: { allow: [entry("GHSA-gone", "ghost")] },
      workspace: ".",
      today: TODAY,
    });
    assert.equal(r.failed, false);
    assert.deepEqual(
      r.stale.map((e) => e.ghsa),
      ["GHSA-gone"],
    );
  });
});

describe("evaluate — ambient mode (#2391)", () => {
  const report = {
    vulnerabilities: {
      fresh: { name: "fresh", severity: "critical", via: [adv("GHSA-new")] },
      known: { name: "known", severity: "high", via: [adv("GHSA-known")] },
    },
  };
  const allowlist = { allow: [entry("GHSA-known", "known")] };

  test("an advisory this diff cannot have introduced is reported, not blocked", () => {
    const r = evaluate({ report, allowlist, workspace: ".", today: TODAY, ambient: true });
    assert.equal(r.failed, false);
    assert.equal(r.blocked.length, 0);
    assert.deepEqual(
      r.ambient.map((a) => a.name),
      ["fresh"],
    );
    assert.deepEqual(r.ambient[0].ids, ["GHSA-new"]);
    assert.equal(r.ambient[0].kind, "blocked");
  });

  test("the same input BLOCKS when the diff did touch dependencies", () => {
    const r = evaluate({ report, allowlist, workspace: ".", today: TODAY, ambient: false });
    assert.equal(r.failed, true);
    assert.deepEqual(
      r.blocked.map((b) => b.name),
      ["fresh"],
    );
  });

  test("allowlisted advisories still report as ALLOWLISTED, not as ambient", () => {
    const r = evaluate({ report, allowlist, workspace: ".", today: TODAY, ambient: true });
    assert.deepEqual(
      r.suppressed.map((s) => s.name),
      ["known"],
    );
  });

  test("an expiry that fires mid-PR rides the ambient path rather than blocking", () => {
    const r = evaluate({
      report: { vulnerabilities: { known: report.vulnerabilities.known } },
      allowlist: { allow: [entry("GHSA-known", "known", { expires: "2026-01-01" })] },
      workspace: ".",
      today: TODAY,
      ambient: true,
    });
    assert.equal(r.failed, false);
    assert.equal(r.expired.length, 0);
    assert.equal(r.ambient.length, 1);
    assert.equal(r.ambient[0].kind, "expired");
  });
});

describe("carriesAdvisory / reachableCarriers — the transitive walk (#2388)", () => {
  const byName = new Map(Object.entries(lhciReport().vulnerabilities));

  test("a node with an advisory OBJECT in via carries; one with only strings does not", () => {
    assert.equal(carriesAdvisory(byName.get("extract-zip")), true);
    assert.equal(carriesAdvisory(byName.get("lighthouse")), false);
    assert.equal(carriesAdvisory(byName.get("@lhci/cli")), false);
  });

  test("the five-deep extract-zip chain resolves to its ONE carrier", () => {
    // @lhci/utils -> lighthouse -> puppeteer-core -> @puppeteer/browsers -> extract-zip
    assert.deepEqual([...reachableCarriers(byName.get("@lhci/utils"), byName)], ["extract-zip"]);
    assert.deepEqual([...reachableCarriers(byName.get("lighthouse"), byName)], ["extract-zip"]);
    assert.deepEqual([...reachableCarriers(byName.get("puppeteer-core"), byName)], ["extract-zip"]);
  });

  test("a node reached through several branches collects every carrier below it", () => {
    // Uses the pre-#2397 tree: since tmp was fixed upstream, @lhci/cli reaches
    // only one carrier in the current one, so a multi-branch walk needs the
    // older shape to be exercised at all.
    const before = new Map(Object.entries(lhciReportBefore2397().vulnerabilities));
    assert.deepEqual([...reachableCarriers(before.get("@lhci/cli"), before)].sort(), [
      "extract-zip",
      "tmp",
    ]);
  });

  test("non-gating carriers are not collected — a moderate advisory does not gate", () => {
    // `uuid` carries a moderate advisory and is a direct via of @lhci/cli.
    assert.equal(reachableCarriers(byName.get("@lhci/cli"), byName).has("uuid"), false);
  });

  test("a cyclic via graph terminates instead of hanging the gate", () => {
    const cyclic = new Map([
      ["a", { name: "a", severity: "high", via: ["b"] }],
      ["b", { name: "b", severity: "high", via: ["a", "c"] }],
      ["c", { name: "c", severity: "high", via: [adv("GHSA-c")] }],
    ]);
    assert.deepEqual([...reachableCarriers(cyclic.get("a"), cyclic)], ["c"]);
  });
});

describe("evaluate — the real @lhci/cli fixture (#2388)", () => {
  // Post-#2397 the allowlist is ONE entry for this whole chain: `tmp` and
  // `js-yaml` were fixed upstream via root `overrides` rather than justified.
  const realEntries = [entry("GHSA-jmr9-qjv8-65gv", "extract-zip")];

  test("(deep-chain) ONE entry naming the carrier clears every node below it", () => {
    // This is the whole ticket: before #2388 this same allowlist left
    // puppeteer-core, lighthouse and @lhci/utils blocked, because each named
    // only its immediate child.
    const r = evaluate({
      report: lhciReport(),
      allowlist: { allow: realEntries },
      workspace: ".",
      today: TODAY,
    });
    assert.deepEqual(r.blocked, [], "nothing should block");
    assert.equal(r.gating.length, 6);
    assert.deepEqual(
      r.suppressed.map((s) => s.name),
      [
        "@lhci/cli",
        "@lhci/utils",
        "@puppeteer/browsers",
        "extract-zip",
        "lighthouse",
        "puppeteer-core",
      ],
    );
  });

  test("(no-padding) the three PATH NODE ONLY entries are no longer needed", () => {
    // Present them and nothing changes; absent (the test above) and nothing
    // changes either. They were pure padding.
    const r = evaluate({
      report: lhciReport(),
      allowlist: {
        allow: [
          ...realEntries,
          entry("GHSA-jmr9-qjv8-65gv", "@puppeteer/browsers"),
          entry("GHSA-jmr9-qjv8-65gv", "puppeteer-core"),
          entry("GHSA-jmr9-qjv8-65gv", "lighthouse"),
        ],
      },
      workspace: ".",
      today: TODAY,
    });
    assert.deepEqual(r.blocked, []);
  });

  test("dropping the tmp entry re-blocks @lhci/cli — EVERY reachable carrier must be cleared", () => {
    // @lhci/cli is reported for extract-zip AND tmp. Clearing one of two is not
    // clearing the node; a transitive walk must not become a wildcard. Uses the
    // pre-#2397 tree because that is where @lhci/cli reached two carriers.
    const r = evaluate({
      report: lhciReportBefore2397(),
      allowlist: {
        allow: [
          entry("GHSA-jmr9-qjv8-65gv", "extract-zip"),
          entry("GHSA-8cvf-q4jm-h6q8", "js-yaml"),
          entry("GHSA-h67p-54hq-rp68", "js-yaml"),
        ],
      },
      workspace: ".",
      today: TODAY,
    });
    assert.equal(r.failed, true);
    assert.ok(r.blocked.some((b) => b.name === "@lhci/cli"));
    assert.ok(r.blocked.some((b) => b.name === "tmp"));
    // …but the extract-zip branch is still fully cleared by its one entry.
    assert.equal(
      r.blocked.some((b) => b.name === "lighthouse" || b.name === "puppeteer-core"),
      false,
    );
  });

  test("an EXPIRED carrier entry does not clear the chain below it", () => {
    const r = evaluate({
      report: lhciReport(),
      allowlist: {
        allow: [entry("GHSA-jmr9-qjv8-65gv", "extract-zip", { expires: "2026-01-01" })],
      },
      workspace: ".",
      today: TODAY,
    });
    assert.equal(r.failed, true);
    assert.deepEqual(
      r.expired.map((e) => e.name),
      ["extract-zip"],
    );
    assert.ok(r.blocked.some((b) => b.name === "puppeteer-core"));
  });

  test("every contributing entry is credited, so none reads as stale", () => {
    const r = evaluate({
      report: lhciReport(),
      allowlist: { allow: realEntries },
      workspace: ".",
      today: TODAY,
    });
    assert.deepEqual(r.stale, []);
  });
});

describe("evaluate — the over-suppression direction (#2388)", () => {
  test("(no-over-suppress) a node carrying its OWN un-allowlisted advisory still blocks", () => {
    // `victim` has an advisory of its own AND depends on an allowlisted package.
    // The one-hop matcher suppressed it on the sibling name; a transitive walk
    // must not, or every entry silently widens to cover its dependents' own
    // vulnerabilities.
    const report = {
      vulnerabilities: {
        victim: {
          name: "victim",
          severity: "high",
          via: [adv("GHSA-victim-own"), "excused"],
        },
        excused: { name: "excused", severity: "high", via: [adv("GHSA-excused")] },
      },
    };
    const r = evaluate({
      report,
      allowlist: { allow: [entry("GHSA-excused", "excused")] },
      workspace: ".",
      today: TODAY,
    });
    assert.equal(r.failed, true);
    assert.deepEqual(
      r.blocked.map((b) => b.name),
      ["victim"],
    );
    assert.deepEqual(r.blocked[0].ids, ["GHSA-victim-own"]);
  });

  test("a path node with NO reachable carrier fails closed rather than clearing", () => {
    // `orphan` names a child npm did not report. There is no justification to
    // point at, so it must not be waved through.
    const report = {
      vulnerabilities: {
        orphan: { name: "orphan", severity: "high", via: ["not-in-this-report"] },
      },
    };
    const r = evaluate({
      report,
      allowlist: { allow: [entry("GHSA-anything", "something-else")] },
      workspace: ".",
      today: TODAY,
    });
    assert.equal(r.failed, true);
    assert.deepEqual(
      r.blocked.map((b) => b.name),
      ["orphan"],
    );
  });

  test("an entry naming a path node directly still works (no existing allowlist breaks)", () => {
    const report = {
      vulnerabilities: {
        "react-router-dom": { name: "react-router-dom", severity: "high", via: ["react-router"] },
        "react-router": { name: "react-router", severity: "high", via: [adv("GHSA-qwww")] },
      },
    };
    const r = evaluate({
      report,
      allowlist: {
        allow: [
          entry("GHSA-qwww", "react-router"),
          entry("GHSA-qwww", "react-router-dom", { ghsa: "GHSA-qwww" }),
        ],
      },
      workspace: ".",
      today: TODAY,
    });
    assert.equal(r.failed, false);
  });
});

export { lhciReport, adv, entry, TODAY };

describe("evaluate — every advisory id needs its own entry (#2397)", () => {
  const twoOnOneNode = () => ({
    vulnerabilities: {
      tmp: {
        name: "tmp",
        severity: "high",
        via: [adv("GHSA-52f5-9888-hmc6"), adv("GHSA-ph9p-34f9-6g65")],
        effects: [],
      },
    },
  });

  test("(surfaced) a second advisory does NOT ride in on its neighbour's entry", () => {
    // The live case this ticket was filed for: `tmp` carried an allowlisted LOW
    // advisory and an unreviewed HIGH one. Only high/critical gate, so the node
    // was in the gating set BECAUSE of the un-allowlisted one — and the ANY-match
    // cleared it anyway, on the strength of an entry for the advisory that was
    // not the problem.
    const r = evaluate({
      report: twoOnOneNode(),
      allowlist: { allow: [entry("GHSA-52f5-9888-hmc6", "tmp")] },
      workspace: ".",
      today: TODAY,
    });
    assert.equal(r.failed, true);
    assert.deepEqual(
      r.blocked.map((b) => b.name),
      ["tmp"],
    );
  });

  test("(surfaced) the failure names the UNJUSTIFIED id, not the whole list", () => {
    // Reporting all ids would leave the new advisory hiding among its
    // allowlisted neighbours — the same concealment, one layer out.
    const r = evaluate({
      report: twoOnOneNode(),
      allowlist: { allow: [entry("GHSA-52f5-9888-hmc6", "tmp")] },
      workspace: ".",
      today: TODAY,
    });
    assert.deepEqual(r.blocked[0].unmatched, ["GHSA-ph9p-34f9-6g65"]);
    assert.deepEqual(r.blocked[0].ids, ["GHSA-52f5-9888-hmc6", "GHSA-ph9p-34f9-6g65"]);
  });

  test("both ids allowlisted → suppressed, and BOTH entries are credited", () => {
    // The stale-report half. Under the ANY-match this was a live bug: only the
    // first matching entry was credited, so the second read as "no longer
    // matches ... It can be removed" — advice which, if followed, would have
    // deleted a live justification while the node still passed on its sibling.
    // `image-size` carries two GHSAs and hit exactly this.
    const r = evaluate({
      report: twoOnOneNode(),
      allowlist: {
        allow: [entry("GHSA-52f5-9888-hmc6", "tmp"), entry("GHSA-ph9p-34f9-6g65", "tmp")],
      },
      workspace: ".",
      today: TODAY,
    });
    assert.equal(r.failed, false);
    assert.deepEqual(
      r.suppressed.map((s) => s.name),
      ["tmp"],
    );
    assert.deepEqual(r.stale, [], "neither entry should read as removable");
  });

  test("a partially-covered BLOCKED node does not report its live entry as removable", () => {
    // Caught by a live positive control, not by a unit test: with one of
    // image-size's two real entries removed, the gate blocked correctly AND
    // told you to delete the remaining one. A blocked node still has to credit
    // whatever genuinely matched, or the stale report invites you to throw away
    // a justification you still need.
    const r = evaluate({
      report: twoOnOneNode(),
      allowlist: { allow: [entry("GHSA-52f5-9888-hmc6", "tmp")] },
      workspace: ".",
      today: TODAY,
    });
    assert.equal(r.failed, true);
    assert.deepEqual(r.stale, [], "the matching entry must not read as removable");
  });

  test("one of two covering entries EXPIRED expires the whole node", () => {
    // A node is suppressed only while every justification holding it up is
    // live; a lapsed entry must withdraw the cover it was providing.
    const r = evaluate({
      report: twoOnOneNode(),
      allowlist: {
        allow: [
          entry("GHSA-52f5-9888-hmc6", "tmp"),
          entry("GHSA-ph9p-34f9-6g65", "tmp", { expires: "2026-01-01" }),
        ],
      },
      workspace: ".",
      today: TODAY,
    });
    assert.equal(r.failed, true);
    assert.deepEqual(
      r.expired.map((e) => e.name),
      ["tmp"],
    );
    assert.equal(r.expired[0].entry.ghsa, "GHSA-ph9p-34f9-6g65");
  });

  test("the package-name fallback is GONE — naming the package no longer suppresses", () => {
    // This was the widest surface in the matcher: an entry matching by name
    // cleared whatever that package carried, forever. It is how the js-yaml
    // entry silently absorbed three advisories after the feed re-issued them
    // under new ids.
    const r = evaluate({
      report: {
        vulnerabilities: {
          "js-yaml": { name: "js-yaml", severity: "high", via: [adv("GHSA-h67p-54hq-rp68")] },
        },
      },
      allowlist: { allow: [entry("GHSA-8cvf-q4jm-h6q8", "js-yaml")] },
      workspace: ".",
      today: TODAY,
    });
    assert.equal(r.failed, true, "an entry naming the package must not cover a different advisory");
    assert.deepEqual(r.blocked[0].unmatched, ["GHSA-h67p-54hq-rp68"]);
  });

  test("a path node is still cleared by its carrier, with no name entry involved", () => {
    // Dropping the name clause must not re-break #2388: a path node carries no
    // ids of its own and is cleared purely by the carriers it reaches.
    const r = evaluate({
      report: {
        vulnerabilities: {
          parent: { name: "parent", severity: "high", via: ["child"] },
          child: { name: "child", severity: "high", via: [adv("GHSA-child")] },
        },
      },
      allowlist: { allow: [entry("GHSA-child", "child")] },
      workspace: ".",
      today: TODAY,
    });
    assert.equal(r.failed, false);
    assert.deepEqual(r.suppressed.map((s) => s.name).sort(), ["child", "parent"]);
  });
});
