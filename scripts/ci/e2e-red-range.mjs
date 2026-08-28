#!/usr/bin/env node
// #2435 — I/O shell for the e2e-full red marker's "Suspect commits" range. All
// decision logic lives in e2e-red-range-core.mjs (pure, unit-tested); this
// does the two git calls and prints one JSON line for the caller.
//
// Invoked from e2e-full.yml's `notify-failure` job, whose "Comment the
// rolling issue" step is inline Python (curl beats Node's fetch against
// forge.example.com's Cloudflare fingerprint block — see that step's
// comment). Rather than reimplement the ancestor check in Python, that step
// shells out to this script and reads its JSON stdout.
//
// Never throws past its own boundary: any git failure just means "could not
// verify", which the core module already treats as "fall back, say so".
import { execFileSync } from "node:child_process";
import { chooseRange, RANGE_COMMIT_CAP, FALLBACK_COMMIT_WINDOW } from "./e2e-red-range-core.mjs";

const lastGreen = (process.env.LAST_GREEN || "").trim() || null;
const head = (process.env.HEAD_SHA || "").trim();

if (!head) {
  process.stderr.write("e2e-red-range.mjs: HEAD_SHA is required\n");
  process.exit(1);
}

/** Run git; return trimmed stdout on success, null on any non-zero exit. */
function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" });
  } catch {
    return null;
  }
}

let isAncestor = null;
let aheadLog = "";
if (lastGreen) {
  // Exit 0 = ancestor, exit 1 = not an ancestor, exit 128 = unknown object
  // (e.g. a PR-branch commit this checkout never fetched) — all three land on
  // `git()` returning null for anything but a clean ancestor proof.
  isAncestor = git("merge-base", "--is-ancestor", lastGreen, head) !== null;
  if (isAncestor) {
    aheadLog =
      git("log", `${lastGreen}..${head}`, "--oneline", "-n", String(RANGE_COMMIT_CAP)) ?? "";
  }
}
const recentLog = git("log", "--oneline", "-n", String(FALLBACK_COMMIT_WINDOW)) ?? "";

process.stdout.write(
  JSON.stringify(chooseRange({ lastGreen, head, isAncestor, aheadLog, recentLog })),
);
