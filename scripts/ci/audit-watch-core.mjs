/**
 * audit-watch-core.mjs — #2391 Job B. Pure rendering + issue-selection logic for
 * the scheduled whole-tree audit run against main.
 *
 * Job A took ambient advisories OFF the blocking path. This is where they land
 * instead: a rolling Forgejo issue, in the pattern already used by
 * `ci-main-red` (ci.yml) and the e2e flaky dashboard (flaky-report-core.mjs).
 *
 * No I/O here — `audit-watch.mjs` is the shell.
 */

/**
 * The rolling-issue marker.
 *
 * A DISTINCT marker from `ci-main-red`: that issue means "a gate failed on a
 * push to main", this one means "the world moved under an unchanged main". Two
 * different remedies, so two different tickets.
 */
export const MARKER = "<!-- audit-ambient-red -->";

/**
 * Pick the rolling issue out of a list of open issues.
 *
 * The marker must LEAD the body — never be matched as a substring anywhere in
 * it. An issue that DOCUMENTS a marker contains it, and a reporter that matched
 * on containment once overwrote the very ticket describing the format. Only a
 * body this tool wrote starts with the marker.
 *
 * Oldest wins, so a duplicate filed during an outage does not become the new
 * home and orphan the original. Ported from `pickDashboard` in
 * flaky-report-core.mjs — same rule, same reasons.
 */
export function pickIssue(issues) {
  const hits = (issues ?? [])
    .filter((i) => (i?.body || "").trimStart().startsWith(MARKER))
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  return { issue: hits[0] ?? null, duplicates: hits.slice(1).map((i) => i.number) };
}

/**
 * Fold per-workspace `evaluate()` results into one report.
 *
 * @param {{workspace: string, result: object, error?: string}[]} runs
 * @returns {{findings: object[], errors: object[], clean: boolean}}
 */
export function summarise(runs) {
  const findings = [];
  const errors = [];
  for (const run of runs ?? []) {
    if (run.error) {
      errors.push({ workspace: run.workspace, error: run.error });
      continue;
    }
    for (const b of run.result?.blocked ?? []) {
      findings.push({ workspace: run.workspace, kind: "advisory", ...b });
    }
    for (const e of run.result?.expired ?? []) {
      findings.push({
        workspace: run.workspace,
        kind: "expired",
        name: e.name,
        severity: "expired-allowlist",
        ids: [e.entry.ghsa],
        entry: e.entry,
      });
    }
  }
  // "We could not look" is not "we found nothing" — an unreadable workspace
  // keeps the issue open with the error spelled out rather than reading as an
  // all-clear (the same conflation #2303 removed from the flaky reporter).
  return { findings, errors, clean: findings.length === 0 && errors.length === 0 };
}

/** A stable one-line key per finding, used to keep the body diff-friendly. */
function key(f) {
  return `${f.workspace}|${f.name}|${(f.ids ?? []).join(",")}`;
}

export function renderTitle({ findings, errors, clean }) {
  if (clean) return "npm audit against main: clear";
  if (findings.length === 0) return `npm audit against main: ${errors.length} workspace error(s)`;
  const workspaces = [...new Set(findings.map((f) => f.workspace))].sort();
  return `npm audit against main: ${findings.length} un-allowlisted advisor${findings.length === 1 ? "y" : "ies"} (${workspaces.join(", ")})`;
}

/**
 * The issue body. Always begins with MARKER — see pickIssue.
 *
 * @param {{findings: object[], errors: object[], clean: boolean}} summary
 * @param {{runLabel?: string, runUrl?: string|null, sha?: string|null}} meta
 */
export function renderBody(summary, meta = {}) {
  const { findings, errors, clean } = summary;
  const lines = [MARKER, ""];

  if (clean) {
    lines.push(
      "✅ **npm audit is clear against `main`** — every high/critical advisory in every workspace is either absent or covered by a live `scripts/audit-allowlist.json` entry.",
    );
  } else {
    lines.push(
      `🟠 **npm audit found ${findings.length} un-allowlisted high/critical advisor${findings.length === 1 ? "y" : "ies"} against \`main\`.**`,
      "",
      "These are **ambient**: they do not block any PR (#2391 took the live advisory feed off the blocking path), so they need a deliberate decision here — patch, override, or an allowlist entry with a written justification and an expiry.",
      "",
      "| Workspace | Package | Severity | Advisory |",
      "| --- | --- | --- | --- |",
    );
    const seen = new Set();
    for (const f of findings) {
      const k = key(f);
      if (seen.has(k)) continue;
      seen.add(k);
      const ids = (f.ids ?? []).length
        ? (f.ids ?? []).map((id) => `[${id}](https://github.com/advisories/${id})`).join("<br>")
        : "_(none reported)_";
      const note = f.kind === "expired" ? " _(allowlist entry EXPIRED)_" : "";
      lines.push(`| \`${f.workspace}\` | \`${f.name}\`${note} | ${f.severity} | ${ids} |`);
    }
  }

  if (errors.length) {
    lines.push(
      "",
      "⚠️ **Workspaces that could not be audited** (this is NOT an all-clear for them):",
      "",
    );
    for (const e of errors) lines.push(`- \`${e.workspace}\` — ${e.error}`);
  }

  lines.push(
    "",
    "---",
    "",
    `_Last run: ${meta.runLabel ?? "unknown"}${meta.sha ? ` on \`${String(meta.sha).slice(0, 12)}\`` : ""}${meta.runUrl ? ` — [run log](${meta.runUrl})` : ""}._`,
    "_Auto-filed by `.forgejo/workflows/audit-watch.yml` (#2391). This issue is rewritten on every scheduled run and closed automatically once main is clear._",
  );
  return lines.join("\n");
}
