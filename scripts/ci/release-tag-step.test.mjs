// #2458 — release-tag.yml's tag-creation step, run under the SHELL THE RUNNER
// ACTUALLY USES, with curl stubbed to drive each outcome.
//
// WHY THIS TEST EXISTS, AND WHY IT DRIVES THE REAL SHELL
//   The workflow shipped in #2409 could never create a tag. The step read
//
//       api_get
//       exists=$?
//
//   and the runner invokes every `run:` step with
//   `bash --noprofile --norc -eo pipefail`. `-e` is ON — the step's own
//   `set -uo pipefail` adds to it rather than replacing it — so a BARE call
//   returning non-zero terminates the script instantly. `api_get` returns 1 to
//   mean "tag absent", which is the entire reason this job exists, so the step
//   died silently every time there was actually a tag to create.
//
//   It hid for two releases because v0.198.0 was bootstrapped by hand: every
//   run took the `return 0` (tag exists) branch, where `-e` never fires. The
//   first push that genuinely had to create a tag (run 9976) failed both
//   attempts, on different runners, contributing ZERO lines to an 87-line log.
//
//   So the bug is invisible to any test that does not use `-e`, and invisible
//   to any test that only exercises the tag-exists path. This test does both:
//   it parses the step out of the workflow and runs it under the runner's exact
//   flags. Reverting either fix below turns the `absent` cases red — verified,
//   not assumed.
//
//   Stubbing curl (rather than serving real HTTP, as fetch-binary.test.mjs
//   does) is deliberate: nothing here is transport-level. What is under test is
//   the shell's control flow around curl's exit status and printed status code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW = fileURLToPath(
  new URL("../../.forgejo/workflows/release-tag.yml", import.meta.url),
);

/**
 * The `run:` body of the step that creates the tag.
 *
 * Read by text rather than with a YAML parser, matching
 * check-e2e-tiers-core.mjs: no YAML library is a declared dependency of this
 * repo, and taking one on purely so a test can read a block scalar would put a
 * new package in the tree for no runtime benefit (knip flags it, correctly).
 * A block scalar is unambiguous to read directly — everything indented deeper
 * than its `run:` key belongs to it — so the parse is exact, not a heuristic.
 */
function tagStepScript() {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const nameAt = lines.findIndex((l) => /^\s*-\s*name:\s*Create the tag/.test(l));
  assert.notEqual(nameAt, -1, "release-tag.yml no longer has a 'Create the tag…' step");

  const runAt = lines.findIndex((l, i) => i > nameAt && /^\s*run:\s*\|\s*$/.test(l));
  assert.notEqual(runAt, -1, "that step no longer uses a `run: |` block");

  const runIndent = lines[runAt].match(/^\s*/)[0].length;
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    const indent = line.match(/^\s*/)[0].length;
    // A blank line inside a block scalar stays part of it.
    if (line.trim() !== "" && indent <= runIndent) break;
    body.push(line);
  }

  const dedent = Math.min(
    ...body.filter((l) => l.trim() !== "").map((l) => l.match(/^\s*/)[0].length),
  );
  return body.map((l) => l.slice(dedent)).join("\n");
}

// STUB_MODE drives the outcome. The stub mirrors curl's contract as the step
// uses it: the HTTP status on stdout (`-w '%{http_code}'`), and a non-zero
// EXIT for a transport failure — the distinction the bug turned on.
const CURL_STUB = `#!/usr/bin/env bash
is_post=0
for a in "$@"; do [ "$a" = "POST" ] && is_post=1; done
# Honour -o so the step's \`head -c 200 <file>\` has something to read.
out=""
prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
[ -n "$out" ] && echo '{"stub":true}' > "$out"
case "$STUB_MODE" in
  exists)     echo "200" ;;
  absent)     [ "$is_post" = 1 ] && echo "201" || echo "404" ;;
  netfail)    exit 7 ;;                       # transport failure, no status
  createfail) [ "$is_post" = 1 ] && echo "403" || echo "404" ;;
esac
`;

function runStep({ mode, dryRun }) {
  const dir = mkdtempSync(join(tmpdir(), "release-tag-step-"));
  try {
    const script = join(dir, "step.sh");
    writeFileSync(script, tagStepScript());
    const stubDir = join(dir, "bin");
    mkdirSync(stubDir, { recursive: true });
    const curl = join(stubDir, "curl");
    writeFileSync(curl, CURL_STUB);
    chmodSync(curl, 0o755);

    const res = spawnSync(
      "bash",
      // EXACTLY the runner's invocation. Without `-e` this test cannot fail.
      ["--noprofile", "--norc", "-eo", "pipefail", script],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${stubDir}:${process.env.PATH}`,
          STUB_MODE: mode,
          FALLBACK_TOKEN: "tok-a",
          GH_TOKEN: "tok-b",
          API_URL: "https://git.example.test/api/v1",
          REPO: "aaron/darkwatch",
          SHA: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          TAG: "v0.199.0",
          DRY_RUN: String(dryRun),
        },
      },
    );
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("tag already exists — the normal push between releases", () => {
  const { code, out } = runStep({ mode: "exists", dryRun: false });
  assert.equal(code, 0);
  assert.match(out, /already exists/);
});

// THE REGRESSION. Before #2458 this exited 1 having printed nothing at all.
test("tag absent + dry run — reports what it would do, creates nothing", () => {
  const { code, out } = runStep({ mode: "absent", dryRun: true });
  assert.equal(code, 0, "the tag-absent path must not abort the step");
  assert.match(out, /DRY RUN — would create tag v0\.199\.0/);
});

test("tag absent + real run — creates the tag", () => {
  const { code, out } = runStep({ mode: "absent", dryRun: false });
  assert.equal(code, 0, "the tag-absent path must not abort the step");
  assert.match(out, /Created tag v0\.199\.0/);
});

// The step already had a "could not tell" branch. Under `-e` it was DEAD CODE:
// a failing curl killed the shell with curl's own exit status (7), so the
// branch written to report the problem could never run.
test("transport failure — reports it rather than dying with curl's status", () => {
  const { code, out } = runStep({ mode: "netfail", dryRun: false });
  assert.equal(code, 1, "must fail as a reported error, not curl's exit 7");
  assert.match(out, /::error::Could not determine whether/);
});

test("creation rejected — names the status and fails loudly", () => {
  const { code, out } = runStep({ mode: "createfail", dryRun: false });
  assert.equal(code, 1);
  assert.match(out, /HTTP 403/);
  assert.match(out, /::error::Could not create tag/);
});

// A guard on the guard: if someone reintroduces a bare status-losing call, the
// cases above catch it — but only while this test runs the real `-e` shell.
// Assert the invocation itself, so weakening it is a visible edit.
test("the workflow still carries the -e-safe call shape", () => {
  const script = tagStepScript();
  assert.match(
    script,
    /api_get \|\| exists=\$\?/,
    "api_get must stay on the left of `||` — a bare call is fatal under `set -e` (#2458)",
  );
  assert.doesNotMatch(
    script,
    /^\s*api_get\s*$/m,
    "a bare `api_get` line is the #2458 bug — keep it in a tested context",
  );
});
