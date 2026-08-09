// Tests for the pure acceptance-reconciliation decision (#2297).
// Run: node --test scripts/ship-guard/reconcile.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stripFences,
  sliceSection,
  parseReconciliation,
  parseAcceptanceKeys,
  decideReconciliation,
  RECONCILE_HEADER,
  ACCEPTANCE_HEADER,
} from "./reconcile.mjs";

// A well-formed PR body in the locked /ship format: one resolved issue with a
// two-bullet reconciliation block (one met, one deferred to a live tracker).
const goodBody = (n = 100, defer = 200) => `## Summary
- did a thing

## Acceptance reconciliation

### #${n}
- (alpha) — met
- (beta) — deferred:#${defer}

## Test plans

### #${n} — some issue
1. Do the thing.
Expected: it happens.

Ready #${n}

🤖 Generated with [Claude Code](https://claude.com/claude-code)`;

// An issue whose keyed `## Acceptance` matches the block above.
const issueWithKeys = (state = "open") => ({
  state,
  ...parseAcceptanceKeys(
    `## Summary\nblah\n\n## Acceptance\n- [ ] (alpha) first thing\n- [ ] (beta) second thing\n`,
  ),
});

describe("sliceSection", () => {
  it("slices a `##` section up to the next `## ` (keeps `### ` inside)", () => {
    const body = "## A\naaa\n### sub\nbbb\n## B\nccc";
    assert.equal(sliceSection(body, /^##\s+A\s*$/im).trim(), "aaa\n### sub\nbbb");
  });
  it("returns '' when the header is absent", () => {
    assert.equal(sliceSection("## Other\nx", RECONCILE_HEADER), "");
  });
  it("is safe on non-string input", () => {
    assert.equal(sliceSection(undefined, ACCEPTANCE_HEADER), "");
  });
});

describe("parseReconciliation", () => {
  it("parses a met + deferred block", () => {
    const blocks = parseReconciliation(goodBody(100, 200));
    const blk = blocks.get("100");
    assert.ok(blk);
    assert.deepEqual(
      blk.bullets.map((b) => [b.slug, b.deferTo]),
      [
        ["alpha", null],
        ["beta", "200"],
      ],
    );
    assert.equal(blk.malformed.length, 0);
  });
  it("records a malformed bullet (missing marker)", () => {
    const body = `## Acceptance reconciliation\n\n### #7\n- (nope) no marker here\n- (ok) — met\n`;
    const blk = parseReconciliation(body).get("7");
    assert.deepEqual(
      blk.bullets.map((b) => b.slug),
      ["ok"],
    );
    assert.equal(blk.malformed.length, 1);
  });
  it("accepts en-dash, colon and hyphen separators, and `deferred: #N` spacing", () => {
    const body =
      "## Acceptance reconciliation\n\n### #1\n- (a) – met\n- (b): met\n- (c) - deferred: #9\n";
    const blk = parseReconciliation(body).get("1");
    assert.deepEqual(
      blk.bullets.map((b) => [b.slug, b.deferTo]),
      [
        ["a", null],
        ["b", null],
        ["c", "9"],
      ],
    );
  });
  it("ignores prose lines inside a block (only list lines count)", () => {
    const body = "## Acceptance reconciliation\n\n### #3\nsome note\n- (x) — met\n";
    const blk = parseReconciliation(body).get("3");
    assert.equal(blk.bullets.length, 1);
    assert.equal(blk.malformed.length, 0);
  });
  it("returns an empty map when the section header is absent", () => {
    assert.equal(parseReconciliation("## Summary\n- x\nReady #5").size, 0);
  });
});

describe("parseAcceptanceKeys", () => {
  it("collects `(slug)`-keyed checklist items", () => {
    const { hasChecklist, keys } = parseAcceptanceKeys(
      "## Acceptance\n- [ ] (epoch) a\n- [x] (audit-row) b\n",
    );
    assert.equal(hasChecklist, true);
    assert.deepEqual([...keys].sort(), ["audit-row", "epoch"]);
  });
  it("reports a checklist with no keys (hasChecklist true, keys empty)", () => {
    const { hasChecklist, keys } = parseAcceptanceKeys("## Acceptance\n- [ ] unkeyed item\n");
    assert.equal(hasChecklist, true);
    assert.equal(keys.size, 0);
  });
  it("reports no checklist when `## Acceptance` is absent", () => {
    const { hasChecklist, keys } = parseAcceptanceKeys("## Summary\n- [ ] (x) stray");
    assert.equal(hasChecklist, false);
    assert.equal(keys.size, 0);
  });
});

describe("decideReconciliation — A (structural, offline)", () => {
  it("passes a well-formed block with skipB", () => {
    const { problems } = decideReconciliation({ body: goodBody(), skipB: true });
    assert.equal(problems.filter((p) => p.level === "error").length, 0);
  });
  it("errors when a Ready #N has no block", () => {
    const body = "## Summary\n- x\n\nReady #42";
    const { problems } = decideReconciliation({ body, skipB: true });
    assert.match(problems.find((p) => p.level === "error").msg, /#42: no .*block/);
  });
  it("errors on a malformed bullet", () => {
    const body = "## Acceptance reconciliation\n\n### #8\n- broken bullet\n\nReady #8";
    const { problems } = decideReconciliation({ body, skipB: true });
    assert.ok(problems.some((p) => p.level === "error" && /malformed/.test(p.msg)));
  });
  it("errors on an empty block", () => {
    const body = "## Acceptance reconciliation\n\n### #8\n\n## Test plans\n\nReady #8";
    const { problems } = decideReconciliation({ body, skipB: true });
    assert.ok(problems.some((p) => p.level === "error" && /no bullets/.test(p.msg)));
  });
  it("no Ready lines → no problems", () => {
    const { problems } = decideReconciliation({ body: "## Summary\n- chore", skipB: true });
    assert.equal(problems.length, 0);
  });
});

describe("decideReconciliation — B (completeness + liveness)", () => {
  it("passes when every keyed acceptance item is addressed and the deferral is open", () => {
    const issues = new Map([
      ["100", issueWithKeys("open")],
      ["200", { state: "open", hasChecklist: false, keys: new Set() }],
    ]);
    const { problems } = decideReconciliation({ body: goodBody(100, 200), issues });
    assert.equal(problems.filter((p) => p.level === "error").length, 0);
  });
  it("errors when the block omits an acceptance key (the #2230 silent drop)", () => {
    // Block only has (alpha); issue #100 requires (alpha) AND (beta).
    const body = `## Acceptance reconciliation\n\n### #100\n- (alpha) — met\n\nReady #100`;
    const issues = new Map([["100", issueWithKeys("open")]]);
    const { problems } = decideReconciliation({ body, issues });
    assert.match(
      problems.find((p) => p.level === "error").msg,
      /omits acceptance key\(s\) \(beta\)/,
    );
  });
  it("notices (does not error) when the issue has no keyed checklist", () => {
    const issues = new Map([
      ["100", { state: "open", hasChecklist: false, keys: new Set() }],
      ["200", { state: "open", hasChecklist: false, keys: new Set() }],
    ]);
    const { problems } = decideReconciliation({ body: goodBody(100, 200), issues });
    assert.equal(problems.filter((p) => p.level === "error").length, 0);
    assert.ok(problems.some((p) => p.level === "notice" && /no keyed .*Acceptance/.test(p.msg)));
  });
  it("errors when a deferral points at a CLOSED issue", () => {
    const issues = new Map([
      ["100", issueWithKeys("open")],
      ["200", { state: "closed", hasChecklist: false, keys: new Set() }],
    ]);
    const { problems } = decideReconciliation({ body: goodBody(100, 200), issues });
    assert.match(problems.find((p) => p.level === "error").msg, /CLOSED/);
  });
  it("errors when a deferral target can't be resolved", () => {
    const issues = new Map([["100", issueWithKeys("open")]]); // #200 not fetched
    const { problems } = decideReconciliation({ body: goodBody(100, 200), issues });
    assert.ok(problems.some((p) => p.level === "error" && /could not resolve/.test(p.msg)));
  });
  it("notices when the issue body couldn't be fetched", () => {
    const { problems } = decideReconciliation({ body: goodBody(100, 200), issues: new Map() });
    assert.ok(problems.some((p) => p.level === "notice" && /could not fetch/.test(p.msg)));
  });
});

describe("fenced examples are ignored (the #2297 self-dogfood bug)", () => {
  it("stripFences drops ``` and ~~~ blocks, keeps real content", () => {
    const body = "real one\n```\nfenced line\n```\nreal two\n~~~\nother fence\n~~~\nreal three";
    assert.equal(stripFences(body), "real one\nreal two\nreal three");
  });
  it("parseAcceptanceKeys reads the REAL `## Acceptance`, not a fenced example", () => {
    // An issue body that *documents* an example checklist in a code fence, then
    // carries its own real one at the end — exactly #2297's shape.
    const issueBody = [
      "Some prose about the format:",
      "```",
      "## Acceptance",
      "- [ ] (example-a) illustrative",
      "- [ ] (example-b) illustrative",
      "```",
      "more prose",
      "",
      "## Acceptance",
      "- [ ] (real-key) the actual criterion",
    ].join("\n");
    const { hasChecklist, keys } = parseAcceptanceKeys(issueBody);
    assert.equal(hasChecklist, true);
    assert.deepEqual([...keys], ["real-key"]);
  });
  it("parseReconciliation ignores a `## Acceptance reconciliation` shown inside a fence", () => {
    const body = [
      "Docs showing the format:",
      "```",
      "## Acceptance reconciliation",
      "### #999",
      "- (bogus) — met",
      "```",
      "## Acceptance reconciliation",
      "### #100",
      "- (real) — met",
    ].join("\n");
    const blocks = parseReconciliation(body);
    assert.ok(blocks.has("100"));
    assert.ok(!blocks.has("999"));
  });
});
