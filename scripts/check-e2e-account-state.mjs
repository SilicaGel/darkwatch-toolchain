#!/usr/bin/env node
// #2166 — E2E specs must not leave shared seed accounts mutated.
//
// THE FAILURE THIS EXISTS TO CATCH. A spec that drives a real settings control
// persists state to the shared seed ACCOUNT, not just to its browser context.
// The next spec to log in as that account inherits it. On 2026-08-03 that broke
// four tests in PR #2163: `2114-wave1-wt-chrome.spec.ts` and
// `2115-wave2-wt-chrome.spec.ts` each drive the real layout switch, which calls
// `updateAccountLayout` and writes `users.layout_preference` for DungeonMaster —
// an account dozens of specs share. Neither restored it.
//
// It stayed invisible for a year because nothing READ the account preference on
// a fresh context's first load; resolution came from the per-tab pin or the
// localStorage mirror. #2098 closed that gap deliberately, and a year of
// harmless pollution became load-bearing overnight: four tests that had always
// passed started failing, on code that hadn't changed, and the cause surfaced
// far from where it lived (it was first misdiagnosed as a reload loop).
//
// That is the general shape of this debt — silent until some unrelated change
// starts reading the state — which is exactly why it needs a mechanical guard
// rather than a convention. `1670-layout-flip.spec.ts` had independently worked
// out the right pattern (a low-traffic seed account + an `afterEach` restore)
// and written it down nowhere; the two specs that later needed it didn't follow
// it, because nothing made them.
//
// THE RULE. A spec that mutates shared-account state must:
//   1. restore that state in a teardown hook (`test.afterEach` / `test.afterAll`),
//      so a mid-test failure still leaves the account as it was found; and
//   2. do it on a low-traffic seed account — never DungeonMaster or Adventurer,
//      the two every other spec depends on.
//
// A spec that registers its own throwaway account (`/api/auth/register`) is out
// of scope by construction: it never touches a shared account at all. That is
// what the four 2FA specs do, and #2401 made them delete the throwaway too.
//
// DELIBERATELY NOT COVERED: consuming one of `TOTP_2FA_FIXTURE`'s two seeded
// recovery codes (2213, 2384). That IS an irreversible write to a shared seed
// account — but it is what the #2213 fixture exists for, it has no restore
// (a spent code cannot be un-spent through any API), and helpers/auth.ts
// documents the tradeoff explicitly: CI reseeds per run, and a local re-run
// needs a reseed first. Flagging it would report a defect with no available
// fix. Reconsider if a "reset fixture 2FA" test hook ever ships.
//
// This is a text scan, not a type-aware analysis. It is deliberately biased
// toward false POSITIVES (a spec that mentions a mutator must prove it cleans
// up) over false negatives, because a false positive is a 30-second read and a
// false negative is the 2026-08-03 debugging session.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SPEC_DIR = "tests/e2e";

/**
 * The endpoints that write durable state onto a shared seed account, each with
 * the markers that betray a spec touching it — the API path itself, and the UI
 * controls that call it (the #2163 specs never named the endpoint; they clicked
 * the button).
 *
 * `restoreValue`, when present, is the value the seed actually leaves in the
 * column, so a "restore" that writes something else is caught too. It is only
 * set where that value has been verified against the schema/seed — see the
 * layout entry. Where it is absent, the guard only requires that a restore of
 * some kind exists.
 */
export const ACCOUNT_MUTATORS = [
  {
    id: "layout",
    endpoint: "/api/account/layout",
    markers: [
      /["'`]\/api\/account\/layout["'`]/,
      /getByTestId\(\s*["'`](?:wt-)?layout-switch["'`]\s*\)/,
    ],
    // 20260729120000_users_layout_preference.sql adds the column NULL and
    // nothing seeds a value, so NULL — not "wartable" — is the found state.
    // Writing "wartable" gives the account a preference it never had, which
    // then reaches every later spec that logs in unpinned.
    restoreValue: /layout:\s*null/,
  },
  {
    id: "dice-settings",
    endpoint: "/api/account/dice-settings",
    markers: [
      /["'`]\/api\/account\/dice-settings["'`]/,
      /getByRole\(\s*["'`]radiogroup["'`]\s*,\s*\{[^}]*["'`]Dice preset["'`]/,
    ],
  },
  {
    id: "password",
    endpoint: "/api/account/change-password",
    markers: [/["'`][^"'`]*\/account\/change-password["'`]/],
  },
  {
    id: "email",
    endpoint: "/api/account/change-email",
    markers: [/["'`][^"'`]*\/account\/change-email["'`]/],
  },
  {
    id: "2fa",
    endpoint: "/api/auth/2fa",
    markers: [
      /["'`][^"'`]*\/2fa\/(?:enroll|disable)["'`]/,
      /getByTestId\(\s*["'`](?:enable|disable)-2fa-btn["'`]\s*\)/,
    ],
  },
];

/**
 * Seed accounts too widely shared to be a settings spec's subject.
 *
 * Matched by the helper identifier as well as the bare username, because specs
 * overwhelmingly write `loginAs(page, DM.username, DM.password)` and never
 * mention "DungeonMaster" at all — a literal-only scan would find nothing.
 * `\bPLAYER\.` deliberately does not match `PLAYER2.` / `PLAYER3.` (Rook and
 * Sylva), which are the low-traffic accounts this rule steers you toward.
 */
export const HIGH_TRAFFIC_ACCOUNTS = [
  { name: "DungeonMaster", patterns: [/\bDM\.username\b/, /["'`]DungeonMaster["'`]/] },
  { name: "Adventurer", patterns: [/\bPLAYER\.username\b/, /["'`]Adventurer["'`]/] },
];

/**
 * Specs allowed to mutate a HIGH_TRAFFIC account. Restoring is still mandatory
 * for these — the exemption is only from rule 2. Each needs a reason a reviewer
 * can check, in the same spirit as check-prod-env-provisioning's grace list.
 */
export const HIGH_TRAFFIC_EXEMPT = [
  {
    file: "2114-wave1-wt-chrome.spec.ts",
    reason:
      "#2163 — the subject IS the DM's War Table chrome, which only exists on a DM " +
      "account; the layout switch is incidental to that. Restores in afterEach.",
  },
  {
    file: "2115-wave2-wt-chrome.spec.ts",
    reason: "#2163 — same as 2114: DM chrome is the subject. Restores in afterEach.",
  },
];

const TEARDOWN_HOOKS = ["test.afterEach(", "test.afterAll(", "afterEach(", "afterAll("];

/**
 * Extract the source of the call whose opening `(` is at `openParenIndex`,
 * by paren matching while skipping string/template literals and comments —
 * so a `)` inside a message or a regex-ish string can't end the call early.
 *
 * Best-effort, like check-prod-env-provisioning's `extractBlock`: validated
 * against this repo's actual teardown hooks rather than being a real parser.
 */
export function extractCall(text, openParenIndex) {
  let depth = 0;
  let i = openParenIndex;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === quote) break;
        i++;
      }
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) return text.slice(openParenIndex + 1, i);
    }
    i++;
  }
  return text.slice(openParenIndex + 1); // unterminated — best effort
}

/** Every teardown-hook body in one spec's source, concatenated. */
export function teardownBodies(text) {
  const bodies = [];
  for (const hook of TEARDOWN_HOOKS) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(hook, from);
      if (at === -1) break;
      // `test.afterEach(` also matches the bare `afterEach(` needle; the paren
      // index is the same either way, so duplicates are harmless (they only
      // repeat an identical body) but skipping them keeps the output clean.
      const parenAt = at + hook.length - 1;
      bodies.push(extractCall(text, parenAt));
      from = at + hook.length;
    }
  }
  return bodies;
}

/**
 * Evaluate one spec.
 *
 * @param {{ file: string, text: string }} spec
 * @returns {Array<{ file: string, mutator: string, rule: string, detail: string }>}
 */
export function checkSpec({ file, text }) {
  const violations = [];

  // A spec that registers its own account never touches a shared one.
  if (/["'`][^"'`]*\/auth\/register["'`]/.test(text)) return violations;

  const bodies = teardownBodies(text);
  const exempt = HIGH_TRAFFIC_EXEMPT.some((e) => file.endsWith(e.file));

  for (const mutator of ACCOUNT_MUTATORS) {
    if (!mutator.markers.some((m) => m.test(text))) continue;

    const restoring = bodies.filter((b) => b.includes(mutator.endpoint));
    if (restoring.length === 0) {
      violations.push({
        file,
        mutator: mutator.id,
        rule: "no-restore",
        detail: `drives ${mutator.id} account state but no test.afterEach/afterAll writes ${mutator.endpoint}`,
      });
    } else if (mutator.restoreValue && !restoring.some((b) => mutator.restoreValue.test(b))) {
      violations.push({
        file,
        mutator: mutator.id,
        rule: "wrong-restore-value",
        detail: `restores ${mutator.endpoint} to a value the seed never had — expected ${String(mutator.restoreValue)}`,
      });
    }

    if (!exempt) {
      const account = HIGH_TRAFFIC_ACCOUNTS.find((a) => a.patterns.some((p) => p.test(text)));
      if (account) {
        violations.push({
          file,
          mutator: mutator.id,
          rule: "high-traffic-account",
          detail: `mutates ${mutator.id} state while logged in as ${account.name} — use a low-traffic seed account (Rook, Sylva) or add a reasoned HIGH_TRAFFIC_EXEMPT entry`,
        });
      }
    }
  }

  return violations;
}

/** Run the check across a directory of spec files. */
export function checkSpecDir(specDir) {
  const files = readdirSync(specDir)
    .filter((f) => f.endsWith(".spec.ts"))
    .sort();
  return files.flatMap((f) => checkSpec({ file: f, text: readFileSync(join(specDir, f), "utf8") }));
}

function main() {
  const repoRoot = process.argv[2] ?? ".";
  const violations = checkSpecDir(join(repoRoot, SPEC_DIR));
  if (violations.length === 0) {
    console.log(
      "[check-e2e-account-state] OK — every spec that mutates shared seed-account state restores it.",
    );
    return;
  }
  console.error(
    `[check-e2e-account-state] FAILED — ${violations.length} spec(s) leave shared seed-account state mutated:`,
  );
  for (const v of violations) {
    console.error(`  - ${v.file} [${v.rule}]: ${v.detail}`);
  }
  console.error(
    "\nA spec that drives a real settings control writes to the shared seed ACCOUNT, " +
      "not just its browser context — the next spec to log in as that account inherits it " +
      "(#2166; #2163 lost four tests to exactly this). Fix by restoring in a " +
      "test.afterEach so a mid-test failure still cleans up, and by running on a " +
      "low-traffic seed account. A spec that registers its OWN throwaway account is out " +
      "of scope automatically.",
  );
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
