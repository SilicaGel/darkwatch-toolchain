// #2010 — fetch-binary.sh retries a download whose CONNECTION dies mid-body,
// which is the failure that killed e2e-full twice in 24h (curl exit 56, "SSL
// routines::decryption failed or bad record mac"). The interesting cases are
// all transport-level, so these tests drive a real local HTTP server and cut
// the socket rather than stubbing curl.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./fetch-binary.sh", import.meta.url));
const BODY = "#!/bin/sh\necho i-am-the-binary\n";

// Serve BODY, but kill the connection mid-response for the first
// `failures` requests. Returns { url, requests(), close() }.
async function startServer({ failures = 0, mode = "cut" } = {}) {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    if (requests <= failures) {
      if (mode === "cut") {
        // Promise more bytes than we send, then hang up: curl sees a
        // transport failure (exit 18/56), the same shape as a bad TLS record.
        res.writeHead(200, { "Content-Length": String(BODY.length) });
        res.write(BODY.slice(0, 5));
        res.socket.destroy();
        return;
      }
      if (mode === "404") {
        res.writeHead(404).end("nope");
        return;
      }
      if (mode === "empty") {
        res.writeHead(200, { "Content-Length": "0" }).end();
        return;
      }
    }
    res.writeHead(200, { "Content-Length": String(BODY.length) }).end(BODY);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/binary`,
    requests: () => requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Must be async: the server under test lives in THIS process, so a blocking
// spawnSync would deadlock the event loop and the request would never be served.
function run(url, dest, attempts) {
  return new Promise((resolve) => {
    execFile(
      "bash",
      [SCRIPT, url, dest, String(attempts)],
      { encoding: "utf8", env: { ...process.env, FETCH_RETRY_DELAY: "0" } },
      (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr }),
    );
  });
}

async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "fetch-binary-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("retries past a connection cut and lands the complete body", async () => {
  const server = await startServer({ failures: 2 });
  try {
    await withTmpDir(async (dir) => {
      const dest = join(dir, "minio");
      const res = await run(server.url, dest, 5);

      assert.equal(res.status, 0, res.stderr);
      assert.equal(readFileSync(dest, "utf8"), BODY);
      assert.equal(server.requests(), 3, "should have retried twice");
      assert.match(res.stdout, /attempt 3\/5/);
      assert.equal(existsSync(`${dest}.part`), false, "no .part left behind");
    });
  } finally {
    await server.close();
  }
});

test("gives up after the attempt budget and leaves no partial binary", async () => {
  const server = await startServer({ failures: Infinity });
  try {
    await withTmpDir(async (dir) => {
      const dest = join(dir, "minio");
      const res = await run(server.url, dest, 3);

      assert.equal(res.status, 1);
      assert.equal(server.requests(), 3, "should have used the whole budget");
      assert.match(res.stderr, /giving up/);
      // The whole point: a truncated download must never be left where the
      // caller will chmod +x it and run it.
      assert.equal(existsSync(dest), false);
      assert.equal(existsSync(`${dest}.part`), false);
    });
  } finally {
    await server.close();
  }
});

test("an empty 200 body counts as a failure, not a download", async () => {
  const server = await startServer({ failures: Infinity, mode: "empty" });
  try {
    await withTmpDir(async (dir) => {
      const dest = join(dir, "mc");
      const res = await run(server.url, dest, 2);

      assert.equal(res.status, 1);
      assert.match(res.stderr, /EMPTY body/);
      assert.equal(existsSync(dest), false);
    });
  } finally {
    await server.close();
  }
});

test("an HTTP error is a failure (curl -f), never a 'binary' full of HTML", async () => {
  const server = await startServer({ failures: Infinity, mode: "404" });
  try {
    await withTmpDir(async (dir) => {
      const dest = join(dir, "mc");
      const res = await run(server.url, dest, 2);

      assert.equal(res.status, 1);
      assert.equal(existsSync(dest), false);
    });
  } finally {
    await server.close();
  }
});

test("recovers on the very last attempt", async () => {
  const server = await startServer({ failures: 2 });
  try {
    await withTmpDir(async (dir) => {
      const dest = join(dir, "minio");
      const res = await run(server.url, dest, 3);

      assert.equal(res.status, 0, res.stderr);
      assert.equal(readFileSync(dest, "utf8"), BODY);
    });
  } finally {
    await server.close();
  }
});

test("missing arguments exit 2 rather than downloading something odd", () => {
  const res = spawnSync("bash", [SCRIPT, "http://example.invalid/x"], {
    encoding: "utf8",
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage/);
});
