// Pure: (net-new alerts split by blocking/informational + counts) -> markdown.
// Versioned marker so re-runs update in place (see dead-code-comment).

export const MARKER = "<!-- supply-chain-bot:v2 -->";
export const MARKER_RE = /<!-- supply-chain-bot:v(\d+) -->/;
export const CURRENT_VERSION = 2;

function table(alerts) {
  const rows = ["| Package | Alert | Severity |", "|---|---|---:|"];
  for (const al of alerts) {
    const name = al.url ? `[${al.pkg}@${al.version}](${al.url})` : `${al.pkg}@${al.version}`;
    rows.push(`| ${name} | ${al.title} (\`${al.type}\`) | ${al.severity} |`);
  }
  return rows.join("\n");
}

function countsText(counts) {
  return counts
    ? `_Socket scan-diff: ${counts.added} added alert${counts.added === 1 ? "" : "s"} → ${counts.netNew} net-new (de-duped)._`
    : null;
}

export function buildComment({ blocking = [], informational = [], blocked, counts }) {
  const ct = countsText(counts);
  if (blocking.length + informational.length === 0) {
    return (
      `${MARKER}\n\n## 🛡️ Supply-chain: clean\n\n` +
      `✅ No new supply-chain alerts introduced by this PR.` +
      (ct ? `\n\n${ct}` : "") +
      `\n`
    );
  }
  const parts = [MARKER, "", "## 🛡️ Supply-chain alerts (net-new in this PR)", ""];
  parts.push(
    blocked
      ? "> ❌ **This PR is blocked** by the finding(s) below. Fix the dependency, or — for a reviewed false positive — add `[allow-deps]` to the PR title to override."
      : "> ℹ️ Informational findings — none block the merge.",
  );
  if (ct) parts.push("", ct);
  if (blocking.length) {
    parts.push("", "### ❌ Blocking", "", table(blocking));
  }
  if (informational.length) {
    const n = informational.length;
    parts.push(
      "",
      `<details><summary>ℹ️ ${n} informational finding${n === 1 ? "" : "s"} (none block)</summary>`,
      "",
      table(informational),
      "",
      "</details>",
    );
  }
  parts.push("", "_Scanned diff-forward vs `main`; the existing tree is trusted (see #723 baseline)._");
  return parts.join("\n");
}
