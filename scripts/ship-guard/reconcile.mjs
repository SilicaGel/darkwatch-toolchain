// ship-guard/reconcile.mjs — #2297 acceptance-reconciliation gate.
//
// The ship skill's Step 4.6 requires each `Ready #N` to reconcile the issue's
// acceptance bullets against the diff, with every unmet bullet either fixed or
// filed as a live tracker. #2287 made that a skill *instruction* — but a skill
// instruction only binds a session that loaded that skill version, so a
// concurrent batch/umbrella session that loaded an older skill silently skips
// it (that's how #2294 shipped three untracked deferrals right after the gate
// merged). This module moves the MECHANICAL half of the gate into `ship-guard`
// CI, where a stale skill load can't bypass it, and into a pre-POST self-check
// the /ship skill runs against the drafted PR body for fast local feedback.
//
// Two layers, matched to what each environment can actually verify:
//
//   A — structural (offline, no network): every `Ready #N` has a `### #N` block
//       under `## Acceptance reconciliation`, and every bullet is well-formed
//       (`- (slug) — met | deferred:#M`). Catches the whole-block skip (#2294).
//
//   B — completeness + liveness (needs the issue bodies): every keyed item in
//       the issue's own `## Acceptance` checklist appears in the block (catches
//       a silently-omitted bullet, #2230), and every `deferred:#M` resolves to
//       an OPEN issue (catches a dead/fake tracker). B needs a `## Acceptance`
//       checklist keyed with `(slug)`s on the issue; issues without one degrade
//       to a NOTICE (A-checks only), so legacy issues never wedge a PR.
//
// What deliberately stays OUT of here (a human / qa-check concern, mirroring
// check.mjs): whether the diff *actually satisfies* a bullet marked `met`. CI
// enforces that the reconciliation exists, is well-formed, is complete against
// the issue's keyed checklist, and cites live trackers — never that `met` is
// true. That judgment can't be made from a string.
//
// Rollout is WARN-FIRST: problems print as `::warning::` and the process exits
// 0, so in-flight PRs from pre-format sessions aren't insta-redded. Set
// `RECONCILE_ENFORCE=1` to flip the same problems to `::error::` + exit 1 once
// the format has proven out.
//
// The pure functions (parse*/decideReconciliation) are exported and fully
// tested (reconcile.test.mjs). The runner is a thin wrapper: `--list` prints
// the issue numbers CI must fetch; `--check` reads PR_BODY + a dir of fetched
// issue JSON (ISSUE_DIR) and prints the verdict. Network (the issue fetch)
// lives in the workflow / self-check caller via curl — NOT here — so this
// module stays pure and offline, and so the fetch uses curl rather than a
// urllib/fetch call that Cloudflare 403s (#1620).

import { readFileSync, readdirSync } from "node:fs";
import { parseReadyNumbers, SKIP_MARKER } from "./check.mjs";

// Locked section headers (must match what the /ship and /issue skills emit).
export const RECONCILE_HEADER = /^##\s+Acceptance reconciliation\s*$/im;
// The issue-side acceptance header. Accepts a trailing qualifier: a reframe per
// implementing-issues.md revises the list and dates the header
// (`## Acceptance (revised 2026-08-10)`), which the old EXACT match missed
// entirely — silently following an *archived* bare `## Acceptance` instead and
// verifying against withdrawn criteria (#2320). The negative lookahead keeps it
// from also matching the PR-body `## Acceptance reconciliation` header.
export const ACCEPTANCE_HEADER = /^##\s+Acceptance\b(?!\s+reconciliation\b).*$/im;

// A `### #N` block header inside the reconciliation section.
const BLOCK_HEADER = /^###\s+#(\d+)\b/;

// A reconciliation bullet: `- (slug) — met` or `- (slug) — deferred:#123`.
// Separator between the (slug) and the marker is one or more of —/–/:/- so a
// bullet whose prose merely ends in "met" can't masquerade as marked.
const BULLET = /^[\s>]*[-*+]\s+\(([a-z0-9][a-z0-9-]*)\)\s*[—–:-]+\s*(met|deferred:\s*#(\d+))\s*$/i;

// A markdown list line (used to decide whether a line is *meant* to be a bullet
// — a list line that doesn't match BULLET is malformed, not ignored).
const LIST_LINE = /^[\s>]*[-*+]\s+/;

// An issue `## Acceptance` checklist item, keyed: `- [ ] (slug) text`.
const ACCEPTANCE_ITEM = /^[\s>]*[-*+]\s+\[[ xX]\]\s*/;
const ACCEPTANCE_KEY = /^[\s>]*[-*+]\s+\[[ xX]\]\s*\(([a-z0-9][a-z0-9-]*)\)/;

// A retire marker on an acceptance item — `- [ ] (slug) … — superseded:#M`
// (or `moved:` / `carved:`) — declares the key withdrawn to another ticket, so
// the gate drops it from the REQUIRED set without relying on the
// `~~strikethrough~~`-defeats-the-regex accident that no test pinned (#2320,
// folds in #2316). The target #M should be a live issue (checked like a deferral).
const SUPERSEDED = /\b(?:superseded|moved|carved):\s*#(\d+)/i;

/**
 * Drop content the parser must NOT treat as authoritative:
 *   - fenced code blocks (``` / ~~~) — an *illustrative* `## Acceptance` shown
 *     as a format example (the fence examples in this very issue's body);
 *   - `<details>…</details>` blocks — a COLLAPSED / archived section. A reframe
 *     per implementing-issues.md moves the superseded acceptance list into a
 *     `<details>`; collapsing it must also hide it from the parser, else the
 *     gate can follow the withdrawn criteria (#2320).
 *
 * Order matters: strip fenced code FIRST, then remove only *balanced*
 * `<details>…</details>` pairs. An UNBALANCED `<details>` — e.g. an inline-code
 * prose mention like `` `<details>` `` in an issue *about* this very format
 * (#2320's own body) — is left as harmless text, so it can never over-strip
 * past a real closing tag and swallow the live section. Unbalanced fences drop
 * to EOF (conservative — better to ignore trailing example text than parse it
 * as a live header).
 */
export function stripIgnored(body) {
  if (typeof body !== "string") return "";
  // 1) Fenced code blocks (line-based; a fence closes on the marker char it opened).
  const out = [];
  let fence = null;
  for (const line of body.split("\n")) {
    const f = line.match(/^\s*(```+|~~~+)/);
    if (f) {
      const marker = f[1][0];
      if (fence === null)
        fence = marker; // opening fence
      else if (marker === fence) fence = null; // matching closing fence
      continue; // never emit a fence line
    }
    if (fence === null) out.push(line);
  }
  // 2) Balanced <details>…</details> pairs (a collapsed/archived section). Repeat
  //    so adjacent/nested pairs all go; an unbalanced <details> stays put.
  let text = out.join("\n");
  let prev;
  do {
    prev = text;
    text = text.replace(/<details\b[\s\S]*?<\/details\s*>/gi, "");
  } while (text !== prev);
  return text;
}

/**
 * Slice a markdown section from its `## Header` to the next `## ` (a `### `
 * subsection stays inside), after removing fenced code blocks. Mirrors
 * check.mjs's `## Test plans` slicing so the two guards scope sections the
 * same way. Returns "" when the header is absent.
 */
export function sliceSection(body, headerRe) {
  if (typeof body !== "string") return "";
  const stripped = stripIgnored(body);
  const m = stripped.match(headerRe);
  if (!m) return "";
  const rest = stripped.slice(m.index + m[0].length);
  const next = rest.search(/^##\s+(?!#)/m); // next `## ` that isn't `### `
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Parse the `## Acceptance reconciliation` section into per-issue blocks.
 * Returns Map<numberString, { bullets: [{slug, deferTo}], malformed: [string] }>.
 * `deferTo` is the target issue number for a `deferred:#M` bullet, else null.
 */
export function parseReconciliation(body) {
  const out = new Map();
  const section = sliceSection(body, RECONCILE_HEADER);
  if (!section) return out;
  let cur = null;
  for (const raw of section.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const h = line.match(BLOCK_HEADER);
    if (h) {
      cur = { bullets: [], malformed: [] };
      out.set(h[1], cur);
      continue;
    }
    if (!cur || !LIST_LINE.test(line)) continue; // prose / blank inside a block: ignore
    const b = line.match(BULLET);
    if (!b) {
      cur.malformed.push(line.trim());
      continue;
    }
    cur.bullets.push({ slug: b[1].toLowerCase(), deferTo: b[3] ?? null });
  }
  return out;
}

/**
 * Parse an issue body's `## Acceptance` checklist.
 * Returns { hasChecklist, keys:Set<slug>, retired:Map<slug,#M>, headerCount }.
 * - `keys` are the REQUIRED `(slug)`-keyed items (a `superseded:#M` item is
 *   dropped here and recorded in `retired` instead).
 * - `headerCount` is how many `## Acceptance` headers survive stripping — >1
 *   means the live section is ambiguous (the #2320 collision) and callers must
 *   not trust the parsed keys.
 * A checklist with items but no keys → hasChecklist true, keys empty → B can't
 * verify completeness deterministically, so it degrades to a NOTICE.
 */
export function parseAcceptanceKeys(issueBody) {
  const stripped = stripIgnored(issueBody);
  const headerCount = (stripped.match(new RegExp(ACCEPTANCE_HEADER.source, "gim")) || []).length;
  const section = sliceSection(issueBody, ACCEPTANCE_HEADER);
  const keys = new Set();
  const retired = new Map();
  let hasChecklist = false;
  for (const raw of section.split("\n")) {
    if (!ACCEPTANCE_ITEM.test(raw)) continue;
    hasChecklist = true;
    const k = raw.match(ACCEPTANCE_KEY);
    if (!k) continue;
    const slug = k[1].toLowerCase();
    const sup = raw.match(SUPERSEDED);
    if (sup) retired.set(slug, sup[1]);
    else keys.add(slug);
  }
  return { hasChecklist, keys, retired, headerCount };
}

/**
 * Pure decision. `issues` is Map<numberString, {state, hasChecklist, keys}>
 * (state: "open" | "closed" | null-when-unfetched). `skipB` runs A-checks only
 * (used when no issue bodies are available — e.g. no API token).
 * Returns { problems: [{level:"error"|"notice", msg}] }. `error` blocks under
 * RECONCILE_ENFORCE; `notice` never blocks.
 */
export function decideReconciliation({ body, issues = new Map(), skipB = false }) {
  const problems = [];
  const ready = [...parseReadyNumbers(body)];
  const blocks = parseReconciliation(body);

  for (const n of ready) {
    const blk = blocks.get(n);
    if (!blk) {
      problems.push({
        level: "error",
        msg: `#${n}: no \`### #${n}\` block under \`## Acceptance reconciliation\` — every Ready #N needs a per-bullet reconciliation.`,
      });
      continue;
    }
    for (const bad of blk.malformed) {
      problems.push({
        level: "error",
        msg: `#${n}: malformed reconciliation bullet \`${bad}\` — expected \`- (slug) — met | deferred:#M\`.`,
      });
    }
    if (blk.bullets.length === 0) {
      problems.push({ level: "error", msg: `#${n}: reconciliation block has no bullets.` });
    }

    if (skipB) continue;

    const iss = issues.get(n);
    if (iss && iss.headerCount > 1) {
      problems.push({
        level: "error",
        msg: `#${n}: ${iss.headerCount} \`## Acceptance\` headers found — the gate can't tell which is live, so completeness is NOT verified (it could follow a superseded section, the #2320 hole). Keep one live \`## Acceptance\`; archive superseded ones in <details>, or retire individual keys with \`superseded:#M\`.`,
      });
      continue;
    }
    if (iss && iss.hasChecklist && iss.keys.size) {
      const have = new Set(blk.bullets.map((x) => x.slug));
      const missing = [...iss.keys].filter((k) => !have.has(k));
      if (missing.length) {
        problems.push({
          level: "error",
          msg: `#${n}: reconciliation omits acceptance key(s) ${missing
            .map((k) => `(${k})`)
            .join(
              ", ",
            )} — address each with \`met\` or \`deferred:#M\`, or a bullet was silently dropped.`,
        });
      }
    } else if (iss && iss.state) {
      problems.push({
        level: "notice",
        msg: `#${n}: issue has no keyed \`## Acceptance\` checklist — completeness not verified (A-checks only).`,
      });
    } else {
      problems.push({
        level: "notice",
        msg: `#${n}: could not fetch issue body — completeness not verified.`,
      });
    }
  }

  if (!skipB) {
    for (const [n, blk] of blocks) {
      for (const b of blk.bullets) {
        if (!b.deferTo) continue;
        const st = issues.get(b.deferTo);
        if (!st || !st.state) {
          problems.push({
            level: "error",
            msg: `#${n}: \`deferred:#${b.deferTo}\` — could not resolve that issue (does it exist?).`,
          });
        } else if (st.state === "closed") {
          problems.push({
            level: "error",
            msg: `#${n}: \`deferred:#${b.deferTo}\` points at a CLOSED issue — a deferral needs a live tracker.`,
          });
        }
      }
    }
    // NOTE: a `superseded:#M` retire marker drops the key from the required set
    // (parseAcceptanceKeys → retired), but its target's liveness is NOT checked
    // here: unlike a `deferred:#M` (declared in the PR block, so listable), a
    // retire lives in the ISSUE body and its target isn't known until after the
    // Ready #N is fetched — full liveness would need a two-phase fetch. Deferred.
  }

  return { problems };
}

// ---------------------------------------------------------------------------
// Thin runner. `--list` → issue numbers to fetch (Ready ∪ deferral targets).
// `--check` → read PR_BODY + ISSUE_DIR/*.json, print verdict. Node built-ins
// only; the network fetch is the workflow's/hook's job (curl).
// ---------------------------------------------------------------------------

function listNumbers(body) {
  const nums = new Set(parseReadyNumbers(body));
  for (const [, blk] of parseReconciliation(body)) {
    for (const b of blk.bullets) if (b.deferTo) nums.add(b.deferTo);
  }
  return [...nums];
}

const EMPTY_ISSUE = () => ({
  state: null,
  hasChecklist: false,
  keys: new Set(),
  retired: new Map(),
  headerCount: 0,
});

function loadIssues(dir) {
  const issues = new Map();
  let files = [];
  try {
    files = readdirSync(dir);
  } catch {
    return issues;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const fallbackKey = f.replace(/\.json$/, "");
    try {
      const j = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
      if (j && j.number != null) {
        const { hasChecklist, keys, retired, headerCount } = parseAcceptanceKeys(j.body ?? "");
        issues.set(String(j.number), {
          state: j.state ?? null,
          hasChecklist,
          keys,
          retired,
          headerCount,
        });
      } else {
        issues.set(fallbackKey, EMPTY_ISSUE());
      }
    } catch {
      issues.set(fallbackKey, EMPTY_ISSUE());
    }
  }
  return issues;
}

function runList() {
  const body = process.env.PR_BODY ?? "";
  const nums = listNumbers(body);
  if (nums.length) process.stdout.write(nums.join("\n") + "\n");
}

function runCheck() {
  const body = process.env.PR_BODY ?? "";
  const title = process.env.PR_TITLE ?? "";
  const enforce = process.env.RECONCILE_ENFORCE === "1";

  if (title.includes(SKIP_MARKER)) {
    console.log(`reconcile: ${SKIP_MARKER} present in PR title — skipped.`);
    return 0;
  }
  const ready = [...parseReadyNumbers(body)];
  if (ready.length === 0) {
    console.log("reconcile: no `Ready #N` lines — nothing to reconcile. OK.");
    return 0;
  }

  const dir = process.env.ISSUE_DIR;
  const skipB = !dir;
  const issues = skipB ? new Map() : loadIssues(dir);
  const { problems } = decideReconciliation({ body, issues, skipB });

  for (const p of problems) {
    if (p.level === "notice") console.log(`::notice::reconcile: ${p.msg}`);
    else console.log(`::${enforce ? "error" : "warning"}::reconcile: ${p.msg}`);
  }
  if (skipB) {
    console.log(
      "::notice::reconcile: B-checks (completeness + deferral liveness) skipped — no issue bodies (ISSUE_DIR unset).",
    );
  }

  const errors = problems.filter((p) => p.level === "error");
  if (errors.length === 0) {
    console.log(
      `reconcile: OK — Ready ${ready.map((n) => `#${n}`).join(", ")} each has a well-formed reconciliation block.`,
    );
    return 0;
  }
  if (enforce) {
    console.error(
      `reconcile: FAIL — ${errors.length} problem(s) above. See the /ship skill Step 4.6.`,
    );
    return 1;
  }
  console.log(
    `reconcile: ${errors.length} problem(s) — WARNING only (warn-first rollout). Set RECONCILE_ENFORCE=1 to block.`,
  );
  return 0;
}

function main() {
  const mode = process.argv[2];
  if (mode === "--list") return (runList(), 0);
  if (mode === "--check") return runCheck();
  console.error("usage: reconcile.mjs --list | --check");
  return 2;
}

const invokedDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith("reconcile.mjs") || process.argv[1].endsWith("ship-guard/reconcile"));
if (invokedDirectly) process.exit(main() ?? 0);
