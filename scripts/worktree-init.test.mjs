// #1373 — worktree-init.sh provisions node_modules into a fresh worktree via a
// copy-on-write clone from main (instant + isolated on APFS), guarded by a
// per-workspace lockfile match. Sandboxed with WORKTREE_INIT_*_ROOT overrides
// so no real git worktree / real node_modules is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./worktree-init.sh", import.meta.url));

// Probe whether the temp filesystem supports `cp -c` (APFS clonefile). The
// clone assertions branch on this so the test is honest on Linux CI too.
function cowSupported() {
  const d = mkdtempSync(join(tmpdir(), "cow-probe-"));
  try {
    writeFileSync(join(d, "a"), "x");
    const r = spawnSync("cp", ["-c", join(d, "a"), join(d, "b")]);
    return r.status === 0;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
const COW = cowSupported();

// Build a fake main checkout + linked worktree under one temp root. A clone is
// valid iff (a) the worktree's tracked package-lock.json equals main's, AND
// (b) main is freshly installed (main's package-lock.json is not newer than its
// node_modules/.package-lock.json install manifest).
// opts.workspaces: { [dir]: {
//   want?: string,        // worktree package-lock.json (default "LOCK")
//   mainLock?: string,    // main package-lock.json (default = want → branch unchanged)
//   mainNodeModules?: bool,
//   stale?: bool,         // main lockfile newer than its install manifest (pulled-not-installed)
//   noInstalledManifest?: bool, wtNodeModules?: bool,
// } }
function setup(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "wt-init-"));
  const main = join(root, "main");
  const wt = join(root, "wt");
  mkdirSync(main, { recursive: true });
  mkdirSync(wt, { recursive: true });

  // Deterministic mtimes (seconds): install manifest at T; main lockfile before
  // (fresh) or after (stale).
  const T = 1_000_000;

  for (const [dir, cfg] of Object.entries(opts.workspaces ?? {})) {
    const mainDir = dir === "." ? main : join(main, dir);
    const wtDir = dir === "." ? wt : join(wt, dir);
    mkdirSync(mainDir, { recursive: true });
    mkdirSync(wtDir, { recursive: true });

    const want = cfg.want ?? "LOCK";
    const mainLock = cfg.mainLock ?? want; // default: branch hasn't changed deps
    writeFileSync(join(wtDir, "package-lock.json"), want);
    const mainLockPath = join(mainDir, "package-lock.json");
    writeFileSync(mainLockPath, mainLock);

    if (cfg.mainNodeModules) {
      mkdirSync(join(mainDir, "node_modules", "left-pad"), { recursive: true });
      writeFileSync(join(mainDir, "node_modules", "left-pad", "index.js"), "module.exports=1");
      writeFileSync(join(mainDir, "node_modules", ".sentinel"), "deps");
      if (!cfg.noInstalledManifest) {
        const manifestPath = join(mainDir, "node_modules", ".package-lock.json");
        writeFileSync(manifestPath, "installed");
        // Install at T; lockfile before (fresh) or after (stale) the install.
        utimesSync(manifestPath, T, T);
        utimesSync(mainLockPath, cfg.stale ? T + 10 : T - 10, cfg.stale ? T + 10 : T - 10);
      }
    }
    if (cfg.wtNodeModules) {
      mkdirSync(join(wtDir, "node_modules"), { recursive: true });
      writeFileSync(join(wtDir, "node_modules", ".existing"), "keep");
    }
  }
  if (opts.mainEnv) writeFileSync(join(main, ".env"), "DB_ROOT_PASSWORD=secret\n");
  return { root, main, wt };
}

function run(main, wt) {
  return spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      WORKTREE_INIT_MAIN_ROOT: main,
      WORKTREE_INIT_WORKTREE_ROOT: wt,
    },
  });
}

test(
  "clones node_modules when main's installed deps match the worktree lockfile (CoW)",
  { skip: !COW },
  () => {
    const { main, wt } = setup({ workspaces: { client: { mainNodeModules: true } } });
    const r = run(main, wt);
    assert.equal(r.status, 0);
    assert.ok(existsSync(join(wt, "client", "node_modules", ".sentinel")), "node_modules cloned");
    assert.equal(
      readFileSync(join(wt, "client", "node_modules", "left-pad", "index.js"), "utf8"),
      "module.exports=1",
    );
  },
);

test("provisions every in-sync workspace", { skip: !COW }, () => {
  const { main, wt } = setup({
    workspaces: {
      ".": { mainNodeModules: true },
      client: { mainNodeModules: true },
      server: { mainNodeModules: true },
    },
  });
  run(main, wt);
  for (const d of [".", "client", "server"]) {
    const p = d === "." ? join(wt, "node_modules") : join(wt, d, "node_modules");
    assert.ok(existsSync(join(p, ".sentinel")), `${d} provisioned`);
  }
});

test("skips when the branch changed deps (worktree lockfile differs from main → npm ci)", () => {
  const { main, wt } = setup({
    workspaces: { client: { mainLock: "MAIN", want: "BRANCH-CHANGED", mainNodeModules: true } },
  });
  const r = run(main, wt);
  assert.equal(r.status, 0);
  assert.ok(!existsSync(join(wt, "client", "node_modules")), "changed deps NOT cloned");
  assert.match(r.stdout, /npm ci/, "hints to run npm ci");
});

test("skips when main's node_modules is stale (lockfile newer than install → pulled but not npm ci'd)", () => {
  const { main, wt } = setup({
    workspaces: { client: { mainNodeModules: true, stale: true } },
  });
  const r = run(main, wt);
  assert.equal(r.status, 0);
  assert.ok(!existsSync(join(wt, "client", "node_modules")), "stale main NOT cloned");
  assert.match(r.stdout, /stale/, "names the staleness");
});

test("skips when main's node_modules has no install manifest (can't verify freshness)", () => {
  const { main, wt } = setup({
    workspaces: { client: { mainNodeModules: true, noInstalledManifest: true } },
  });
  const r = run(main, wt);
  assert.equal(r.status, 0);
  assert.ok(!existsSync(join(wt, "client", "node_modules")), "unverifiable deps NOT cloned");
});

test("idempotent — leaves an existing node_modules untouched", () => {
  const { main, wt } = setup({
    workspaces: { client: { mainNodeModules: true, wtNodeModules: true } },
  });
  const r = run(main, wt);
  assert.equal(r.status, 0);
  assert.ok(existsSync(join(wt, "client", "node_modules", ".existing")), "existing kept");
  assert.ok(!existsSync(join(wt, "client", "node_modules", ".sentinel")), "not overwritten");
});

test("skips gracefully when main has no node_modules for a workspace", () => {
  const { main, wt } = setup({ workspaces: { server: { mainNodeModules: false } } });
  const r = run(main, wt);
  assert.equal(r.status, 0);
  assert.ok(!existsSync(join(wt, "server", "node_modules")));
});

test("still symlinks env files (existing #859 behavior preserved)", () => {
  const { main, wt } = setup({
    mainEnv: true,
    workspaces: { client: { mainNodeModules: true } },
  });
  const r = run(main, wt);
  assert.equal(r.status, 0);
  assert.ok(existsSync(join(wt, ".env")), ".env present in worktree");
});

test("always exits 0 even with nothing to do", () => {
  const { main, wt } = setup({});
  assert.equal(run(main, wt).status, 0);
});
