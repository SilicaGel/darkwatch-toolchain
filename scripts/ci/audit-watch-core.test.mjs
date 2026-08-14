import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MARKER, pickIssue, renderBody, renderTitle, summarise } from "./audit-watch-core.mjs";

const run = (workspace, over = {}) => ({
  workspace,
  result: { gating: [], blocked: [], suppressed: [], expired: [], stale: [], ...over },
});

describe("pickIssue — the rolling-issue marker trap", () => {
  test("matches only a body that STARTS with the marker", () => {
    const issues = [
      { number: 10, body: `Docs describing the format: ${MARKER} goes at the top.` },
      { number: 20, body: `${MARKER}\n\nreal report` },
    ];
    assert.equal(pickIssue(issues).issue.number, 20);
  });

  test("leading whitespace before the marker is tolerated", () => {
    assert.equal(pickIssue([{ number: 7, body: `\n  ${MARKER}\n\nbody` }]).issue.number, 7);
  });

  test("no match yields null rather than an arbitrary issue", () => {
    assert.equal(pickIssue([{ number: 1, body: "unrelated" }]).issue, null);
    assert.equal(pickIssue([]).issue, null);
    assert.equal(pickIssue(undefined).issue, null);
  });

  test("duplicates: the OLDEST wins and the rest are reported", () => {
    const { issue, duplicates } = pickIssue([
      { number: 90, body: `${MARKER}\nb` },
      { number: 40, body: `${MARKER}\na` },
      { number: 55, body: `${MARKER}\nc` },
    ]);
    assert.equal(issue.number, 40);
    assert.deepEqual(duplicates, [55, 90]);
  });
});

describe("summarise", () => {
  test("every workspace clean is clean", () => {
    const s = summarise([run("."), run("server"), run("client")]);
    assert.equal(s.clean, true);
    assert.deepEqual(s.findings, []);
  });

  test("blocked advisories are collected with their workspace", () => {
    const s = summarise([
      run(".", { blocked: [{ name: "extract-zip", severity: "high", ids: ["GHSA-a"] }] }),
      run("server"),
    ]);
    assert.equal(s.clean, false);
    assert.equal(s.findings.length, 1);
    assert.equal(s.findings[0].workspace, ".");
    assert.equal(s.findings[0].kind, "advisory");
  });

  test("an expired entry is a finding too", () => {
    const s = summarise([
      run("client", {
        expired: [{ name: "react-router", entry: { ghsa: "GHSA-q", issue: 1883 } }],
      }),
    ]);
    assert.equal(s.findings[0].kind, "expired");
    assert.deepEqual(s.findings[0].ids, ["GHSA-q"]);
  });

  test("'we could not look' is NOT an all-clear", () => {
    const s = summarise([{ workspace: "server", error: "npm audit produced nothing" }]);
    assert.equal(s.clean, false);
    assert.deepEqual(s.findings, []);
    assert.equal(s.errors.length, 1);
  });
});

describe("renderTitle / renderBody", () => {
  test("the body ALWAYS leads with the marker", () => {
    for (const s of [
      summarise([run(".")]),
      summarise([run(".", { blocked: [{ name: "x", severity: "high", ids: ["GHSA-a"] }] })]),
      summarise([{ workspace: ".", error: "boom" }]),
    ]) {
      assert.ok(renderBody(s).startsWith(MARKER), renderTitle(s));
    }
  });

  test("a clean run renders a closable all-clear", () => {
    const s = summarise([run("."), run("server")]);
    assert.match(renderTitle(s), /clear/);
    assert.match(renderBody(s), /npm audit is clear against/);
  });

  test("findings render one table row each, naming package and advisory", () => {
    const s = summarise([
      run(".", { blocked: [{ name: "extract-zip", severity: "high", ids: ["GHSA-jmr9"] }] }),
      run("server", { blocked: [{ name: "image-size", severity: "critical", ids: [] }] }),
    ]);
    const body = renderBody(s, { runLabel: "run-42", runUrl: "https://example/run" });
    assert.match(body, /`extract-zip`/);
    assert.match(body, /GHSA-jmr9/);
    assert.match(body, /`image-size`/);
    assert.match(body, /run-42/);
    assert.match(renderTitle(s), /2 un-allowlisted advisories/);
  });

  test("a workspace that could not be audited is spelled out, not hidden", () => {
    const body = renderBody(
      summarise([{ workspace: "client", error: "npm audit produced nothing" }]),
    );
    assert.match(body, /NOT an all-clear/);
    assert.match(body, /client/);
  });
});
