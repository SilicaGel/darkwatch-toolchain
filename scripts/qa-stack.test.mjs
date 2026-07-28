// #2008 — qa-stack.sh runs the e2e / qa-check lane against its own server and
// database instead of the dev one.
//
// The properties worth testing are the refusals. Everything this script does
// after the guards involves starting two long-lived processes, which a unit
// test has no business doing; but every guard exists because failing to refuse
// produces a run that LOOKS isolated and silently writes to `darkwatch`.
//
// Sandboxed with fake docker/lsof/curl on PATH, so no real container is
// consulted and no real port is bound.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./qa-stack.sh", import.meta.url));

/**
 * Run the script with fakes on PATH.
 *
 * `holdPort` is the one port the fake lsof claims is taken; "" means every port
 * is free, and lsof exits 1 — the case that once aborted the whole script
 * silently. `dbExists` decides whether the fake docker finds the QA database.
 */
function runScript(args, { env = {}, holdPort = "", dbExists = true } = {}) {
  const binDir = mkdtempSync(join(tmpdir(), "qastack-bin-"));
  const log = join(binDir, "calls.log");

  const fakes = {
    // Exit 1 with no output when there's nothing to report — real lsof does
    // this, and it's the happy path.
    lsof: `#!/usr/bin/env bash
echo "lsof $*" >> "${log}"
case " $* " in
  *"iTCP:${holdPort || "__none__"} "*|*"iTCP:${holdPort || "__none__"}"*) echo 4242 ;;
  *) exit 1 ;;
esac`,
    docker: `#!/usr/bin/env bash
echo "docker $*" >> "${log}"
exit ${dbExists ? 0 : 1}`,
    // Never reached in these tests, but present so a guard slipping through
    // fails on an assertion rather than on a missing binary.
    curl: `#!/usr/bin/env bash
echo "curl $*" >> "${log}"
echo 401`,
    ps: `#!/usr/bin/env bash
echo "fake-process"`,
  };
  for (const [name, body] of Object.entries(fakes)) {
    const p = join(binDir, name);
    writeFileSync(p, `${body}\n`);
    chmodSync(p, 0o755);
  }

  try {
    const res = spawnSync("bash", [SCRIPT, ...args], {
      env: { ...process.env, ...env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: "utf8",
      timeout: 20_000,
    });
    return {
      status: res.status,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      calls: existsSync(log) ? readFileSync(log, "utf8") : "",
    };
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

describe("qa-stack.sh (#2008)", () => {
  test("refuses to point the QA lane at the dev database", () => {
    const r = runScript(["--", "true"], { env: { QA_DB_NAME: "darkwatch" } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /refusing to run the QA lane against the dev DB/);
    // Aborted before consulting docker or binding anything.
    assert.equal(r.calls, "");
  });

  test("refuses a database name that isn't a bare identifier", () => {
    const r = runScript(["--", "true"], { env: { QA_DB_NAME: "darkwatch; DROP DATABASE x" } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /must be \[A-Za-z0-9_\]\+/);
    assert.equal(r.calls, "");
  });

  test("refuses to start when the server port is already held", () => {
    // Reusing a port is how a run looks isolated while writing to `darkwatch`:
    // Playwright's reuseExistingServer would adopt whatever is already there.
    const r = runScript(["--", "true"], { holdPort: "3001" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /port 3001 \(server\) is already in use by pid 4242/);
    assert.match(r.stderr, /QA_SERVER_PORT=<free port>/);
  });

  test("names the client port when that is the one held", () => {
    // The server port is free in this run, so reaching this refusal at all
    // proves the loop checks both ports and labels each one correctly.
    const r = runScript(["--", "true"], { holdPort: "5174" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /port 5174 \(client\) is already in use by pid 4242/);
    assert.match(r.stderr, /QA_CLIENT_PORT=<free port>/);
  });

  test("tells you to --reset when the QA database does not exist yet", () => {
    const r = runScript(["--", "true"], { dbExists: false });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /database 'darkwatch_e2e' does not exist yet/);
    assert.match(r.stderr, /--reset/);
    // It asked docker, and asked about the QA database — never the dev one.
    assert.match(r.calls, /docker exec darkwatch-maria/);
    assert.doesNotMatch(r.calls, /USE `darkwatch`/);
  });

  test("a free port produces no refusal — lsof exiting 1 is the happy path", () => {
    // Regression: `set -e` + `pipefail` turned lsof's empty-result exit 1 into a
    // silent abort with no output at all, before anything started.
    const r = runScript(["--check"], { holdPort: "", dbExists: true });
    assert.doesNotMatch(r.stderr, /already in use/);
    assert.doesNotMatch(r.stderr, /does not exist yet/);
    // It got past every guard and reported ready, without starting a thing.
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ready: 'darkwatch_e2e' exists, ports 3001\/5174 are free/);
    assert.match(r.calls, /docker exec darkwatch-maria/);
  });
});
