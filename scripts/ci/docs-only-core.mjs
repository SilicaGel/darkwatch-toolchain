// docs-only-core.mjs — the one piece of #2496's shell that needs pinning by test.
//
// WHY THIS EXISTS AS A SEPARATE, TESTED MODULE
//   The first version of docs-only.mjs read `github.event_name` and was DEAD in
//   test.yml, because a `workflow_call` callee's `event_name` is literally
//   `workflow_call` — never `pull_request`. It failed open (ran everything), so
//   nothing broke; it simply never engaged. `smoke`, an ordinary job in ci.yml,
//   worked on the same commit, which is exactly how a bug like this hides.
//
//   test.yml already carried the warning — #2351's comment on the coverage step
//   says "expressed as data, not event_name (which is literally 'workflow_call'
//   in a callee)". Reading it was not enough; this module makes the rule
//   executable so the next caller inherits it instead of rediscovering it.

/**
 * Is this run a pull request, expressed as DATA?
 *
 * A PR number is present in the payload for both an ordinary `pull_request` job
 * and a `workflow_call` callee running underneath one, so it is the portable
 * signal. `event_name` is not.
 *
 * Falls back to `event_name` only when there is no PR number, which is what
 * keeps a push / schedule / dispatch run reading as "not a PR" — those must
 * always run everything.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string} an event name safe to hand to `decide()`
 */
export function resolveEventName(env = {}) {
  const pr = (env.PR_NUMBER ?? "").trim();
  // '' and the literal '0' are both "no PR". A real index is >= 1.
  if (pr && pr !== "0") return "pull_request";
  return (env.GITHUB_EVENT_NAME ?? "").trim();
}
