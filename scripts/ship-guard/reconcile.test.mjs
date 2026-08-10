// Tests for the pure acceptance-reconciliation decision (#2297).
// Run: node --test scripts/ship-guard/reconcile.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stripIgnored,
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
  it("stripIgnored drops ``` and ~~~ blocks, keeps real content", () => {
    const body = "real one\n```\nfenced line\n```\nreal two\n~~~\nother fence\n~~~\nreal three";
    assert.equal(stripIgnored(body), "real one\nreal two\nreal three");
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

describe("reframed issues + retire markers (#2320)", () => {
  // The exact shape implementing-issues.md produces on a reframe: revised list
  // live under a dated header, original archived in a <details>.
  const reframed = [
    "## Problem",
    "blah",
    "",
    "## Acceptance (revised 2026-08-10)",
    "- [ ] (live-a) the current criterion",
    "- [ ] (live-b) another current one",
    "",
    "<details><summary>Original acceptance (superseded)</summary>",
    "",
    "## Acceptance",
    "- [ ] (retired-a) old withdrawn criterion",
    "- [ ] (retired-b) another withdrawn one",
    "",
    "</details>",
  ].join("\n");

  it("stripIgnored drops a balanced <details> block, keeps surrounding content", () => {
    assert.equal(
      stripIgnored("keep 1\n<details>\ndrop a\ndrop b\n</details>\nkeep 2"),
      "keep 1\n\nkeep 2",
    );
  });

  it("stripIgnored drops adjacent <details> blocks", () => {
    const two = "a\n<details>x</details>\nb\n<details>y</details>\nc";
    assert.equal(stripIgnored(two).replace(/\n+/g, "\n"), "a\nb\nc");
  });

  it("stripIgnored leaves an UNBALANCED <details> mention as text (the #2320 own-body case)", () => {
    // An inline-code prose mention with no closing tag must NOT over-strip the
    // live section that follows it.
    const b = "Archive it in a `<details>` block.\n\n## Acceptance\n- [ ] (real) x";
    const stripped = stripIgnored(b);
    assert.match(stripped, /## Acceptance/);
    assert.deepEqual([...parseAcceptanceKeys(b).keys], ["real"]);
  });

  it("live-section-wins: parses the REVISED keys, not the archived ones", () => {
    const { keys, headerCount } = parseAcceptanceKeys(reframed);
    assert.deepEqual([...keys].sort(), ["live-a", "live-b"]);
    assert.equal(headerCount, 1); // the archived one is inside <details>, stripped
  });

  it("accepts a qualified `## Acceptance (revised …)` header but not `## Acceptance reconciliation`", () => {
    assert.match("## Acceptance (revised 2026-08-10)", ACCEPTANCE_HEADER);
    assert.doesNotMatch("## Acceptance reconciliation", ACCEPTANCE_HEADER);
  });

  it("multi-header-detected: two LIVE ## Acceptance headers → collision error, completeness skipped", () => {
    const body = "## Acceptance\n- [ ] (a) one\n\n## Acceptance\n- [ ] (b) two";
    const parsed = parseAcceptanceKeys(body);
    assert.equal(parsed.headerCount, 2);
    const prBody = "## Acceptance reconciliation\n### #77\n- (a) — met\n\nReady #77";
    const issues = new Map([["77", { state: "open", ...parsed }]]);
    const { problems } = decideReconciliation({ body: prBody, issues });
    const err = problems.find((p) => p.level === "error");
    assert.match(err.msg, /2 `## Acceptance` headers/);
    // and it must NOT also emit an omitted-key error (completeness was skipped)
    assert.ok(!problems.some((p) => /omits acceptance key/.test(p.msg)));
  });

  it("retire-is-declared: a `superseded:#M` key is dropped from required and recorded", () => {
    const body =
      "## Acceptance\n- [ ] (keep) still required\n- [ ] (gone) withdrawn — superseded:#2305";
    const { keys, retired } = parseAcceptanceKeys(body);
    assert.deepEqual([...keys], ["keep"]);
    assert.equal(retired.get("gone"), "2305");
  });

  it("a retired key is NOT demanded by the completeness check", () => {
    const issueBody = "## Acceptance\n- [ ] (keep) required\n- [ ] (gone) x — superseded:#2305";
    const parsed = parseAcceptanceKeys(issueBody);
    // Reconciliation addresses only (keep); (gone) is retired, so no omission error.
    const prBody = "## Acceptance reconciliation\n### #88\n- (keep) — met\n\nReady #88";
    const issues = new Map([["88", { state: "open", ...parsed }]]);
    const { problems } = decideReconciliation({ body: prBody, issues });
    assert.equal(problems.filter((p) => p.level === "error").length, 0);
  });
});
