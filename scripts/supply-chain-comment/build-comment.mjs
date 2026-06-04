// Pure: (net-new alerts + gate outcome) -> markdown PR comment body.
// Versioned marker so re-runs update in place (see dead-code-comment).

export const MARKER = "<!-- supply-chain-bot:v1 -->";
export const MARKER_RE = /<!-- supply-chain-bot:v(\d+) -->/;
export const CURRENT_VERSION = 1;

export function buildComment({ netNew, blocked }) {
  if (!netNew || netNew.length === 0) {
    return `${MARKER}\n\n## 🛡️ Supply-chain: clean\n\n✅ No new supply-chain alerts introduced by this PR.\n`;
  }
  const parts = [MARKER, "", "## 🛡️ Supply-chain alerts (net-new in this PR)", ""];
  if (blocked) {
    parts.push(
      "> ❌ **This PR is blocked** by one or more findings below. Fix the dependency, or — for a reviewed false positive — add `[allow-deps]` to the PR title to override.",
    );
  } else {
    parts.push("> ℹ️ Informational findings — none block the merge.");
  }
  parts.push("");
  parts.push("| Package | Alert | Severity |");
  parts.push("|---|---|---:|");
  for (const al of netNew) {
    const name = al.url ? `[${al.pkg}@${al.version}](${al.url})` : `${al.pkg}@${al.version}`;
    parts.push(`| ${name} | ${al.title} (\`${al.type}\`) | ${al.severity} |`);
  }
  parts.push("");
  parts.push("_Scanned diff-forward vs `main`; the existing tree is trusted (see #723 baseline)._");
  return parts.join("\n");
}
