import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  alreadyReported,
  compareVersions,
  findFix,
  fixCommentMarker,
  parseVersion,
  renderFixComment,
  satisfiesRange,
} from "./audit-fix-watch-core.mjs";

describe("compareVersions", () => {
  test("orders by major, then minor, then patch", () => {
    assert.equal(compareVersions("1.0.0", "2.0.0"), -1);
    assert.equal(compareVersions("1.2.0", "1.10.0"), -1);
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
    assert.equal(compareVersions("0.15.1", "0.1.0"), 1);
  });

  test("a prerelease sorts BELOW its release", () => {
    assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
    assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  });

  test("unparseable versions sort below everything", () => {
    assert.equal(parseVersion("not-a-version"), null);
    assert.equal(compareVersions("latest", "1.0.0"), -1);
  });
});

describe("satisfiesRange — the npm-advisory comparator grammar", () => {
  test("<= and <", () => {
    assert.equal(satisfiesRange("2.0.1", "<=2.0.1"), true);
    assert.equal(satisfiesRange("2.0.2", "<=2.0.1"), false);
    assert.equal(satisfiesRange("3.14.2", "<3.14.3"), true);
  });

  test("an AND pair", () => {
    assert.equal(satisfiesRange("1.1.0", ">=1.0.0 <1.2.3"), true);
    assert.equal(satisfiesRange("1.2.3", ">=1.0.0 <1.2.3"), false);
    assert.equal(satisfiesRange("0.9.0", ">=1.0.0 <1.2.3"), false);
  });

  test("|| alternatives", () => {
    const r = "<1.2.3 || >=2.0.0 <2.1.0";
    assert.equal(satisfiesRange("1.0.0", r), true);
    assert.equal(satisfiesRange("2.0.5", r), true);
    assert.equal(satisfiesRange("1.5.0", r), false);
    assert.equal(satisfiesRange("2.1.0", r), false);
  });

  test("a hyphen range is inclusive on both ends", () => {
    // npm emits this form for most advisories with a floor and a ceiling —
    // puppeteer-core's live range is `19.8.4 - 24.43.1`.
    const r = "19.8.4 - 24.43.1";
    assert.equal(satisfiesRange("19.8.3", r), false);
    assert.equal(satisfiesRange("19.8.4", r), true);
    assert.equal(satisfiesRange("24.43.1", r), true);
    assert.equal(satisfiesRange("24.43.2", r), false);
  });

  test("hyphen ranges combine with || and with prerelease bounds", () => {
    const r = "10.1.1-dev.20230414 - 10.1.1-dev.20230503 || 10.2.0-dev.20230504 - 13.3.0";
    assert.equal(satisfiesRange("12.6.1", r), true);
    assert.equal(satisfiesRange("13.3.1", r), false);
  });

  test("* means everything is vulnerable", () => {
    assert.equal(satisfiesRange("9.9.9", "*"), true);
  });

  test("a grammar we do not understand yields null, never a guess", () => {
    assert.equal(satisfiesRange("1.0.0", "^1.0.0"), null);
    assert.equal(satisfiesRange("1.0.0", ""), null);
    assert.equal(satisfiesRange("1.0.0", undefined), null);
  });
});

describe("findFix", () => {
  test("reports the LOWEST published release outside the vulnerable range", () => {
    const fix = findFix({
      installed: "3.14.2",
      versions: ["3.13.0", "3.14.1", "3.14.2", "3.14.3", "4.0.0", "4.1.0"],
      range: "<3.14.3",
    });
    assert.equal(fix.version, "3.14.3");
    assert.equal(fix.isMajor, false);
  });

  test("flags a semver-major UPGRADE as needing review, but still reports it", () => {
    const fix = findFix({
      installed: "7.18.1",
      versions: ["7.18.1", "8.0.0"],
      range: "<8.0.0",
    });
    assert.equal(fix.version, "8.0.0");
    assert.equal(fix.isMajor, true);
  });

  test("no published version clears the range → no news", () => {
    // extract-zip: 2.0.1 is the latest release (2023) and the range is <=2.0.1.
    assert.equal(
      findFix({ installed: "2.0.1", versions: ["1.7.0", "2.0.0", "2.0.1"], range: "<=2.0.1" }),
      null,
    );
  });

  test("(no-downgrade-noise) a semver-major DOWNGRADE is never reported as a fix", () => {
    // The @lhci/cli@0.1.0 trap: npm's own fixAvailable offers a 2019-era release
    // flagged isSemVerMajor. Only versions strictly greater than installed are
    // ever considered, so the downgrade cannot survive the filter.
    assert.equal(
      findFix({
        installed: "0.15.1",
        versions: ["0.1.0", "0.2.0", "0.15.0", "0.15.1"],
        range: ">=0.2.0",
      }),
      null,
    );
  });

  test("prereleases are never offered as the fix", () => {
    const fix = findFix({
      installed: "1.0.0",
      versions: ["1.0.0", "1.0.1-rc.1", "1.0.1-rc.2"],
      range: "<=1.0.0",
    });
    assert.equal(fix, null);
  });

  test("a range we cannot parse yields no news rather than a false alarm", () => {
    assert.equal(findFix({ installed: "1.0.0", versions: ["2.0.0"], range: "^1.0.0" }), null);
    assert.equal(findFix({ installed: "1.0.0", versions: ["2.0.0"], range: "*" }), null);
  });

  test("an installed version already outside the range is not this watcher's business", () => {
    // The entry is stale; audit-gate.mjs's own NOTE covers that case.
    assert.equal(findFix({ installed: "4.0.0", versions: ["4.0.0"], range: "<3.14.3" }), null);
  });
});

describe("idempotency", () => {
  const entry = {
    ghsa: "GHSA-w3rx-r6r6-pgpr",
    package: "image-size",
    workspaces: ["server"],
    issue: 2225,
    expires: "2026-11-30",
  };

  test("the marker is keyed by ghsa + package + fixed version", () => {
    assert.equal(
      fixCommentMarker(entry, "1.2.3"),
      "<!-- audit-fix-watch:GHSA-w3rx-r6r6-pgpr:image-size:1.2.3 -->",
    );
  });

  test("news already posted is not posted again", () => {
    const marker = fixCommentMarker(entry, "1.2.3");
    const comments = [{ body: "unrelated" }, { body: `${marker}\n\nA fixed version...` }];
    assert.equal(alreadyReported(comments, marker), true);
  });

  test("a LATER fixed version is still news", () => {
    const comments = [{ body: `${fixCommentMarker(entry, "1.2.3")}\n\nold news` }];
    assert.equal(alreadyReported(comments, fixCommentMarker(entry, "1.3.0")), false);
  });

  test("a comment that merely QUOTES the marker does not count as having reported it", () => {
    const marker = fixCommentMarker(entry, "1.2.3");
    assert.equal(
      alreadyReported([{ body: `The marker looks like ${marker} — see the core.` }], marker),
      false,
    );
  });

  test("the rendered comment leads with the marker and names the versions", () => {
    const body = renderFixComment(entry, { version: "1.2.3", installed: "1.0.0", isMajor: false });
    assert.ok(body.startsWith(fixCommentMarker(entry, "1.2.3")));
    assert.match(body, /image-size/);
    assert.match(body, /still suppressing/);
    assert.match(body, /1\.0\.0/);
  });
});
