// Pure gate decision for the supply-chain bot. Mirrors dead-code-comment's
// shouldFailGate + [allow-...] escape-hatch pattern.
//
// "What blocks" is driven by Socket's per-alert org-policy verdict (`action`):
// ignore | monitor | warn | error. We block on `error` — so the real policy
// lives in the Socket dashboard security policy (set malware / typosquat /
// install-scripts → error there). Everything softer (monitor/warn/ignore, and
// normal signals like networkAccess/installScripts on legit packages) is
// informational: it comments, never blocks.

export const ALLOW_MARKER = "[allow-deps]";

// Defense-in-depth floor: unambiguous-malware alert types block regardless of
// org-policy action, in case the Socket policy is ever misconfigured. These
// never appear on a legitimate package.
const ALWAYS_BLOCK_TYPES = new Set(["malware", "gptMalware", "gptSecurity"]);

// The dashboard's "Block" tier surfaces in the CLI JSON `action` field as
// "error" (and possibly "block" on newer versions) — accept both.
const BLOCK_ACTIONS = new Set(["error", "block"]);

export function isBlocking(alert) {
  return BLOCK_ACTIONS.has(alert.action) || ALWAYS_BLOCK_TYPES.has(alert.type);
}

export function shouldFailGate({ netNew, prTitle }) {
  const blocking = (netNew ?? []).filter(isBlocking);
  if (blocking.length === 0) return { fail: false, reason: "no net-new blocking alerts" };
  if (typeof prTitle === "string" && prTitle.includes(ALLOW_MARKER)) {
    return { fail: false, reason: "allow-deps escape hatch in PR title" };
  }
  const names = blocking.map((a) => `${a.pkg}@${a.version} (${a.type})`).join(", ");
  return { fail: true, reason: `net-new blocking alert(s): ${names}` };
}
